// 番茄专注「轮次」幂等：多标签页 / 多实例下，同一轮专注（同一 roundStartTs）只入账一次。
//
// 根因（round19 R19-1）：原去重仅靠每标签页独立的 lastPeerFinish + 5s BroadcastChannel
// 墙钟窗口。后台节流会使两个标签页的 finish() 间隔 > 5s，窗口击穿 → 同一轮专注被
// addPomoSession 双写（番茄数 / 成就 / 长休判定各 +2）。
//
// 修复：以 roundStartTs 派生稳定 roundId（两标签页读同一 localStorage 状态 → 同一
// roundId），用 localStorage 记录集做跨标签页幂等判重；BroadcastChannel 只作低延迟
// 同步（携带 rid 即时标记），不再依赖脆弱的 5s 时间窗。
const KEY = 'sxy_pomo_recorded';
// round33 E-3：容量 30 → 500。原 30 条在密集使用 + 异常重放（崩溃后恢复重复提交）时，
// 旧 rid 很快被挤出记录集 → isRoundRecorded 失忆 → 同一轮可能再次入账（极端双写）。
// 500 条约 15~20KB localStorage，可覆盖数月密集专注；即便极端溢出，淘汰窗口也远超
// 任何现实的异常重放时间跨度（幂等兜底仍由 roundId 派生保证）。
const MEM_CAP = 500;

// 无 localStorage 环境（node 测试）的兜底内存集
const mem = new Set();

function load() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) return arr;
  } catch {}
  return [];
}

function persist(arr) {
  const capped = arr.slice(-MEM_CAP);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(capped));
  } catch {}
  mem.clear();
  for (const x of capped) mem.add(x);
}

/** 由「真正开始时刻」派生稳定轮次 id（同轮专注跨标签页一致） */
export function makePomoRoundId(focusStartedAt) {
  return 'pomo-' + (focusStartedAt || 0);
}

/** 该轮次是否已入账（跨标签页共享） */
export function isRoundRecorded(rid) {
  if (!rid) return false;
  if (mem.has(rid)) return true;
  return load().includes(rid);
}

/** 标记某轮次已入账（去重 + 限长） */
export function markRoundRecorded(rid) {
  if (!rid) return;
  const arr = load().filter((x) => x !== rid);
  arr.push(rid);
  persist(arr);
}
