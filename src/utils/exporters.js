/**
 * 通用导出工具（纯函数层，Node 可测）
 *
 * 路由：
 *   - triggerDownload(blob, filename) 浏览器侧下载（Node 环境仅返回 blob 供测试）
 *   - toJSON(data)                     通用 JSON 导出（带 .meta 层结构）
 *   - toMarkdown(data, opts)           通用 Markdown 导出
 *   - toCSV(rows, opts)                通用 CSV（RFC 4180 转义）
 *
 * 4 个具体导出器（封装通用函数 + 业务 schema）：
 *   - exportCardsToJSON / exportCardsToCSV / exportCardsToMarkdown / exportCardsToApkg*
 *   - exportNotesToJSON / exportNotesToMarkdown
 *   - exportMemosToJSON / exportMemosToMarkdown / exportMemosToCSV
 *   - exportGraphToJSON / exportGraphToGraphML / exportGraphToMarkdown
 *
 * *Apkg 复已有 src/utils/apkg.js（buildApkg），这里只做壳。
 *
 * 设计原则：
 *  - 纯函数：无 Vue / 无 DB / 无 DOM（triggerDownload 是唯一边界）
 *  - 元数据标注导出时间、版本、过滤条件，便于溯源
 *  - Markdown 兼容 CommonMark + GFM 表格（Obsidian/Typora/VSCode 原生可读）
 *  - CSV 严格 RFC 4180：BOM 可选转义、CRLF、字段含 , " 换行 时整体加双引号并双倍转义
 */

// ──────────────── 边界：下载触发 ────────────────

const APP_META = { app: 'SxyBrick', exportFormatVersion: 1 };

/**
 * 触发浏览器下载。返回 blob 供测试断言（Node 环境无 DOM）。
 * @returns {Blob | null} 浏览器环境下返回 null（已触发下载）；Node 环境返回原 blob。
 */
export function triggerDownload(blob, filename) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return blob;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'export';
  // 兼容：在 iOS PWA 中，append 到 body 才生效
  document.body.appendChild(a);
  a.click();
  // 延迟释放：避免某些浏览器在 click 同步链路里 url 已失效
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
  return null;
}

/** 拼 MIME，避免直接引用 Blob 工厂 */
function makeBlob(text, mime) {
  if (typeof Blob === 'undefined') return null;
  return new Blob([text], { type: `${mime};charset=utf-8` });
}

// ──────────────── JSON ────────────────

/**
 * 通用 JSON 导出。自动包裹一层 meta 便于溯源。
 * 自动排除不可序列化字段（function / symbol / undefined 静默剔除）。
 */
export function toJSON(payload, { pretty = true, meta = {} } = {}) {
  const obj = {
    ...APP_META,
    exportedAt: new Date().toISOString(),
    ...meta,
    payload,
  };
  return JSON.stringify(obj, null, pretty ? 2 : 0);
}

// ──────────────── Markdown ────────────────

/**
 * 安全转义 Markdown 表格竖线/换行（GFM 表格里 | 是分隔符，必须转义）。
 */
function escMdPipe(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * CSV 单元安全转义（双引号 " 需重复一次；含 , " 换行 → 整个加双引号）。
 */
function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * 通用 Markdown 表格渲染（无 rows 时返回空串 + 提示）。
 *   thead: ['A', 'B']
 *   rows: [['x', 'y']]
 */
export function mdTable(thead, rows) {
  if (!Array.isArray(thead) || !thead.length) return '';
  if (!Array.isArray(rows) || !rows.length) return '_（无数据）_';
  const safeThead = thead.map(escMdPipe);
  const sep = safeThead.map(() => '---');
  const body = rows.map(r => safeThead.map((_, i) => escMdPipe(r?.[i])).join(' | '));
  return [safeThead.join(' | '), sep.join(' | '), ...body].join('\n');
}

// ──────────────── CSV ────────────────

/**
 * RFC 4180 CSV。第一行 thead（按列定义顺序），第二行起 rows。
 * 行分隔符固定 CRLF（Excel 稳定 + Windows 原生）。
 */
export function toCSV(thead, rows, { withBOM = false } = {}) {
  if (!Array.isArray(thead) || !thead.length) throw new Error('toCSV: thead 不能为空');
  const headLine = thead.map(csvEscape).join(',');
  const bodyLines = (rows || []).map(r => thead.map((_, i) => csvEscape(r?.[i])).join(','));
  const text = [headLine, ...bodyLines].join('\r\n') + '\r\n';
  // Excel 在中文环境下需要 UTF-8 BOM 才能识别中文
  const bom = withBOM ? '\uFEFF' : '';
  return bom + text;
}

// ──────────────── 业务：Cards ────────────────

/** 导出卡片时主键列（顺序即 CSV 列顺序 / Markdown 表格列顺序） */
const CARD_COLS = [
  { key: 'id', label: 'ID' },
  { key: 'front', label: '正面' },
  { key: 'back', label: '背面' },
  { key: 'subject', label: '科目' },
  { key: 'tags', label: '标签', transform: arr => Array.isArray(arr) ? arr.join(',') : '' },
  { key: 'ease', label: '难度' },
  { key: 'level', label: '等级' },
  { key: 'intervalDays', label: '间隔(天)' },
  { key: 'dueAt', label: '到期时间', transform: v => v ? new Date(v).toISOString() : '' },
  { key: 'createdAt', label: '创建时间', transform: v => v ? new Date(v).toISOString() : '' },
];

function pickRow(card, cols) {
  const obj = {};
  for (const c of cols) {
    const raw = card?.[c.key];
    obj[c.key] = c.transform ? c.transform(raw) : (raw ?? '');
  }
  return obj;
}

export function exportCardsToJSON(cards, meta = {}) {
  return toJSON(cards, { meta: { kind: 'cards', count: cards.length, ...meta } });
}

export function exportCardsToCSV(cards, { withBOM = true } = {}) {
  const rows = cards.map(c => CARD_COLS.map(c2 => {
    const raw = c?.[c2.key];
    return c2.transform ? c2.transform(raw) : (raw ?? '');
  }));
  return toCSV(CARD_COLS.map(c => c.label), rows, { withBOM });
}

export function exportCardsToMarkdown(cards, meta = {}) {
  const lines = [];
  lines.push(`# 卡片导出`);
  if (meta.subject) lines.push(`> 科目：${meta.subject}`);
  if (meta.tag) lines.push(`> 标签：${meta.tag}`);
  lines.push(`> 导出时间：${new Date().toISOString()}`);
  lines.push(`> 共 ${cards.length} 张\n`);
  lines.push(mdTable(
    CARD_COLS.map(c => c.label),
    cards.map(c => CARD_COLS.map(c2 => {
      const raw = c?.[c2.key];
      return c2.transform ? c2.transform(raw) : (raw ?? '');
    }))
  ));
  return lines.join('\n');
}

// ──────────────── 业务：Memos（Memo.vue 四象限） ────────────────

const MEMO_COLS = [
  { key: 'id', label: 'ID' },
  { key: 'text', label: '备忘' },
  { key: 'quadrant', label: '象限', transform: (_, m) =>
    m?.important && m?.urgent ? '重要×紧急' :
    m?.important ? '重要×非紧急' :
    m?.urgent ? '非重要×紧急' : '非重要×非紧急' },
  { key: 'createdAt', label: '创建时间', transform: v => v ? new Date(v).toISOString() : '' },
];

export function exportMemosToJSON(memos) {
  return toJSON(memos, { meta: { kind: 'memos', count: memos.length } });
}

export function exportMemosToMarkdown(memos) {
  const lines = [
    `# 备忘录导出`,
    `> 导出时间：${new Date().toISOString()}`,
    `> 共 ${memos.length} 条\n`,
    mdTable(
      MEMO_COLS.map(c => c.label),
      memos.map(m => MEMO_COLS.map(c => {
        const raw = m?.[c.key];
        return c.transform ? c.transform(raw, m) : (raw ?? '');
      }))
    ),
  ];
  return lines.join('\n');
}

export function exportMemosToCSV(memos) {
  const rows = memos.map(m => MEMO_COLS.map(c => {
    const raw = m?.[c.key];
    return c.transform ? c.transform(raw, m) : (raw ?? '');
  }));
  return toCSV(MEMO_COLS.map(c => c.label), rows, { withBOM: true });
}

// ──────────────── 业务：Notes（通用笔记 schema；供 P7.1 复用） ────────────────

const NOTE_COLS = [
  { key: 'id', label: 'ID' },
  { key: 'title', label: '标题' },
  { key: 'category', label: '分类' },
  { key: 'tags', label: '标签', transform: arr => Array.isArray(arr) ? arr.join(',') : '' },
  { key: 'content', label: '正文' },
  { key: 'updatedAt', label: '更新时间', transform: v => v ? new Date(v).toISOString() : '' },
];

export function exportNotesToJSON(notes) {
  return toJSON(notes, { meta: { kind: 'notes', count: notes.length } });
}

export function exportNotesToMarkdown(notes) {
  const lines = [
    `# 笔记导出`,
    `> 导出时间：${new Date().toISOString()}`,
    `> 共 ${notes.length} 条\n`,
  ];
  for (const n of notes) {
    const tags = Array.isArray(n?.tags) && n.tags.length ? ` *(${n.tags.join(', ')})*` : '';
    const cat = n?.category ? ` \`${n.category}\`` : '';
    lines.push(`## ${n?.title || '(无标题)'}${cat}${tags}`);
    lines.push('');
    lines.push(String(n?.content || '').trim());
    lines.push('\n---');
  }
  return lines.join('\n');
}

// ──────────────── 业务：Graph Edges（知识图谱） ────────────────

/**
 * 边 → 行转换（统一格式，资料边 type=doc-card 与卡片边 type=card-card 共用）。
 */
function edgeToRow(e) {
  return {
    from: e.from || '',
    to: e.to || '',
    label: e.label || '相关',
    type: e.type || 'card-card',
    docId: e.docId || '',
    subject: e.subject || '',
    createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : '',
  };
}

export function exportGraphToJSON(edges, meta = {}) {
  const nodes = new Set();
  edges.forEach(e => { nodes.add(e.from); nodes.add(e.to); });
  return toJSON({
    nodes: [...nodes].map(id => ({ id })),
    edges: edges.map(edgeToRow),
  }, { meta: { kind: 'graph', nodes: nodes.size, edges: edges.length, ...meta } });
}

/** GraphML（导入 Gephi / Cytoscape / Neo4j 等图工具的标准格式） */
export function exportGraphToGraphML(edges, meta = {}) {
  const nodeIds = new Set();
  edges.forEach(e => { nodeIds.add(e.from); nodeIds.add(e.to); });
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphstruct.org/xmlns">',
    '  <key id="label" for="edge" attr.name="label" attr.type="string"/>',
    '  <key id="type" for="edge" attr.name="type" attr.type="string"/>',
    '  <key id="docId" for="edge" attr.name="docId" attr.type="string"/>',
    '  <key id="subject" for="edge" attr.name="subject" attr.type="string"/>',
    `  <graph id="SxyBrick" edgedefault="directed">`,
  ];
  for (const id of nodeIds) {
    lines.push(`    <node id="${escapeXml(id)}"/>`);
  }
  for (const e of edges) {
    lines.push(
      `    <edge source="${escapeXml(e.from || '')}" target="${escapeXml(e.to || '')}">`,
      `      <data key="label">${escapeXml(e.label || '相关')}</data>`,
      `      <data key="type">${escapeXml(e.type || 'card-card')}</data>`,
      `      <data key="docId">${escapeXml(e.docId || '')}</data>`,
      `      <data key="subject">${escapeXml(e.subject || '')}</data>`,
      `    </edge>`,
    );
  }
  lines.push('  </graph>', '</graphml>');
  return lines.join('\n');
}

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function exportGraphToMarkdown(edges) {
  const lines = [
    `# 知识图谱导出`,
    `> 导出时间：${new Date().toISOString()}`,
    `> 共 ${edges.length} 条边\n`,
    mdTable(
      ['起点', '关系', '终点', '类型', '来源资料', '科目'],
      edges.map(e => [
        e.from || '',
        e.label || '相关',
        e.to || '',
        e.type || 'card-card',
        e.docId || '',
        e.subject || '',
      ])
    ),
  ];
  return lines.join('\n');
}

// ──────────────── 业务：Library（资料库导出索引） ────────────────

const DOC_COLS = [
  { key: 'id', label: 'ID' },
  { key: 'name', label: '文件名' },
  { key: 'subject', label: '科目' },
  { key: 'type', label: '类型' },
  { key: 'status', label: '状态' },
  { key: 'sizeText', label: '大小' },
  { key: 'textLen', label: '文本字数' },
  { key: 'createdAt', label: '上传时间', transform: v => v ? new Date(v).toISOString() : '' },
];

export function exportLibraryToJSON(docFiles, countTextLenFn) {
  // countTextLenFn(id) => number 异步取 docTexts；为纯函数分离 UI 副作用
  return toJSON(docFiles.map(d => ({
    ...d,
    textLen: typeof countTextLenFn === 'function' ? (countTextLenFn(d.id) || 0) : (d.textLen || 0),
  })), { meta: { kind: 'docFiles', count: docFiles.length } });
}

export function exportLibraryToMarkdown(docFiles, countTextLenFn) {
  const rows = docFiles.map(d => [
    d.id, d.name || '', d.subject || '', d.type || '', d.status || '',
    d.sizeText || '', typeof countTextLenFn === 'function' ? (countTextLenFn(d.id) || 0) : (d.textLen || 0),
    d.createdAt ? new Date(d.createdAt).toISOString() : '',
  ]);
  return [
    `# 资料库导出`,
    `> 导出时间：${new Date().toISOString()}`,
    `> 共 ${docFiles.length} 个资料\n`,
    mdTable(DOC_COLS.map(c => c.label), rows),
  ].join('\n');
}

// ──────────────── 文件名工具 ────────────────

/**
 * 拼带时间戳的默认文件名，避免覆盖；非法字符替换为 _。
 * 例：cards-export-2026-08-28-12-34.json
 */
export function defaultFilename(prefix, ext) {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const safe = String(prefix).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  return `${safe}-${ts}.${ext.replace(/^\./, '')}`;
}

/** 一次性便捷：导出文本 → blob → 触发下载 */
export function downloadText(text, filename, mime = 'text/plain') {
  const blob = makeBlob(text, mime);
  if (!blob) return null;
  return triggerDownload(blob, filename);
}
