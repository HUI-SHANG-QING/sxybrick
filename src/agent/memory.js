// src/agent/memory.js
// 分层长期记忆：Agent 跨对话记住关于用户的“核心/偏好/事实”，并在每次对话注入系统提示。
// 数据落在 db.aiMemories（IndexedDB），随数据包一起同步，零服务器依赖。

import { db, uid } from '../db.js';

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
  };
  await db.aiMemories.put(m);
  return m;
}

/** 删除一条记忆 */
export async function deleteMemory(id) {
  await db.aiMemories.delete(id);
}

/** 把分层记忆拼成注入文本（核心 > 偏好 > 事实） */
export async function buildMemoryText() {
  const mems = await listMemories();
  if (!mems.length) return '';
  const g = { core: [], preference: [], fact: [] };
  for (const m of mems) (g[m.category] || g.fact).push(m.content);
  const out = ['【Agent 对用户的长期记忆（跨对话，务必记得并遵循）】'];
  if (g.core.length) out.push('· 核心：' + g.core.join('；'));
  if (g.preference.length) out.push('· 偏好：' + g.preference.join('；'));
  if (g.fact.length) out.push('· 事实：' + g.fact.join('；'));
  return out.join('\n');
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
    const arr = Array.isArray(r) ? r : (() => { try { return JSON.parse(String(r).match(/\[[\s\S]*\]/)?.[0] || '[]'); } catch { return []; } })();
    if (Array.isArray(arr)) for (const it of arr) if (it && it.content) await addMemory(it);
    return Array.isArray(arr) ? arr.filter((x) => x && x.content).length : 0;
  } catch {
    return 0;
  }
}
