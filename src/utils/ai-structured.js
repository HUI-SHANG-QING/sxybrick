// src/utils/ai-structured.js
// AI / Agent 回复的「结构化结果」识别与渲染（纯函数，可测）。
//
// 背景（2026-09-14 用户反馈）：工具结果以 JSON 进上下文后，模型有时会**把 JSON 原样抄出来**当回答，
// 用户看到的是一大坨 `{"type":"list","data":{"items":[...]}}`——
// 既不可读，也浪费一次回答。用户要求：list 应渲染成列表、graph 应渲染成图，
// 而不是把 JSON 文本甩给用户。
//
// 设计原则（保守，绝不误伤正文）：
//   · 只认「整段就是一个 JSON 对象」（trim 后以 { 开头、} 结尾，或 ```json 代码块裹一层）；
//     正文里夹带的 JSON 片段一律不动——卡片正文/笔记里出现 JSON 是合法的用户内容；
//   · 必须同时具备 type 与 data 字段才认定为结构化回复（否则当普通文本）；
//   · 渲染失败/类型不认识 → 返回 null，调用方按原文显示（降级不丢信息）。

/** 支持的形状（与 Agent 提示协议、前端渲染分支保持一致） */
export const STRUCTURED_TYPES = ['list', 'table', 'graph', 'cards', 'keyvalue'];

/**
 * 尝试把一段回复解析为结构化结果。
 * @param {string} text
 * @returns {{type:string, data:object, note:string, raw:string}|null}
 */
export function parseStructuredReply(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  let body = raw;
  // ```json ... ``` / ``` ... ``` 包裹（模型最常见的输出形态）
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) body = fence[1].trim();

  // 严格门禁：整段必须是一个 JSON 对象
  if (!(body.startsWith('{') && body.endsWith('}'))) return null;

  let obj;
  try { obj = JSON.parse(body); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const type = String(obj.type || obj.shape || '').trim().toLowerCase();
  if (!type) return null;
  // 必须有 data（list/graph/table… 的数据体）；note 可选
  if (obj.data == null) return null;

  return {
    type,
    data: obj.data,
    note: typeof obj.note === 'string' ? obj.note : '',
    raw,
  };
}

const esc = (s) => String(s ?? '').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));

/** list：{ items: [{title, detail, meta?}] } → 有序列表 */
function listToMd(data) {
  const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : null);
  if (!items || !items.length) return null;
  const lines = items.map((it, i) => {
    if (it == null) return `${i + 1}. —`;
    if (typeof it === 'string') return `${i + 1}. ${esc(it)}`;
    const title = esc(it.title || it.name || it.word || it.front || `#${i + 1}`);
    const detail = esc(it.detail || it.desc || it.note || it.meaning || it.back || '');
    const meta = esc(it.meta || it.subject || '');
    const tail = [detail, meta].filter(Boolean).join(' · ');
    return `${i + 1}. **${title}**${tail ? ` — ${tail}` : ''}`;
  });
  return lines.join('\n');
}

/** table：{ columns:[...], rows:[[...]] } 或 rows:[{...}] → Markdown 表格 */
function tableToMd(data) {
  const rows = Array.isArray(data?.rows) ? data.rows : null;
  if (!rows || !rows.length) return null;
  if (Array.isArray(rows[0])) {
    const cols = Array.isArray(data.columns) && data.columns.length
      ? data.columns.map(esc)
      : rows[0].map((_, i) => `列${i + 1}`);
    const head = `| ${cols.join(' | ')} |`;
    const sep = `| ${cols.map(() => '---').join(' | ')} |`;
    const body = rows.map((r) => `| ${(Array.isArray(r) ? r : []).map(esc).join(' | ')} |`).join('\n');
    return [head, sep, body].join('\n');
  }
  // 对象数组：列取并集
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
  if (!cols.length) return null;
  const head = `| ${cols.map(esc).join(' | ')} |`;
  const sep = `| ${cols.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${cols.map((c) => esc(r?.[c])).join(' | ')} |`).join('\n');
  return [head, sep, body].join('\n');
}

/** cards：[{front, back, subject?}] → 问答列表（比裸 JSON 好读，但不落库） */
function cardsToMd(data) {
  const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : null);
  if (!items || !items.length) return null;
  const lines = items.map((c, i) => {
    const front = esc(c?.front || c?.title || c?.word || '');
    const back = esc(c?.back || c?.detail || c?.meaning || '');
    const subject = esc(c?.subject || '');
    return `**${i + 1}. ${front}**${subject ? `（${subject}）` : ''}\n\n${back}`;
  });
  return lines.join('\n\n');
}

/** keyvalue / 兜底：平铺对象 → 键值列表；数组 → 逐项列表 */
function genericToMd(data) {
  if (Array.isArray(data)) return listToMd({ items: data });
  if (!data || typeof data !== 'object') return null;
  const entries = Object.entries(data).filter(([, v]) => v != null);
  if (!entries.length) return null;
  // 值里有长数组/对象时给个紧凑表示，避免又变成一坨 JSON
  const fmt = (v) => {
    if (Array.isArray(v)) {
      const head = v.slice(0, 8).map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x)));
      return head.join('；') + (v.length > 8 ? `；…还有 ${v.length - 8} 项` : '');
    }
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 300);
    return String(v);
  };
  return entries.map(([k, v]) => `- **${esc(k)}**：${esc(fmt(v))}`).join('\n');
}

/**
 * 把结构化结果渲染成 Markdown（便于现有的 MarkdownRenderer 统一展示）。
 * @param {{type:string, data:object, note?:string}} parsed
 * @returns {string|null} null = 该类型应交由专用组件渲染（如 graph）或无法渲染
 */
export function structuredToMarkdown(parsed) {
  if (!parsed || !parsed.type) return null;
  const { type, data, note } = parsed;
  let body = null;
  if (type === 'list') body = listToMd(data);
  else if (type === 'table') body = tableToMd(data);
  else if (type === 'cards') body = cardsToMd(data);
  else if (type === 'keyvalue') body = genericToMd(data);
  else if (type === 'graph') return null; // 交给图表组件渲染
  else body = genericToMd(data);
  if (!body) return null;
  return note ? `${note}\n\n${body}` : body;
}

/** 该结构化结果是否需要交给专用图组件渲染 */
export function isGraphReply(parsed) {
  return !!parsed && parsed.type === 'graph' && parsed.data && typeof parsed.data === 'object';
}

/**
 * 从 graph 结构里规整出 ECharts 需要的 nodes/links（容错各种字段命名）。
 * @param {object} data
 * @returns {{nodes:Array, links:Array, kind:string}|null}
 */
export function normalizeGraphData(data) {
  if (!data || typeof data !== 'object') return null;
  const rawNodes = Array.isArray(data.nodes) ? data.nodes : (Array.isArray(data.vertices) ? data.vertices : []);
  const rawLinks = Array.isArray(data.links) ? data.links
    : (Array.isArray(data.edges) ? data.edges : (Array.isArray(data.relations) ? data.relations : []));
  if (!rawNodes.length) return null;
  const nodes = rawNodes.map((n, i) => {
    if (typeof n === 'string') return { id: n, name: n, category: '' };
    const id = String(n.id ?? n.key ?? n.name ?? `n${i}`);
    return {
      id,
      name: String(n.name ?? n.label ?? n.title ?? id),
      category: String(n.category ?? n.group ?? n.subject ?? ''),
      value: n.value ?? n.count ?? 1,
    };
  });
  const idSet = new Set(nodes.map((n) => n.id));
  const nameToId = new Map(nodes.map((n) => [n.name, n.id]));
  const links = rawLinks.map((l) => {
    const s = String(l?.source ?? l?.from ?? '');
    const t = String(l?.target ?? l?.to ?? '');
    return {
      source: idSet.has(s) ? s : (nameToId.get(s) || s),
      target: idSet.has(t) ? t : (nameToId.get(t) || t),
      label: String(l?.label ?? l?.relation ?? l?.name ?? ''),
    };
  }).filter((l) => idSet.has(l.source) && idSet.has(l.target) && l.source !== l.target);
  return { nodes, links, kind: String(data.kind ?? data.layout ?? '').toLowerCase() };
}

/**
 * 回复出口净化：把「带引子的结构化 JSON」剥离成前端可渲染的纯 JSON。
 *
 * 场景（2026-09-14 用户实测）：模型按协议把工具结果抄出来，但常给 JSON 加个引子——
 *   `结果如下：\n\n{"type":"list","data":{...}}` 或
 *   `根据查询：\n\n```json\n{...}\n````
 * parseStructuredReply 只认「整段就是 JSON/代码块」，这类带前后缀的会被当成普通文本
 * 原样展示 → 用户又看到一坨 JSON。
 *
 * 规则（保守，绝不误伤正文）：
 *   · 已经能被 parseStructuredReply 识别的 → 原样返回；
 *   · 从文本中提取「第一个 { 到最后一个 }」之间的 JSON，且：
 *       a) 可解析为合法对象；
 *       b) 带 type + data（结构化回复特征）；
 *       c) 前后缀都 ≤ 40 字符（判定为「模型加了个引子」，而不是正文里夹 JSON）。
 *     同时满足才剥离；否则原样返回。
 * @param {string} text
 * @returns {string}
 */
export function normalizeStructuredFinal(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return raw;
  if (parseStructuredReply(raw)) return raw;

  // round44 N2：优先尝试「代码围栏」提取——正文里若还有第二个 {...} 示例文本，
  // 下面的 first/last 兜底扫描会把最后一个 } 截进候选、解析失败。围栏块是模型
  // 表达「这就是结构化回复」的最强信号，命中且带 type+data 就直接采用；
  // 未命中或解析失败再走原有的首尾扫描兜底（保守规则不变）。
  const fence = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fence) {
    try {
      const obj = JSON.parse(fence[1]);
      const type = String(obj?.type || obj?.shape || '').trim().toLowerCase();
      if (type && obj.data != null) return fence[1];
    } catch { /* 围栏内容不是合法结构化 JSON，走兜底 */ }
  }

  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last <= first) return raw;
  const prefix = raw.slice(0, first).trim();
  const suffix = raw.slice(last + 1).trim();
  if (prefix.length > 40 || suffix.length > 40) return raw;

  const body = raw.slice(first, last + 1);
  try {
    const obj = JSON.parse(body);
    const type = String(obj?.type || obj?.shape || '').trim().toLowerCase();
    if (type && obj.data != null) return body;
  } catch { /* 不是合法 JSON，按原文返回 */ }
  return raw;
}
