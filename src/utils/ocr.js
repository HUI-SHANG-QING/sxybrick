// OCR 纯函数层（Phase 6.5b 资料中心）
// 原则：本地 Tesseract 优先（worker/core 已本地化 public/ocr/，离线可用、数据不出浏览器）；
//       云端 OpenAI 兼容视觉端点可选（设置里配置后启用）。
// 纯函数无浏览器依赖，Node 可测；浏览器 IO（worker 复用/逐页识别）在 docs-lib.ocrDoc 编排。

export const OCR_DEFAULT_LANG = 'chi_sim+eng';
export const OCR_LANG_OPTIONS = [
  { value: 'chi_sim', label: '简体中文' },
  { value: 'eng', label: '英文' },
  { value: 'chi_sim+eng', label: '简中 + 英文（真题默认）' },
  { value: 'chi_tra', label: '繁体中文' },
];

/** 语言白名单校验：只允许 [a-z_+]，防路径/URL 注入；空值回默认 */
export function normalizeOcrLang(lang) {
  const l = String(lang ?? '').trim();
  if (!l || !/^[a-z_+]+$/.test(l)) return OCR_DEFAULT_LANG;
  return l;
}

/**
 * 本地资源路径组装（worker/core 本地化；语言数据默认 jsdelivr CDN 可配）。
 * @param {string} baseUrl import.meta.env.BASE_URL（如 '/sxybrick/'）
 * @param {string} [langPath] 自定义语言数据目录（留空走默认 @tesseract.js-data CDN）
 */
export function buildOcrAssets(baseUrl = '', langPath = '') {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return {
    workerPath: `${base}/ocr/worker.min.js`,
    // 锁定单核心文件（simd-lstm）：现代浏览器 SIMD 全覆盖；corePath 传文件即跳过自动挑选
    corePath: `${base}/ocr/tesseract-core-simd-lstm.wasm.js`,
    langPath: String(langPath || '').trim() || undefined,
  };
}

/** OCR 文本清洗：与 parsers.cleanExtractedText 同规则（内联保持本文件独立自洽） */
export function cleanOcrText(text) {
  return String(text ?? '')
    .replace(/[ \t]+\n/g, '\n') // 行尾空白
    .replace(/\n{4,}/g, '\n\n\n') // 压缩过多空行
    .trim();
}

/**
 * 空结果判定：不含任何「可读字符」（空白/标点/符号之外的字、字母、数字）即视为空。
 * 注意不能用 [\s\W]——\W 会把中文汉字也匹配掉导致误判。
 */
export function isOcrEmpty(text) {
  const t = cleanOcrText(text);
  if (!t) return true;
  return !/[^\s\p{P}\p{S}]/u.test(t);
}

/**
 * 识别前画布缩放：长边压到 maxLen（默认 2000px），平衡质量/内存/耗时（大图直识别易爆内存）。
 * @returns {{width:number, height:number, scale:number}}
 */
export function fitCanvasSize(w, h, maxLen = 2000) {
  const W = Number(w) || 0;
  const H = Number(h) || 0;
  if (W <= 0 || H <= 0) return { width: W, height: H, scale: 1 };
  const longest = Math.max(W, H);
  if (longest <= maxLen) return { width: W, height: H, scale: 1 };
  const scale = maxLen / longest;
  return { width: Math.round(W * scale), height: Math.round(H * scale), scale };
}

/**
 * 云端 OCR 请求构造（OpenAI 兼容视觉端点）。
 * @param {string} imageDataUrl 图片 data URL（canvas.toDataURL 产物）
 * @param {object} cfg { endpoint, apiKey, model }
 * @returns {object|null} fetch 请求参数；未配置返回 null（表示走本地 Tesseract）
 */
export function buildCloudOcrRequest(imageDataUrl, { endpoint, apiKey, model = 'gpt-4o-mini' } = {}) {
  const ep = String(endpoint || '').trim();
  const key = String(apiKey || '').trim();
  if (!ep || !key) return null;
  return {
    url: ep,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: {
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '请识别这张图片中的全部文字，原样输出，保留段落与换行。只输出识别到的文字，不要任何解释。' },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      }],
      temperature: 0,
    },
  };
}

/** 云端响应解析：兼容 choices[0].message.content 字符串与数组两种形态 */
export function parseCloudOcrResponse(json) {
  const content = json?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('');
  }
  return typeof content === 'string' ? content : '';
}
