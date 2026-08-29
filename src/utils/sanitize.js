// src/utils/sanitize.js
// 统一 HTML 净化层 —— 所有 v-html 的入口都必须经过这里
//
// 背景（2026-08-29 P0 修复）：项目有 3 处 v-html 直接渲染外部内容
// （Markdown 渲染器 / Excel 预览 / Word 预览），而 marked@4 已移除内置 sanitize，
// 导入的 apkg、PDF/Word/Excel 解析文本、OCR 结果、AI 返回内容均可携带恶意 HTML，
// 形成存储型 XSS，可窃取 localStorage 中的 AI API Key 与 GitHub Token。
//
// 设计：
//   - 浏览器环境：直接用 window 构造 DOMPurify 实例
//   - Node / 测试环境：通过 setSanitizerWindow(new JSDOM('').window) 注入
//   - 两者都不可用时：退化为「整体转义」的保守兜底，绝不返回原始 HTML

import createDOMPurify from 'dompurify';

let _window = typeof window !== 'undefined' ? window : null;
let _purify = null;

/**
 * 注入 window（仅供 Node/单测使用）。
 * 浏览器下无需调用；重复调用会重建实例。
 */
export function setSanitizerWindow(win) {
  _window = win || null;
  _purify = null;
}

// DOMPurify 默认会剥掉 blob: 协议，而本项目本地图片（OPFS/IndexedDB）正是 blob: URL，
// 不显式放行会导致所有本地图片在净化后消失。data: 仅对图片放开。
const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|blob):|data:image\/[a-z+.\-]+;base64,|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

function getPurify() {
  if (_purify) return _purify;
  if (!_window) return null;
  _purify = createDOMPurify(_window);
  // 外链统一补 rel=noopener noreferrer，防止 tabnabbing 反向操控来源页
  _purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('target') === '_blank') {
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return _purify;
}

/**
 * 净化一段 HTML。返回可安全交给 v-html 的字符串。
 * @param {string} html
 * @returns {string}
 */
export function sanitizeHtml(html) {
  if (html == null) return '';
  const src = String(html);
  if (!src) return '';

  const purify = getPurify();
  if (!purify || !purify.isSupported) {
    // 兜底：无 DOM 环境（SSR / 未注入 window 的 Node）下整体转义，绝不放行原始 HTML
    return src
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  return purify.sanitize(src, {
    // 允许 MathML（KaTeX 公式）+ SVG；默认已含 html 命名空间
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    // KaTeX 的 <semantics>/<annotation> 承载 LaTeX 原文，默认会被剥掉，影响无障碍朗读
    ADD_TAGS: ['semantics', 'annotation'],
    ADD_ATTR: ['encoding', 'aria-hidden', 'target'],
    ALLOWED_URI_REGEXP,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form',
      'input', 'button', 'textarea', 'select', 'link', 'meta', 'base'],
    FORBID_ATTR: ['formaction', 'formtarget', 'srcdoc'],
    // 保留 class（hljs / katex 依赖）与 style（KaTeX 定位依赖）
    ALLOW_DATA_ATTR: false,
    RETURN_TRUSTED_TYPE: false,
  });
}

/** 净化器是否可用（浏览器恒为 true；Node 下需先 setSanitizerWindow） */
export function isSanitizerReady() {
  const p = getPurify();
  return !!(p && p.isSupported);
}
