// src/agent/llm.js
// LLM 适配器：对接 OpenAI 兼容的 /chat/completions 接口（DeepSeek / OpenAI / 本地 llama.cpp 等均可）。
// 设计要点：
//  1) 仅做“聊天”，不耦合任何业务；配置由调用方传入，避免与 ai.js 形成循环依赖。
//  2) 支持流式（onToken）与非流式两种模式，UI 可实时展示思考过程。
//  3) 不依赖原生 function calling —— 工具调用交由上层用“文本协议”解析，保证任意兼容端点都能跑通。
//  4) P2-27 用量账本：每次调用记录 token/耗时（API usage 优先，缺失时估算），写入本地 db.aiUsage。

import { recordUsage, estimateTokens } from '../utils/ai-usage.js';
import { tryParseLLMJson } from '../utils/llm-json.js';
// 图片富集：把消息里的 sxy-img:// 占位符转成 AI 可分析内容（OCR 先行 / 视觉兜底）。
// 本 chat() 是所有 AI 链路（对话/Agent/卡片联动/子任务）的唯一出口，在此覆盖全部。
import { enrichForLlm } from '../services/image-analysis.js';

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

  // 图片富集：正文里的 sxy-img:// 占位符按策略转成 AI 可分析内容（OCR 文字 / 多模态图片）。
  // 所有 AI 链路（对话/Agent/卡片联动/子任务）都经此 chat() 发送，一处覆盖全部；
  // 富集失败不阻塞——降级纯文字照常发送（详见 services/image-analysis.js）。
  let finalMessages = messages;
  let visionCount = 0;
  try {
    const en = await enrichForLlm(messages);
    finalMessages = en.messages;
    visionCount = en.vision || 0;
  } catch (e) {
    console.warn('[llm] 图片富集失败，按纯文字发送：', e?.message || e);
  }

  const body = {
    model,
    messages: finalMessages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 2000,
    stream: !!opts.stream,
  };

  // P1-9 超时控制：单次 LLM 调用不允许永久挂起（默认 60s，可被 opts.timeoutMs 覆盖）。
  // 审计 P2-5（round32）：此前 `external || 自建` 在调用方传入 signal 时把超时兜底整个丢弃
  // ——外部中断与超时是 AND 关系（任一触发都该中断），不是 OR。改用 AbortSignal.any
  // 让两者同时生效；旧环境无 AbortSignal.any 时退回原行为（外部 signal 时无超时，不比之前差）。
  let ctrl;
  let timeoutId;
  const external = opts.signal;
  const timeoutMs = opts.timeoutMs ?? 60000;
  const timeoutSignal = (ctrl = new AbortController(), (timeoutId = setTimeout(() => ctrl.abort(), timeoutMs)), ctrl.signal);
  const signal = (external && typeof AbortSignal !== 'undefined' && AbortSignal.any)
    ? AbortSignal.any([external, timeoutSignal])
    : (external || timeoutSignal);

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      // 模型不支持视觉输入时（纯文本模型 + 我们发了图），服务端通常回 400/422。
      // 直接抛错会让用户看到一句晦涩的「AI 请求失败」——而他的真实意图只是「分析图片内容」。
      // 这里剥离附图重试一次，并在正文里说明「已省略 N 张图 + 怎么改设置」，
      // 让用户至少得到一次可读的回答，而不是一个红字报错。
      if (visionCount > 0 && !opts._visionRetry && (res.status === 400 || res.status === 422)) {
        const plain = stripVisionForRetry(finalMessages, visionCount);
        return await chat(plain, cfg, { ...opts, _visionRetry: true });
      }
      const err = new Error(`AI 请求失败(${res.status}${httpHint(res.status)})：${t.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }

  if (!opts.stream) {
    const data = await res.json();
    const choice = data?.choices?.[0];
    const apiErr = data?.error;
    // 服务端可能返回 200 + {error:{...}}（内容审核 / 余额不足 / 模型不存在 / 图片过大等）——
    // 此时没有 choices。旧代码 `data?.choices?.[0]?.message?.content || ''` 静默返回空串，
    // 上层只显示「当前回答为空，请检查 AI 密钥与网络」，把真实原因彻底掩盖（用户明明密钥/网络正常）。
    // 这里显式抛出可读原因，让 UI 直接告诉用户「到底哪里不对」。
    if (apiErr || !Array.isArray(data?.choices) || !data.choices.length) {
      const msg = apiErr?.message || apiErr?.code || JSON.stringify(apiErr ?? data ?? {}).slice(0, 300);
      reportUsage(data?.usage, '', false);
      throw new Error(`AI 返回异常：${msg || '响应中没有 choices 字段'}`);
    }
    const text = choice?.message?.content || '';
    // HTTP 成功但正文为空：细分「截断 / 推理模型 / 附图被忽略」，绝不再静默返回空串
    if (!text.trim()) {
      const fr = choice?.finish_reason;
      const reasoning = choice?.message?.reasoning_content;
      let reason = 'AI 返回了空内容';
      if (fr === 'length') reason = 'AI 回复被截断（max_tokens 用尽），请缩短问题或调大 max_tokens';
      else if (reasoning) reason = '当前模型只返回了推理过程（reasoning_content）、正文为空——请在 AI 设置里改用普通对话模型';
      else if (visionCount > 0) reason = `AI 未返回内容（本次附带了 ${visionCount} 张图片，当前模型可能不支持视觉输入，可在「图片分析策略」里改用 OCR 或换视觉模型）`;
      reportUsage(data?.usage, '', false);
      throw new Error(reason);
    }
    reportUsage(data?.usage, text, true);
    return text;
  }

  // 流式解析 SSE
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  try {
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
  } finally {
    // 审计 P2-5（round32）：abort/异常退出时释放 SSE 连接体——否则底层 socket 挂到服务端超时
    try { await reader.cancel(); } catch { /* 已关闭/不支持时忽略 */ }
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
 * round20：委托 llm-json.js 的 tryParseLLMJson（3 级容错 + 尾逗号修复），
 * 消除两处重复的代码块剥离/括号截取逻辑。
 */
export function extractJSON(text) {
  return tryParseLLMJson(text);
}

/**
 * 视觉降级：把多模态消息还原成纯文本，并在末尾追加一句给模型的说明。
 * 用于「模型不支持视觉 → 服务端 400/422」时重试，避免用户只拿到一个晦涩报错。
 * @param {Array} messages 已富集的消息（可能含 image_url 数组）
 * @param {number} visionCount 本次原本附带的图片数
 */
function stripVisionForRetry(messages, visionCount) {
  const note = `\n\n（系统提示：本次原本附带了 ${visionCount} 张图片，但当前 AI 模型不支持视觉输入，已自动省略。`
    + '请如实告知用户「图片内容本次未能分析」，并建议其到「英语中心 → 设置 → 图片分析策略」'
    + '把模型换成支持视觉的型号（如 gpt-4o / qwen-vl-max / glm-4v / doubao-vision），或改用「先 OCR」策略；'
    + '切勿凭已有文字臆测图片内容。）';
  const arr = messages || [];
  return arr.map((m, i) => {
    const isLast = i === arr.length - 1;
    if (typeof m?.content === 'string') {
      return isLast ? { ...m, content: m.content + note } : m;
    }
    if (Array.isArray(m?.content)) {
      const text = m.content.filter((p) => p?.type === 'text').map((p) => p.text).join('');
      return { ...m, content: isLast ? text + note : text };
    }
    return m;
  });
}
