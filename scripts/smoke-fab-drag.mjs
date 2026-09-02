// 悬浮按钮拖动冒烟：用系统 Chrome headless + 原生 WebSocket 直连 CDP，
// 分别在「移动端模拟（touch 事件）」与「桌面模式（mouse 事件）」下拖动三个悬浮按钮，
// 校验：① 位移生效 ② 边界收敛 ③ 位置持久化 ④ 短按仍能触发点击 ⑤ 全程零 console 错误。
//
// 用法：node scripts/smoke-fab-drag.mjs
// 可选：CHROME_BIN=<chrome 路径>  SMOKE_BASE=<预览地址>
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CHROME = process.env.CHROME_BIN
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9345;
const PREVIEW_PORT = 5199;
const BASE = process.env.SMOKE_BASE || `http://127.0.0.1:${PREVIEW_PORT}/sxybrick/`;

// 三个悬浮按钮：[名称, 手柄选择器, 定位容器选择器, localStorage 键]
const FABS = [
  ['设置中心', '.settings-fab', '.settings-fab', 'sxy_fab_pos'],
  ['通知中心', '.nb-bell', '.nb-root', 'sxy_nb_pos'],
  ['AI 对话', '.fa-ball', '.fa-root', 'sxy_ai_pos'],
];

// ---------- 启动预览服务 ----------
const preview = spawn(process.execPath, [
  join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
  'preview', '--port', String(PREVIEW_PORT), '--strictPort',
], { cwd: ROOT, stdio: 'ignore' });
const stopPreview = () => { try { preview.kill('SIGKILL'); } catch { /* 已退出 */ } };

async function waitPreview() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('预览服务未就绪');
}

// ---------- 启动 Chrome ----------
const profile = mkdtempSync(join(tmpdir(), 'sxy-fab-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-dev-shm-usage',
  '--window-size=420,900',
  'about:blank',
], { stdio: 'ignore' });
const stopChrome = () => { try { chrome.kill('SIGKILL'); } catch { /* 已退出 */ } };
process.on('exit', () => { stopPreview(); stopChrome(); });

async function getWsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('拿不到 CDP 调试地址');
}

await waitPreview();
const ws = new WebSocket(await getWsUrl());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'unknown');
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
  }
};
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r.result?.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');

// ---------- 两种环境：移动端模拟（touch） / 桌面（mouse） ----------
async function setup(name) {
  errors.length = 0;
  if (name === '移动端模拟 (390×844, touch)') {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  } else {
    await send('Emulation.clearDeviceMetricsOverride');
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
    });
  }
  await send('Page.navigate', { url: `${BASE}?t=${Date.now()}#/` });
  await sleep(1800);
  // 关掉首次访问引导层（Intro/Guide 是全屏遮罩，会拦截所有指针事件）+ 清空旧位置存档
  await evalJs(`try{localStorage.setItem('sxy_onboarding_done','1');localStorage.removeItem('sxy_fab_pos');localStorage.removeItem('sxy_nb_pos');localStorage.removeItem('sxy_ai_pos');}catch(e){} 'ok'`);
  await send('Page.navigate', { url: `${BASE}?t=${Date.now()}#/` });
  await sleep(1800);
}

// 触摸序列（CDP 会据此合成 pointer 事件，与真机手指一致）
async function touchDrag(handleSel, from, to, steps = 12) {
  const pt = (x, y) => [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }];
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(from.x, from.y) });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + (to.x - from.x) * (i / steps);
    const y = from.y + (to.y - from.y) * (i / steps);
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x, y) });
    await sleep(16); // ~60fps 的采样节奏，贴近真机
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(120);
}

async function mouseDrag(handleSel, from, to, steps = 12) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + (to.x - from.x) * (i / steps);
    const y = from.y + (to.y - from.y) * (i / steps);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    await sleep(16);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(120);
}

async function tap(handleSel, pos, isTouch) {
  if (isTouch) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pos.x, y: pos.y, id: 1 }] });
    await sleep(60);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1, buttons: 0 });
  }
  await sleep(400);
}

const rectOf = (sel) => evalJs(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
})()`);

const results = [];

for (const env of ['移动端模拟 (390×844, touch)', '桌面模式 (1280×800, mouse)']) {
  const isTouch = env.startsWith('移动端');
  await setup(env);

  for (const [name, handleSel, rootSel, key] of FABS) {
    if (process.env.ONLY && !name.includes(process.env.ONLY)) continue;
    // 全程探针（拖动前注入）：记录面板开关时机与指针事件，定位"点了没反应/莫名打开"
    await evalJs(`(() => {
      window.__probe = { log: [] };
      const b = document.querySelector(${JSON.stringify(handleSel)});
      if (!b) return 'no-el';
      for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) {
        b.addEventListener(t, () => window.__probe.log.push(t), true);
      }
      const panelCls = ${JSON.stringify(name === 'AI 对话' ? 'fa-panel' : (name === '通知中心' ? 'nb-panel' : 'settings-modal'))}.replace('.','');
      new MutationObserver((muts) => {
        for (const m of muts) {
          m.addedNodes.forEach(n => n.nodeType === 1 && n.classList?.contains(panelCls) && window.__probe.log.push('PANEL+'));
          m.removedNodes.forEach(n => n.nodeType === 1 && n.classList?.contains(panelCls) && window.__probe.log.push('PANEL-'));
        }
      }).observe(document.body, { childList: true, subtree: true });
      return 'ok';
    })()`);
    const before = await rectOf(handleSel);
    if (!before) { results.push({ env, name, ok: false, detail: '元素未找到' }); continue; }
    // 命中测试：中心点若被遮罩挡住，指针事件根本不会派发到按钮上
    const hit = await evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(handleSel)});
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
      return { ok: el === top || el.contains(top), blocker: (el === top || el.contains(top)) ? '' : (top?.className || top?.tagName || '?') };
    })()`);
    if (!hit?.ok) { results.push({ env, name, ok: false, detail: `中心点被遮挡：${hit?.blocker}` }); continue; }

    // ① 拖动到视口中部，位移应生效
    const mid = isTouch ? { x: 195, y: 420 } : { x: 640, y: 400 };
    await (isTouch ? touchDrag : mouseDrag)(handleSel, { x: before.cx, y: before.cy }, mid);
    const after = await rectOf(handleSel);
    const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y);
    const tf = await evalJs(`document.querySelector(${JSON.stringify(rootSel)})?.style.transform || ''`);

    // ② 拖到视口角落（贴近边缘但松手点仍在页面内，模拟真实用户把球推到边上），应被收敛在边界内
    const outside = await rectOf(handleSel);
    await (isTouch ? touchDrag : mouseDrag)(handleSel, { x: outside.cx, y: outside.cy }, { x: 2, y: 2 });
    const clamped = await rectOf(handleSel);
    const inView = clamped.x >= 0 && clamped.y >= 0 && clamped.x + clamped.w <= (await evalJs('window.innerWidth')) + 1;

    // ③ 位置应写入 localStorage
    const saved = await evalJs(`localStorage.getItem(${JSON.stringify(key)})`);

    // ④ 短按（无位移）应触发点击而非拖动
    const p = await rectOf(handleSel);
    const panelSel = name === 'AI 对话' ? '.fa-panel' : (name === '通知中心' ? '.nb-panel' : '.settings-modal');
    const panelOpenBeforeTap = await evalJs(`!!document.querySelector(${JSON.stringify(panelSel)})`);
    await tap(handleSel, { x: p.cx, y: p.cy }, isTouch);
    const opened = await evalJs(`!!document.querySelector(${JSON.stringify(panelSel)})`);
    // 收起面板：全屏遮罩类（设置面板）直接派发一次遮罩点击；气泡类再点一次按钮
    await evalJs(`document.querySelectorAll('.modal-mask').forEach(m => m.dispatchEvent(new MouseEvent('click', { bubbles: true }))); 'ok'`);
    await tap(handleSel, { x: p.cx, y: p.cy }, isTouch);
    await evalJs(`document.querySelectorAll('.modal-mask').forEach(m => m.dispatchEvent(new MouseEvent('click', { bubbles: true }))); 'ok'`);
    const probeLog = await evalJs(`window.__probe?.log.join('>') || ''`);

    const ok = moved > 20 && tf.includes('translate3d') && inView && !!saved && opened;
    results.push({
      env, name, ok,
      detail: `位移=${Math.round(moved)}px transform=${tf || '(无)'} 边界内=${inView} 存档=${saved || '(无)'} tap前面板=${panelOpenBeforeTap} 点击生效=${opened} ‖ ${probeLog}`,
    });
  }
  if (errors.length) results.push({ env, name: '控制台', ok: false, detail: errors.slice(0, 3).join(' | ') });
}

console.log('\n================ 悬浮按钮拖动冒烟 ================');
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} [${r.env}] ${String(r.name).padEnd(8)} ${r.detail}`);
}
const bad = results.filter(r => !r.ok);
console.log(`\n合计 ${results.length} 项，异常 ${bad.length} 项`);

ws.close();
stopPreview();
stopChrome();
process.exit(bad.length ? 1 : 0);
