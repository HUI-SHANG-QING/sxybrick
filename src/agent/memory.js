// src/agent/memory.js
// 分层长期记忆：Agent 跨对话记住关于用户的“核心/偏好/事实”，并在每次对话注入系统提示。
// 数据落在 db.aiMemories（IndexedDB），随数据包一起同步，零服务器依赖。

import { db, uid } from '../db.js';
import { extractJSON } from './llm.js';
// 复用检索层的中文 bigram 关键词打分（Q 里含中文时按 2-gram + 单字 + 空格词切分），
// 避免在记忆层再写第三套分词（项目里已有 retrieval-core 与 embedding 两套，够了）。
import { scoreKeyword } from './retrieval-core.js';

/** 列出记忆（limit 可选：喂 LLM 时按 updatedAt 倒序取前 N 条即可，避免全表物化） */
export async function listMemories(limit) {
  const col = db.aiMemories.orderBy('updatedAt').reverse();
  return (typeof limit === 'number' && limit > 0) ? col.limit(limit).toArray() : col.toArray();
}

// 记忆条数硬上限（round48）：addMemory 此前无去重、无上限 —— 同一条事实在每轮对话都被
// extractMemories 重新提取、反复插入，几个月就有几十上百条重复；既把注入提示挤满（真·新记忆
// 被 `MEM_LIMITS` 条数上限挡在门外），又让 buildMemoryText 每轮全表扫描越来越慢。
const MEM_MAX_ROWS = 300;

/** 记忆上限清理：超出上限删**得分最低**的（写墓碑，否则对端同步会复活）。与 errorLog 同款处理。
 *
 * round110（自用优化）：此前是「删 updatedAt 最旧的」——等于「最久没被刷新」的优先淘汰，
 * 与实际价值无关：一条被反复提到、但一直没被重写的核心事实，会被大量新的琐碎事实挤掉。
 * 现在改为按 scoreMemories 的综合分淘汰（重要度 × 新鲜度 × 巩固度；core 类别额外保护），
 * 让「重要的老记忆」活得比「不重要的新记忆」久。 */
async function pruneMemories() {
  try {
    const count = await db.aiMemories.count();
    if (count <= MEM_MAX_ROWS) return 0;
    const all = await db.aiMemories.toArray();
    if (all.length <= MEM_MAX_ROWS) return 0;
    // 升序 = 得分最低的先淘汰；core 加权保护（身份/目标类记忆最后才丢）
    const ranked = scoreMemories('', all).slice().sort((a, b) => {
      const pa = a.s + (a.m.category === 'core' ? CORE_PRUNE_PROTECT : 0);
      const pb = b.s + (b.m.category === 'core' ? CORE_PRUNE_PROTECT : 0);
      return pa - pb;
    });
    const stale = ranked.slice(0, all.length - MEM_MAX_ROWS).map((x) => x.m);
    if (!stale.length) return 0;
    const ts = Date.now();
    await db.transaction('rw', db.aiMemories, db.tombstones, async () => {
      await db.aiMemories.bulkDelete(stale.map(r => r.id));
      await db.tombstones.bulkPut(stale.map(r => ({ id: r.id, kind: 'memory', deletedAt: ts })));
    });
    return stale.length;
  } catch { return 0; }
}

/** 新增一条记忆（同内容去重：命中已有则只刷新时间戳/重要度，不新增行） */
export async function addMemory(item) {
  const content = String(item?.content || '').trim();
  if (!content) return null;
  const category = ['core', 'preference', 'fact'].includes(item?.category) ? item.category : 'fact';
  // 去重键：忽略大小写与空白差异（同一事实常以不同标点/空格被重复提取）
  const norm = content.replace(/\s+/g, ' ').toLowerCase();
  try {
    const dup = (await db.aiMemories.toArray()).find(
      m => String(m.content || '').trim().replace(/\s+/g, ' ').toLowerCase() === norm,
    );
    if (dup) {
      await db.aiMemories.put({
        ...dup,
        category,
        updatedAt: Date.now(),
        importance: Math.max(Number(dup.importance) || 0, Number(item?.importance) || 2),
      });
      return dup.id;
    }
  } catch { /* 去重扫描失败则继续走新增，不阻断记忆写入 */ }

  const nowTs = Date.now();
  const m = {
    id: uid(),
    content,
    category,
    importance: item?.importance || 2,
    createdAt: nowTs,
    updatedAt: nowTs,
    // round38：字段级时间戳（为将来「记忆可编辑」路径预留逐字段合并语义）
    fieldTs: { content: nowTs, category: nowTs, importance: nowTs },
  };
  await db.aiMemories.put(m);
  await pruneMemories();
  return m;
}

/**
 * 批量清空记忆（round110：记忆管理界面「清空」入口）。
 * @param {{category?: 'core'|'preference'|'fact'}} [opt] 不传 category = 全部清空
 * @returns {Promise<number>} 实际删除条数
 * 必须逐条写墓碑：merge:'updatedAt' + 同步的语义下，**absence ≠ deletion**，
 * 不写墓碑的话对端/中枢会在下次同步把清掉的记忆原样推回来（与 deleteMemory 同一不变量）。
 */
export async function clearMemories(opt = {}) {
  const category = ['core', 'preference', 'fact'].includes(opt?.category) ? opt.category : null;
  const rows = category
    ? await db.aiMemories.where('category').equals(category).toArray()
    : await db.aiMemories.toArray();
  if (!rows.length) return 0;
  const ts = Date.now();
  await db.transaction('rw', db.aiMemories, db.tombstones, async () => {
    await db.aiMemories.bulkDelete(rows.map((r) => r.id));
    await db.tombstones.bulkPut(rows.map((r) => ({ id: r.id, kind: 'memory', deletedAt: ts })));
  });
  return rows.length;
}

/** 删除一条记忆 */
export async function deleteMemory(id) {
  // 事务：删行 + 墓碑原子化。分两次 await 时墓碑写失败会留下
  // 「本机已删、对端永远还在」的幽灵记忆（下次同步还会被推回来）。
  await db.transaction('rw', db.aiMemories, db.tombstones, async () => {
    await db.aiMemories.delete(id);
    await db.tombstones.put({ id, kind: 'memory', deletedAt: Date.now() }); // 墓碑：跨设备同步删除
  });
}

// 审计 S-1（round33）：记忆注入必须有上界——此前把 db.aiMemories 全表拼进系统提示，
// 用几个月后几十上百条记忆会把上下文撑爆（token 超限 → 请求失败或静默截断掉真正的对话），
// 且越攒越贵。这里做三层护栏：
//   ① 分层条数上限（核心/偏好/事实分别限流，核心最贵最珍贵）
//   ② 单条长度截断（一句话记忆，超长说明提取器抽歪了）
//   ③ 总字符上限（最后一道保险，按层优先级丢弃）
// listMemories 按 updatedAt 倒序 → 取前 N 条即「保留最近被刷新/新增的记忆」，
// 老记忆不会永久占位（被新近的同类记忆自然挤出）。
// ── 记忆排序（round110，自用优化核心）────────────────────────────────────────
// 旧行为：所有类别都按 updatedAt 倒序取前 N 条。后果：**与当前问题无关的新记忆会挤掉相关的旧记忆**
//   —— 用户三个月前说「考数一、目标院校考数据结构」，之后聊过 20 条琐碎事实，
//   那条关键事实就被挤出注入；而跟当前问题无关的新记忆反而占位、白花 token。
// 新行为：**类别配额与字符上界完全不变**（core 12 / pref 12 / fact 20 / 总计 1800 字 → token 不膨胀），
//   但「谁能进这 44 个位置」改为按综合分排序：
//     分 = 相关度(复用 retrieval-core 关键词打分) ×3 + 重要度 /5 + 新鲜度 + 巩固度
//   · 无 query（内部调用/无上下文）时相关度恒为 0 → 退化为「重要度+新鲜度+巩固度」，
//     仍优于原来的纯时间倒序（且不再依赖那个从未被读过的 importance 字段作装饰）；
//   · core 类别**永远先于** preference/fact 占位（身份/目标最不该被挤掉）。
const DECAY_TAU_DAYS = 45;   // 新鲜度衰减口径：45 天衰减到约 1/2（经验起点，后续可按体感调）
const REL_W = 3;             // 相关度权重
const IMP_W = 1;             // 重要度权重
const FRESH_W = 0.6;         // 新鲜度权重
const USE_W = 0.4;           // 巩固度权重（被注入过几次 → 越提越牢）
const CORE_PRUNE_PROTECT = 2; // core 在淘汰排序里的保护加分

/** 时间衰减因子：距今越久越接近 0（双曲衰减，比指数更平缓，适合「偏好会长期有效」的场景） */
function decayFactor(ts, now) {
  const days = Math.max(0, (now - (Number(ts) || 0)) / 86400000);
  return 1 / (1 + days / DECAY_TAU_DAYS);
}

/**
 * 记忆综合打分并降序排序。
 * @param {string} [query] 当前用户问题；为空则只按重要度/新鲜度/巩固度排
 * @param {Array} mems 记忆行（需 id/content/category/importance/updatedAt/useCount）
 * @param {number} [now]
 * @returns {Array<{m: object, s: number}>}
 */
export function scoreMemories(query, mems, now = Date.now()) {
  const rel = new Map();
  const q = String(query || '').trim();
  if (q && mems.length) {
    try {
      // scoreKeyword 需要 row.text 字段（记忆内容是 content）
      for (const { row, score } of scoreKeyword(q, mems.map((m) => ({ ...m, text: String(m.content || '') })))) {
        rel.set(row.id, Number(score) || 0);
      }
    } catch { /* 打分失败 → 相关度按 0 处理，不影响其余权重 */ }
  }
  return mems
    .map((m) => {
      const imp = Math.max(1, Math.min(5, Number(m.importance) || 2)) / 5;
      const fresh = decayFactor(m.updatedAt ?? m.createdAt, now);
      const use = Math.min(1, Math.log2(1 + (Number(m.useCount) || 0)) / 3); // 1 次≈0.33、7 次≈1
      const s = REL_W * (rel.get(m.id) || 0) + IMP_W * imp + FRESH_W * fresh + USE_W * use;
      return { m, s };
    })
    .sort((a, b) => b.s - a.s || (Number(b.m.updatedAt) || 0) - (Number(a.m.updatedAt) || 0));
}

/** 巩固节流：同一条记忆 6 小时内只记一次使用，避免每轮对话都写库 */
const CONSOLIDATE_GAP_MS = 6 * 3600 * 1000;

/**
 * 记录「这几条记忆被实际注入了」——越提越牢（供下次排序加分）。
 * 刻意**只写 useCount/lastUsedAt，不动 updatedAt**：
 *   · updatedAt 是对外同步的合并键（merge:'updatedAt'），动它会引发跨设备整行覆盖与无谓 churn；
 *   · 使用频次属于本机行为，不必同步。
 * 失败静默（这只是排序的锦上添花，绝不能影响对话主链路）。
 */
async function consolidateUsage(picked, now = Date.now()) {
  const ids = (picked || [])
    .filter((m) => !m.lastUsedAt || now - Number(m.lastUsedAt) > CONSOLIDATE_GAP_MS)
    .map((m) => m.id);
  if (!ids.length) return;
  await Promise.all(ids.map((id) => db.aiMemories
    .filter((m) => m.id === id)
    .modify((m) => { m.useCount = (Number(m.useCount) || 0) + 1; m.lastUsedAt = now; })
    .catch(() => 0)));
}

const MEM_LIMITS = { core: 12, preference: 12, fact: 20 };
const MEM_ITEM_MAX = 120;
const MEM_TOTAL_MAX = 1800;
// 扫描上限：表本身被 MEM_MAX_ROWS 硬顶在 300 行，故直接全取候选——
// 旧值 200 会让「第 201 行以后的老记忆」**永远不可能被选中**（哪怕它与当前问题高度相关）。
// 300 行的全表物化成本可忽略（同一份数据在 addMemory 里已经在做全表扫）。
const MEM_SCAN_LIMIT = MEM_MAX_ROWS;

/**
 * 把分层记忆拼成注入文本（核心 > 偏好 > 事实），带条数/长度/总量三重上界。
 * @param {string} [query] 当前用户问题——传入后按「相关度优先」挑选；不传则退化为重要度/新鲜度排序
 */
export async function buildMemoryText(query) {
  const mems = await listMemories(MEM_SCAN_LIMIT);
  if (!mems.length) return '';
  // round110：先按综合分排序，再按类别配额挑选（配额不变 → token 不膨胀）
  const ranked = scoreMemories(query, mems);
  const g = { core: [], preference: [], fact: [] };
  const picked = [];
  for (const { m } of ranked) {
    const layer = (g[m.category] || g.fact);
    if (layer.length >= (MEM_LIMITS[m.category] ?? MEM_LIMITS.fact)) continue;
    const c = String(m.content || '').trim();
    if (!c) continue;
    layer.push(c.length > MEM_ITEM_MAX ? c.slice(0, MEM_ITEM_MAX) + '…' : c);
    picked.push(m);
  }
  const out = ['【Agent 对用户的长期记忆（跨对话，务必记得并遵循）】'];
  const lines = [];
  if (g.core.length) lines.push('· 核心：' + g.core.join('；'));
  if (g.preference.length) lines.push('· 偏好：' + g.preference.join('；'));
  if (g.fact.length) lines.push('· 事实：' + g.fact.join('；'));
  let text = out.concat(lines).join('\n');
  // 总量护栏：按「事实 → 偏好」顺序丢弃（核心最后才丢）
  while (text.length > MEM_TOTAL_MAX && lines.length > 1) {
    lines.pop();
    text = out.concat(lines).join('\n');
  }
  // 巩固：被真正注入的记忆记一次使用（节流 6h、不阻塞、失败静默）
  consolidateUsage(picked).catch(() => {});
  return text;
}

/**
 * 对话结束后，自动提取值得长期记住的信息。
 * 使用“记忆提取器”子 Agent（纯 prompt，无需注册进主路由）。
 */
export async function extractMemories(userMsg, aiReply, chatFn) {
  try {
    const r = await chatFn([
      {
        role: 'system',
        content:
          '你是记忆提取器。从这轮对话提取值得长期记住的关于用户的信息（身份/专业/目标/重要事实/偏好），输出 JSON 数组，每项 {"category":"core|preference|fact","content":"简短描述"}。没有值得记的输出 []。只输出 JSON，不要多余文字。',
      },
      { role: 'user', content: `用户说：${userMsg}\n助手回：${aiReply}` },
    ]);
    const arr = Array.isArray(r) ? r : (extractJSON(r) || []);
    if (Array.isArray(arr)) for (const it of arr) if (it && it.content) await addMemory(it);
    return Array.isArray(arr) ? arr.filter((x) => x && x.content).length : 0;
  } catch {
    return 0;
  }
}
