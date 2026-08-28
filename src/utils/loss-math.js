/**
 * 损失量化（纯函数层）
 *
 * 设计意图（来自研究结论：friendly nudges 对拖延几乎没用 —— 必须 small friction/negative affect）：
 *  所有提示都必须「明确量化损失」，不给温和鼓励。提示语气从「您已经有 5 张卡片待复习了」
 *  改为「你今日最低复习 N 张，差 1 张 = 落后计划 0.5 张，距考试 X 天，每天必须做 1.4 张才能追上」。
 *
 * 输入 data：
 *  - dueCount       今日到期待复习卡片数
 *  - overdueCount   超期未复习卡片数（dueAt + 1天）
 *  - daysSinceStudy 自上次启动番茄钟或完成复习的天数（Infinity = 从未）
 *  - weekReviews    本周累计复习数
 *  - weekGoal       本周复习目标数（默认 100，可从 config 读）
 *  - daysToExam     距考试天数
 *  - subject        当前科目（可选）
 *
 * 输出：
 *  - severity: 'none' | 'info' | 'warn' | 'critical'
 *  - level: number 0..1（用于组件进度条动画）
 *  - headline: 文案（用真实数字 + 量化损失）
 *  - daysCatchUp: 每天必须复习数（追上计划所需）
 *  - isBehind: 是否落后于计划
 */

const APP_LOSS_META = { schema: 1, source: 'SxyBrick/loss-math' };

/**
 * @param {object} stats
 * @param {number} [stats.dueCount=0]
 * @param {number} [stats.overdueCount=0]
 * @param {number} [stats.daysSinceStudy=0]
 * @param {number} [stats.weekReviews=0]
 * @param {number} [stats.weekGoal=100]
 * @param {number} [stats.daysToExam=90]
 * @param {string} [stats.subject='']
 */
export function computeLoss(stats = {}) {
  const {
    dueCount = 0,
    overdueCount = 0,
    daysSinceStudy = 0,
    weekReviews = 0,
    weekGoal = 100,
    daysToExam = 90,
    subject = '',
  } = stats;

  // 计算每周进度 (-1..1+)，>0 表示超前，<0 表示落后
  // 假设现在是 weekGoal 周的中点（weekGoal/7 * (今天在周中的位置）），简化用累计比
  const weekProgress = weekGoal > 0 ? weekReviews / weekGoal - 0.5 : 0; // -0.5 当周刚开始
  const isBehind = weekReviews < weekGoal;

  // 紧迫度打分：基于四个维度，0..1
  // - dueCount 权重最高（用户最直接反馈）：>20 接近满
  // - overdueCount：高权重
  // - daysSinceStudy：>3 直接 1
  // - daysToExam 反比：越小越紧
  const dueScore = Math.min(1, dueCount / 30);                   // 30 张满
  const overdueScore = Math.min(1, overdueCount / 10);           // 10 张满
  const dormantScore = Math.min(1, Math.max(0, daysSinceStudy) / 5); // 5 天未学满
  const examScore = Math.max(0, Math.min(1, (45 - daysToExam) / 45)); // 45 天内逐渐紧张
  const severityScore = Math.min(1, dueScore * 0.45 + overdueScore * 0.3 + dormantScore * 0.15 + examScore * 0.1);

  let severity = 'none';
  if (severityScore >= 0.7) severity = 'critical';
  else if (severityScore >= 0.4) severity = 'warn';
  else if (severityScore > 0) severity = 'info';

  // 量化「每天必须复习多少张」才能追上本周目标
  // （weekGoal - weekReviews）/ 7，每周 7 天（粗略）
  const remaining = Math.max(0, weekGoal - weekReviews);
  const daysPerWeek = 7;
  const dailyCatchUp = Math.ceil(remaining / daysPerWeek);

  // 文案生成：四档紧迫度对应不同语气
  const subj = subject ? `（${subject}）` : '';
  const headline = (() => {
    if (severity === 'critical') {
      // critical：必须立刻动手
      const bits = [];
      if (dueCount > 0) bits.push(`你有 ${dueCount} 张待复习${subj}，其中 ${overdueCount} 张已经逾期`);
      if (daysSinceStudy >= 2) bits.push(`已 ${daysSinceStudy} 天没学`);
      if (isBehind && dailyCatchUp > 0) bits.push(`每天必须复习 ${dailyCatchUp} 张才能追上`);
      if (daysToExam > 0 && daysToExam <= 45) bits.push(`距考 ${daysToExam} 天`);
      return bits.length ? `⚠️ 危机：你正在被复习账单追讨 — ${bits.join('，')}` : '⚠️ 你的学习状态需要立刻调整';
    }
    if (severity === 'warn') {
      const bits = [];
      if (dueCount > 0) bits.push(`今日 ${dueCount} 张待复习`);
      if (overdueCount > 0) bits.push(`${overdueCount} 张逾期`);
      if (isBehind && dailyCatchUp > 0) bits.push(`本周每天需补 ${dailyCatchUp} 张`);
      return `📉 落后计划：${bits.join('，')}`;
    }
    if (severity === 'info') {
      return dueCount > 0
        ? `📚 今日 ${dueCount} 张待复习${subj}（保持节奏即可）`
        : `✓ 状态正常：暂无逾期${subj}`;
    }
    return `✓ 状态正常${subj}`;
  })();

  // how-to 钩子：推荐 openGraphReview / openDocs 这个具体动作
  const recommendations = [];
  if (overdueCount > 0 && subject) {
    recommendations.push(`先做「${subject}」的逾期卡片：错误模式会反复（同一章节错过 2 次要警惕）`);
  }
  if (dueCount >= 10) {
    recommendations.push('打开番茄钟 25 分钟专注背诵，分 3-4 组完成今天的量');
  }

  return {
    ...APP_LOSS_META,
    severity,
    severityScore: Number(severityScore.toFixed(3)),
    level: severityScore,
    dueCount,
    overdueCount,
    daysSinceStudy,
    weekReviews,
    weekGoal,
    weekProgress: Number(weekProgress.toFixed(3)),
    isBehind,
    daysToExam,
    daysCatchUp: dailyCatchUp,
    headline,
    recommendations,
    hasLoss: severityScore > 0 || dueCount > 0 || overdueCount > 0,
  };
}

/**
 * 简化版：仅给一个文案的快捷接口（用于 lossBar 顶部）
 */
export function lossHeadline(stats) {
  return computeLoss(stats).headline;
}

/**
 * 多少个今天复习中应该暂停并强制评估（用于紧迫感弹窗触发判断）
 *  触发条件：连续 N 天未启动番茄钟 OR 累计 due 卡片 > 阈值
 */
export function shouldShowHardIntervention(stats, thresholds = {}) {
  const {
    dormantDaysTrigger = 2,        // 默认 2 天未启动就触发
    dueCountTrigger = 30,          // 默认累计 30 张 due 触发
  } = thresholds;
  if ((stats.daysSinceStudy || 0) >= dormantDaysTrigger) {
    return { trigger: true, reason: `已 ${stats.daysSinceStudy} 天未启动复习` };
  }
  if ((stats.dueCount || 0) >= dueCountTrigger) {
    return { trigger: true, reason: `累计 ${stats.dueCount} 张待复习（超过阈值 ${dueCountTrigger}）` };
  }
  return { trigger: false, reason: '' };
}

/**
 * 把毫秒时间戳格式化为「X 天前」(纯函数)
 *  ts 缺失/无效返回 0；未来时间戳返回 0（不出负数）
 */
export function daysSince(ts, nowMs = Date.now()) {
  if (ts == null) return 0;
  const n = Math.floor((nowMs - Number(ts)) / 86400000);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}
