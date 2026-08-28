/**
 * 每日规划解析器（纯函数层，零 LLM）
 *
 * 把用户「口述」的自由文本解析为结构化任务数组：
 *   输入："复习 30 张卡片，最优先；番茄钟 25 分钟；看线代第三章讲义，重要"
 *   输出：[{ title, type, important, urgent, quadrant, targetCount, estimatedMinutes, subject }, ...]
 *
 * 解析规则（按优先级）：
 *   1) 分句：按换行 / 分号 / 中文句号 / 顿号（不含数字）切分成候选任务
 *   2) 动作分类：关键词 → type（review/pomodoro/doc/exam/note/other）
 *   3) 优先级：关键词 → important + urgent → 四象限（艾森豪威尔矩阵）
 *   4) 数量：数字 + 单位 → targetCount / estimatedMinutes
 *   5) 科目：科目词表 → subject
 *
 * 设计原则：
 *   - 纯函数，无 DOM/DB/网络，可 Node 测试
 *   - 容错优先：无法识别 → 保留原文本为 title + type=other + Q4
 *   - 确定性：相同输入 → 相同输出
 */

// ──────────────── 动作类型词表 ────────────────

const TYPE_RULES = [
  { type: 'review',   keywords: ['复习', '背', '卡片', '背诵', '记忆', 'anki', '复习卡', 'flashcard'] },
  { type: 'pomodoro', keywords: ['番茄', '专注', '计时', '番茄钟', 'pomodoro', '心流'] },
  { type: 'doc',      keywords: ['看', '读', '资料', '讲义', '真题', '书', 'pdf', '文档', '论文', '教材'] },
  { type: 'exam',     keywords: ['做题', '道题', '模考', '考试', '刷题', '试卷', '测验', '练习', '真题卷'] },
  { type: 'note',     keywords: ['笔记', '整理', '总结', '归纳', '错题本', '复盘', '梳理'] },
];

// ──────────────── 优先级词表 ────────────────

// 重要×紧急（Q1）
const Q1_WORDS = ['最优先', '很紧急', '最重要', '马上', '立刻', '立即', '紧急且重要', 'deadline', '必须今天', '今天必须', '首要'];
// 重要但不急（Q2）
const Q2_WORDS = ['重要', '要完成', '关键', '核心', '重点', '必做', '必须'];
// 紧急但不重要（Q3）
const Q3_WORDS = ['紧急', '急', '尽快', '快', '来不及'];
// 其余 → Q4（不重要不紧急，默认）

// ──────────────── 科目词表 ────────────────

const SUBJECT_RULES = [
  { subject: '计组',     keywords: ['计组', '计算机组成', '组成原理', '存储系统', 'cache', 'cpu', '408计组'] },
  { subject: '线代',     keywords: ['线代', '线性代数', '矩阵', '特征值', '方程组', '行列式', '向量'] },
  { subject: '编译原理', keywords: ['编译', '编译原理', '词法', '语法分析', '文法', 'll', 'lr'] },
  { subject: '系统概论', keywords: ['系统概论', '概论', '操作系统', 'os'] },
  { subject: '数据结构', keywords: ['数据结构', 'ds', '算法', '树', '图', '排序', '查找'] },
  { subject: '英语',     keywords: ['英语', '单词', '词汇', '阅读', '作文', '翻译', '长难句'] },
  { subject: '政治',     keywords: ['政治', '马原', '毛概', '史纲', '思修', '时政'] },
  { subject: '数学',     keywords: ['高数', '数学', '微积分', '概率', '统计', '数一', '数二', '数三'] },
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

  // 数量 + 张/题/个/条/节/章/篇/页 → targetCount
  const countRe = /(\d+(?:\.\d+)?)\s*(张|题|个|条|节|章|篇|页|套|组|遍|轮|次)/g;
  let m;
  while ((m = countRe.exec(s)) !== null) {
    const n = parseFloat(m[1]);
    // 第一个命中的数量单位作为 targetCount（复习/做题量）
    if (targetCount === null) targetCount = n;
  }

  // 数量 + 分钟/小时 → estimatedMinutes
  const timeRe = /(\d+(?:\.\d+)?)\s*(分钟|min|mins|小时|小时|h|hours?)/gi;
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
 * 分句：按换行 / 分号 / 中文句号 / 英文句号切分（保留非空片段）
 * 顿号不切（"复习30张、背20个单词" 可能是同一任务的并列，这里保守：顿号也切）
 * 逗号不切（同一任务描述）
 */
export function splitTasks(text) {
  if (!text) return [];
  return String(text)
    .split(/[\n\r;；。、]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

// ──────────────── 主解析 ────────────────

/**
 * 主入口：把口述文本解析为任务数组。
 * @param {string} text 用户口述文本
 * @returns {Array<{
 *   title, type, important, urgent, quadrant,
 *   targetCount, estimatedMinutes, subject
 * }>}
 */
export function parsePlan(text) {
  const segments = splitTasks(text);
  return segments.map(seg => {
    const q = inferQuadrant(seg);
    const { targetCount, estimatedMinutes } = extractQuantity(seg);
    const subject = inferSubject(seg);
    return {
      title: seg,
      type: inferType(seg),
      important: q.important,
      urgent: q.urgent,
      quadrant: q.quadrant,
      targetCount,
      estimatedMinutes,
      subject,
    };
  });
}

/**
 * 高层解析 + 统计汇总（供 UI 直接渲染）。
 * @returns {{ tasks, summary }}
 *   summary: { total, byQuadrant, byType, estimatedTotalMinutes }
 */
export function parsePlanWithSummary(text) {
  const tasks = parsePlan(text);
  const byQuadrant = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
  const byType = {};
  let estimatedTotalMinutes = 0;
  for (const t of tasks) {
    byQuadrant[t.quadrant] = (byQuadrant[t.quadrant] || 0) + 1;
    byType[t.type] = (byType[t.type] || 0) + 1;
    if (t.estimatedMinutes) estimatedTotalMinutes += t.estimatedMinutes;
  }
  return {
    tasks,
    summary: {
      total: tasks.length,
      byQuadrant,
      byType,
      estimatedTotalMinutes,
    },
  };
}
