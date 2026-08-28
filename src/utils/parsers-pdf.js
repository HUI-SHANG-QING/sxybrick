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
