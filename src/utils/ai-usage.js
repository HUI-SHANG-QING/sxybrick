// src/utils/ai-usage.js
// AI 用量账本（P2-27）：记录每次 AI 调用的 token 数 / 耗时 / 费用。
// - 数据来源：API 响应的 usage 字段优先（est=0）；缺失时按字符数估算（est=1）
// - 存储：db.aiUsage（v21 本地表，不同步——用量属于本设备计费上下文，已入 EXCLUDED_FROM_SYNC）
// - 费用仅为估算：内置模型费率表（元/百万 token），实际账单以 API 服务商为准

import { db, uid } from '../db.js';

// 内置费率表：元 / 百万 token [输入, 输出]；未知模型回退 DEFAULT_RATE
const RATES = {
  'deepseek-chat': [1, 2],
  'deepseek-v4-flash': [1, 2],
  'deepseek-reasoner': [4, 16],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4o': [2.5, 10],
  'gpt-4.1-mini': [0.4, 1.6],
  'text-embedding-3-small': [0.02, 0],
  'text-embedding-3-large': [0.13, 0],
  'bge-large-zh': [0.1, 0],
};
const DEFAULT_RATE = [1, 2];

/** 粗略 token 估算：中文约 1 字 1 token，英文约 1 词 1.3 token，再计 10% 符号/格式开销 */
export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const words = (s.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
  return Math.ceil((cjk + words * 1.3) * 1.1);
}

/** 费用估算（元）：先按模型名精确匹配费率表，再子串匹配，最后回退默认费率 */
export function estimateCost(promptTokens, completionTokens, model) {
  const key = String(model || '').toLowerCase();
  const hit = RATES[key] || RATES[Object.keys(RATES).find(k => key.includes(k) && k.length > 4) || ''] || DEFAULT_RATE;
  return (promptTokens / 1e6) * hit[0] + (completionTokens / 1e6) * hit[1];
}

/** 记录一次 AI 调用（fire-and-forget 调用：内部吞错只告警，绝不影响主流程） */
export async function recordUsage(rec) {
  const row = {
    id: uid(),
    t: rec.t ?? Date.now(),
    source: String(rec.source || 'llm').slice(0, 40),
    model: String(rec.model || '').slice(0, 60),
    promptTokens: Number(rec.promptTokens) || 0,
    completionTokens: Number(rec.completionTokens) || 0,
    totalTokens: Number(rec.totalTokens) || (Number(rec.promptTokens) || 0) + (Number(rec.completionTokens) || 0),
    durationMs: Number(rec.durationMs) || 0,
    ok: rec.ok === false ? 0 : 1,
    est: rec.est ? 1 : 0,
  };
  try {
    await db.aiUsage.add(row);
  } catch (e) {
    console.warn('[ai-usage] 写入失败（不影响主流程）:', e?.message || e);
  }
  return row;
}

/** 聚合最近 N 天：总次数 / token / 耗时 / 估算费用 + 按来源、按模型分布 */
export async function aggregateUsage(days = 30) {
  const since = Date.now() - days * 86400000;
  const rows = await db.aiUsage.where('t').aboveOrEqual(since).toArray();
  const agg = {
    days,
    calls: rows.length,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    costCny: 0,
    bySource: {},
    byModel: {},
  };
  for (const r of rows) {
    const c = estimateCost(r.promptTokens, r.completionTokens, r.model);
    agg.promptTokens += r.promptTokens;
    agg.completionTokens += r.completionTokens;
    agg.totalTokens += r.totalTokens;
    agg.durationMs += r.durationMs;
    agg.costCny += c;
    const s = (agg.bySource[r.source] ||= { source: r.source, calls: 0, totalTokens: 0, costCny: 0 });
    s.calls += 1; s.totalTokens += r.totalTokens; s.costCny += c;
    const m = (agg.byModel[r.model || 'unknown'] ||= { model: r.model || 'unknown', calls: 0, totalTokens: 0, costCny: 0 });
    m.calls += 1; m.totalTokens += r.totalTokens; m.costCny += c;
  }
  agg.bySource = Object.values(agg.bySource).sort((a, b) => b.totalTokens - a.totalTokens);
  agg.byModel = Object.values(agg.byModel).sort((a, b) => b.totalTokens - a.totalTokens);
  return agg;
}

/** 清空全部用量记录 */
export async function clearUsage() {
  await db.aiUsage.clear();
}
