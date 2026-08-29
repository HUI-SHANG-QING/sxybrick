// src/agent/llm.js
// LLM 适配器：对接 OpenAI 兼容的 /chat/completions 接口（DeepSeek / OpenAI / 本地 llama.cpp 等均可）。
// 设计要点：
//  1) 仅做“聊天”，不耦合任何业务；配置由调用方传入，避免与 ai.js 形成循环依赖。
//  2) 支持流式（onToken）与非流式两种模式，UI 可实时展示思考过程。
//  3) 不依赖原生 function calling —— 工具调用交由上层用“文本协议”解析，保证任意兼容端点都能跑通。
//  4) P2-27 用量账本：每次调用记录 token/耗时（API usage 优先，缺失时估算），写入本地 db.aiUsage。

import { recordUsage, estimateTokens } from '../utils/ai-usage.js';

/**
 * 发起一次聊天补全。
 * @param {Array<{role:string,content:string}>} messages
 * @param {object} cfg  { baseUrl, apiKey, model }
 * @param {object} opts { temperature, maxTokens, stream, onToken, signal, timeoutMs }
 * @returns {Promise<string>} 模型回复文本
 */
export async function chat(messages, cfg, opts = {}) {
  const apiKey = cfg?.apiKey;
  if (!apiKey) throw new Error('请先在「AI 设置」里填入 API 密钥');
  const base = String(cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = cfg.model || 'deepseek-v4-flash';

  // P2-27：用量记录（fire-and-forget，绝不影响主流程）
  const t0 = Date.now();
  const source = String(opts.source || 'chat');
  const reportUsage = (usage, reply, ok) => {
    const promptTokens = usage?.prompt_tokens ?? messages.reduce((n, m) => n + estimateTokens(m?.content ?? ''), 0);
    const completionTokens = usage?.completion_tokens ?? estimateTokens(reply);
    recordUsage({
      source, model, promptTokens, completionTokens,
      durationMs: Date.now() - t0, ok,
      est: usage?.prompt_tokens == null ? 1 : 0,
    }).catch(() => {});
  };

  const body = {
    model,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 2000,
    stream: !!opts.stream,
  };

  // P1-9 超时控制：调用方未传入 signal 时自建 AbortController（默认 60s，可被 opts.timeoutMs 覆盖）。
  // 这样即便上层忘了传 signal，单次 LLM 调用也不会永久挂起。
  let ctrl;
  let timeoutId;
  const external = opts.signal;
  const signal = external || (ctrl = new AbortController()).signal;
  const timeoutMs = opts.timeoutMs ?? 60000;
  if (!external) timeoutId = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const err = new Error(`AI 请求失败(${res.status}${httpHint(res.status)})：${t.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }

  if (!opts.stream) {
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    reportUsage(data?.usage, text, true);
    return text;
  }

  // 流式解析 SSE
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const s = line.trim();
      if (!s || !s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          opts.onToken?.(delta, full);
        }
      } catch { /* 忽略非 JSON 行 */ }
    }
  }
  reportUsage(null, full, true);
  return full;
  } catch (e) {
    reportUsage(null, '', false);
    // P1-9：超时 / 用户取消统一归类为 AbortError，给出可读错误码便于上层降级
    if (e?.name === 'AbortError') {
      const err = new Error(timeoutMs ? `AI 请求超时（>${Math.round(timeoutMs / 1000)}s 未响应）` : 'AI 请求已取消');
      err.code = 'TIMEOUT';
      err.aborted = true;
      throw err;
    }
    throw e;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * HTTP 状态码 → 用户可读的失败原因（P1-9：区分 401/429/超时/网络，便于上层优雅降级）。
 */
function httpHint(status) {
  if (status === 401) return '：API 密钥无效或已过期';
  if (status === 403) return '：无权限访问该模型';
  if (status === 404) return '：接口或模型不存在（检查 baseUrl / model）';
  if (status === 429) return '：请求过于频繁，稍后重试';
  if (status >= 500) return '：服务暂时不可用（稍后重试）';
  return '';
}

/**
 * 轻量 JSON 抽取：从模型可能带 markdown 的代码块/杂项中解析出 JSON。
 * 工具参数、组卡结果都依赖它，鲁棒性很重要。
 */
export function extractJSON(text) {
  if (text == null) return null;
  const s = String(text);
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : s;
  try {
    return JSON.parse(candidate.trim());
  } catch { /* fallthrough */ }
  const arr = candidate.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch { /* noop */ } }
  const obj = candidate.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch { /* noop */ } }
  return null;
}
