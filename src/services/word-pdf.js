// 英语模块 A4 PDF 直下载服务（jsPDF 矢量绘制，双列 40 词 + 页眉页脚 + 乱序 + 历史）
//
// ⚠️ 重要限制：jsPDF 内置字体（helvetica/times/courier）只含 ASCII 字形，**不支持中文**。
//   本通道输出的中文会变成空白或方块。因此它只适用于「纯英文内容」场景
//   （例如只想打印一份英文单词清单）。
//   中文版式（含释义）请走 services/word-print.js —— 渲染 A4 HTML 交给浏览器打印，
//   中文由系统字体渲染，且可在打印对话框「另存为 PDF」，同样是矢量输出。
//   之所以不给 jsPDF 内嵌中文字体：一份可用的中文子集 2~8MB，PWA 预缓存体积不可接受。
//
// 版式（与 word-print.js 保持一致）：
//   a4write  A4 默写：左英文 → 右空白线
//   zhList   中文词表：左中文 → 右空白线
//   enList   英文词表：左英文 + 右中文（全填）

import { db, uid } from '../db.js';

// jsPDF 通过 CDN 动态加载（避免 npm 依赖膨胀；PWA 离线缓存首屏后亦可用）
let _jspdfLoader = null;
function loadJsPdf() {
  if (_jspdfLoader) return _jspdfLoader;
  _jspdfLoader = new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('PDF 导出仅在浏览器可用'));
    const tryLoad = (src) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve(window.jspdf?.jsPDF);
      s.onerror = () => reject(new Error(`加载 jsPDF 失败：${src}`));
      document.head.appendChild(s);
    };
    tryLoad('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
  }).catch((e) => {
    _jspdfLoader = null;
    throw e;
  });
  return _jspdfLoader;
}

// ---------- 工具：分页 / 乱序 / 渲染 ----------
function shuffleInPlace(arr) {
  const a = [...arr];
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

// 三种版式的列内容（与 word-print.js rowOf 同口径）
function renderRow(card, mode) {
  // mode: 'a4write' | 'zhList' | 'enList'
  if (mode === 'zhList') {
    // 中文词表：左释义 → 右留空默写英文
    return { left: card.meaning, right: card.word, rightEmpty: true };
  }
  if (mode === 'enList') {
    // 英文词表：英中对照全填
    return { left: card.word, right: card.meaning, rightEmpty: false };
  }
  // a4write：左英文 → 右留空默写中文
  return { left: card.word, right: card.meaning, rightEmpty: true };
}

/**
 * 写导出历史（仅本地表 wordExportHistory，不进同步）。
 * word-pdf.js 与 word-print.js 共用，避免两处重复实现与保留策略漂移。
 * @returns {Promise<boolean>} 是否写入成功
 */
export async function recordExportHistory(entry = {}) {
  try {
    await db.wordExportHistory.put({
      id: uid(),
      kind: entry.kind || 'a4write',
      total: Number(entry.total || 0),
      scope: entry.scope || '',
      lang: entry.lang || '',
      ordered: entry.ordered !== false,
      createdAt: Date.now(),
      fileName: entry.fileName || '',
      sizeBytes: Number(entry.sizeBytes || 0),
      pageCount: Number(entry.pageCount || 0),
    });
    // 保留策略：近一年 + 最多 30 条（避免本地表膨胀）
    const YEAR = 365 * 24 * 3600 * 1000;
    const cutoff = Date.now() - YEAR;
    const all = await db.wordExportHistory.orderBy('createdAt').reverse().toArray();
    const stale = all.filter((x, i) => i >= 30 || (x.createdAt || 0) < cutoff);
    if (stale.length) await db.wordExportHistory.bulkDelete(stale.map((x) => x.id));
    return true;
  } catch (e) {
    console.warn('[word-export] write history failed:', e);
    return false;
  }
}

// ---------- 主入口 ----------
/**
 * @param {object} req
 * @param {Array}  req.cards        待导出的 wordCards（需带 word/meaning 等）
 * @param {'a4write'|'zhList'|'enList'} req.mode
 * @param {string} req.title        页眉标题，如「四级词汇闪过·复习中」
 * @param {boolean}[req.shuffle]    乱序导出
 * @param {string}[req.scopeLabel]  范围描述（导出历史显示用）
 * @param {string}[req.langLabel]   语言描述
 * @returns {Promise<{ok:boolean, fileName?:string, pageCount?:number, reason?:string}>}
 */
export async function exportWordPdf(req) {
  let jsPDF;
  try {
    jsPDF = await loadJsPdf();
  } catch (e) {
    return { ok: false, reason: e?.message || 'jsPDF 加载失败' };
  }
  if (!jsPDF) return { ok: false, reason: 'jsPDF 未就绪' };
  if (!Array.isArray(req?.cards) || req.cards.length === 0) {
    return { ok: false, reason: '没有可导出的单词' };
  }
  const mode = req.mode || 'a4write';
  const title = req.title || '单词本';
  const cards = req.shuffle ? shuffleInPlace(req.cards) : req.cards;
  // 一页 40 词 = 双列 20 × 2；不足 40 也填一页
  const pages = chunk(cards, 40);
  const totalPages = pages.length;

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = 210, pageH = 297;
  const marginX = 14, marginTop = 26, marginBottom = 18;
  const tableTop = marginTop + 12;          // 表头位置
  const colGap = 6;                          // 左右两列间距
  const colW = (pageW - marginX * 2 - colGap) / 2;
  const rowH = 6.6;                          // 行高
  const rowsPerCol = 20;

  pages.forEach((pageCards, idx) => {
    if (idx > 0) doc.addPage();

    // —— 页眉 —— 左：标题；右上：二维码占位；右中：模版效果图徽标
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(40, 40, 40);
    doc.text(title, marginX, marginTop - 8);

    // 二维码占位（右上角 16×16）
    doc.setDrawColor(120, 120, 120);
    doc.rect(pageW - marginX - 18, marginTop - 18, 16, 16);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(120, 120, 120);
    doc.text('QR', pageW - marginX - 14, marginTop - 8);

    // 「模版效果图」红色徽标（标题右侧）。注意：本通道字体不含中文，徽标只能用 ASCII
    doc.setFillColor(230, 90, 80);
    doc.roundedRect(marginX + doc.getTextWidth(title) + 4, marginTop - 16, 24, 6, 1.5, 1.5, 'F');
    doc.setFontSize(8);
    doc.setTextColor(255, 255, 255);
    doc.text('~ TEMPLATE ~', marginX + doc.getTextWidth(title) + 5.5, marginTop - 11.5);

    // —— 表头：Word | Meaning ——
    doc.setFillColor(255, 230, 215);             // 浅橙底
    doc.rect(marginX, tableTop - 5, colW, 6, 'F');
    doc.rect(marginX + colW + colGap, tableTop - 5, colW, 6, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(60, 60, 60);
    const headerLeft = mode === 'zhList' ? 'Meaning' : 'Word';
    const headerRight = mode === 'a4write' ? 'Meaning' : (mode === 'zhList' ? 'Word' : 'Meaning');
    doc.text(headerLeft, marginX + 2, tableTop - 1);
    doc.text(headerRight, marginX + colW + colGap + 2, tableTop - 1);

    // —— 表格行（双列 40 条）——
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(30, 30, 30);
    for (let i = 0; i < rowsPerCol * 2; i++) {
      const c = pageCards[i];
      if (!c) continue;
      const isLeftCol = i < rowsPerCol;
      const x0 = isLeftCol ? marginX : marginX + colW + colGap;
      const rowIdx = isLeftCol ? i : i - rowsPerCol;
      const y = tableTop + 1 + rowIdx * rowH;

      // 序号
      const num = String(i + 1);
      doc.setTextColor(120, 120, 120);
      doc.text(num, x0 + 1, y + 2);

      // 行底色：奇行浅米色
      if (i % 2 === 1) {
        doc.setFillColor(252, 248, 240);
        doc.rect(x0, y - 1.5, colW, rowH, 'F');
      }
      // 行分隔线
      doc.setDrawColor(235, 230, 220);
      doc.line(x0, y - 1.5, x0 + colW, y - 1.5);

      // 内容
      const r = renderRow(c, mode);
      doc.setTextColor(30, 30, 30);
      doc.text(String(r.left || '').slice(0, 32), x0 + 6, y + 2);
      if (r.rightEmpty) {
        // 留空：画一条下划线供手写
        doc.setDrawColor(120, 120, 120);
        doc.line(x0 + 6, y + 3, x0 + colW - 3, y + 3);
      } else {
        doc.setTextColor(80, 80, 80);
        doc.text(String(r.right || '').slice(0, 40), x0 + 6, y + 2);
      }

      // 右侧小方框（打勾用）
      doc.setDrawColor(220, 215, 200);
      doc.rect(x0 + colW - 4, y - 1, 3, 3);
    }

    // —— 页脚 ——
    const footY = pageH - marginBottom + 4;
    doc.setFontSize(7.5);
    doc.setTextColor(120, 120, 120);
    doc.text('SxyBrick - word print template', marginX, footY);
    doc.text(`共 ${totalPages} 页  ${idx + 1}/${totalPages}`, pageW - marginX, footY, { align: 'right' });
  });

  // —— 输出 ——
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `${title.replace(/[\\/:*?"<>|]/g, '_')}_${mode}_${stamp}.pdf`;
  const blob = doc.output('blob');

  // 触发浏览器下载
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  } catch (e) {
    console.warn('[word-pdf] download trigger failed:', e);
  }

  // —— 写历史（仅本地）——
  await recordExportHistory({
    kind: mode,
    total: cards.length,
    scope: req.scopeLabel || '',
    lang: req.langLabel || '',
    ordered: !req.shuffle,
    fileName,
    sizeBytes: blob.size,
    pageCount: totalPages,
  });

  return { ok: true, fileName, pageCount: totalPages };
}

// ---------- 历史查询 ----------
export async function listExportHistory() {
  try {
    return await db.wordExportHistory.orderBy('createdAt').reverse().toArray();
  } catch {
    return [];
  }
}

// ---------- 简单兜底：纯文本导出（不依赖 jsPDF）----------
export function exportWordText(req) {
  const cards = req.shuffle ? shuffleInPlace(req.cards || []) : (req.cards || []);
  const title = req.title || '单词本';
  const head = `# ${title}\n> 共 ${cards.length} 词 · 导出 ${new Date().toISOString().slice(0, 10)}\n\n`;
  const body = cards
    .map((c, i) => `${i + 1}. ${c.word}  ${c.phonetic || ''}  ${c.meaning || ''}`)
    .join('\n');
  return head + body;
}