/**
 * 笔记解析器（纯函数层，Node 可测）
 *
 * 核心能力：
 *  1) 双向链接识别：从 Markdown 文本里识别 `[[card-id]]` / `[[doc-id]]` / `[[note-id]]`
 *     - 用花括号扩展可加别名：`[[card-id|别名]]` → 显示「别名」但指向 card-id
 *     - 这种语法与 Obsidian / Roam / RemNote 类似，学习成本 0
 *  2) 反向链接：给定一张卡片/资料/笔记 id，返回所有"链接到它"的笔记 id 集合
 *  3) #标签提取：标题/正文中出现的 #xxx 转为 tags（去 #、转小写、去重）
 *  4) 字数 / 摘要统计（无 DOM 依赖，all 纯字符串）
 *
 * 设计原则：
 *  - 纯函数：无 Vue / 无 DB / 无 DOM
 *  - 容错优先：无法识别的 [[xxx]] 保留原样不删除（避免破坏 markdown 结构）
 *  - 性能 O(n)：单正则扫描全文一遍就够
 *
 * 节点前缀约定（用于 [[type-id]] 形式的精确寻址）：
 *  - [[c<id>]]        → 卡片（c 前缀）
 *  - [[d<id>]]        → 资料文档（d 前缀）
 *  - [[n<id>]]        → 笔记（n 前缀）
 *  - [[<id>]]         → 未指定前缀，按 id 唯一识别（需 callers 显式查找）
 * 实际实现：默认不强制前缀，recognizeWikiLinks 返回完整元数据，方便 UI 层决定如何显示
 */

// 双向链接识别正则：`[[xxx]]` 或 `[[xxx|别名]]`
//   排除换行嵌入 `[[abc\ndef]]`，避免误识别
const WIKI_LINK_RE = /\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n|]+?))?\]\]/g;
// #标签识别正则：`#xxx` 不再含空白字符 + 中文英文都允许
const TAG_RE = /(?:^|[\s\u3000,，;；])#([\p{L}\p{N}_-]+)/gu;

/** 节点类型枚举（供 UI 层查表用） */
export const NODE_TYPES = {
  CARD: 'card',
  DOC: 'doc',
  NOTE: 'note',
  UNKNOWN: 'unknown',
};

/**
 * 推断一个 id 字符串的节点类型（基于前缀约定）
 *  c 前缀 → card；d 前缀 → doc；n 前缀 → note
 */
export function inferNodeType(id) {
  const s = String(id || '').trim();
  if (!s) return NODE_TYPES.UNKNOWN;
  if (s.startsWith('c')) return NODE_TYPES.CARD;
  if (s.startsWith('d')) return NODE_TYPES.DOC;
  if (s.startsWith('n')) return NODE_TYPES.NOTE;
  return NODE_TYPES.UNKNOWN;
}

/**
 * 从一段 Markdown 文本里识别所有双向链接
 * @param {string} text Markdown 文本
 * @returns {Array<{ id, alias, type, raw }>}
 *   id:    链接目标 id
 *   alias: 别名（未指定则与 id 相同）
 *   type:  推断的节点类型
 *   raw:   原始字符串（含 [[ ]]）
 */
export function recognizeWikiLinks(text) {
  const out = [];
  if (!text) return out;
  const s = String(text);
  // 重置 lastIndex 防御（因为声明为全局正则）
  WIKI_LINK_RE.lastIndex = 0;
  let m;
  while ((m = WIKI_LINK_RE.exec(s)) !== null) {
    const id = String(m[1] || '').trim();
    const alias = String(m[2] || '').trim() || id;
    out.push({ id, alias, type: inferNodeType(id), raw: m[0] });
  }
  return out;
}

/**
 * 计算"反向链接"：返回所有引用了 targetId 的笔记 id 集合
 * @param {Array<{id, content}>} notes 笔记列表（轻量：只需要 id + content 即可）
 * @param {string} targetId 目标 id
 * @returns {Set<string>} 来源笔记 id 集合
 */
export function findBacklinks(notes, targetId) {
  const out = new Set();
  if (!targetId) return out;
  for (const n of notes || []) {
    if (!n?.id || !n?.content) continue;
    const links = recognizeWikiLinks(n.content);
    if (links.some(l => l.id === targetId)) out.add(n.id);
  }
  return out;
}

/**
 * 渲染双向链接：将 `[[id]]` 转为 HTML <a> / `[别名](id)` 形式
 * @param {string} text Markdown 文本
 * @param {Function} hrefBuilder (id, type) => string
 * @returns {string} 替换后的字符串（未识别的 [[xxx]] 保留原样）
 */
export function renderWikiLinks(text, hrefBuilder) {
  if (!text) return '';
  return String(text).replace(WIKI_LINK_RE, (whole, id, alias) => {
    const tid = String(id || '').trim();
    const aliasText = String(alias || '').trim() || tid;
    const type = inferNodeType(tid);
    let href = '#';
    try { href = hrefBuilder?.(tid, type) || '#'; } catch { href = '#'; }
    // 标签属性方便 CSS 样式与权限判断
    return `<a class="wiki-link" data-id="${escapeAttr(tid)}" data-type="${type}" href="${escapeAttr(href)}">${escapeHtml(aliasText)}</a>`;
  });
}

/**
 * 提取 # 标签（标题 + 正文合并，去 #、转小写、去重）
 * @returns {string[]} 标签数组
 */
export function extractTags(title, content) {
  const set = new Set();
  for (const src of [title, content]) {
    if (!src) continue;
    TAG_RE.lastIndex = 0;
    let m;
    while ((m = TAG_RE.exec(src)) !== null) {
      const tag = String(m[1]).toLowerCase().trim();
      if (tag && tag.length <= 32) set.add(tag);
    }
  }
  return [...set];
}

/**
 * 计算笔记字数（中英文字符都算 1 字，纯空白不计）
 */
export function countChars(content) {
  if (!content) return 0;
  // 去除所有空白字符后再算长度（CJK 字符与英文字母都按 1 计）
  return String(content).replace(/\s+/g, '').length;
}

/**
 * 生成纯文本摘要（取前 N 字，省略号兜底）
 */
export function summarize(content, { len = 120 } = {}) {
  if (!content) return '';
  // 优先去掉双向链接的 [[ ]]
  const clean = String(content)
    .replace(/\[\[([^\[\]\n|]+?)(?:\|[^\[\]\n|]+?)?\]\]/g, '$1')
    .replace(/[#*`>\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > len ? clean.slice(0, len) + '…' : clean;
}

// ──────────────── 转义工具 ────────────────

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

// ──────────────── 校验 ────────────────

/**
 * 一份笔记的最小必需字段（用于建笔记前/导入前校验）
 */
export function validateNote(note) {
  const errors = [];
  if (!note || typeof note !== 'object') errors.push('note 必须是对象');
  if (!note?.title?.trim()) errors.push('title 必填');
  if (note?.content != null && typeof note.content !== 'string') errors.push('content 必须是字符串');
  if (note?.category != null && typeof note.category !== 'string') errors.push('category 必须是字符串');
  if (note?.tags != null && !Array.isArray(note.tags)) errors.push('tags 必须是数组');
  if (note?.linkedCardIds != null && !Array.isArray(note.linkedCardIds)) errors.push('linkedCardIds 必须是数组');
  return { valid: errors.length === 0, errors };
}

/**
 * 把外部输入（口述 / 表单）归一为标准 note payload：
 *  - 自动从 content 抽取 [[x]] 关联到 linkedCardIds/linkedDocIds
 *  - 自动从 title + content 抽取 #tags 合并到 tags
 *  - 自动补 createdAt / updatedAt
 */
export function normalizeNotePayload(raw, opts = {}) {
  const now = opts.now || Date.now();
  const title = String(raw?.title || '').trim().slice(0, 200);
  const content = String(raw?.content || '');
  const category = String(raw?.category || '').trim().slice(0, 64);
  const tagsIn = Array.isArray(raw?.tags) ? raw.tags.map(t => String(t).toLowerCase().trim()).filter(Boolean) : [];
  // 双向链接抽取
  const links = recognizeWikiLinks(content);
  const linkedCardIds = uniq([
    ...(Array.isArray(raw?.linkedCardIds) ? raw.linkedCardIds : []),
    ...links.filter(l => l.type === NODE_TYPES.CARD).map(l => l.id),
  ]);
  const linkedDocId = String(raw?.linkedDocId || '').trim()
    || links.find(l => l.type === NODE_TYPES.DOC)?.id
    || '';
  // 标签合并（用户给 + 文中 #）
  const tagsFromText = extractTags(title, content);
  const tags = uniq([...tagsIn, ...tagsFromText]);
  const out = {
    title,
    content,
    category,
    tags,
    linkedCardIds,
    linkedDocId,
    createdAt: raw?.createdAt || now,
    updatedAt: raw?.updatedAt || now,
  };
  return out;
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}
