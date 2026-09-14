// src/agent/memory.js
// 分层长期记忆：Agent 跨对话记住关于用户的“核心/偏好/事实”，并在每次对话注入系统提示。
// 数据落在 db.aiMemories（IndexedDB），随数据包一起同步，零服务器依赖。

import { db, uid } from '../db.js';
import { extractJSON } from './llm.js';

/** 列出记忆（limit 可选：喂 LLM 时按 updatedAt 倒序取前 N 条即可，避免全表物化） */
export async function listMemories(limit) {
  const col = db.aiMemories.orderBy('updatedAt').reverse();
  return (typeof limit === 'number' && limit > 0) ? col.limit(limit).toArray() : col.toArray();
}

// 记忆条数硬上限（round48）：addMemory 此前无去重、无上限 —— 同一条事实在每轮对话都被
// extractMemories 重新提取、反复插入，几个月就有几十上百条重复；既把注入提示挤满（真·新记忆
// 被 `MEM_LIMITS` 条数上限挡在门外），又让 buildMemoryText 每轮全表扫描越来越慢。
const MEM_MAX_ROWS = 300;

/** 记忆上限清理：超出上限删最旧的（写墓碑，否则对端同步会复活）。与 errorLog 同款处理。 */
async function pruneMemories() {
  try {
    const count = await db.aiMemories.count();
    if (count <= MEM_MAX_ROWS) return 0;
    const stale = await db.aiMemories.orderBy('updatedAt').limit(count - MEM_MAX_ROWS).toArray();
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
const MEM_LIMITS = { core: 12, preference: 12, fact: 20 };
const MEM_ITEM_MAX = 120;
const MEM_TOTAL_MAX = 1800;
// 扫描上限（round48）：只需凑够 12+12+20=44 条，留足跳过空内容的余量即可——
// 此前 listMemories() 全表物化，记忆越多每轮对话越慢。
const MEM_SCAN_LIMIT = 200;

/** 把分层记忆拼成注入文本（核心 > 偏好 > 事实），带条数/长度/总量三重上界 */
export async function buildMemoryText() {
  const mems = await listMemories(MEM_SCAN_LIMIT);
  if (!mems.length) return '';
  const g = { core: [], preference: [], fact: [] };
  for (const m of mems) {
    const layer = (g[m.category] || g.fact);
    if (layer.length >= (MEM_LIMITS[m.category] ?? MEM_LIMITS.fact)) continue;
    const c = String(m.content || '').trim();
    if (!c) continue;
    layer.push(c.length > MEM_ITEM_MAX ? c.slice(0, MEM_ITEM_MAX) + '…' : c);
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
