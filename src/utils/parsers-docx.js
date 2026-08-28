// Word 文本提取：mammoth 转纯文本（预览用近似 HTML 在视图层另取）
import mammoth from 'mammoth';

/**
 * @param {Blob} blob docx 文件
 * @returns {Promise<{text:string}>}
 */
export async function extractDocxText(blob) {
  // mammoth 1.x 的 unzip 只认 path/buffer/file（arrayBuffer 会被拒）
  const result = await mammoth.extractRawText({ buffer: await blob.arrayBuffer() });
  return { text: result.value || '' };
}

/**
 * Word → 近似 HTML（在线预览用，标注「近似预览」）。
 * @returns {Promise<{html:string}>}
 */
export async function docxToHtml(blob) {
  const result = await mammoth.convertToHtml({ buffer: await blob.arrayBuffer() });
  return { html: result.value || '' };
}
