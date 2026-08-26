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
import { agentSystem } from './agent/index.js';

export { agentSystem } from './agent/index.js';

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

// 调 OpenAI 兼容的 chat/completions 接口（供简单直连场景复用）
export async function chatAI(messages, opts = {}) {
  return llmChat(messages, getAIConfig(), opts);
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
  await db.aiChats.delete(id);
  await db.tombstones.put({ id, kind: 'chat', deletedAt: Date.now() }); // 墓碑：跨设备同步删除
}
export function newChat() {
  return { id: uid(), title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
}

/**
 * 高层编排入口：把一条用户输入交给 Agent 框架执行（自动路由 + 多步工具编排）。
 * @param {object} opt { userInput, history, agentId, onTrace, signal }
 * @returns {Promise<{reply, agentId, agentName, trace}>}
 */
export function runAgentTurn(opt) {
  return agentSystem.runTask({ ...opt, cfg: getAIConfig() });
}
