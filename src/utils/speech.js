// 语音输入：用浏览器 Web Speech API 把语音转文字（Chrome 支持，不支持则自动隐藏）
export function isSpeechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function startSpeech(onResult, onEnd, lang = 'zh-CN') {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  try {
    const rec = new SR();
    rec.lang = lang;
    rec.interimResults = false;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) onResult(e.results[i][0].transcript);
      }
    };
    rec.onend = onEnd;
    rec.onerror = onEnd;
    rec.start();
    return rec;
  } catch { return null; }
}