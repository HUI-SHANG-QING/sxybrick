// src/agent/llm.js
// LLM 适配器：对接 OpenAI 兼容的 /chat/completions 接口（DeepSeek / OpenAI / 本地 llama.cpp 等均可）。
// 设计要点：
//  1) 仅做“聊天”，不耦合任何业务；配置由调用方传入，避免与 ai.js 形成循环依赖。
//  2) 支持流式（onToken）与非流式两种模式，UI 可实时展示思考过程。
//  3) 不依赖原生 function calling —— 工具调用交由上层用“文本协议”解析，保证任意兼容端点都能跑通。

/**
 * 发起一次聊天补全。
 * @param {Array<{role:string,content:string}>} messages
 * @param {object} cfg  { baseUrl, apiKey, model }
 * @param {object} opts { temperature, maxTokens, stream, onToken, signal }
 * @returns {Promise<string>} 模型回复文本
 */
export async function chat(messages, cfg, opts = {}) {
  const apiKey = cfg?.apiKey;
  if (!apiKey) throw new Error('请先在「AI 设置」里填入 API 密钥');
  const base = String(cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = cfg.model || 'deepseek-v4-flash';

  const body = {
    model,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 2000,
    stream: !!opts.stream,
  };

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`AI 请求失败(${res.status})：${t.slice(0, 300)}`);
  }

  if (!opts.stream) {
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || '';
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
  return full;
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
