// src/ai.js
// AI 服务层（对外兼容层）。
// 历史导出（chatAI/buildContext/buildMemoryText/extractMemories/listMemories/
// addMemory/deleteMemory 以及对话历史相关方法）全部保留，便于既有视图零改动迁移；
// 其中“上下文构建 / 分层记忆”已下沉到 src/agent 引擎，本文件仅作委托，避免逻辑重复。
// 新增：导出 agentSystem（专业 Agent 框架的公共 API）与 runAgentTurn 高层编排入口。

import { db, uid } from './db.js';
import { buildStudyContext } from './agent/context.js';
import {
  listMemories as mList,
  addMemory as mAdd,
  deleteMemory as mDel,
  buildMemoryText as mText,
  extractMemories as mExtract,
} from './agent/memory.js';
import { chat as llmChat } from './agent/llm.js';
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
      ...(c || {}),
    };
    // 旧配置没有 maxTokens（或存了非法值）→ 回落到默认；注意展开会带进 undefined，必须补一次
    if (!Number.isFinite(merged.maxTokens)) merged.maxTokens = DEFAULT_AI_MAX_TOKENS;
    return merged;
  } catch {
    return { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-v4-flash', maxTokens: DEFAULT_AI_MAX_TOKENS };
  }
}

export function setAIConfig(cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

export function hasAIKey() {
  return !!getAIConfig().apiKey;
}

// 调 OpenAI 兼容的 chat/completions 接口（供简单直连场景复用）
// 离线兜底：无 key 或网络失败时返回诚实引导，避免功能直接崩溃
export async function chatAI(messages, opts = {}) {
  if (shouldFallback()) return offlineChat(messages);
  try {
    return await llmChat(messages, getAIConfig(), opts);
  } catch (e) {
    if (isNetworkError(e)) return offlineChat(messages);
    throw e;
  }
}

// ---- 上下文 / 记忆：委托给引擎 ----
export function buildContext() {
  return buildStudyContext();
}
export function buildMemoryText() {
  return mText();
}
export function listMemories() {
  return mList();
}
export function addMemory(item) {
  return mAdd(item);
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
