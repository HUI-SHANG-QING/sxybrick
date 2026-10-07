// 本文件由 repo.js 物理拆分而来（方案 A：**只搬移、不改任何逻辑**）。
// 业务域：每日计划与任务（仅依赖 cards，单向）
// 依赖方向：本文件 → ./cards.js → db.js|srs.js|...（单向；**禁止反向 import 以免成环**）
// 5 个模块级缓存变量（_schedCache/_dashSnap/_dashLoading/_failCountCache/_failCountForced）
// 与其读写函数同处 cards.js —— 缓存绝不分裂。

// 数据访问层：把原版 Express 后端的业务逻辑，改写成对本地 IndexedDB 的读写
import { db, uid } from '../db.js';
import { RETRIEVAL_STRENGTH_OPTIONS } from '../srs.js';
// P3-4 插件事件钩子：业务动作后向已启用插件分发（fire-and-forget，不阻塞也不抛错）
// 静态导入无循环依赖：plugins/registry 只依赖 db.js 与 agent/registry.js，不依赖 repo.js
// P1-3 检索强度分级选项：供 Review.vue 等 UI 直接渲染选择器
export { RETRIEVAL_STRENGTH_OPTIONS };
// D3.1 笔记解析纯函数（双向链接 + 标签抽取 + 归一化）
// P1-18 统一格式化（日期补零 / 字节）收口到 format.js，消除全局重复实现
// 审计 D7：日期 key 统一走 time.dateKey（补零 yyyy-MM-dd），与 word/streak 同源，
// 否则 repo 本地一份 localDateStr 独立实现会在未来格式演进时跨表整日错位。
import { dateKey as createDateKey } from '../utils/time.js';
// 向量行 id 的确定性形态与前缀匹配（agent/embedding-key.js 无任何依赖，静态导入不成环）
// N9 纯函数层：校验/过滤/排序/统计逻辑抽至 repo-core.js（Node 可单测），repo.js 只做 IO 编排
import { DEFAULT_SUBJECTS, validateCard as _validateCard, gradeCard as _gradeCard, WRONG_REASON_MAP as _WRONG_REASON_MAP, WRONG_REASONS as _WRONG_REASONS, wrongReasonToCode as _wrongReasonToCode, formatDue as _formatDue, dayWindowOf } from '../repo-core.js';
export { DEFAULT_SUBJECTS };
import { triggerHook } from '../plugins/registry.js';
import { trashItem } from './cards.js';

// fireHook 原是 repo.js 的**模块私有**函数（原文件无 export），拆到 cards.js 后
// plans.js 无法 import —— 它是 3 行纯分发、无状态（fire-and-forget + 吞错），
// 按原样内联一份（逐字一致，不改行为）。
function fireHook(event, ...args) {
  triggerHook(event, ...args).catch(() => {});
}

// 以下定义原为 repo.js 顶层，被本模块引用 —— 搬移时复制一份（纯常量/纯函数，无状态）：
const MAX_ESTIMATED_MINUTES = 1440;
const now = () => Date.now();
const plain = (x) => JSON.parse(JSON.stringify(x));
const localDateStr = (d) => createDateKey(d ? new Date(d).getTime() : undefined);
function clampEstimatedMinutes(v) {
  if (!Number.isFinite(v) || v < 0) return null;
  if (v === 0) return 0;
  return Math.min(MAX_ESTIMATED_MINUTES, Math.round(v));
}

/**
 * 排程时刻（0-23）归一化 —— **全仓唯一一份**（数据层 3 条写路径 + AI 工具层 4 处读/写映射共用）。
 *
 * round82：首次收口（此前 updateDailyTask 里有一份内联副本，createDailyPlan 与 addDailyTask
 *          两条写路径**都没有**）——「同一字段两套规则」。
 * round85：二次收口到工具层。那里另有 4 处 `Number.isFinite(Number(v)) ? Number(v) : null`，
 *          而 **`Number(null) === 0` 且 `Number.isFinite(0) === true`** → 库里明明是 null
 *          （「没排时段」），上报给模型却成了 0 → 模型会对用户说「已安排 0 点」，
 *          list_daily_tasks 同病。这正是铁律里 `Number(x) || 默认值` 的孪生陷阱：
 *          一个吞掉显式 0，一个把 null 变成 0。
 *
 * 语义（与 sync-manifest 的 dailyTasks 域校验对齐：**存进去的必须是 number 或 null**）：
 *   - 合法 → [0,23] 的整数（允许数字串 '9' → 9，规范化后正好满足同步域）
 *   - 其余 → null（null / undefined / '' / NaN / Infinity / 'abc' / '9:00' / 布尔 / 对象 / 数组）
 * 两个必须显式挡住的坑：
 *   ① `Number('') === 0` —— 空串是「没填」，不是「0 点」，所以先 trim 再判空；
 *   ② `Number([]) === 0` —— 只接受 number / string，其余类型一律 null（免得对象被强制成 0）。
 * 为什么非得钳：调用方（AI 工具 / 手动编辑）可能传 25 / -1 / 99.7，不钳会渲染出「25:00」、
 * 四象限时段排布错乱；而同步入口的域校验只管**导入**，管不到本地这几条写路径。
 */
export function clampScheduledHour(v) {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const raw = typeof v === 'string' ? v.trim() : v;
  if (raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(23, Math.floor(n)));
}

// 审计 C1/C4：跨设备时钟与同毫秒覆盖主要通过「确定性决胜 + 严格比较」在 sync-manifest
// 的纯合并函数里根治（mergeCardPair/mergeTombstones 已改 `>` + 字典序收敛）。
// 此处 now() 保持墙钟即可——在整进程内混用「单调时钟」与多处裸 Date.now() 会破坏
// deleteCard/restoreFromTrash 等既有「updatedAt 必须晚于墓碑」的不变量，得不偿失。
// 完整跨设备时钟偏置免疫需 per-epoch（ts,uuid）元组，属更大改造，未在此次混入。
export async function createDailyPlan(payload) {
  const rawInput = String(payload?.rawInput || '').trim();
  if (!rawInput) throw new Error('请输入今日规划内容');
  const date = payload?.date || localDateStr();
  const t = now();

  // 优先使用调用方解析好的任务（预览一致），否则离线解析。
  // 解析是纯计算且含动态 import，必须在 Dexie 事务外完成（事务 Zone 内不能 await 非库 promise）。
  let parsed = Array.isArray(payload.tasks) && payload.tasks.length ? payload.tasks : null;
  if (!parsed) {
    const { parsePlan } = await import('../utils/plan-parser.js');
    parsed = parsePlan(rawInput);
  }
  const planId = uid();
  const tasks = parsed.map(task => ({
    id: uid(),
    planId,
    date,
    // 审计 P3（round37）：调用方传的是 preview.value.tasks（ref 深响应式 → 元素/嵌套
    // 字段可能是 Proxy）。对象字面量只做浅展开，嵌套子对象仍是 Proxy，落 IndexedDB 时
    // structuredClone 会抛 DataCloneError。JSON 往返剥壳（任务为纯 JSON，无 Blob/Date）。
    ...JSON.parse(JSON.stringify(task || {})),
    // round82：放在展开**之后**——无论来自解析器还是调用方（如 AI 工具传入的 draft），
    // 这两个字段都必须守同一套边界（此前只有 addDailyTask/updateDailyTask 部分覆盖）。
    estimatedMinutes: clampEstimatedMinutes(task?.estimatedMinutes),
    scheduledHour: clampScheduledHour(task?.scheduledHour),
    status: 'pending',
    completedAt: null,
    completionNote: '',
    createdAt: t, updatedAt: t,
  }));
  const plan = { id: planId, date, rawInput, status: 'active', createdAt: t, updatedAt: t };

  // 覆盖重建 + 新建全部包进单个事务（round15 P1：任一步失败整体回滚，
  // 杜绝「旧计划已清空但新计划未建成」的半残态——此前逐条删除无事务保护）
  // 审计 P3-3（round36）：覆盖重建同样先存回收站快照——旧口径只有显式删除
  // （deleteDailyPlan）进回收站，「重新规划」覆盖掉的旧计划无法找回。
  // 快照含计划+全部任务，恢复路径与删除共用 kind='dailyPlan'。
  await db.transaction('rw', db.dailyPlans, db.dailyTasks, db.tombstones, db.trash, async () => {
    const existing = await db.dailyPlans.where('date').equals(date).toArray();
    for (const p of existing) {
      const oldTasks = await db.dailyTasks.where('planId').equals(p.id).toArray();
      await trashItem(p.id, 'dailyPlan', { ...plain(p), _tasks: oldTasks });
      // 级联删任务必须逐条写墓碑，否则对端会把旧任务推回来、与新计划混在一起
      await cascadeDeletePlanTasks(p.id, t);
      await db.dailyPlans.delete(p.id);
      await db.tombstones.put({ id: p.id, kind: 'dailyPlan', deletedAt: t });
    }
    await db.dailyPlans.put(plan);
    if (tasks.length) await db.dailyTasks.bulkPut(tasks);
  });
  fireHook('onDailyPlanSaved', { plan, tasks });
  return { plan, tasks };
}

/** 今天的日期串 YYYY-MM-DD（本地时区）——统一委托 time.dateKey，见顶部 D7 注释 */
export async function listDailyPlan(date = localDateStr()) {
  const plans = await db.dailyPlans.where('date').equals(date).toArray();
  if (!plans.length) return null;
  plans.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const plan = plans[0];
  const tasks = await db.dailyTasks.where('planId').equals(plan.id).toArray();
  return { plan, tasks };
}

/** 列出最近 N 天（含今天）的计划头（历史趋势用） */
export async function listDailyPlans(limit = 30) {
  return db.dailyPlans.orderBy('date').reverse().limit(limit).toArray();
}

/**
 * 最近 N 天计划摘要（按日期合并去重，历史回溯/热力图用）。
 * 同一天多份计划合并 total/done，取最新 updatedAt 排序。
 * @param {number} [days=30]
 * @returns {Array<{ date, total, done, updatedAt }>}
 */
export async function listDailyPlanSummary(days = 30) {
  const plans = await db.dailyPlans.orderBy('date').reverse().limit(days * 3).toArray();
  const byDate = new Map();
  // BUG-09：循环内逐 plan 串行查 dailyTasks = N 次索引查询（N 可达 90）。
  // 改 anyOf 一次批量拉取后按 planId 分组，查询次数从 O(N) 降到 O(1)。
  const planIds = plans.map((p) => p.id);
  const allTasks = planIds.length
    ? await db.dailyTasks.where('planId').anyOf(planIds).toArray()
    : [];
  const tasksByPlan = new Map();
  for (const t of allTasks) {
    const arr = tasksByPlan.get(t.planId) || [];
    arr.push(t);
    tasksByPlan.set(t.planId, arr);
  }
  for (const p of plans) {
    const tasks = tasksByPlan.get(p.id) || [];
    const cur = byDate.get(p.date) || { date: p.date, total: 0, done: 0, updatedAt: 0 };
    cur.total += tasks.length;
    cur.done += tasks.filter(t => t.status === 'done').length;
    cur.updatedAt = Math.max(cur.updatedAt, p.updatedAt || 0);
    byDate.set(p.date, cur);
  }
  return [...byDate.values()]
    .sort((a, b) => (b.updatedAt - a.updatedAt) || (a.date < b.date ? 1 : -1))
    .slice(0, days);
}

/** 更新任务（中途调整：加/删/改象限/打卡） */
export async function updateDailyTask(id, patch) {
  // round17 R17-29：读-改-写包进事务（防并发打卡/编辑互相覆盖 = lost update，
  // 兄弟函数 checkinDailyTask 已事务化，此路径是漏网）+ patch 脱壳（调用方可能传
  // Vue reactive 对象，直接展开落库会触发 Dexie structuredClone 的 DataCloneError）
  // 审计 B5：补上与 checkinDailyTask 同款的状态白名单——原实现直接合并 patch，调用方
  // 可写入任意 status 值（如 'any-invalid'），listDailyPlanSummary 只认 'done'，非法值
  // 既不算完成也不算打卡 → 幽灵任务。同时统一维护 completedAt 语义。
  const p = patch ? plain(patch) : {};
  if (p.status !== undefined) {
    const valid = ['done', 'partial', 'skipped', 'pending'];
    if (!valid.includes(p.status)) throw new Error('非法打卡状态');
    // 统一 completedAt：只有 'done' 才带完成时刻，其余清空（与 checkinDailyTask 同口径）
    p.completedAt = p.status === 'done' ? now() : null;
  }
  // round30 P2-7：更新路径同样 clamp 时长与排程时刻（解析层已 clamp scheduledHour，
  // 但手动编辑走更新路径，需在此兜底，否则超大 estimatedMinutes 会污染联动分析与同步）。
  if (p.estimatedMinutes !== undefined) p.estimatedMinutes = clampEstimatedMinutes(p.estimatedMinutes);
  if (p.scheduledHour !== undefined) p.scheduledHour = clampScheduledHour(p.scheduledHour);
  let task;
  await db.transaction('rw', db.dailyTasks, async () => {
    const old = await db.dailyTasks.get(id);
    if (!old) throw new Error('任务不存在');
    task = { ...old, ...p, updatedAt: now() };
    await db.dailyTasks.put(task);
  });
  return task;
}

/** 删除任务 */
export async function deleteDailyTask(id) {
  // round15 P2：delete + 墓碑包进同一事务——此前无事务，墓碑写失败时对端无墓碑
  // 会把已删任务推回，删除永不生效。
  await db.transaction('rw', db.dailyTasks, db.tombstones, async () => {
    await db.dailyTasks.delete(id);
    await db.tombstones.put({ id, kind: 'dailyTask', deletedAt: now() });
  });
}

/**
 * 中途追加任务到现有当日计划（口述/手动添加均可）。
 * @param {string} planId 关联的 dailyPlans.id
 * @param {object} task 任务字段（title/type/quadrant/...），缺省字段会被填默认值
 */
export async function addDailyTask(planId, task = {}) {
  const plan = await db.dailyPlans.get(planId);
  if (!plan) throw new Error('当日计划不存在，请先创建计划');
  const t = now();
  const row = {
    id: uid(),
    planId,
    date: plan.date,
    title: String(task.title || '新任务').slice(0, 200),
    type: task.type || 'other',
    important: !!task.important,
    urgent: !!task.urgent,
    quadrant: task.quadrant || 'Q4',
    targetCount: Number.isFinite(task.targetCount) ? Number(task.targetCount) : null,
    estimatedMinutes: clampEstimatedMinutes(task.estimatedMinutes),
    subject: task.subject || '',
    scheduledHour: clampScheduledHour(task.scheduledHour),
    status: 'pending',
    completedAt: null,
    completionNote: '',
    createdAt: t, updatedAt: t,
  };
  await db.dailyTasks.put(row);
  // 同步更新计划头的 updatedAt（便于跨设备同步）
  await db.dailyPlans.put({ ...plan, updatedAt: t });
  fireHook('onDailyTaskAdded', row);
  return row;
}

/** 把口述文本解析后批量追加到现有当日计划（中途补充） */
export async function appendDailyTasksByText(planId, text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const { parsePlan } = await import('../utils/plan-parser.js');
  const parsed = parsePlan(raw);
  const rows = [];
  for (const p of parsed) rows.push(await addDailyTask(planId, p));
  return rows;
}

/**
 * 级联删除某计划下的全部任务，并为每一行写 dailyTask 墓碑。
 * 只删行不写墓碑的话，对端设备下次同步会把这些任务原样推回来（删除永不生效）。
 * @returns {Promise<number>} 删除的任务数
 */
async function cascadeDeletePlanTasks(planId, ts = now()) {
  const tasks = await db.dailyTasks.where('planId').equals(planId).toArray();
  if (!tasks.length) return 0;
  await db.dailyTasks.where('planId').equals(planId).delete();
  await db.tombstones.bulkPut(tasks.map(x => ({ id: x.id, kind: 'dailyTask', deletedAt: ts })));
  return tasks.length;
}

/** 删除整日计划 + 其任务（联级） */
export async function deleteDailyPlan(planId) {
  const t = now();
  // 审计（round35 小问题1）：删前存回收站快照——此前 deleteDailyPlan 只写墓碑不存 trash，
  // 用户误删后回收站里找不到、无法恢复。与 deletePlan/deleteCard 同口径：快照含计划+任务，
  // 恢复路径按 kind='dailyPlan' 还原 dailyPlans+dailyTasks。
  const plan = await db.dailyPlans.get(planId);
  if (!plan) return;
  const tasks = await db.dailyTasks.where('planId').equals(planId).toArray();
  // round17 R17-10：删计划 + 级联删任务 + 双墓碑包进同一事务（createDailyPlan:606 已事务化，
  // 删除路径此前漏了同款）——中途任一步异常会留下「计划没了但任务/墓碑残留」的孤儿数据，
  // 且墓碑缺失会让对端同步把已删任务推回
  await db.transaction('rw', db.dailyPlans, db.dailyTasks, db.tombstones, db.trash, async () => {
    await trashItem(planId, 'dailyPlan', { ...plain(plan), _tasks: tasks });
    await cascadeDeletePlanTasks(planId, t);
    await db.dailyPlans.delete(planId);
    await db.tombstones.put({ id: planId, kind: 'dailyPlan', deletedAt: t });
  });
}

/**
 * 任务打卡：设置状态 + 完成时间 + 备注。
 * @param {string} taskId
 * @param {'done'|'partial'|'skipped'|'pending'} status
 * @param {string} note 备注
 */
export async function checkinDailyTask(taskId, status = 'done', note = '') {
  return db.transaction('rw', db.dailyTasks, async () => {
    const old = await db.dailyTasks.get(taskId);
    if (!old) throw new Error('任务不存在');
    const valid = ['done', 'partial', 'skipped', 'pending'];
    if (!valid.includes(status)) throw new Error('非法打卡状态');
    const task = {
      ...old,
      status,
      completedAt: status === 'done' ? now() : null,
      completionNote: note,
      updatedAt: now(),
    };
    await db.dailyTasks.put(task);
    fireHook('onDailyTaskCheckin', task);
    return task;
  });
}

// ───────────── 跨模块协同（D8.4）：打卡时拉真实数据 ─────────────

/**
 * 拉取某天的真实学习数据，用于任务打卡时对比。
 * @returns {{
 *   reviewsToday: number,          // 今日复习次数
 *   pomodoroMinutes: number,       // 今日番茄分钟
 *   docsToday: number,             // 今日新建/阅读资料数
 * }}
 */
export async function getDailyReality(date = localDateStr()) {
  // 审计 B3：窗口统一走 repo-core.dayWindowOf（左闭右开），与 computeStats 同一口径
  const { start: dayStart, end: dayEnd } = dayWindowOf(new Date(`${date}T00:00:00`).getTime());

  // 今日复习数（reviews 表）
  let reviewsToday = 0;
  try {
    // 左闭右开：与 dayWindowOf 一致（此前 end 取闭区间会把次日 00:00:00 整点那条算进来）
    reviewsToday = await db.reviews.where('reviewedAt').between(dayStart, dayEnd, true, false).filter(r => r.type !== 'quick').count();
  } catch { reviewsToday = 0; }

  // 今日番茄分钟（pomoSessions 表）
  let pomodoroMinutes = 0;
  try {
    const sessions = await db.pomoSessions.where('startedAt').between(dayStart, dayEnd, true, true).toArray();
    // round17 R17-1：pomoSessions 的字段是 duration（单位：分钟，见 addPomoSession），
    // 此前误读 durationMs 并再 ÷60000 —— 该字段根本不存在，专注分钟恒为 0。
    // 与 analytics.js:144 / intelligence.js / WeeklyReport 的已有口径对齐。
    pomodoroMinutes = Math.round(sessions.reduce((s, x) => s + (x?.duration || 0), 0));
  } catch { pomodoroMinutes = 0; }

  // 今日新建资料（docFiles 表，createdAt）
  let docsToday = 0;
  try {
    docsToday = await db.docFiles.where('createdAt').between(dayStart, dayEnd, true, true).count();
  } catch { docsToday = 0; }

  return { reviewsToday, pomodoroMinutes, docsToday };
}

// ───────────── 笔记（D3.1：完整笔记系统，区别于 memos 四象限短备忘） ─────────────

/**
 * 列表（按 updatedAt 倒序），支持 q 关键词、category、tags 过滤
 */
// ---------- 学习计划（可持久化、随数据包同步） ----------
export async function listPlans() {
  return db.plans.orderBy('updatedAt').reverse().toArray();
}
export async function createPlan(payload) {
  const title = String(payload?.title || '').trim() || '未命名计划';
  const content = String(payload?.content || '').trim();
  const t = now();
  const p = {
    id: uid(), title, content,
    status: ['active', 'done', 'archived'].includes(payload?.status) ? payload.status : 'active',
    createdAt: t, updatedAt: t,
    // round34 H1：fieldTs 初始化（计划可编辑字段 title/content/status）
    fieldTs: { title: t, content: t, status: t },
  };
  await db.plans.put(p);
  return p;
}
export async function updatePlan(id, patch) {
  return db.transaction('rw', db.plans, async () => {
    const old = await db.plans.get(id);
    if (!old) throw new Error('计划不存在');
    const p = plain({ ...old, ...(patch || {}), updatedAt: now() });
    // round34 H1：字段级时间戳——只 bump 变化的字段
    const fts = { ...(old.fieldTs || {}) };
    for (const k of ['title', 'content', 'status']) if (p[k] !== old[k]) fts[k] = now();
    p.fieldTs = fts;
    await db.plans.put(p);
    return p;
  });
}
export async function deletePlan(id) {
  const old = await db.plans.get(id);
  if (!old) return;
  await db.transaction('rw', db.plans, db.trash, db.tombstones, async () => {
    await trashItem(id, 'plan', old);
    await db.plans.delete(id);
    await db.tombstones.put({ id, kind: 'plan', deletedAt: now() }); // 墓碑：跨设备同步删除
  });
}

// ---------- 知识图谱关系（可持久化、随数据包同步） ----------
