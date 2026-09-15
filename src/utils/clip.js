// 图片感知的文本截断（纯函数，零依赖）。
//
// 为什么需要：卡片/笔记/文档正文里的图片以 `![alt](sxy-img://<36位uuid>)` 内嵌，
// 单个标记就有 56 字符。任何朴素的 `String(x).slice(0, N)` 都会把它**拦腰截断**，
// 产生残缺 id → 富集时 `db.images.get(残缺id)` 查不到 → 图被静默丢弃，
// 而 AI 只会看到一句「未随本次发送」的标注，误以为是自己没收到图。
//
// 实测（2026-09-15）：正文「计算机网络习题：停止-等待协议的重传机制与超时重传分析」
// + 图片标记（起始于第 28 字符）：
//   slice(0, 60) → 只剩 `sxy-img://a1b2c3d4-e5f6`   ✗ 切坏
//   slice(0, 80) → 只剩 `...ef1234567`                ✗ 差 3 字符
// 即：正文前面多写 5 个字（60 档）/ 25 个字（80 档），图片就丢了。
//
// 本模块统一出口：正文照常按长度截断，**图片引用一律完整保留**并追加在末尾
// （引用出现的位置对 AI 无意义，id 完整才有意义；单个标记仅 56 字符，代价可忽略）。

// 两条视觉引用协议都必须完整保留：
//   sxy-img://<uuid>        —— 卡片/笔记正文里的图片（Markdown 形态或裸引用）
//   sxy-doc://<docId>[#pages] —— 资料库文件页（页码后缀被截断会静默改变送图页码）
const IMG_REF_SRC = [
  '!?\\[[^\\]]*\\]\\(sxy-img:\\/\\/[0-9a-fA-F-]+\\)',
  'sxy-img:\\/\\/[0-9a-fA-F-]+',
  'sxy-doc:\\/\\/[A-Za-z0-9_-]{6,}(?:#[0-9,\\-]+)?',
].join('|');

/**
 * 正文是否引用了图片 / 资料页。
 * 用于给「只返回摘要、不含引用 id」的列表类工具附 `hasImage` 提示，
 * 引导 AI 去调 `get_card_detail` / `read_doc` 拿完整内容（那里引用是完整的）。
 * @param {*} text
 * @returns {boolean}
 */
export function hasImageRef(text) {
  // 不带 g 标志 → 无 lastIndex 状态，可安全反复调用
  return /sxy-(?:img|doc):\/\//.test(String(text ?? ''));
}

/**
 * 去掉所有视觉引用。
 * 用于「取卡名 / 生成去重键 / 拼一句话摘要」这类**不需要图片**的场景——
 * 引用跟着截断只会留下残缺标记污染文本（模型看到半截 `sxy-img://` 会误判为「图丢了」）。
 * @param {*} text
 * @returns {string}
 */
export function stripImageRefs(text) {
  return String(text ?? '').replace(new RegExp(IMG_REF_SRC, 'g'), '').trim();
}

/**
 * 图片感知截断：按 maxLen 截断正文，但所有图片引用完整保留。
 *
 * 返回值**可能略长于 maxLen**（正文 maxLen + 图片引用总长）——这是刻意的：
 * 图片引用是稀缺且不可再生的信息，宁可多几十字符也不能切坏 id。
 *
 * @param {*} text 原始正文
 * @param {number} maxLen 正文截断长度
 * @returns {string}
 */
export function clipText(text, maxLen) {
  const s = String(text ?? '');
  const n = Number(maxLen);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (s.length <= n) return s;

  const re = new RegExp(IMG_REF_SRC, 'g'); // 每次新建，避免 lastIndex 残留
  const refs = s.match(re);
  if (!refs || !refs.length) return s.slice(0, n);

  // 去掉引用后再截断正文，引用原样追加 —— 保证 id 完整可解析
  const body = s.replace(re, '');
  // 码点安全截断（防把 emoji 等代理对切成半个字符，与调用方的 Array.from 口径一致）：
  // 先按码元粗切到 2n（n 个码点最多占 2n 个码元），再按码点精切 —— 避免对大文本做全量展开。
  const head = body.length > n * 2 ? body.slice(0, n * 2) : body;
  return `${Array.from(head).slice(0, n).join('')}${refs.join('')}`;
}
