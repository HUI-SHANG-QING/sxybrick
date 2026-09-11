// src/agent/memory.js
// 分层长期记忆：Agent 跨对话记住关于用户的“核心/偏好/事实”，并在每次对话注入系统提示。
// 数据落在 db.aiMemories（IndexedDB），随数据包一起同步，零服务器依赖。

import { db, uid } from '../db.js';
import { extractJSON } from './llm.js';

/** 列出全部记忆 */
export async function listMemories() {
  return db.aiMemories.orderBy('updatedAt').reverse().toArray();
}

/** 新增一条记忆 */
export async function addMemory(item) {
  const content = String(item?.content || '').trim();
  if (!content) return null;
  const m = {
    id: uid(),
    content,
    category: ['core', 'preference', 'fact'].includes(item?.category) ? item.category : 'fact',
    importance: item?.importance || 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // round38：字段级时间戳（为将来「记忆可编辑」路径预留逐字段合并语义）
    fieldTs: { content: Date.now(), category: Date.now(), importance: Date.now() },
  };
  await db.aiMemories.put(m);
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

/** 把分层记忆拼成注入文本（核心 > 偏好 > 事实），带条数/长度/总量三重上界 */
export async function buildMemoryText() {
  const mems = await listMemories();
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
