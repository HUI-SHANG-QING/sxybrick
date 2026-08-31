// src/utils/speak.js
// 英文朗读（TTS）封装：基于浏览器原生 SpeechSynthesis，无需后端、离线可用。
// 设计：
//   - 浏览器守卫：typeof window === 'undefined' 时不抛错（Node 单测 / SSR 安全）。
//   - 默认英文语音（en-US / en-GB），优先挑本地已安装的英文 voice。
//   - speak() 返回 Promise，朗读结束后 resolve；可被 cancel() 打断。
//   - 考研场景：用户口述存词、单词模块需"朗读单词/句子"，故单独提供此工具。

let _voices = [];
function loadVoices() {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  try { _voices = window.speechSynthesis.getVoices() || []; } catch { _voices = []; }
  if (!_voices.length && typeof window.speechSynthesis.onvoiceschanged !== 'undefined') {
    window.speechSynthesis.onvoiceschanged = () => { _voices = window.speechSynthesis.getVoices() || []; };
  }
}

/** 是否支持语音合成 */
export function speechSupported() {
  return typeof window !== 'undefined' && !!window.speechSynthesis;
}

function pickEnglishVoice() {
  if (!_voices.length) return null;
  return (
    _voices.find(v => /^en[-_]US/i.test(v.lang)) ||
    _voices.find(v => /^en[-_]GB/i.test(v.lang)) ||
    _voices.find(v => /^en/i.test(v.lang)) ||
    null
  );
}

/**
 * 朗读文本
 * @param {string} text 要朗读的文本
 * @param {object} opts { lang?, rate?, pitch?, onEnd? }
 * @returns {Promise<boolean>} 是否成功触发朗读
 */
export function speak(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t || !speechSupported()) return Promise.resolve(false);
  loadVoices();
  try {
    window.speechSynthesis.cancel(); // 先打断上一段，避免排队叠加
    const u = new SpeechSynthesisUtterance(t);
    u.lang = opts.lang || pickEnglishVoice()?.lang || 'en-US';
    u.rate = Number.isFinite(opts.rate) ? opts.rate : 0.95;
    u.pitch = Number.isFinite(opts.pitch) ? opts.pitch : 1;
    const v = pickEnglishVoice();
    if (v) u.voice = v;
    return new Promise((resolve) => {
      u.onend = () => resolve(true);
      u.onerror = () => resolve(false);
      window.speechSynthesis.speak(u);
    });
  } catch {
    return Promise.resolve(false);
  }
}

/** 打断当前朗读 */
export function cancelSpeech() {
  if (speechSupported()) {
    try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
  }
}
