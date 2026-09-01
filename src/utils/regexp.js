// src/utils/regexp.js
// 用户数据进 RegExp 前的元字符转义（round14 P2-D 根因修复）：
// 用户输入（单词/词组/搜索词）含 () [] * + ? $ {} | . \ 等元字符时，
// 直传 new RegExp 会抛 SyntaxError 且调用链往往无 try/catch → 整会话崩溃。
// 统一出口，避免每处手写正则漏字符。
export function escapeRegExp(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
