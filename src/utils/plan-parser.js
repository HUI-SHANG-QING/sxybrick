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

  // 数量 + 张/题/个/条/节/章/篇/页/套/组/遍/轮/次/词 → targetCount
  const countRe = /(\d+(?:\.\d+)?)\s*(张|题|个|条|节|章|篇|页|套|组|遍|轮|次|词|篇作文|份)/g;
  let m;
  while ((m = countRe.exec(s)) !== null) {
    const n = parseFloat(m[1]);
    if (targetCount === null) targetCount = n;
  }

  // 数量 + 分钟/小时 → estimatedMinutes
  // 注意：不用 \b（中文字符后无词边界）；用负向先行断言避免 'h' 误匹配英文单词
  const timeRe = /(\d+(?:\.\d+)?)\s*(分钟|min|mins|小时|hours?|h)(?![a-z\u4e00-\u9fff])/gi;
  timeRe.lastIndex = 0;
  let tm;
  while ((tm = timeRe.exec(s)) !== null) {
    let mins = parseFloat(tm[1]);
    const unit = tm[2].toLowerCase();
    if (unit === 'h' || unit === 'hours' || unit === 'hour' || unit === '小时') mins *= 60;
    if (estimatedMinutes === null) estimatedMinutes = Math.round(mins);
  }

  return { targetCount, estimatedMinutes };
}

/**
 * 提取计划时间（24h 制小时数，便于日程时间轴渲染）。
 *   "早上8点"   → 8
 *   "下午3点"   → 15
 *   "晚上10点"  → 22
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
    let h = parseInt(m[1], 10);
    // 12 小时制 + 时段前缀
    if (/(下午|傍晚|晚上|晚|pm)/i.test(s) && h <= 12) h += 12;
    if (h >= 0 && h <= 23) return h;
  }

  // "HH 点"（无分）
  m = s.match(/(\d{1,2})\s*点/);
  if (m) {
    let h = parseInt(m[1], 10);
    if (/(下午|傍晚|晚上|晚|pm)/i.test(s) && h <= 12) h += 12;
    if (h >= 0 && h <= 23) return h;
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

/** 优先级 → 四象限 */
export function inferQuadrant(text) {
  const s = String(text || '');
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
 * 逗号不切（同一任务描述）
 */
export function splitTasks(text) {
  if (!text) return [];
  return String(text)
    .split(/[\n\r;；。、]+/)
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
