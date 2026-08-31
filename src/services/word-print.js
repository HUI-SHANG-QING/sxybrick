// 英语模块「不背风」A4 打印服务（HTML → 浏览器打印 / 另存为 PDF）
//
// 为什么不直接用 jsPDF（services/word-pdf.js）？
//   jsPDF 内置的 helvetica / times / courier 都是 ASCII 标准字体，**不含中文字形**。
//   词表的右列全是中文释义，用 jsPDF 直接 doc.text('单词') 会输出空白或乱码方块，
//   要修就得内嵌一份中文字体子集（动辄 2~8MB，PWA 预缓存体积不可接受）。
//   因此中文版式走「渲染 A4 HTML → iframe → window.print()」：
//     - 中文由系统字体渲染，永远正确；
//     - 用户在打印对话框里选「另存为 PDF」即得矢量 PDF，清晰度优于位图方案；
//     - 零新依赖、离线可用（不像 jsPDF 需要 CDN）。
//   jsPDF 通道保留给纯英文场景（见 word-pdf.js），本模块是默认主通道。
//
// 版式（三种，互不重复）：
//   a4write  A4 默写：左英文 → 右空白线（默写中文释义）
//   zhList   中文词表：左中文 → 右空白线（默写英文单词）
//   enList   英文词表：左英文 + 右中文（全部填好，直接通读背诵）
//
// 排版规格：A4 纵向，双栏 × 20 行 = 40 词/页；
//   页眉 = 标题 + 「模版效果图」红色徽标 + 二维码占位 + 元信息行；
//   页脚 = 水印 + 页码 X / Y。

import { recordExportHistory } from './word-pdf.js';

export const PAGE_SIZE = 40;      // 每页词数
export const ROWS_PER_COL = 20;   // 每栏行数

/** Fisher–Yates 乱序（返回副本，不改原数组） */
export function shuffleCards(list) {
  const a = [...(list || [])];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

/**
 * 单行内容（纯函数，便于测试）。
 * @returns {{left:string, right:string, rightBlank:boolean, leftIsEn:boolean}}
 */
export function rowOf(card, mode) {
  const word = card?.word || '';
  const meaning = card?.meaning || '';
  if (mode === 'zhList') return { left: meaning, right: word, rightBlank: true, leftIsEn: false };
  if (mode === 'enList') return { left: word, right: meaning, rightBlank: false, leftIsEn: true };
  // a4write（默认）
  return { left: word, right: meaning, rightBlank: true, leftIsEn: true };
}

/** 表头文案（跟版式一致） */
function headers(mode) {
  if (mode === 'zhList') return ['释义 Meaning', '单词 Word'];
  if (mode === 'enList') return ['单词 Word', '释义 Meaning'];
  return ['单词 Word', '默写释义 Meaning'];
}

const SHEET_CSS = `
@page { size: A4 portrait; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: #eeebe5;
  color: #2c2a26;
  font-family: "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.page {
  position: relative;
  width: 210mm; height: 297mm;
  padding: 11mm 10mm 10mm;
  margin: 0 auto 6mm;
  background: #fff;
  display: flex; flex-direction: column;
  page-break-after: always; break-after: page;
  overflow: hidden;
}
.page:last-child { page-break-after: auto; break-after: auto; margin-bottom: 0; }

.hd { display: flex; align-items: flex-start; justify-content: space-between; gap: 6mm;
      border-bottom: 1pt solid #e8c9a4; padding-bottom: 2.6mm; }
.hd-l { min-width: 0; }
.hd-title { display: flex; align-items: center; gap: 3mm; flex-wrap: wrap; }
.hd-title h1 { margin: 0; font-size: 14.5pt; font-weight: 800; letter-spacing: .3pt; }
.badge { padding: 0.8mm 2.6mm; border-radius: 6mm; background: #e05a4e; color: #fff;
         font-size: 7.5pt; font-weight: 700; white-space: nowrap; }
.hd-meta { margin: 1.6mm 0 0; font-size: 7.5pt; color: #948c80; line-height: 1.5; }
.qr { flex: none; width: 16mm; text-align: center; }
.qr-box { width: 16mm; height: 16mm; border: .8pt solid #cfc7b8; border-radius: 1.2mm;
          background: repeating-linear-gradient(45deg, #f6f3ee 0 1.2mm, #fff 1.2mm 2.4mm);
          display: flex; align-items: center; justify-content: center;
          font-size: 6.5pt; color: #a89f92; }
.qr-cap { margin-top: .8mm; font-size: 6pt; color: #b3aa9c; }

.thead { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; margin-top: 3.2mm; }
.thead > div { background: #fdeadb; border-radius: 1.2mm; padding: 1mm 3mm;
               font-size: 8pt; font-weight: 700; color: #8a6547;
               display: flex; justify-content: space-between; }
.thead .th-r { color: #b09272; font-weight: 500; }

.cols { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; margin-top: 1.6mm; }
.col { display: flex; flex-direction: column; }
.row { display: flex; align-items: center; gap: 1.6mm; height: 9.4mm; padding: 0 1.2mm;
       border-bottom: .5pt dashed #ece5d8; }
.row.z { background: #fcfaf6; }
.no { flex: none; width: 6mm; text-align: right; font-size: 7pt; color: #bab1a3; }
.en { font-size: 9.8pt; font-weight: 600; letter-spacing: .1pt; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; }
.zh { font-size: 8.6pt; color: #5d574e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ph { font-size: 7pt; color: #a99f90; margin-left: 1.2mm; font-weight: 400; }
.c-fixed { flex: 0 0 33mm; }
.c-grow { flex: 1 1 auto; min-width: 0; }
.blank { flex: 1 1 auto; height: 0; border-bottom: .5pt solid #d2cabb; margin: 3mm 1.5mm 0 1.5mm; }
.box { flex: none; width: 3mm; height: 3mm; border: .5pt solid #d8d0c0; border-radius: .5mm; }

.ft { display: flex; align-items: center; justify-content: space-between;
      border-top: .5pt solid #efe9dd; padding-top: 2mm; margin-top: 1.6mm;
      font-size: 7pt; color: #b3aa9c; }
.ft b { color: #8f8779; font-weight: 600; }

.tip { max-width: 210mm; margin: 0 auto 6mm; padding: 3mm 4mm; background: #fffbe8;
       border: 1px solid #f0e0a8; border-radius: 3mm; font-size: 9pt; color: #7a6a3a; }
@media print {
  body { background: #fff; }
  .page { margin: 0; }
  .tip { display: none; }
}
`;

/**
 * 生成「不背风」A4 打印 HTML（纯函数，Node 可测）。
 * @param {object} req
 * @param {Array}  req.cards
 * @param {'a4write'|'zhList'|'enList'} [req.mode]
 * @param {string} [req.title]
 * @param {string} [req.metaLine]   页眉元信息（范围/顺序/时间等）
 * @param {boolean}[req.phonetic]   英文后是否带音标
 * @param {string} [req.watermark]  页脚水印
 * @param {boolean}[req.tip]        是否在屏幕上显示「Ctrl+P 打印」提示条（打印时自动隐藏）
 * @returns {{html:string, pageCount:number, total:number}}
 */
export function buildWordSheet(req = {}) {
  const cards = Array.isArray(req.cards) ? req.cards : [];
  const mode = req.mode || 'a4write';
  const title = req.title || '单词本';
  const watermark = req.watermark || 'SxyBrick · 背单词打印模板';
  const withPhonetic = req.phonetic !== false;
  const [thL, thR] = headers(mode);
  const pages = cards.length ? chunk(cards, PAGE_SIZE) : [[]];
  const total = pages.length;

  const rowHtml = (card, idx) => {
    if (!card) return `<div class="row${idx % 2 ? ' z' : ''}"><span class="no"></span><span class="c-grow"></span></div>`;
    const r = rowOf(card, mode);
    const ph = withPhonetic && r.leftIsEn && card.phonetic ? `<span class="ph">/${esc(card.phonetic)}/</span>` : '';
    const leftCls = r.leftIsEn ? 'en' : 'zh';
    const left = r.rightBlank
      ? `<span class="${leftCls} c-grow">${esc(r.left)}${ph}</span>`
      : `<span class="${leftCls} c-fixed">${esc(r.left)}${ph}</span>`;
    const right = r.rightBlank
      ? '<span class="blank"></span>'
      : `<span class="zh c-grow">${esc(r.right)}</span>`;
    return `<div class="row${idx % 2 ? ' z' : ''}"><span class="no">${idx + 1}</span>${left}${right}<span class="box"></span></div>`;
  };

  const pageHtml = pages
    .map((pageCards, p) => {
      const left = [];
      const right = [];
      for (let i = 0; i < PAGE_SIZE; i++) {
        const html = rowHtml(pageCards[i], i);
        (i < ROWS_PER_COL ? left : right).push(html);
      }
      return `<section class="page">
  <header class="hd">
    <div class="hd-l">
      <div class="hd-title"><h1>${esc(title)}</h1><span class="badge">~ 模版效果图 ~</span></div>
      <p class="hd-meta">${esc(req.metaLine || '')}</p>
    </div>
    <div class="qr"><div class="qr-box">扫码<br>回顾</div><div class="qr-cap">SxyBrick</div></div>
  </header>
  <div class="thead">
    <div><span>${esc(thL)}</span><span class="th-r">✓</span></div>
    <div><span>${esc(thR)}</span><span class="th-r">✓</span></div>
  </div>
  <div class="cols"><div class="col">${left.join('')}</div><div class="col">${right.join('')}</div></div>
  <footer class="ft"><span>${esc(watermark)}</span><span>共 <b>${total}</b> 页 · <b>${p + 1} / ${total}</b></span></footer>
</section>`;
    })
    .join('\n');

  const tip = req.tip
    ? '<div class="tip">按 <b>Ctrl / ⌘ + P</b> 打印；在打印对话框中选择「另存为 PDF」即可得到清晰的 PDF 文件（边距请选“无”或“默认”）。</div>'
    : '';

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${SHEET_CSS}</style>
</head><body>${tip}
${pageHtml}
</body></html>`;

  return { html, pageCount: total, total: cards.length };
}

/**
 * 打印（或另存为 PDF）：隐藏 iframe 载入 A4 HTML → 调用打印对话框 → 写导出历史。
 * @returns {Promise<{ok:boolean, pageCount?:number, reason?:string}>}
 */
export async function printWordSheet(req = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { ok: false, reason: '打印仅在浏览器可用' };
  }
  const cards = Array.isArray(req.cards) ? req.cards : [];
  if (!cards.length) return { ok: false, reason: '没有可导出的单词' };

  const list = req.shuffle ? shuffleCards(cards) : cards;
  const built = buildWordSheet({ ...req, cards: list });

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;';
  document.body.appendChild(iframe);

  const cleanup = () => {
    setTimeout(() => {
      try { iframe.remove(); } catch { /* ignore */ }
    }, 1000);
  };

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('打印文档加载超时')), 8000);
      iframe.onload = () => { clearTimeout(timer); resolve(); };
      iframe.onerror = () => { clearTimeout(timer); reject(new Error('打印文档加载失败')); };
      // srcdoc 比 document.write 更安全，且与 CSP 兼容（无内联脚本）
      iframe.srcdoc = built.html;
    });
    // 等一帧，确保字体与分栏布局完成
    await new Promise((r) => setTimeout(r, 220));
    const w = iframe.contentWindow;
    if (!w) throw new Error('打印窗口不可用');
    w.focus();
    w.print();
  } catch (e) {
    cleanup();
    return { ok: false, reason: e?.message || '打印失败' };
  }
  cleanup();

  await recordExportHistory({
    kind: req.mode || 'a4write',
    total: list.length,
    scope: req.scopeLabel || '',
    lang: req.langLabel || '',
    ordered: !req.shuffle,
    fileName: `${req.title || '单词本'}.print`,
    sizeBytes: built.html.length,
    pageCount: built.pageCount,
  });

  return { ok: true, pageCount: built.pageCount };
}

/** 下载 A4 HTML 文件（离线保存/换设备打印用），同样写导出历史。 */
export async function downloadWordSheetHtml(req = {}) {
  if (typeof document === 'undefined') return { ok: false, reason: '仅浏览器可用' };
  const cards = Array.isArray(req.cards) ? req.cards : [];
  if (!cards.length) return { ok: false, reason: '没有可导出的单词' };
  const list = req.shuffle ? shuffleCards(cards) : cards;
  const built = buildWordSheet({ ...req, cards: list, tip: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `${String(req.title || '单词本').replace(/[\\/:*?"<>|]/g, '_')}_${req.mode || 'a4write'}_${stamp}.html`;
  const blob = new Blob([built.html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);

  await recordExportHistory({
    kind: req.mode || 'a4write',
    total: list.length,
    scope: req.scopeLabel || '',
    lang: req.langLabel || '',
    ordered: !req.shuffle,
    fileName,
    sizeBytes: blob.size,
    pageCount: built.pageCount,
  });
  return { ok: true, fileName, pageCount: built.pageCount };
}
