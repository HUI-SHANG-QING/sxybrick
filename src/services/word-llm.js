// 英语单词 AI 生成服务
// 功能：用户只输入单词 → 自动生成同义词 / 相关词组 / 短语 / 2 种难度的例句（简单句 / 长难句）
// 设计：
//   1. 优先复用项目 agent 系统（如果 ctx.agent 可用）；
//   2. 降级到用户自填 LLM Key（豆包/DeepSeek/OpenAI 兼容）；
//   3. 调用前用 word-syllabus 过滤；超纲词直接拒生成（返回 skipped）；
//   4. 输出严格 JSON schema，便于 UI 直接消费。
//
// 注意：所有 prompt 都明确要求「原创」与「学习辅助用途」，避免调用方把任何
//       受版权保护的文本（例如教材原文、考题节选）原样回写；LLM 端如命中
//       受限内容应自行跳过，由调用方 fallback 到本地预设模板。

import { isInSyllabus, getSyllabusMeta } from './word-syllabus.js';
import { recordUsage, estimateTokens } from '../utils/ai-usage.js';

// ---------- Provider 配置 ----------
export const LLM_PROVIDERS = [
  { id: 'doubao', label: '豆包 Ark（火山引擎）', base: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-pro-32k' },
  { id: 'deepseek', label: 'DeepSeek', base: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI 兼容（自定义 base）', base: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
];

// ---------- Schema（与 AI 输出对齐） ----------
const SCHEMA_EXAMPLE = `{"level":"simple|long","sentence":"...","translation":"..."}`;
const SCHEMA_OUTPUT = `{
  "synonyms": ["..."],
  "collocations": ["..."],
  "phrases": ["..."],
  "examples": [
    {"level":"simple",   "sentence":"...","translation":"..."},
    {"level":"long",     "sentence":"...","translation":"..."}
  ],
  "pos": "n./v./adj./...",
  "mnemonic": "..."
}`;

function buildPrompt(word, opts) {
  const levelNotes = {
    simple: '简单句（10 词以内，初中难度）',
    long: '长难句（25-40 词，含从句/分词/倒装等结构）',
  };
  const only = (opts?.levels || ['simple', 'long']).join(', ');
  return [
    `你是英语学习辅助助手。请为单词「${word}」生成结构化学习资料。`,
    `要求：`,
    `1. 全部内容为原创教学素材，不得照搬任何教材原文、考题节选、词典释义原句；`,
    `2. 同义词 (synonyms) 4-6 个；词组搭配 (collocations) 4-6 个；相关短语 (phrases) 2-4 个；`,
    `3. 例句 (examples) 必须覆盖难度：${only}，每条对应：${Object.entries(levelNotes).map(([k, v]) => `${k}=${v}`).join('；')}`,
    `4. 输出严格 JSON（不要 Markdown 代码块、不要多余文字、不要注释）：`,
    SCHEMA_OUTPUT,
  ].join('\n');
}

// ---------- 主入口 ----------
/**
 * @param {object} req
 * @param {string} req.word         待生成单词/短语
 * @param {string[]} [req.levels]   需要哪些难度（默认 2 种：simple/long）
 * @param {object}   req.settings   wordSettings 单行（含 provider/key/model 等）
 * @param {object}   [req.agentCtx] 项目 agent ctx（如果有；优先调用）
 * @returns {Promise<{ok:boolean, skipped?:string, reason?:string, data?:object}>}
 */
export async function generateWordMaterials(req) {
  const word = String(req?.word || '').trim();
  if (!word) return { ok: false, reason: 'empty-word' };
  // 大纲过滤
  if (!isInSyllabus(word)) {
    return {
      ok: false,
      skipped: word,
      reason: `「${word}」不在考研大纲词表内，按设定跳过 AI 生成。词表：${getSyllabusMeta().title}`,
    };
  }
  const levels = Array.isArray(req.levels) && req.levels.length
    ? req.levels
    : ['simple', 'long'];
  const settings = req.settings || {};
  const agentCtx = req.agentCtx;

  // 1) 优先项目 agent
  if (agentCtx && typeof agentCtx.runAgent === 'function') {
    try {
      const raw = await agentCtx.runAgent({
        task: 'word-material-gen',
        input: word,
        prompt: buildPrompt(word, { levels }),
      });
      const data = parseJsonSafe(raw);
      if (data) return { ok: true, data: normalize(data, levels) };
    } catch (e) {
      // fallthrough 到用户 Key
      console.warn('[word-llm] agent failed, fallback to key:', e?.message);
    }
  }

  // 2) 用户自填 Key
  const provider = (settings.llmProvider || '').toLowerCase();
  const apiKey = settings.llmApiKey || '';
  const model = settings.llmModel || '';
  const baseOverride = settings.llmBase || '';
  if (!provider || !apiKey || !model) {
    return {
      ok: false,
      reason: '未配置 LLM：项目 agent 不可用且未填入 provider/key/model（设置 → AI 生成）。',
    };
  }
  const providerDef = LLM_PROVIDERS.find((p) => p.id === provider) || LLM_PROVIDERS[2];
  const base = (baseOverride || providerDef.base).replace(/\/+$/, '');

  try {
    const raw = await callChatCompletion({ base, apiKey, model, prompt: buildPrompt(word, { levels }) });
    const data = parseJsonSafe(raw);
    if (!data) return { ok: false, reason: 'LLM 返回非 JSON，无法解析。' };
    return { ok: true, data: normalize(data, levels) };
  } catch (e) {
    return { ok: false, reason: `LLM 调用失败：${e?.message || e}` };
  }
}

// ---------- HTTP 调用（用户 Key 路径） ----------
// P2-27：每次真实 AI 生成都记录用量到 db.aiUsage（与 AgentWorkbench 用量面板打通）。
//   仅在此直接 fetch 路径记账——agent 通道若经 agent/llm.js 的 chat 入口会自行记录，
//   这里再记会重复；连通性探针 testLlmConnection 不计（非内容生成，仅 4 token 探测）。
//   刻意 await 而非 fire-and-forget：recordUsage 内部已吞错不影响主流程，而一次生成
//   只有一次 ~1ms 写入，await 可保证记录不静默丢失且可被断言（agent/llm.js 仍沿用 void）。
async function callChatCompletion({ base, apiKey, model, prompt }) {
  const t0 = Date.now();
  const url = `${base}/chat/completions`;
  let content = '', usage = null;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是原创教学素材生成器。严格输出 JSON，不要任何额外文字。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.6,
        max_tokens: 1200,
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status} ${txt.slice(0, 200)}`);
    }
    const json = await resp.json();
    content = json?.choices?.[0]?.message?.content || '';
    usage = json?.usage; // OpenAI 兼容：{ prompt_tokens, completion_tokens, total_tokens }
  } catch (e) {
    await recordUsage({
      source: 'english-word', model,
      promptTokens: estimateTokens(prompt), completionTokens: estimateTokens(content),
      durationMs: Date.now() - t0, ok: false, est: 1,
    });
    throw e;
  }
  await recordUsage({
    source: 'english-word', model,
    promptTokens: usage?.prompt_tokens ?? estimateTokens(prompt),
    completionTokens: usage?.completion_tokens ?? estimateTokens(content),
    durationMs: Date.now() - t0, ok: true,
    est: usage?.prompt_tokens == null ? 1 : 0,
  });
  return content;
}

// ---------- 解析与归一化 ----------
function parseJsonSafe(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  // 去掉 ```json ... ``` 包裹
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // 尝试从混合文本中抠 JSON
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function normalize(data, levels) {
  const out = {
    synonyms: Array.isArray(data.synonyms) ? data.synonyms.slice(0, 6).map(String) : [],
    collocations: Array.isArray(data.collocations) ? data.collocations.slice(0, 6).map(String) : [],
    phrases: Array.isArray(data.phrases) ? data.phrases.slice(0, 4).map(String) : [],
    examples: [],
    pos: typeof data.pos === 'string' ? data.pos : '',
    mnemonic: typeof data.mnemonic === 'string' ? data.mnemonic : '',
  };
  if (Array.isArray(data.examples)) {
    for (const ex of data.examples) {
      const lv = String(ex.level || '').toLowerCase();
      if (!levels.includes(lv)) continue;
      if (typeof ex.sentence === 'string' && typeof ex.translation === 'string') {
        out.examples.push({ level: lv, sentence: ex.sentence, translation: ex.translation });
      }
    }
  }
  // 缺哪一档用本地模板补一条占位
  for (const lv of levels) {
    if (!out.examples.find((e) => e.level === lv)) {
      out.examples.push(localTemplate(lv));
    }
  }
  return out;
}

// LLM 失败 / 缺档时的本地占位模板（原创通用句型，不照搬任何词典例句）
function localTemplate(level) {
  const bank = {
    simple: { sentence: 'Please use this word in your own sentence.', translation: '请用这个单词造一个你自己的句子。' },
    long:   { sentence: 'Although the word may look simple at first glance, its usage in academic writing often requires careful attention to context, register, and collocation.', translation: '尽管这个单词乍看简单，但在学术写作中使用时往往需要仔细关注语境、语域与搭配。' },
  };
  return { level, ...(bank[level] || bank.simple) };
}

// ---------- 设置页用：测试连通性 ----------
export async function testLlmConnection(settings) {
  if (!settings?.llmApiKey) return { ok: false, reason: '未填写 Key' };
  const providerDef = LLM_PROVIDERS.find((p) => p.id === settings.llmProvider) || LLM_PROVIDERS[2];
  const base = (settings.llmBase || providerDef.base).replace(/\/+$/, '');
  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.llmApiKey}` },
      body: JSON.stringify({
        model: settings.llmModel || providerDef.defaultModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 4,
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return { ok: false, reason: `HTTP ${resp.status} ${t.slice(0, 120)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}