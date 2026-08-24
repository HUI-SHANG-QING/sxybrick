// 音效工具：用 Web Audio 合成轻量提示音（无需外部音频文件）
// 供卡通萌系、左轮手枪等交互主题使用。

let _ctx = null;
function ctx() {
  try {
    if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (_ctx.state === 'suspended') _ctx.resume();
    return _ctx;
  } catch { return null; }
}

/**
 * 播放一个短促音效。
 * @param {number} freq 频率 Hz
 * @param {number} dur  时长 s
 * @param {string} type 波形 sine/square/triangle/sawtooth
 * @param {number} vol  音量 0~1
 */
export function playBlip(freq = 660, dur = 0.08, type = 'sine', vol = 0.2) {
  const c = ctx();
  if (!c) return;
  try {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = vol;
    osc.connect(gain); gain.connect(c.destination);
    const t = c.currentTime;
    osc.start(t);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.stop(t + dur);
  } catch { /* 忽略 */ }
}

// 卡通角色点击：上行琶音（欢快）
export function playCartoon(i = 0) {
  const notes = [523, 659, 784, 880, 1047, 1175, 1319, 1568];
  playBlip(notes[i % notes.length], 0.12, 'triangle', 0.25);
  setTimeout(() => playBlip(notes[i % notes.length] * 1.5, 0.1, 'triangle', 0.18), 70);
}

// 左轮扳机：短促「咔哒」
export function playRevolver() {
  playBlip(180, 0.04, 'square', 0.3);
  setTimeout(() => playBlip(120, 0.05, 'square', 0.25), 60);
}

// 解密：神秘「叮」
export function playMystery() {
  playBlip(880, 0.15, 'sine', 0.2);
  setTimeout(() => playBlip(1175, 0.2, 'sine', 0.15), 90);
}
