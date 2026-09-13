// PDF 文本提取：pdfjs-dist 逐页流式（内存受控、进度回调、可取消）
// 浏览器：标准 build + worker（不阻塞主线程）；Node 测试：legacy build（内置 fake worker）

let pdfjsPromise = null;

/** 加载 pdfjs（浏览器 worker / Node legacy），供文本提取与 OCR 渲染共用 */
export function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const isBrowser = typeof window !== 'undefined' && !!window?.document;
      if (isBrowser) {
        const pdfjs = await import('pdfjs-dist');
        const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        return pdfjs;
      }
      // Node（测试）：legacy build 无需 worker
      return import('pdfjs-dist/legacy/build/pdf.mjs');
    })();
  }
  return pdfjsPromise;
}

/**
 * 逐页提取 PDF 全文。
 * @param {Blob} blob PDF 文件
 * @param {object} opts { onPage?(page,total), onProgress?(ratio), signal? }
 * @returns {Promise<{text:string, pageCount:number}>}
 */
export async function extractPdfText(blob, opts = {}) {
  const pdfjs = await getPdfjs();
  const data = await blob.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  const total = doc.numPages;
  const pages = [];
  try {
    for (let i = 1; i <= total; i++) {
      if (opts.signal?.aborted) throw new DOMException('解析已取消', 'AbortError');
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      // 保留原文档换行结构（item.hasEOL），中文逐字不丢、英文按行聚合
      const lines = [];
      let line = '';
      for (const it of tc.items) {
        if (it.str == null) continue;
        line += it.str;
        if (it.hasEOL) { lines.push(line); line = ''; }
      }
      if (line) lines.push(line);
      pages.push(lines.join('\n'));
      page.cleanup();
      opts.onPage?.(i, total);
      opts.onProgress?.(i / total);
    }
  } finally {
    // pdfjs v6：destroy 可能挂在 loadingTask 或 proxy 上，版本差异大，容错处理
    try { await doc.destroy?.(); } catch { /* ignore */ }
  }
  return { text: pages.join('\n\n'), pageCount: total };
}

/**
 * 把 PDF 指定页渲染成 JPEG dataURL（供多模态视觉分析 / OCR 共用）。
 *
 * 与 extractPdfText 互补：文本层可用的 PDF 走文本，**扫描件 / 图表型 PDF** 文本层为空或
 * 只有零散标题，必须走渲染。逐页渲染、用后立即释放 canvas（大页 4MB+，连续几十页不释放
 * 会累积数百 MB 内存峰值）。
 *
 * @param {Blob} blob PDF 文件
 * @param {object} opts
 *   pages       要渲染的页码（1-based）；缺省从第 1 页起渲染 maxPages 页
 *   maxPages    最多渲染页数（默认 3，调用方按费用护栏收紧）
 *   scale       渲染倍率（默认 2，小字号更清晰）
 *   quality     JPEG 质量（默认 0.8）
 *   onPage?(i,total)
 *   signal?
 * @returns {Promise<Array<{page:number, dataUrl:string}>>}
 */
export async function renderPdfPages(blob, opts = {}) {
  const { maxPages = 3, scale = 2, quality = 0.8, signal } = opts;
  const pdfjs = await getPdfjs();
  const data = await blob.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  const total = doc.numPages;
  const wanted = Array.isArray(opts.pages) && opts.pages.length
    ? opts.pages.filter((p) => Number.isInteger(p) && p >= 1 && p <= total).slice(0, maxPages)
    : Array.from({ length: Math.min(maxPages, total) }, (_, i) => i + 1);

  const out = [];
  try {
    for (const p of wanted) {
      if (signal?.aborted) throw new DOMException('渲染已取消', 'AbortError');
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale });
      // Node（测试/SSR）无 document → 无法渲染，直接返回空数组让调用方降级
      if (typeof document === 'undefined' || !document.createElement) break;
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      canvas.width = 0; canvas.height = 0; // 立即释放
      page.cleanup();
      opts.onPage?.(p, total);
      out.push({ page: p, dataUrl });
    }
  } finally {
    try { await doc.destroy?.(); } catch { /* ignore */ }
  }
  return out;
}
