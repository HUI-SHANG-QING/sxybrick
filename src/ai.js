// src/ai.js
// AI 服务层（对外兼容层）。
// 历史导出（chatAI/buildContext/buildMemoryText/extractMemories/listMemories/
// addMemory/deleteMemory 以及对话历史相关方法）全部保留，便于既有视图零改动迁移；
// 其中“上下文构建 / 分层记忆”已下沉到 src/agent 引擎，本文件仅作委托，避免逻辑重复。
// 新增：导出 agentSystem（专业 Agent 框架的公共 API）与 runAgentTurn 高层编排入口。

import { db, uid } from './db.js';
import { buildStudyContext, buildFullContext as ctxFull, buildQuestionCardContext, buildModuleNodesContext } from './agent/context.js';
import {
  listMemories as mList,
  addMemory as mAdd,
  deleteMemory as mDel,
  buildMemoryText as mText,
  clearMemories as mClear,
  extractMemories as mExtract,
} from './agent/memory.js';
import { chat as llmChat } from './agent/llm.js';
import { t } from './i18n/index.js'; // 入参错误的可读文案（round109）
import { offlineChat, shouldFallback, isNetworkError } from './utils/offlineAI.js';

// round37 E1：agentSystem 不再静态 re-export。
// 静态 import './agent/index.js' 会让
//   agent/index → tools → genDeck → ai → agent/index
// 成环（打包提升后 re-export 可能先于初始化读取 → 运行时 TDZ）。
// agent 框架公共 API 直接从 './agent/index.js' 取用；本文件的 runAgentTurn
// 在运行时才动态 import，不进静态初始化图。
export async function runAgentTurn(opt) {
  const { agentSystem } = await import('./agent/index.js');
  return agentSystem.runTask({ ...opt, cfg: getAIConfig() });
}

const CFG_KEY = 'sxy_ai_config';

// 默认最大输出长度（round50）：2000/4096 对「分析多张图 / 生成完整学习路径(依赖链) / 长解析」
// 这类回答偏小，会被 finish_reason='length' 截断。提到 8192（DeepSeek V3 起普遍支持），
// 并在「AI 设置」里开放给用户按自己模型的上限调整（V4 Pro/Flash 上限 384K；V3 约 8K~16K；
// R1 约 16K~32K）。设置超出模型上限时，llm.js 会按服务端提示自动降级重试一次，不会打死请求。
export const DEFAULT_AI_MAX_TOKENS = 8192;

export function getAIConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
    const merged = {
      baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-v4-flash',
      maxTokens: DEFAULT_AI_MAX_TOKENS,
      // round110：向量检索可单独指定供应商（留空则逐项回退到上面的聊天配置）
      embeddingBaseUrl: '',
      embeddingApiKey: '',
      embeddingModel: '',
      ...(c || {}),
    };
    // 旧配置没有 maxTokens（或存了非法值）→ 回落到默认；注意展开会带进 undefined，必须补一次
    if (!Number.isFinite(merged.maxTokens)) merged.maxTokens = DEFAULT_AI_MAX_TOKENS;
    return merged;
  } catch {
    return { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-v4-flash', maxTokens: DEFAULT_AI_MAX_TOKENS };
  }
}

/**
 * 计算某次调用实际应使用的 max_tokens。
 *
 * 背景（用户实测，2026-09-17）：他在设置里把「最大输出长度」调到最大（131072），
 * 但**变式 / 组卡 / 出题**这些流程各自硬编码了 3000~8000 的上限，而 `llm.js` 里取的是
 * `opts.maxTokens ?? cfg.maxTokens`（opts 优先）→ **用户设置被静默忽略**，
 * 于是「我已经调成最大了，还是报预算被截断」。
 *
 * 规则：取「调用方的够用下限」与「用户设置」的较大者——
 *   · 用户设得大（131072）→ 用用户的（这正是他的意图）；
 *   · 用户设得小（如 500）→ 仍用下限，避免流程必然失败；
 *   · 配置缺失/非法 → 用下限。
 * 注意 max_tokens 是**上限**而非目标：调大不会让模型多写，也不会因此多计费。
 * @param {number} floor 该流程需要的最小输出预算
 * @returns {number}
 */
export function resolveMaxTokens(floor) {
  const f = Number(floor);
  const want = Number.isFinite(f) && f > 0 ? f : DEFAULT_AI_MAX_TOKENS;
  const cap = Number(getAIConfig()?.maxTokens);
  return Number.isFinite(cap) && cap > 0 ? Math.max(want, cap) : want;
}

export function setAIConfig(cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

export function hasAIKey() {
  return !!getAIConfig().apiKey;
}

// round86【普通对话路径的历史滑动窗口】：
// 对齐 Agent 路径（orchestrator.js 的 history.slice(-12)），普通对话（AIAssistant.vue 走 chatAI）
// 此前把**全量**会话历史塞进请求——长对话时请求体逐轮膨胀：变慢、变贵，最终 400「上下文超限」
// 或模型静默丢弃早期内容（"失忆"）。规则：
//   · 头部连续的 system 消息（人设/上下文）永远保留；
//   · 其余按「轮」截断：以 user 消息为锚点，保留最近 maxTurns 轮（每轮 user+assistant），
//     保证**本轮输入永远在**，且不把轮对切成半截（user 在、assistant 被切走）。
// 调用方可传 opts.historyTurns 覆盖默认值。
export function trimChatHistory(messages, maxTurns = 16) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  let i = 0;
  while (i < messages.length && messages[i]?.role === 'system') i++;
  const system = messages.slice(0, i);
  const rest = messages.slice(i);
  if (rest.length === 0) return messages;
  const userIdx = [];
  for (let j = 0; j < rest.length; j++) {
    if (rest[j]?.role === 'user') userIdx.push(j);
  }
  // 防御 maxTurns=0/负数/NaN：至少保留 1 轮（本轮输入永远在），NaN/非数回落默认 16
  const turns = Number.isFinite(maxTurns) ? Math.max(1, Math.trunc(maxTurns)) : 16;
  if (userIdx.length <= turns) return messages;
  const start = userIdx[userIdx.length - turns];
  return [...system, ...rest.slice(start)];
}

// 调 OpenAI 兼容的 chat/completions 接口（供简单直连场景复用）
// 离线兜底：无 key 或网络失败时返回诚实引导，避免功能直接崩溃
export async function chatAI(messages, opts = {}) {
  // round109【入参防御】任何一层都不该因为"传了字符串"就炸出
  // `messages.reduce is not a function` 这种看不懂的错（PrivacyData.vue 就踩过：
  // 「AI 增强报告」按钮必然失败，用户只看到一句莫名其妙的报错）。
  // 这里做两件事：① 字符串按"单条 user 消息"归一（保持旧调用可用）；
  // ② 其余非数组入参抛**可读**错误，明确指出该怎么改。
  if (typeof messages === 'string') {
    messages = [{ role: 'user', content: messages }];
  }
  if (!Array.isArray(messages)) {
    throw new Error(t('agent.llm.badMessages', undefined, { got: typeof messages }));
  }
  messages = trimChatHistory(messages, opts.historyTurns);
  if (shouldFallback()) return offlineChat(messages);
  try {
    // round73：默认走**流式**。非流式下 llm.js 的 60s 是「整段回答必须在 60s 内写完」的硬上限
    // （约 1500~2000 汉字），而本项目的 AI 场景几乎全是长输出（周报 / 组卡 / 出题 / 学习路径 /
    // 逐张列卡片 / 文档总结）—— 于是间歇性失败，且越长越必挂。流式把判定改成**空闲超时**
    // （每收到增量即重置计时），长回答不再被误杀。
    // · 调用方仍可用 { stream: false } 显式关闭；
    // · 端点不支持流式时（400/422 且错误文本含 stream）llm.js 会自动退回非流式重试一次；
    // · 流式超时/取消时，已生成的内容会被抢救返回（llm.js 内实现）。
    return await llmChat(messages, getAIConfig(), { stream: true, ...opts });
  } catch (e) {
    if (isNetworkError(e)) return offlineChat(messages);
    throw e;
  }
}

// ---- 上下文 / 记忆：委托给引擎 ----
export function buildContext() {
  return buildStudyContext();
}

/**
 * 带检索的完整上下文：统计面板 + 与问题相关的**原文片段**（卡片正/背面、文档等）。
 *
 * ⚠️ 对话入口必须用这个，而不是 buildContext()：
 * 后者只给「目录级」信息（卡片数量、掌握度、标签），模型看不到任何正文，
 * 于是用户问「这张卡背面写了什么」时只能回答「我看不到内容」。
 * buildFullContext = buildStudyContext + buildRAGContext(query)。
 *
 * @param {string} query 用户问题（用于检索相关内容）
 * @returns {Promise<string>}
 */
export function buildFullContext(query) {
  return ctxFull(query);
}

// round92：普通问答「按问题搜卡注入全文」+「模块节点可见」两个上下文构建函数，
// 对外导出供 AIAssistant.vue 在 system 消息里追加（Agent 路径不改，避免每步放大成本）。
export { buildQuestionCardContext, buildModuleNodesContext };


export function buildMemoryText(query) {
  return mText(query); // round110：可选 query —— 传入后按「相关度 × 重要度 × 新鲜度」挑选记忆
}
export function listMemories() {
  return mList();
}
export function addMemory(item) {
  return mAdd(item);
}
export function clearMemories(category) {
  return mClear(category ? { category } : {});
}
export function deleteMemory(id) {
  return mDel(id);
}
export async function extractMemories(userMsg, aiReply) {
  return mExtract(userMsg, aiReply, chatAI);
}

// ---------- 对话历史（存 IndexedDB，随数据包同步） ----------
export async function listChats() {
  return db.aiChats.orderBy('updatedAt').reverse().toArray();
}
export async function getChat(id) {
  return (await db.aiChats.get(id)) || null;
}
export async function saveChat(chat) {
  // 剥离 Vue 响应式代理：messages 是 ref 数组，直接 put 会触发 IndexedDB 结构化克隆失败（费曼/AI 历史曾因此丢失）
  const plain = JSON.parse(JSON.stringify(chat));
  await db.aiChats.put({ ...plain, updatedAt: Date.now() });
}
export async function deleteChat(id) {
  // 事务：删行与墓碑同生共死。分两次 await 的话，墓碑写失败会留下
  // 「本机已删、对端永远还在」的幽灵对话（下次同步还会被推回来）。
  await db.transaction('rw', db.aiChats, db.tombstones, async () => {
    await db.aiChats.delete(id);
    await db.tombstones.put({ id, kind: 'chat', deletedAt: Date.now() }); // 墓碑：跨设备同步删除
  });
}
export function newChat() {
  return { id: uid(), title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
}

/**
 * 高层编排入口：把一条用户输入交给 Agent 框架执行（自动路由 + 多步工具编排）。
 * 实现见文件顶部 runAgentTurn（动态 import agent/index.js，round37 E1 断环）。
 * @param {object} opt { userInput, history, agentId, onTrace, signal }
 * @returns {Promise<{reply, agentId, agentName, trace}>}
 */
