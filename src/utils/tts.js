// 语音朗读：把 Markdown 抽成纯文本，用浏览器 SpeechSynthesis 读出来（免费、离线可用）
export function mdToSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\$\$?[^$]+\$\$?/g, ' ')
    .replace(/\{\{([^}]+)\}\}/g, '$1')
    .replace(/[*_#>~`|\[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function speak(text, lang = 'zh-CN') {
  if (!('speechSynthesis' in window)) return false;
  const t = mdToSpeech(text);
  if (!t) return false;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(t);
  u.lang = lang;
  u.rate = 0.9;
  window.speechSynthesis.speak(u);
  return true;
}