// AI 服务层：OpenAI 兼容格式（DeepSeek 等均可）
// 密钥存本地 localStorage，前端直连，无需自建服务器
import { getStats, weakCards, getReviewSuggestion, getTags } from './repo.js';
import { db, uid } from './db.js';

const CFG_KEY = 'sxy_ai_config';

export function getAIConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
    return { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-v4-flash', ...(c || {}) };
  } catch {
    return { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-v4-flash' };
  }
}

export function setAIConfig(cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

export function hasAIKey() {
  return !!getAIConfig().apiKey;
}

// 调 OpenAI 兼容的 chat/completions 接口
export async function chatAI(messages, opts = {}) {
  const cfg = getAIConfig();
  if (!cfg.apiKey) throw new Error('请先在「AI 设置」里填入 API 密钥');
  const base = String(cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model || 'deepseek-v4-flash',
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 2000,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AI 请求失败(${res.status})：${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// 收集用户全部数据，拼成给 AI 的上下文（让 Agent 知道你的复习真实情况）
export async function buildContext() {
  const [stats, weak, suggestion, tags] = await Promise.all([
    getStats(), weakCards(40, 1), getReviewSuggestion(), getTags(),
  ]);

  const L = [];
  L.push(`【用户记忆卡片系统数据概览】`);
  L.push(`- 卡片总数 ${stats.totalCards} 张；总复习 ${stats.totalReviews} 次；今日已复习 ${stats.todayReviews} 次；今日待背 ${stats.dueToday} 张；平均掌握度 ${stats.avgMastery}%`);
  L.push(`- 各科卡片占比：${Object.entries(stats.subjectCards).map(([k, v]) => `${k} ${v}张`).join('，') || '无'}`);
  L.push(`- 自评分布：没记住 ${stats.ratingDist[0]} 次 / 还模糊 ${stats.ratingDist[1]} 次 / 记住了 ${stats.ratingDist[2]} 次`);
  L.push(`- 能力四维：掌握度${stats.ability.mastery}% 正确率${stats.ability.correct}% 稳定度${stats.ability.stable}% 覆盖率${stats.ability.coverage}%`);
  if (suggestion.staleSubjects.length) L.push(`- 很久没复习的科目：${suggestion.staleSubjects.map(s => `${s.name}(${s.days}天)`).join('，')}`);
  if (tagCountsStr(tags)) L.push(`- 标签分布：${tagCountsStr(tags)}`);
  if (weak.length) {
    const top = weak.slice(0, 20).map((c, i) => `${i + 1}.[${c.subject || '未分类'}${c.marked ? '·错题' : ''}${c.wrongReason ? '·' + c.wrongReason : ''}] ${String(c.front).replace(/\s+/g, ' ').slice(0, 30)}（遗忘${c.failCount}次）`).join('；');
    L.push(`- 薄弱/错题卡片（按遗忘次数排序）：${top}`);
  }
  return L.join('\n');
}

function tagCountsStr(tags) {
  if (!tags.length) return '';
  return tags.slice(0, 20).map(t => `${t.name}(${t.count}张)`).join('，');
}

// ---------- 对话历史（存 IndexedDB，随数据包同步） ----------
export async function listChats() {
  return db.aiChats.orderBy('updatedAt').reverse().toArray();
}
export async function getChat(id) {
  return (await db.aiChats.get(id)) || null;
}
export async function saveChat(chat) {
  await db.aiChats.put({ ...chat, updatedAt: Date.now() });
}
export async function deleteChat(id) {
  await db.aiChats.delete(id);
}
export function newChat() {
  return { id: uid(), title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
}

// ---------- Agent 记忆库（分层：core / preference / fact） ----------
export async function listMemories() {
  return db.aiMemories.orderBy('updatedAt').reverse().toArray();
}
export async function addMemory(item) {
  const content = String(item.content || '').trim();
  if (!content) return null;
  const m = {
    id: uid(), content,
    category: ['core', 'preference', 'fact'].includes(item.category) ? item.category : 'fact',
    importance: item.importance || 2,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  await db.aiMemories.put(m);
  return m;
}
export async function deleteMemory(id) { await db.aiMemories.delete(id); }

// 把分层记忆拼成给 AI 的文本（核心 > 偏好 > 事实）
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

// 对话结束后，自动提取值得长期记住的信息存入记忆库
export async function extractMemories(userMsg, aiReply) {
  try {
    const r = await chatAI([
      { role: 'system', content: '你是记忆提取器。从这轮对话提取值得长期记住的关于用户的信息（身份/专业/目标/重要事实/偏好），输出 JSON 数组，每项 {"category":"core|preference|fact","content":"简短描述"}。没有值得记的输出 []（空数组）。只输出 JSON，不要多余文字。' },
      { role: 'user', content: `用户说：${userMsg}\n助手回：${aiReply}` },
    ]);
    const m = String(r).match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : r);
    if (Array.isArray(arr)) for (const it of arr) if (it && it.content) await addMemory(it);
    return Array.isArray(arr) ? arr.filter(x => x && x.content).length : 0;
  } catch { return 0; }
}