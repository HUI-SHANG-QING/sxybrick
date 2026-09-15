/**
 * 每日规划解析器（离线纯函数 + LLM 增强）
 *
 * 把用户「口述」的自由文本解析为结构化任务数组：
 *   输入："复习 30 张卡片，最优先；番茄钟 25 分钟；看线代第三章讲义，重要"
 *   输出：[{ title, type, important, urgent, quadrant, targetCount, estimatedMinutes, subject, scheduledHour }, ...]
 *
 * 解析策略：
 *   1) parsePlan(text)         — 离线纯函数（即时、确定性、可 Node 单测）
 *   2) parsePlanWithLLM(text)  — LLM 优先（动态加载 ai.js，结构化输出；失败自动回退离线）
 *   3) parsePlanSmart(text,opts) — 编排：hasAIKey 时走 LLM，否则离线
 *
 * 离线规则：
 *   1) 分句：换行 / 分号 / 中文句号 / 顿号切分
 *   2) 类型：关键词 → type（review/pomodoro/doc/exam/note/write/other）
 *   3) 优先级：关键词 → important + urgent → 四象限（艾森豪威尔矩阵）
 *   4) 数量：数字 + 单位 → targetCount / estimatedMinutes
 *   5) 科目：科目词表 → subject
 *   6) 时间：'HH点'/'HH:MM'/'下午H点' → scheduledHour（24h 制，0-23，便于日程时间轴）
 *
 * 设计原则：
 *   - 离线纯函数可 Node 单测，无 DOM/DB/网络副作用
 *   - 容错：无法识别 → 保留原文本 + type=other + Q4 + scheduledHour=null
 *   - 确定性：相同输入 → 相同输出
 *   - 向后兼容：parsePlan / parsePlanWithSummary 签名不变，仅新增字段
 */

// ──────────────── 动作类型词表 ────────────────

const TYPE_RULES = [
  { type: 'review',   keywords: ['复习', '背', '卡片', '背诵', '记忆', 'anki', '复习卡', 'flashcard', '抽认卡'] },
  { type: 'pomodoro', keywords: ['番茄', '专注', '计时', '番茄钟', 'pomodoro', '心流', '深度工作'] },
  { type: 'doc',      keywords: ['看', '读', '资料', '讲义', '真题', '书', 'pdf', '文档', '论文', '教材', '阅读', '预习', '复习资料'] },
  { type: 'exam',     keywords: ['做题', '道题', '模考', '考试', '刷题', '试卷', '测验', '练习', '真题卷', '套题', '模拟'] },
  { type: 'note',     keywords: ['笔记', '整理', '总结', '归纳', '错题本', '复盘', '梳理', '脑图', '思维导图'] },
  { type: 'write',    keywords: ['写作', '作文', '写信', '写报告', '写论文', '草稿', '撰写', '投稿'] },
];

// ──────────────── 优先级词表 ────────────────

// 重要×紧急（Q1）
const Q1_WORDS = ['最优先', '很紧急', '最重要', '马上', '立刻', '立即', '紧急且重要', 'deadline', '必须今天', '今天必须', '首要', '迫在眉睫', 'ddl'];
// 重要但不急（Q2）
const Q2_WORDS = ['重要', '要完成', '关键', '核心', '重点', '必做', '必须', '要做'];
// 紧急但不重要（Q3）
const Q3_WORDS = ['紧急', '急', '尽快', '快', '来不及', '赶'];
// 其余 → Q4（不重要不紧急，默认）

// ──────────────── 科目词表 ────────────────

const SUBJECT_RULES = [
  { subject: '计组',     keywords: ['计组', '计算机组成', '组成原理', '存储系统', 'cache', 'cpu', '408计组', '总线', '指令'] },
  { subject: '线代',     keywords: ['线代', '线性代数', '矩阵', '特征值', '方程组', '行列式', '向量', '空间'] },
  { subject: '编译原理', keywords: ['编译', '编译原理', '词法', '语法分析', '文法', 'll', 'lr', 'dfa', 'nfa'] },
  { subject: '系统概论', keywords: ['系统概论', '概论', '操作系统', 'os', '进程', '线程', '内存管理'] },
  { subject: '数据结构', keywords: ['数据结构', 'ds', '算法', '树', '图', '排序', '查找', '链表', '栈', '队列'] },
  { subject: '英语',     keywords: ['英语', '单词', '词汇', '阅读', '作文', '翻译', '长难句', '听力'] },
  { subject: '政治',     keywords: ['政治', '马原', '毛概', '史纲', '思修', '时政', '毛中特'] },
  { subject: '数学',     keywords: ['高数', '数学', '微积分', '概率', '统计', '数一', '数二', '数三', '导数', '积分'] },
  { subject: '专业课',   keywords: ['专业课', '408', '综合'] },
];

// ──────────────── 工具 ────────────────

/**
 * 提取任务中的「数字 + 单位」：
 *   支持 "30张" "30 张" "25分钟" "25 分钟" "2章" "2 章" "1小时" "1.5小时"
 * @returns {{ targetCount: number|null, estimatedMinutes: number|null }}
 */
export function extractQuantity(text) {
  const s = String(text || '');
  let targetCount = null;
  let estimatedMinutes = null;

  // 数量 + 张/题/个/条/节/章/篇/页/套/组/遍/轮/次/词/份 → targetCount
  // round62：补齐考研场景高频漏检量词——「道」（理科刷题最标准量词：做8道题/刷120道）、
  //   「讲」（网课：看2讲）、「问」（答疑/问题：刷100问）、「段」（背书/翻译：背5段）、
  //   「集」（视频：看3集）、「课」（看2课）、「题」已在表中。此前这些写法一律 targetCount=null，
  //   导致规划目标数在联动分析（planSynergy 按类型累加）与四象限展示里静默丢失。
  // ⚠️ 「道」「讲」等单字量词要防误匹配（如"这道题很好"里的"道"前面无数字，不受影响；
  //    但"第3道"会命中，语义上可接受——与既有"看第3章"同口径）。
  const countRe = /(\d+(?:\.\d+)?)\s*(张|题|道|个|条|节|章|篇|页|套|组|遍|轮|次|词|份|讲|问|段|集|课|篇作文)/g;
  let m;
  while ((m = countRe.exec(s)) !== null) {
    const n = parseFloat(m[1]);
    if (targetCount === null) targetCount = n;
  }

  // 数量 + 分钟/小时 → estimatedMinutes
  // ⚠️ round62 修复：此前时间单位的尾部统一挂了负向先行断言 `(?![a-z\u4e00-\u9fff])`，
  //   本意是防单字母 `h` 误匹配英文单词（如 "the h"），但**中文单位也被一起封死**了：
  //     "做2小时数学" / "背30分钟单词" / "130分钟" 出现在句子中段时全部失配 → estimatedMinutes=null
  //   ——而「数字+小时/分钟+紧接着科目名」恰是中文计划文本里最主流的写法。
  //   丢失 estimatedMinutes 的后果不是"少个字段"：日程时间轴的时长块（planCharts 课程表）
  //   会退回 defaultDur 兜底 → 全天安排的整体时长估算系统性失真。
  //   正确做法：**只给英文缩写单位加边界**（英文才有词边界问题），中文单位直接放行。
  //   中文单位（分钟/小时）后可以跟任意中文/字母；英文单位（min/mins/hour/h）后不得紧跟字母，
  //   以免 `1h` 命中 `1hello` 之类（并用 (?<![a-z]) 防 `min` 命中 `admin` 的尾部）。
  const timeRe = /(\d+(?:\.\d+)?)\s*(分钟|小时|(?<![a-z])(?:mins?|hours?|h)(?![a-z]))/gi;
  timeRe.lastIndex = 0;
  let tm;
  while ((tm = timeRe.exec(s)) !== null) {
    let mins = parseFloat(tm[1]);
    const unit = tm[2].toLowerCase();
    if (unit === 'h' || unit === 'hours' || unit === 'hour' || unit === '小时') mins *= 60;
    if (estimatedMinutes === null) estimatedMinutes = Math.round(mins);
  }

  // round30 P2-7：estimatedMinutes 必须 clamp，防止 LLM 返回超大值污染
  // 时间轴渲染（start+est 超 24:00）、联动分析（规划/实际完成率）与跨设备同步。
  // 单任务不可能超过一天，绝对上界取 1440（分钟）。
  if (estimatedMinutes != null) {
    if (!Number.isFinite(estimatedMinutes) || estimatedMinutes < 0) estimatedMinutes = null;
    else estimatedMinutes = Math.min(1440, Math.round(estimatedMinutes));
  }
  return { targetCount, estimatedMinutes };
}

/**
 * 12 小时制 → 24 小时制。**"12 点"是唯一的坑**（round62 修复）：
 *   中文口语里"12 点"指向哪一端，完全由**时段前缀的语义方向**决定：
 *     夜晚向（凌晨/深夜/晚上/晚间/夜里/今夜）的 12 点 = **午夜 0 点**（一天结束）
 *     白天向（中午/正午/…）的 12 点                        = **正午 12 点**
 *     无前缀的"12点"                                      = 12（保守不变，歧义不动）
 *   其余 1..11 点：pm 语义 +12，am 语义不变，无前缀按原样。
 *
 * 此前实现写作 `if (pmRe.test(s) && h <= 12) h += 12`，于是：
 *   "晚上12点" → h=12 → 24 → 越出 `h<=23` 被整体丢弃 → 落到"晚上"关键词映射 **19 点**（错 5 小时）
 *   "下午12点" → h=12 → 24 → 丢弃 → 落到"下午"映射 **14 点**（错 2 小时）
 *   "凌晨12点" → h=12 → 无 pm → 返回 **12**（正午！应为 0 点）
 * 即"12 点"这一档在三种语境下全错，且因出口兜底（丢弃后走关键词映射）而不显眼。
 */
// ⚠️ 这里必须区分**三种**语境，混用会立刻出错（round62 我已在这上面返工一次）：
//   ① 夜间向（NIGHT_RE）：12 点 → 0 点。**仅**用于 12 点这一档。
//   ② 下午侧（PM_RE）：1..11 点 → +12。**不能**把"凌晨"放进来（凌晨1点 = 1 点，不是 13 点）。
//   ③ "晚"是单字且同时出现在"凌晨"以外的夜间词里——故 ①②必须分开定义，不能共用一条正则。
const NIGHT_RE = /(凌晨|深夜|夜里|今夜|夜晚|晚间|晚上|晚)/;
const PM_RE = /(中午|正午|晌午|下午|傍晚|晚上|晚间|夜晚|夜里|今夜|pm|晚)/i;
function toHour24(h12, s) {
  if (h12 === 12) {
    // 夜间向的 12 点 = 午夜 0 点；其余（中午/下午/无前缀）= 12 点
    return NIGHT_RE.test(s) ? 0 : 12;
  }
  if (h12 >= 1 && h12 <= 11) {
    // 下午侧 1..11 点 +12；上午/凌晨 1..11 点原样
    return PM_RE.test(s) ? h12 + 12 : h12;
  }
  // 13..23（也可能有 0 或 >23）：本就是 24 小时制写法，原样返回，由调用方判越界。
  return h12;
}

/**
 * 提取计划时间（24h 制小时数，便于日程时间轴渲染）。
 *   "早上8点"   → 8
 *   "下午3点"   → 15
 *   "晚上10点"  → 22
 *   "下午12点"  → 12  （正午；round62 修复，此前错误返回 14）
 *   "晚上12点"  → 0   （午夜；round62 修复，此前错误返回 19）
 *   "14:30"     → 14
 *   "14点30分"  → 14
 *   "上午"      → 9  （粗粒度时段映射）
 *   "下午"      → 14
 *   "晚上"      → 19
 *   无匹配      → null
 * @returns {number|null}
 */
export function extractHour(text) {
  if (!text) return null;
  const s = String(text);

  // 明确 HH:MM 或 HH点MM分
  let m = s.match(/(\d{1,2})\s*[:：点]\s*(\d{1,2})\s*分?/);
  if (m) {
    const h = toHour24(parseInt(m[1], 10), s);
    if (h !== null && h >= 0 && h <= 23) return h;
  }

  // "HH 点"（无分）
  m = s.match(/(\d{1,2})\s*点/);
  if (m) {
    const h = toHour24(parseInt(m[1], 10), s);
    if (h !== null && h >= 0 && h <= 23) return h;
  }

  // 时段关键词粗映射
  if (/凌晨|深夜/.test(s)) return 0;
  if (/清晨|早上|早晨|上午/.test(s)) return 9;
  if (/中午/.test(s)) return 12;
  if (/下午|傍晚/.test(s)) return 14;
  if (/晚上|晚间|晚/.test(s)) return 19;

  return null;
}

/** 动作类型识别 */
export function inferType(text) {
  const s = String(text || '').toLowerCase();
  for (const rule of TYPE_RULES) {
    if (rule.keywords.some(k => s.includes(k.toLowerCase()))) return rule.type;
  }
  return 'other';
}

/**
 * 优先级 → 四象限
 *
 * round62 修复：**否定词取反**。此前的实现是纯 `s.includes(w)` 字面包含，
 * 于是"不急""不紧急""不用急着""无需尽快"里的 `急/紧急/尽快` 全部照常命中 Q3 的紧急词——
 * 用户明说"不急"，任务却被判成**最紧急的 Q1**（因为同时也含"重要"）。
 * 实测："很重要但不急的复习" / "不紧急但要完成" / "重要的英语不急" → 全部 Q1。
 * 四象限是每日规划的主视图，把"不紧急"排到第一优先级会直接误导用户先做次要的事。
 *
 * 修法：先用 negRe 把「否定词 + 紧急/重要词」整段打码（替换成等长空白，保持其余文本的可匹配性），
 * 再在打码后的文本上跑关键词。打码而非删除，是为了避免相邻词被错误拼接产生新的假匹配
 * （如"不急迫重要"删掉"不急"后会拼出"迫重要"）。只打码紧邻的（0-2 个字的间隔），
 * 以免"不重要的内容，但这事很紧急"这类**跨小句**的否定误伤后半句的真实紧急。
 */
const NEG = '(?:不|别|无需|无须|不用|不必|勿|免|没有|没)';
const negRe = new RegExp(`${NEG}.{0,2}?(?:紧急|急|尽快|快|来不及|赶|重要|关键|核心|重点|优先)`, 'g');
function maskNegated(s) {
  return s.replace(negRe, (m) => ' '.repeat(m.length));
}
export function inferQuadrant(text) {
  const s = maskNegated(String(text || ''));
  let important = false, urgent = false;

  // 重要（Q1/Q2 都含"重要"，但 Q1 有更强制词）
  for (const w of Q1_WORDS) if (s.includes(w)) { important = true; urgent = true; break; }
  if (!(important && urgent)) {
    for (const w of Q2_WORDS) if (s.includes(w)) { important = true; break; }
  }
  for (const w of Q3_WORDS) if (s.includes(w)) urgent = true;

  if (important && urgent) return { important: true, urgent: true, quadrant: 'Q1' };
  if (important && !urgent) return { important: true, urgent: false, quadrant: 'Q2' };
  if (!important && urgent) return { important: false, urgent: true, quadrant: 'Q3' };
  return { important: false, urgent: false, quadrant: 'Q4' };
}

/** 科目识别 */
export function inferSubject(text) {
  const s = String(text || '').toLowerCase();
  for (const rule of SUBJECT_RULES) {
    if (rule.keywords.some(k => s.includes(k.toLowerCase()))) return rule.subject;
  }
  return '';
}

/**
 * 分句：换行 / 分号 / 中文句号 / 英文句号 / 顿号切分（保留非空片段）
 * 逗号不切（同一任务描述）。
 * 英文句号仅在「后跟空白或行尾」时切——保护小数（"1.5 小时" 的 . 不切，
 * 否则任务会被切成 "1" 与 "5 小时" 两段）与常见缩写。
 */
export function splitTasks(text) {
  if (!text) return [];
  return String(text)
    .split(/[\n\r;；。、]+|[.](?!\d)(?=\s|$)/)
    .map(s => s.trim())
    .filter(Boolean);
}

// ──────────────── 离线主解析 ────────────────

/**
 * 离线主入口：把口述文本解析为任务数组。
 * @param {string} text 用户口述文本
 * @returns {Array<{
 *   title, type, important, urgent, quadrant,
 *   targetCount, estimatedMinutes, subject, scheduledHour
 * }>}
 */
export function parsePlan(text) {
  const segments = splitTasks(text);
  return segments.map(seg => {
    const q = inferQuadrant(seg);
    const { targetCount, estimatedMinutes } = extractQuantity(seg);
    const subject = inferSubject(seg);
    const scheduledHour = extractHour(seg);
    return {
      title: seg,
      type: inferType(seg),
      important: q.important,
      urgent: q.urgent,
      quadrant: q.quadrant,
      targetCount,
      estimatedMinutes,
      subject,
      scheduledHour,
    };
  });
}

/**
 * 高层解析 + 统计汇总（供 UI 直接渲染）。
 * @returns {{ tasks, summary }}
 *   summary: { total, byQuadrant, byType, estimatedTotalMinutes, scheduledHours }
 */
export function parsePlanWithSummary(text) {
  const tasks = parsePlan(text);
  const byQuadrant = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
  const byType = {};
  let estimatedTotalMinutes = 0;
  const scheduledHours = [];
  for (const t of tasks) {
    byQuadrant[t.quadrant] = (byQuadrant[t.quadrant] || 0) + 1;
    byType[t.type] = (byType[t.type] || 0) + 1;
    if (t.estimatedMinutes) estimatedTotalMinutes += t.estimatedMinutes;
    if (t.scheduledHour != null) scheduledHours.push(t.scheduledHour);
  }
  return {
    tasks,
    summary: {
      total: tasks.length,
      byQuadrant,
      byType,
      estimatedTotalMinutes,
      scheduledHours: scheduledHours.sort((a, b) => a - b),
    },
  };
}

// ──────────────── LLM 增强（动态加载，离线回退） ────────────────

const LLM_SYSTEM_PROMPT = `你是日程解析助手。把用户的口述文本解析为 JSON 任务数组。
每个任务字段：
- title: 简洁任务名（去掉数量/时间/优先级冗余词）
- type: review | pomodoro | doc | exam | note | write | other
- important: true/false（艾森豪威尔"重要"维度）
- urgent: true/false（"紧急"维度）
- quadrant: Q1（重要紧急）/Q2（重要非紧急）/Q3（紧急非重要）/Q4（非重要非紧急）
- targetCount: 数字或 null（张/题/份/遍等数量）
- estimatedMinutes: 数字或 null（分钟数；1小时=60）
- subject: 科目名（计组/线代/英语/政治/数学/数据结构/编译原理/系统概论/专业课等），无则空串
- scheduledHour: 0-23 的整数或 null（24h 制开始时间）

只输出 JSON 数组，不要解释、不要 markdown 代码块。例：
输入"复习30张卡片最优先；下午3点做10道线代题"
输出 [{"title":"复习卡片","type":"review","important":true,"urgent":true,"quadrant":"Q1","targetCount":30,"estimatedMinutes":null,"subject":"","scheduledHour":null},{"title":"做线代题","type":"exam","important":false,"urgent":false,"quadrant":"Q4","targetCount":10,"estimatedMinutes":null,"subject":"线代","scheduledHour":15}]`;

/**
 * LLM 优先解析：动态加载 ai.js，调用 chatAI 结构化解析；失败/无 key 自动回退离线。
 * 返回与 parsePlanWithSummary 相同的形状：{ tasks, summary, source }
 *   source: 'llm' | 'offline'
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.fallbackOnOffline=true] 失败是否回退离线（默认 true）
 */
export async function parsePlanWithLLM(text, opts = {}) {
  const fallbackOnOffline = opts.fallbackOnOffline !== false;
  const offline = () => ({ ...parsePlanWithSummary(text), source: 'offline' });

  try {
    const { hasAIKey, chatAI } = await import('../ai.js');
    if (!hasAIKey()) return fallbackOnOffline ? offline() : { ...parsePlanWithSummary(text), source: 'offline' };

    const messages = [
      { role: 'system', content: LLM_SYSTEM_PROMPT },
      { role: 'user', content: text },
    ];
    const reply = await chatAI(messages, { temperature: 0.1 });
    const tasks = normalizeLLMTasks(reply);
    if (!tasks?.length) return fallbackOnOffline ? offline() : { tasks: [], summary: emptySummary(), source: 'offline' };

    const summary = summarizeTasks(tasks);
    return { tasks, summary, source: 'llm' };
  } catch (e) {
    if (!fallbackOnOffline) throw e;
    return offline();
  }
}

/** 编排：有 AI key 时优先 LLM，否则离线（同步路径，返回 Promise） */
export async function parsePlanSmart(text, opts = {}) {
  if (opts.useLLM === false) return { ...parsePlanWithSummary(text), source: 'offline' };
  return parsePlanWithLLM(text, opts);
}

// ──────────────── LLM 输出归一化（容错） ────────────────

function emptySummary() {
  return { total: 0, byQuadrant: { Q1: 0, Q2: 0, Q3: 0, Q4: 0 }, byType: {}, estimatedTotalMinutes: 0, scheduledHours: [] };
}

const VALID_TYPES = ['review', 'pomodoro', 'doc', 'exam', 'note', 'write', 'other'];
const VALID_QUADS = ['Q1', 'Q2', 'Q3', 'Q4'];

function normalizeLLMTasks(reply) {
  if (!reply) return [];
  let arr;
  try {
    // 容错：剥离可能的 ```json 包裹
    const s = String(reply).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    arr = JSON.parse(s);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((t, i) => {
    const type = VALID_TYPES.includes(t.type) ? t.type : 'other';
    const quadrant = VALID_QUADS.includes(t.quadrant)
      ? t.quadrant
      : (t.important && t.urgent ? 'Q1' : t.important && !t.urgent ? 'Q2' : !t.important && t.urgent ? 'Q3' : 'Q4');
    const important = t.quadrant === 'Q1' || t.quadrant === 'Q2' || !!t.important;
    const urgent = t.quadrant === 'Q1' || t.quadrant === 'Q3' || !!t.urgent;
    const estimatedMinutes = Number.isFinite(t.estimatedMinutes) ? Number(t.estimatedMinutes) : null;
    let scheduledHour = Number.isFinite(t.scheduledHour) && t.scheduledHour >= 0 && t.scheduledHour <= 23
      ? Math.floor(t.scheduledHour) : null;
    // LLM 常漏掉口述里的「几点」时间，用离线规则从标题再抽取兜底
    if (scheduledHour == null) {
      const oh = extractHour(t.title);
      if (oh != null) scheduledHour = oh;
    }
    let subject = (typeof t.subject === 'string' && t.subject) ? t.subject : '';
    if (!subject) subject = inferSubject(t.title);
    let targetCount = Number.isFinite(t.targetCount) ? Number(t.targetCount) : null;
    if (targetCount == null) {
      const q = extractQuantity(t.title);
      if (q.targetCount != null) targetCount = q.targetCount;
    }
    const title = String(t.title || t.text || `任务${i + 1}`).slice(0, 120);
    return { title, type, important, urgent, quadrant, targetCount, estimatedMinutes, subject, scheduledHour };
  });
}

function summarizeTasks(tasks) {
  const byQuadrant = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
  const byType = {};
  let estimatedTotalMinutes = 0;
  const scheduledHours = [];
  for (const t of tasks) {
    byQuadrant[t.quadrant] = (byQuadrant[t.quadrant] || 0) + 1;
    byType[t.type] = (byType[t.type] || 0) + 1;
    if (t.estimatedMinutes) estimatedTotalMinutes += t.estimatedMinutes;
    if (t.scheduledHour != null) scheduledHours.push(t.scheduledHour);
  }
  return {
    total: tasks.length,
    byQuadrant,
    byType,
    estimatedTotalMinutes,
    scheduledHours: scheduledHours.sort((a, b) => a - b),
  };
}
