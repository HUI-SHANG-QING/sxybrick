// src/agent/llm.js
// LLM 适配器：对接 OpenAI 兼容的 /chat/completions 接口（DeepSeek / OpenAI / 本地 llama.cpp 等均可）。
// 设计要点：
//  1) 仅做“聊天”，不耦合任何业务；配置由调用方传入，避免与 ai.js 形成循环依赖。
//  2) 支持流式（onToken）与非流式两种模式，UI 可实时展示思考过程。
//  3) 不依赖原生 function calling —— 工具调用交由上层用“文本协议”解析，保证任意兼容端点都能跑通。
//  4) P2-27 用量账本：每次调用记录 token/耗时（API usage 优先，缺失时估算），写入本地 db.aiUsage。

import { recordUsage, estimateTokens } from '../utils/ai-usage.js';
import { tryParseLLMJson } from '../utils/llm-json.js';
import { t } from '../i18n/index.js'; // 错误/降级文案走字典（check-view-i18n --js 闸门）
// 图片富集：把消息里的 sxy-img:// 占位符转成 AI 可分析内容（OCR 先行 / 视觉兜底）。
// 本 chat() 是所有 AI 链路（对话/Agent/卡片联动/子任务）的唯一出口，在此覆盖全部。
import { enrichForLlm } from '../services/image-analysis.js';

// ---- 输出长度策略（round49 建立 / round50 开放给用户配置）---------------------
// 默认输出上限：2000 对「分析两张思维导图」「给完整学习路径」这类长回答远远不够，会被
// finish_reason='length' 硬截断（用户看到的「AI 回复被截断」就是这么来的，不是模型坏了）。
// 取值优先级：opts.maxTokens（调用方显式指定） > cfg.maxTokens（用户在「AI 设置」里选的） > 本常量。
// 配合下方「截断自动续写」兜底；用户可按自己模型的上限调高（V4 Pro/Flash 上限 384K）。
const DEFAULT_MAX_TOKENS = 8192;
// 截断自动续写：模型因长度中断时，自动追加请求继续输出。
// 业界标准做法（模型输出有硬上限，"分段生成 + 续写"是系统侧该做的事，而不是让用户把问题拆短）。
const MAX_CONTINUATIONS = 3;      // 最多续写轮数
// 流式「空闲超时」默认值：比非流式的 60s 宽松，因为它的含义是「多久没收到新数据」而不是「整段写完要多久」
const DEFAULT_STREAM_IDLE_MS = 120000;
// 兜底解析保留的原始响应上限（防个别网关忽略 stream 参数、回整段巨型 JSON 时占满内存）
const RAW_TAIL_CAP = 200000;
// round73：已学到的「服务端允许的 max_tokens 上限」，按 `base|model` 记住。
// 用户把「最大输出长度」调到 65536 而端点只允许 8K 时，此前**每次调用**都要先撞一次 400
// 再降级重试（Agent 一轮 2~4 次调用 = 白花 0.5~2s）。学到之后直接夹紧，不再重复试探。
const MAX_TOKEN_CAP = new Map();

/**
 * 从服务端 400 文案里解析它允许的 max_tokens 上限（round73）。
 * 覆盖常见形态：
 *   "the valid range of max_tokens is [1, 8192]"
 *   "max_tokens must be less than or equal to 16384"
 *   "max_tokens: 65536 > 8192, max allowed is 8192"
 * 解析不出时返回 0，调用方退回保守降级（2K）。
 * @param {string} text
 * @returns {number}
 */
export function parseMaxTokensBound(text) {
  const s = String(text || '');
  const pats = [
    /max[_-]?tokens?[^0-9]{0,60}\[\s*\d+\s*,\s*(\d{2,7})\s*\]/i,
    /max[_-]?tokens?[^0-9]{0,60}(?:less than or equal to|not exceed|at most|maximum(?:\s+is|\s+allowed\s+is)?|max\s+allowed\s+is|<=\s*)\s*(\d{2,7})/i,
    // 容忍中间夹标点（如 "8192, max allowed is 8192"）——\s* 太窄，实测会漏
    /(\d{2,7})[^0-9]{0,15}(?:is\s+the\s+maximum|max(?:imum)?\s+allowed)/i,
  ];
  for (const re of pats) {
    const m = s.match(re);
    const v = m && Number(m[1]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}
const MAX_TOTAL_CHARS = 24000;    // 续写累计字符上限（防无界膨胀、防费用失控）
const TRUNCATE_CONTINUE_PROMPT =
  '上一条回复因长度限制被截断了。请**从中断处接着写**剩余内容，'
  + '不要重复已经输出的部分，也不要添加任何前言或总结性收尾。';

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
  // round48：把**外部取消信号**透传进富集——用户点"取消"时应能中断图片 OCR，否则最多
  // 8 张图 ×30s 的串行识别仍会跑完（"取消"名不副实）。这里只传外部 signal、不传本函数的
  // 60s 超时，以免多图 OCR 被整体截断（OCR 自身已有每张 30s 上限）。
  let finalMessages = messages;
  let visionCount = 0;
  try {
    const en = await enrichForLlm(messages, { signal: opts.signal });
    finalMessages = en.messages;
    visionCount = en.vision || 0;
  } catch (e) {
    console.warn('[llm] 图片富集失败，按纯文字发送：', e?.message || e);
  }

  // round73：把「用户设置的上限」夹到**已学到的服务端上限**之内（仅学到过时才生效）。
  // 否则用户设 65536、端点只给 8192 时，每次调用都要先浪费一个 400 往返。
  const learnedCap = MAX_TOKEN_CAP.get(`${base}|${model}`) || 0;
  const wantTokens = opts.maxTokens ?? (Number.isFinite(cfg?.maxTokens) ? cfg.maxTokens : DEFAULT_MAX_TOKENS);
  const effectiveMaxTokens = learnedCap ? Math.min(wantTokens, learnedCap) : wantTokens;

  const body = {
    model,
    messages: finalMessages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: effectiveMaxTokens,
    stream: !!opts.stream,
  };

  // P1-9 超时控制：单次 LLM 调用不允许永久挂起（默认 60s，可被 opts.timeoutMs 覆盖）。
  // 审计 P2-5（round32）：此前 `external || 自建` 在调用方传入 signal 时把超时兜底整个丢弃
  // ——外部中断与超时是 AND 关系（任一触发都该中断），不是 OR。改用 AbortSignal.any
  // 让两者同时生效；旧环境无 AbortSignal.any 时退回原行为（外部 signal 时无超时，不比之前差）。
  //
  // round71【本次核心修复】流式与非流式的超时**含义不同**，这里必须分开：
  //   · 非流式：60s = 「整段回答必须在 60s 内写完」。回答越长越容易被判超时；而用户在设置里
  //     把 max_tokens 调到 65536（≈4.7 万字）等于鼓励模型写更长 → **越调大输出上限越容易失败**，
  //     这正是「有时能成功、有时不能」看起来随机的原因（短问答能过、长回答必挂）。
  //   · 流式：改为「**空闲超时**」——每收到一段增量即重置计时。只要模型在持续输出，
  //     写 3000 字还是 30000 字都不会被判超时；只有真正卡死（N 秒无任何新数据）才中止。
  const streaming = !!opts.stream;
  let ctrl = null;
  let timeoutId = null;
  let timedOut = false;
  const external = opts.signal;
  const timeoutMs = opts.timeoutMs ?? (streaming ? DEFAULT_STREAM_IDLE_MS : 60000);
  const arm = (ms) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
  };
  const timeoutSignal = (ctrl = new AbortController(), arm(timeoutMs), ctrl.signal);
  const signal = (external && typeof AbortSignal !== 'undefined' && AbortSignal.any)
    ? AbortSignal.any([external, timeoutSignal])
    : (external || timeoutSignal);
  // 流式已收到的内容（catch 里抢救用）：超时不该把用户已经等到的几百字全丢掉
  let received = '';

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
        // round48：首失败请求也要记一笔用量（此前只在成功分支记账 → 账本少计、计费失真）
        reportUsage(undefined, '', false);
        const plain = stripVisionForRetry(finalMessages, visionCount);
        return await chat(plain, cfg, { ...opts, _visionRetry: true });
      }
      const err = new Error(`AI 请求失败(${res.status}${httpHint(res.status)})：${t.slice(0, 300)}`);
      err.status = res.status;
      // round49：某些本地/自建端点输出上限低于 4096，会把 max_tokens 判为非法（400/422）。
      // 为「修截断」反而把请求打死不划算——按服务端提示降级重试一次（≤2000）。
      // round73：默认流式之后，必须给「不接受 stream 参数的端点/网关」留退路。
      // 这类服务通常回 400/422 且错误文本里带 stream —— 直接抛错会让用户换了个自建端点就全挂。
      if (!opts._streamRetry && opts.stream && (res.status === 400 || res.status === 422) && /stream/i.test(t)) {
        reportUsage(undefined, '', false);
        return await chat(finalMessages, cfg, { ...opts, stream: false, _streamRetry: true });
      }
      if (!opts._maxTokenRetry && (res.status === 400 || res.status === 422) && /max[_\s-]?tokens?/i.test(t)) {
        reportUsage(undefined, '', false);
        // round73：不再一律降到 2000。先从服务端文案里解析**它允许的上限**并按上限重试，
        // 同时把上限记住（后续调用直接夹紧）。旧行为降到 2000 = 长回答被硬截断，
        // 用户明明买了个大窗口的模型，却一直在用 2K 的输出。
        const bound = parseMaxTokensBound(t);
        if (bound) MAX_TOKEN_CAP.set(`${base}|${model}`, bound);
        return await chat(finalMessages, cfg, {
          ...opts,
          _maxTokenRetry: true,
          maxTokens: bound || Math.min(
            Number(opts.maxTokens) || (Number.isFinite(cfg?.maxTokens) ? cfg.maxTokens : DEFAULT_MAX_TOKENS),
            2000,
          ),
        });
      }
      throw err;
    }

  // round73：流式已成为多数链路的默认值，这里补一道防御——200 响应没有可读流
  // （res.body 为空，部分网关/测试替身会出现）时退回非流式解析，
  // 否则 `res.body.getReader()` 抛 TypeError，把一次本该成功的调用变成失败。
  if (!opts.stream || !res.body || typeof res.body.getReader !== 'function') {
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
    let text = choice?.message?.content || '';
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

    // round49：**截断自动续写**（本轮的核心修复）。
    // 模型输出都有硬上限；长回答（分析多张图 / 完整学习路径 / 长解析）在旧默认 2000 tokens 下
    // 几乎必被截断，旧行为要么把半截回答丢给用户、要么抛错让上层「降级本地模式」。
    // 正确做法是系统侧分段续写：把已输出内容作为 assistant 消息回灌 + 一句「接着写」，
    // 最多 MAX_CONTINUATIONS 轮、累计不超过 MAX_TOTAL_CHARS（防费用/长度失控）。
    if (choice?.finish_reason === 'length' && opts.continueOnTruncate !== false) {
      let acc = text;
      for (let i = 0; i < MAX_CONTINUATIONS; i += 1) {
        if (acc.length >= MAX_TOTAL_CHARS) break;
        let more = '';
        let fr2 = null;
        try {
          const r2 = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              ...body,
              messages: [
                ...finalMessages,
                { role: 'assistant', content: acc },
                { role: 'user', content: TRUNCATE_CONTINUE_PROMPT },
              ],
            }),
            signal,
          });
          if (!r2.ok) break;
          const d2 = await r2.json();
          const c2 = d2?.choices?.[0];
          more = c2?.message?.content || '';
          fr2 = c2?.finish_reason;
          reportUsage(d2?.usage, more, true);
        } catch { break; } // 续写失败就返回已有部分，绝不因续写把整体搞崩
        if (!more.trim()) break;
        acc += more;
        if (fr2 !== 'length') break;
      }
      text = acc;
    }
    return text;
  }

  // 流式解析 SSE
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  // 原始文本尾巴：个别自建网关**忽略 stream 参数**直接回整段 JSON（没有 data: 行），
  // 旧实现会把这种响应解析成空串 → 上层报「AI 返回了空内容」。留一份原文用于兜底解析。
  let rawTail = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // 空闲重置：收到数据即证明连接活跃，重新计时（见上方超时语义说明）
      arm(timeoutMs);
      const chunk = decoder.decode(value, { stream: true });
      if (rawTail.length < RAW_TAIL_CAP) rawTail += chunk;
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        // 审计 P2（2026-09-14 续）：流式分支同款缺陷——服务端 200 + SSE error 行
        // （余额不足/内容审核/模型不存在/图片过大）此前被静默忽略 → full='' →
        // 上层误报「当前回答为空，请检查 AI 密钥与网络」。与上方非流式分支同口径：
        // 任何 data 行或非 data 行解析出 {error} 即抛出可读原因，不掩盖成密钥/网络问题。
        let json = null;
        if (s.startsWith('data:')) {
          const payload = s.slice(5).trim();
          if (payload === '[DONE]') continue;
          try { json = JSON.parse(payload); } catch { /* 非 JSON 行忽略 */ }
        } else {
          // 非 data: 行：服务端可能不回 SSE、直接整段 JSON 错误体（部分网关失败响应）
          try { json = JSON.parse(s); } catch { /* 非 JSON 行忽略 */ }
        }
        if (json && json.error) {
          const em = typeof json.error === 'object' && json.error
            ? (json.error.message || json.error.type || '响应异常')
            : String(json.error || '响应异常');
          throw new Error(`AI 返回异常：${em}`);
        }
        if (s.startsWith('data:')) {
          const delta = json?.choices?.[0]?.delta?.content || '';
          if (delta) {
            full += delta;
            received = full;
            opts.onToken?.(delta, full);
          }
        }
      }
    }
    // 兜底：服务端没走 SSE（直接回整段 JSON）时，从原始文本里取出正文
    if (!full.trim() && rawTail.trim()) {
      const j = tryParseLLMJson(rawTail);
      const c = j?.choices?.[0]?.message?.content;
      if (typeof c === 'string' && c.trim()) full = c;
    }
  } finally {
    // 审计 P2-5（round32）：abort/异常退出时释放 SSE 连接体——否则底层 socket 挂到服务端超时
    try { await reader.cancel(); } catch { /* 已关闭/不支持时忽略 */ }
  }
  reportUsage(null, full, true);
  return full;
  } catch (e) {
    // P1-9：超时 / 用户取消统一归类为 AbortError，给出可读错误码便于上层降级
    if (e?.name === 'AbortError') {
      // round71【抢救已生成内容】超时/取消时不再整段丢弃。
      // 旧行为：abort 时一个字都不返回 → 上层只能顶一句「AI 合成回答暂不可用」，
      // 用户白等一分钟后什么都没拿到，重试还是同一个结果。
      const partial = String(received || '').trim();
      if (timedOut && partial) {
        reportUsage(null, partial, true);
        return `${partial}

${t('agent.llm.timeoutPartial')}`;
      }
      reportUsage(null, '', false);
      const err = new Error(timedOut
        ? t('agent.llm.timeoutError', undefined, { n: Math.round(timeoutMs / 1000) })
        : t('agent.llm.canceled'));
      err.code = timedOut ? 'TIMEOUT' : 'ABORTED';
      err.aborted = true;
      err.timeoutMs = timeoutMs;
      throw err;
    }
    reportUsage(null, '', false);
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
