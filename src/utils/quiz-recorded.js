// src/utils/quiz-recorded.js
// AI 出题「记入复习」的**持久防重**（round82——修 round83 P3-2）。
//
// 为什么不能只用组件内的 `recorded` ref：组件卸载（切页 / 刷新 / 换对话）即丢失，
// 同一次生成的题目再次渲染时还能再点一次 → 对同一张卡重复 review(2)，
// 同日连续"记住了"会把稳定性虚增（掌握度注水）。
//
// 实现：localStorage 存一组键（cardId + 题干摘要），键的语义是"这道题已经被记过一次"。
// 环境无 localStorage（Node 测试 / 隐私模式）时退化为内存 Map，**绝不抛错**——
// 它只是防重优化，不能因为存储不可用就让「记入复习」失败。
const KEY_PREFIX = 'sxy_quiz_rec:';
const mem = new Set();

/** 稳定的存储后端（拿不到 localStorage 就用内存） */
function store() {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    // 探测可用性：隐私模式下 setItem 会抛
    ls.setItem(KEY_PREFIX + '__probe', '1');
    ls.removeItem(KEY_PREFIX + '__probe');
    return ls;
  } catch {
    return null;
  }
}

/** 题目身份：同一张卡的同一道题视为一条记录 */
export function quizRecordKey(cardId, question) {
  const q = String(question || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  return `${KEY_PREFIX}${String(cardId || '')}|${q}`;
}

export function isQuizRecorded(cardId, question) {
  const k = quizRecordKey(cardId, question);
  const ls = store();
  if (!ls) return mem.has(k);
  try { return ls.getItem(k) === '1'; } catch { return mem.has(k); }
}

export function markQuizRecorded(cardId, question) {
  const k = quizRecordKey(cardId, question);
  mem.add(k);
  const ls = store();
  if (!ls) return;
  try { ls.setItem(k, '1'); } catch { /* 配额/隐私模式：内存里已记，够用 */ }
}
