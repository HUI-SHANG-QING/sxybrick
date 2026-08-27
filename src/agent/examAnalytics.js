// P2-4 模考分析与预测：成绩趋势、薄弱知识点、通过率预估
// 数据源：exams 表（{title, subject, questions:[{cardId, front, back, user, cov, correct}], score, total, createdAt}）
// 纯函数、零依赖、主线程计算（数据量通常 <100 场，无需 worker）
//
// 认知科学/统计依据：
//   - 通过率预估：近期成绩加权移动平均 + 线性回归斜率（近期权重高，反映学习进步）
//   - 薄弱科目：按科目统计错题率，错题率 >40% 标记为薄弱
//   - 知识点预测：把高频错题的 cardId 聚合，提示需要重点复习

/**
 * 成绩趋势：按时间升序的正确率序列 + 线性回归斜率（预测进步/退步）
 * @param {Array} exams exams 表全量
 * @returns {{ points: [{date, rate, score, total}], slope, trend: 'up'|'down'|'flat', avg, latest }}
 */
export function getExamTrend(exams) {
  if (!Array.isArray(exams) || !exams.length) {
    return { points: [], slope: 0, trend: 'flat', avg: 0, latest: 0 };
  }
  const sorted = [...exams].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const points = sorted.map(ex => ({
    date: new Date(ex.createdAt || 0).toLocaleDateString(),
    rate: ex.total ? Math.round((ex.score / ex.total) * 100) : 0,
    score: ex.score || 0,
    total: ex.total || 0,
  }));
  const rates = points.map(p => p.rate);
  const avg = rates.length ? Math.round(rates.reduce((s, r) => s + r, 0) / rates.length) : 0;
  // 线性回归斜率（最小二乘）：y = rate, x = index
  const n = rates.length;
  let slope = 0;
  if (n >= 2) {
    const xs = rates.map((_, i) => i);
    const meanX = xs.reduce((s, x) => s + x, 0) / n;
    const meanY = rates.reduce((s, r) => s + r, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - meanX) * (rates[i] - meanY); den += (xs[i] - meanX) ** 2; }
    slope = den ? num / den : 0;
  }
  const trend = slope > 2 ? 'up' : slope < -2 ? 'down' : 'flat';
  return { points, slope: +slope.toFixed(2), trend, avg, latest: rates[rates.length - 1] || 0 };
}

/**
 * 薄弱科目分析：按科目统计错题率，返回按薄弱程度排序的科目列表
 * @param {Array} exams
 * @returns {Array} [{ subject, total, wrong, wrongRate, weak }] 按 wrongRate 降序
 */
export function getWeakSubjects(exams) {
  if (!Array.isArray(exams) || !exams.length) return [];
  const map = new Map(); // subject → { total, wrong }
  for (const ex of exams) {
    const subject = ex.subject || '综合';
    if (!map.has(subject)) map.set(subject, { total: 0, wrong: 0 });
    const s = map.get(subject);
    for (const q of (ex.questions || [])) {
      s.total++;
      if (!q.correct) s.wrong++;
    }
  }
  const arr = [...map.entries()].map(([subject, v]) => ({
    subject,
    total: v.total,
    wrong: v.wrong,
    wrongRate: v.total ? Math.round((v.wrong / v.total) * 100) : 0,
    weak: v.total ? (v.wrong / v.total) >= 0.4 : false,
  }));
  return arr.sort((a, b) => b.wrongRate - a.wrongRate);
}

/**
 * 通过率预估：基于近期成绩加权移动平均 + 趋势调整
 * 假设考试通过线 = 60%（可配置）
 * @param {Array} exams
 * @param {object} opts { passLine: 60, recentN: 5 } recentN=取最近几场加权
 * @returns {{ predictedRate, passLine, willPass, confidence, reasons: [] }}
 */
export function predictPassRate(exams, opts = {}) {
  const passLine = opts.passLine ?? 60;
  const recentN = Math.max(1, opts.recentN ?? 5);
  if (!Array.isArray(exams) || !exams.length) {
    return { predictedRate: 0, passLine, willPass: false, confidence: 0, reasons: ['暂无模考数据'] };
  }
  const trend = getExamTrend(exams);
  const recent = trend.points.slice(-recentN);
  // 加权移动平均：最近一场权重最高
  let weighted = 0, totalW = 0;
  for (let i = 0; i < recent.length; i++) {
    const w = i + 1; // 越近权重越高
    weighted += recent[i].rate * w;
    totalW += w;
  }
  const movingAvg = totalW ? Math.round(weighted / totalW) : 0;
  // 趋势调整：斜率 >0 加分，<0 减分（限制 ±5 分）
  const trendAdj = Math.max(-5, Math.min(5, trend.slope * 2));
  const predictedRate = Math.max(0, Math.min(100, Math.round(movingAvg + trendAdj)));
  const willPass = predictedRate >= passLine;
  // 置信度：样本量 + 趋势稳定性
  const sampleConfidence = Math.min(1, recent.length / recentN);
  const variance = recent.length > 1
    ? Math.sqrt(recent.reduce((s, p) => s + (p.rate - movingAvg) ** 2, 0) / recent.length)
    : 0;
  const stabilityConfidence = Math.max(0, 1 - variance / 30); // 方差越小越稳
  const confidence = Math.round((sampleConfidence * 0.5 + stabilityConfidence * 0.5) * 100);
  // 原因解释
  const reasons = [];
  reasons.push(`近期 ${recent.length} 场加权平均 ${movingAvg}%`);
  if (trend.trend === 'up') reasons.push(`成绩上升趋势（斜率 +${trend.slope}）`);
  else if (trend.trend === 'down') reasons.push(`成绩下降趋势（斜率 ${trend.slope}）`);
  else reasons.push('成绩平稳');
  if (variance > 15) reasons.push(`成绩波动大（标准差 ${variance.toFixed(1)}）`);
  if (predictedRate < passLine) reasons.push(`低于通过线 ${passLine}%，需重点复习`);
  return { predictedRate, passLine, willPass, confidence, reasons, trend: trend.trend };
}
