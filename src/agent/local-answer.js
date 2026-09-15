// src/agent/local-answer.js
// Agent 离线兜底回答器：当 ReAct 循环已经执行过工具（拿到了真实本地数据），
// 但随后的「把观察结果转成自然语言」那一步 LLM 调用失败（无 Key / 断网 / 超时）时，
// 不要丢弃已到手的工具结果——用这里把结构化数据确定性地渲染成 Markdown 回答。
//
// 设计原则（与 offlineAI.js 的分工）：
//   · offlineAI.offlineChat  —— 完全没有数据时的「掉线提示」（引导用户检查网络/配置）
//   · local-answer.buildLocalAnswer —— 有数据时的「本地直出」（用户至少能看到真实内容）
//
// 纯函数、零 IO、零新增依赖：只依赖 i18n 字典（字典本身零依赖），可在 node --test 下直接单测。

import { t } from '../i18n/index.js';

const MAX_ITEMS = 12;      // 单个工具结果最多罗列多少条（再多也没人看，且会撑爆气泡）
const MAX_JSON_CHARS = 1200; // 非列表结构退化为 JSON 代码块时的截断上限

/** 折叠空白 + 按字符截断（中文按字计，避免 Array.from 语义漂移） */
function clip(v, n = 60) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const chars = Array.from(s);
  return chars.length > n ? chars.slice(0, n).join('') + '…' : s;
}

/**
 * 从卡片正文抽取标题：优先首个 Markdown 标题行，其次首个非结构行。
 * 卡片 front 常是「# 知识卡片二 - 正面\n## 核心问题…」，直接 clip 会把换行后的
 * 小标题当成正题，故先从标题行取值。
 */
export function cardTitle(md) {
  const lines = String(md || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    const m = l.match(/^#{1,6}\s*(.+)$/);
    if (m) return clip(m[1], 60);
  }
  const plain = lines.find((l) => !/^([-*+>|]|\d+\.)/.test(l));
  return clip(plain || '', 60);
}

/** 把单条记录渲染成一行摘要（覆盖卡片 / 词卡 / 通用对象 / 标量四种形态） */
export function itemLine(it) {
  if (it == null) return '';
  if (typeof it !== 'object') return clip(it, 120);
  if (Array.isArray(it)) return clip(it.map((x) => (x == null ? '' : String(x))).join('，'), 120);

  // 通用卡片（search_cards / list_cards 返回行）
  if (it.front != null) {
    const title = cardTitle(it.front) || t('agent.localAnswer.untitled');
    const bits = [];
    if (it.subject) bits.push(clip(it.subject, 20));
    if (it.kind) bits.push(clip(it.kind, 12));
    if (it.level != null && it.level !== '') bits.push(`level ${it.level}`);
    if (Array.isArray(it.tags) && it.tags.length) bits.push(it.tags.slice(0, 3).map((x) => clip(x, 10)).join('/'));
    return bits.length ? `${title} — _${bits.join(' · ')}_` : title;
  }

  // 英语词卡（word 字段）
  if (it.word != null) {
    const m = it.meaning ? ` — ${clip(it.meaning, 40)}` : '';
    return `${clip(it.word, 40)}${m}`;
  }

  // 其它常见命名（笔记/资料/计划任务等）
  const named = it.title ?? it.name ?? it.label ?? it.text;
  if (named != null) return clip(named, 100);

  // 兜底：取前 4 个标量字段 k=v
  const kv = Object.entries(it)
    .filter(([, v]) => v == null || ['string', 'number', 'boolean'].includes(typeof v))
    .slice(0, 4)
    .map(([k, v]) => `${k}=${clip(v, 30)}`);
  return kv.join(t('agent.localAnswer.kvSep'));
}

/** 从工具返回的数据里取出「可罗列的行数组」 */
function toRows(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && Array.isArray(data.items)) return data.items;
  if (data && typeof data === 'object' && Array.isArray(data.rows)) return data.rows;
  if (data && typeof data === 'object' && Array.isArray(data.results)) return data.results;
  return null;
}

/**
 * 把一次工具观察渲染成 Markdown 段落。
 * @param {{name:string, ok?:boolean, data?:any, error?:string, args?:object}} ob
 * @returns {string}
 */
export function renderObservation(ob) {
  const name = clip(ob?.name || 'tool', 40);
  if (ob && ob.ok === false) {
    return `**${t('agent.localAnswer.toolFailed', undefined, { tool: name })}**\n\n${clip(ob.error || '', 300)}`;
  }
  const data = ob?.data;
  const rows = toRows(data);
  if (rows) {
    const total = Number(data?.total);
    const n = Number.isFinite(total) && total >= rows.length ? total : rows.length;
    const out = [`**${t('agent.localAnswer.listFrom', undefined, { tool: name, n })}**`, ''];
    rows.slice(0, MAX_ITEMS).forEach((it, i) => {
      const line = itemLine(it);
      if (line) out.push(`${i + 1}. ${line}`);
    });
    if (n > rows.length) out.push('', `_${t('agent.localAnswer.more', undefined, { n: n - rows.length })}_`);
    return out.join('\n');
  }
  if (data && typeof data === 'object') {
    return `**${t('agent.localAnswer.dataFrom', undefined, { tool: name })}**\n\n\`\`\`json\n${clip(JSON.stringify(data), MAX_JSON_CHARS)}\n\`\`\``;
  }
  if (data == null) return `**${t('agent.localAnswer.emptyFrom', undefined, { tool: name })}**`;
  return `**${t('agent.localAnswer.dataFrom', undefined, { tool: name })}**\n\n${clip(data, 300)}`;
}

/**
 * 用已拿到的工具结果拼出本地回答。
 * @param {{observations?:Array, reason?:string}} opt
 *   reason: 上游失败的真实原因（超时 / 限流 / 密钥无效 …）。带上它，用户才知道该改什么，
 *   而不是被一句笼统的「网络或服务异常」误导着反复重试同一件错事。
 * @returns {string} 无可用观察时返回 ''（调用方据此决定是否回退到 offlineChat 文案）
 */
export function buildLocalAnswer({ observations = [], reason = '' } = {}) {
  const usable = (observations || []).filter((o) => o && (o.ok === false || o.data != null));
  if (!usable.length) return '';

  const head = reason
    ? t('agent.localAnswer.noticeWithReason', undefined, { reason })
    : t('agent.localAnswer.notice');
  const blocks = [head, ''];
  for (const ob of usable) blocks.push(renderObservation(ob), '');
  blocks.push(`_${t('agent.localAnswer.retryHint')}_`);
  return blocks.join('\n');
}
