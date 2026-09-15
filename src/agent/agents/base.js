// src/agent/agents/base.js
// Agent 基类能力：基于 ReAct（推理-行动-观察）范式的通用执行循环。
// 设计要点：
//  - 用“文本协议”调用工具（<tool>/<args>/<final>），对任意 OpenAI 兼容端点零依赖、零配置。
//  - 每轮把工具结果以 tool 角色回灌，形成可多步推理的闭环——这就是“任务编排”的最小单元。
//  - 全程通过 onTrace 回传轨迹节点，UI 可实时展示 Agent 的思考过程。

import { toolRegistry } from '../registry.js';
import { compactToolPayload } from '../tools/compact.js';
import { TraceKind } from '../types.js';
import { buildLocalAnswer } from '../local-answer.js';
import { normalizeStructuredFinal } from '../../utils/ai-structured.js';
import { isOfflineReply } from '../../utils/offlineAI.js';
import { clipText } from '../../utils/clip.js';
import { t } from '../../i18n/index.js';

const PROTOCOL = `
你可以使用下方列出的工具来辅助回答。调用与收尾严格遵循以下格式：

1) 如需调用工具（每次仅一个），输出：
<tool>工具名</tool><args>{"参数名":"参数值"}</args>
2) 工具返回后，你会看到“工具 X 返回：...”，据此继续推理；
3) 当你已能完整回答用户时，必须输出：
<final>这里写给用户的最终回答</final>
注意：不要同时混用两种标签；<final> 之外不要输出多余说明。

4) 当答案本质是「一组条目 / 一张表 / 一张关系图」时，<final> 里**只输出**下面这种结构化 JSON
   （不要加任何解释文字，前端会按类型渲染成列表、表格或图，直接输出 JSON 文本反而不可读）：
   · 条目：{"type":"list","data":{"items":[{"title":"…","detail":"…"}]},"note":"…"}
   · 表格：{"type":"table","data":{"columns":["…"],"rows":[["…","…"]]}}
   · 关系/图谱/关键路径：{"type":"graph","data":{"kind":"force|critical-path","nodes":[{"id":"a","name":"停止-等待","category":"数据链路层"}],"links":[{"source":"a","target":"b","label":"服务于"}]},"note":"…"}
   · **出题/自测**：{"type":"quiz","data":{"questions":[{"q":"题干","options":["A 选项","B 选项","C 选项","D 选项"],"answer":"B","explain":"为什么选 B / 为什么不选 A","cardId":"若该题来自某张卡，填它的 id"}]}}
     quiz 会在界面上渲染成**可点击作答的题目**（用户点选项即判分并显示解析），所以：
     · 用户要「出题 / 考我 / 自测」时用它，**不要在正文里写 A/B/C/D 让用户自己对照答案**；
     · answer 用选项字母（A/B/C/D），options 2~6 个，explain 写清依据；
     · 题目来自某张卡时带上 cardId（用户答完可一键记入复习）；凭空新出的题不要编造 cardId。
   只有确实适合图形化表达时才用 graph；能用自然语言讲清的就用普通文本。
   切勿把工具返回的原始 JSON 原样抄给用户——那是给程序看的，不是给用户的答案。`;

/** 结构化输出协议（供测试与提示一致性校验引用） */
export const STRUCTURED_REPLY_CONTRACT = {
  list: '{"type":"list","data":{"items":[{"title":"","detail":""}]},"note":""}',
  table: '{"type":"table","data":{"columns":[],"rows":[]}}',
  graph: '{"type":"graph","data":{"kind":"","nodes":[],"links":[]},"note":""}',
  quiz: '{"type":"quiz","data":{"questions":[{"q":"","options":["",""],"answer":"A","explain":"","cardId":""}]}}',
};

function buildSystemPrompt(agent, ctx) {
  let p = agent.systemPrompt || '';
  if (agent.injectContext && ctx.studyContext) p = p.replace(/\{context\}/g, ctx.studyContext);
  if (agent.injectMemory && ctx.memoryText) p = p.replace(/\{memory\}/g, ctx.memoryText);
  if (agent.tools && agent.tools.length) {
    p += '\n\n【可用工具】\n' + toolRegistry.toPrompt(agent.tools) + '\n' + PROTOCOL;
  }
  return p;
}

export function parseToolCall(raw) {
  const text = String(raw);
  const m = text.match(/<tool>([^<]+)<\/tool>\s*<args>([\s\S]*?)<\/args>/);
  if (!m) return null;
  const name = m[1].trim();
  const argsRaw = m[2].trim() || '{}';
  let args = {};
  let parseError = null;
  try {
    args = JSON.parse(argsRaw);
    // 必须是对象（不接受数组/标量/null），否则下游展开会产出畸形参数
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      args = {};
      parseError = '参数必须是 JSON 对象';
    }
  } catch (e) {
    // BUG-03：JSON 解析失败不再静默当 {}（会把错参喂给工具、造成误导），
    // 而是把 parseError 带回，由调用方回灌给模型自我纠正。
    args = {};
    parseError = e.message || '参数不是合法 JSON';
  }
  // 提取工具标记之前的“思考”文字
  const thought = text.slice(0, m.index).trim();
  return { name, args, argsRaw, parseError, thought };
}

// round71：导出供回归测试直接校验「截断抢救」后的标签剥离行为
export function parseFinal(raw) {
  const m = String(raw).match(/<final>([\s\S]*?)<\/final>/);
  if (m) return m[1].trim();
  // 没有 <final> 标签时，若也没有 <tool> 标签，则整段视为最终回答。
  // round71：流式超时抢救回来的内容可能是「被砍在中间」的 <final>（只有开始标签没有结束标签），
  // 此时要把标签本身剥掉，否则用户会看到正文开头挂着一串 `<final>`。
  if (!/<tool>/.test(raw)) return String(raw).replace(/<\/?final>/g, '').trim();
  return null;
}

/**
 * 把 LLM 调用的失败原因翻成一句用户能看懂、能自救的话（round71）。
 *
 * 旧行为：不论什么原因（密钥失效 / 被限流 / 回答太长超时 / 上下文超长）都统一写
 * 「网络或服务异常」，用户只能反复重试同一件错事——明明是密钥过期，他却在重启路由器。
 * 这里按错误码/HTTP 状态给出精确原因，再交给 local-answer 显示。
 */
function explainLlmFailure(e) {
  const code = e?.code;
  const status = Number(e?.status);
  if (code === 'TIMEOUT') return t('agent.localAnswer.reasonTimeout');
  if (code === 'ABORTED') return t('agent.localAnswer.reasonCanceled');
  if (status === 401 || status === 403) return t('agent.localAnswer.reasonAuth');
  if (status === 404) return t('agent.localAnswer.reasonModel');
  if (status === 429) return t('agent.localAnswer.reasonRate');
  if (Number.isFinite(status) && status >= 500) return t('agent.localAnswer.reasonServer');
  if (Number.isFinite(status) && status > 0) return t('agent.localAnswer.reasonHttp', undefined, { status });
  return t('agent.localAnswer.reasonNetwork');
}

async function executeTool(name, args, ctx, onTrace) {
  const tool = toolRegistry.get(name);
  if (!tool) {
    const err = `未知工具：${name}`;
    onTrace?.({ kind: TraceKind.ERROR, text: err });
    return { ok: false, error: err };
  }
  onTrace?.({
    kind: TraceKind.TOOL_CALL,
    text: `调用工具 ${name}`,
    detail: JSON.stringify(args),
    tool: name,
  });
  try {
    const res = await tool.execute(args || {}, ctx);
    const preview = JSON.stringify(res?.data ?? res?.error ?? res);
    onTrace?.({
      kind: TraceKind.TOOL_RESULT,
      text: `工具 ${name} 返回`,
      detail: preview.length > 1200 ? preview.slice(0, 1200) + '…' : preview,
      tool: name,
    });
    return res;
  } catch (e) {
    onTrace?.({ kind: TraceKind.ERROR, text: `工具 ${name} 执行出错：${e.message}` });
    return { ok: false, error: e.message };
  }
}

/**
 * 把「工具观察」包成一条对话消息（round73 修，本轮最关键的修复）。
 *
 * **为什么不用原生 `role: 'tool'`**：
 * 本项目的工具调用是**文本协议**（`<tool>/<args>`，见 llm.js 的设计声明「不依赖原生 function
 * calling，保证任意兼容端点都能跑通」）。而 OpenAI / DeepSeek 等端点对 `role:'tool'` 有硬约束：
 * 它**必须**回应前一条带 `tool_calls` 的 assistant 消息，且必须带 `tool_call_id`。我们两者都没有，
 * 于是服务端直接 400：
 *   `messages with role 'tool' must be a response to a preceding message with 'tool_calls'`
 *
 * 后果正是用户报的现象：**Agent 每轮只要调过工具，第 2 次 LLM 调用必然 400 → 降级成本地直出**
 * （界面上就是「⚠️ AI 合成回答暂不可用」+ 一堆工具原始数据）；而「AI 学习助手」是单次问答、
 * 从不带工具消息，所以**一次就成功** —— 这个不对称就是这么来的。
 *
 * 解法：用 `user` 角色承载（文本协议下这就是「环境把工具结果告诉我」），
 * 并打内部标记 `__toolObs`，供 compactConvo 识别可压缩的中间产物（出站前会剥掉该标记）。
 */
function toolObservation(name, content) {
  return { role: 'user', content, __toolObs: true, __toolName: name };
}

// round48：整段上下文的**总量封顶**。此前各分项（记忆 / 单条工具结果）都有上限，但多步 ReAct
// 会把「每步完整 raw（含 thought）+ 工具回包」逐步累加、每步重发全量，长历史 + 大工具回包时
// 仍可能撑爆模型上下文（413，或服务端静默截断掉真正的对话）。
// 策略（**安全优先**）：只截断「工具观察 / 助手原文」这类可再生的中间产物（从旧到新），
// 绝不丢弃或改写 system 与用户消息——否则会丢掉用户真正的提问。
const CONVO_CHAR_BUDGET = 48000; // 约 1.2万~2.4万 token 量级，给模型上限留足余量
// round50 N2 回归需要直测码点截断，故导出（纯函数，无副作用）
export function compactConvo(convo) {
  const size = () => convo.reduce((n, m) => n + String(m?.content ?? '').length, 0);
  const over = size() > CONVO_CHAR_BUDGET;
  const hasInternal = convo.some((m) => m && (m.__toolObs || m.__toolName));
  // 常规路径（未超预算、无内部标记）：原样返回，零拷贝开销
  if (!over && !hasInternal) return convo;

  const out = [];
  for (const m of convo) {
    // 出站净化：`__toolObs` / `__toolName` 是内部标记，绝不能进请求体
    // （非标准字段会被严格网关判为非法请求）。
    const copy = { ...m };
    delete copy.__toolObs;
    delete copy.__toolName;
    // 可压缩对象 = 工具观察（原生 tool 角色 或 带标记的 user 消息）与 assistant 原文；
    // 真正的用户消息与 system 永不改动 —— 那是用户的原话，改了就是篡改提问。
    const compressible = m?.role === 'tool' || m?.__toolObs === true || m?.role === 'assistant';
    if (over && compressible) {
      const s = String(m.content ?? '');
      // round50 N2：按码点截断（防 emoji / 组合字符被劈成半个，预览尾部出现乱码 �）。
      // round67：改用 clipText —— 在码点安全之外，还保证 `![image](sxy-img://uuid)` 这类
      // 视觉引用不被切坏。此处是工具结果进 AI 的上下文压缩出口，切坏引用 = 图静默丢失。
      if (s.length > 1500) copy.content = clipText(s, 1500) + '…（已截断以控制上下文长度）';
    }
    out.push(copy);
  }
  return out;
}

/**
 * 运行一个 ReAct Agent。
 * @param {object} agent  Agent 定义
 * @param {Array} userMessages  历史消息（role/content）
 * @param {object} ctx  { chat, cfg, studyContext, memoryText }
 * @param {function} onTrace  轨迹回调
 * @returns {Promise<string>} 最终回答
 */
export async function runReActAgent({ agent, userMessages, ctx, onTrace }) {
  const systemPrompt = buildSystemPrompt(agent, ctx);
  const convo = [{ role: 'system', content: systemPrompt }, ...userMessages];

  // 本轮已成功返回数据的工具观察（{name, ok, data}）。用途：LLM 合成那一步掉线时，
  // 用它本地直出一份回答，而不是把【离线模式】占位丢给用户、白扔掉已到手的真实数据。
  const observations = [];

  // P1-9：step 上限同时取「agent 声明值」与「硬上限 12」的最小值，
  // 防止插件在 manifest 里自报 9999 导致单轮近万次 LLM 调用（费用爆炸 / 长时间无响应）。
  const MAX_STEPS = 12;
  const maxSteps = Math.min(Number.isFinite(agent.maxSteps) ? agent.maxSteps : 8, MAX_STEPS);
  for (let step = 0; step < maxSteps; step++) {
    let raw;
    try {
      raw = await ctx.chat(compactConvo(convo));
    } catch (e) {
      // 链路彻底断了（非网络错误也会走到这里）。已有工具数据 → 本地直出，保底给用户真内容。
      // round71：把**真实原因**一并带出去，别再一律写「网络或服务异常」。
      const local = buildLocalAnswer({ observations, reason: explainLlmFailure(e) });
      if (local) {
        onTrace?.({ kind: TraceKind.ERROR, text: `模型调用失败：${e?.message || e}` });
        onTrace?.({ kind: TraceKind.FINAL, text: local });
        return local;
      }
      throw e;
    }
    const toolCall = parseToolCall(raw);

    if (toolCall) {
      if (toolCall.thought) onTrace?.({ kind: TraceKind.THOUGHT, text: toolCall.thought });
      if (toolCall.parseError) {
        // BUG-03：args 解析失败不再静默调工具，回灌错误让模型重试（自我纠正闭环）
        onTrace?.({
          kind: TraceKind.ERROR,
          text: `工具 ${toolCall.name} 参数解析失败：${toolCall.parseError}`,
        });
        convo.push({ role: 'assistant', content: raw });
        // 同下方：工具反馈一律用 user 角色承载，见 toolObservation() 的说明
        convo.push(toolObservation(
          toolCall.name,
          `工具 ${toolCall.name} 参数解析失败：${toolCall.parseError}（原始参数：${toolCall.argsRaw}）。请用合法 JSON 对象重试。`,
        ));
        continue;
      }
      const res = await executeTool(toolCall.name, toolCall.args, ctx, onTrace);
      convo.push({ role: 'assistant', content: raw });
      // 工具结果必须**限量**再进上下文：卡片全文/OCR 长文本会让单请求轻易超限，
      // 表现为「AI 合成回答暂不可用」反复失败。压缩保留 JSON 结构（数组留前 N 项、
      // 长字段截断并标注原长度），并在超限时附说明，模型据此不会误以为"只有这些"。
      const payload = res?.ok === false
        ? `错误：${res.error}`
        : compactToolPayload(res?.data ?? res);
      convo.push(toolObservation(toolCall.name, `工具 ${toolCall.name} 返回：\n${payload}`));
      observations.push({
        name: toolCall.name,
        ok: res?.ok !== false,
        data: res?.ok === false ? null : (res?.data ?? res),
        error: res?.ok === false ? res.error : '',
      });
      continue;
    }

    const final = parseFinal(raw);
    if (final != null) {
      // 关键修复：raw 是离线兜底占位（模型没答出来，chatWithFallback 顶了段提示），
      // 而本轮已经拿到工具数据 → 用本地直出替换，绝不让占位覆盖真实结果。
      if (isOfflineReply(final) && observations.length) {
        const local = buildLocalAnswer({ observations, reason: t('agent.localAnswer.reasonOffline') });
        if (local) {
          onTrace?.({ kind: TraceKind.FINAL, text: local });
          return local;
        }
      }
      // 出口净化（2026-09-14）：模型可能给结构化 JSON 加引子（"结果如下：{...}"），
      // 剥离成纯 JSON 交给前端按类型渲染（list → 列表、graph → 图），否则又是一坨裸 JSON。
      const out = normalizeStructuredFinal(final);
      onTrace?.({ kind: TraceKind.FINAL, text: out });
      return out;
    }
    // 兜底：既无 tool 也无 final，视为异常，直接返回原文
    if (isOfflineReply(raw) && observations.length) {
      const local = buildLocalAnswer({ observations, reason: t('agent.localAnswer.reasonOffline') });
      if (local) {
        onTrace?.({ kind: TraceKind.FINAL, text: local });
        return local;
      }
    }
    const out = normalizeStructuredFinal(raw);
    onTrace?.({ kind: TraceKind.FINAL, text: out });
    return out;
  }
  const msg = '（已达到最大推理步数，Agent 提前结束）';
  onTrace?.({ kind: TraceKind.FINAL, text: msg });
  return msg;
}
