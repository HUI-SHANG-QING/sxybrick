// scripts/smoke-aiassistant-ui.mjs —— AI 学习助手 UI 改动的真实浏览器冒烟
//
// 覆盖 3 个回归点：
//   1) 窄屏(390px)下 .chat-side 抽屉与工具行的 grid 重叠修复：展开「历史对话」后
//      点击某条历史能真正选中（旧实现里 .chat-fs-row 被 stretch 成整行高、透明盖在
//      列表上吞掉点击 → 点了没反应），且选中后抽屉自动收起。
//   2) 窄屏「提问节点」抽屉可展开、节点可点（无异常）。
//   3) 桌面指针设备：历史条目 hover 放大(scale 1.035)、移开缩小回 none。
//   4) 顶部演示横幅已移除（入口迁入设置中心）。
// 用法：node scripts/smoke-aiassistant-ui.mjs（内部自起 vite preview）
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN || 'C://Program Files/Google/Chrome/Application/chrome.exe';
const PREVIEW_PORT = 4180;
const CDP_PORT = 9351;
const BASE = `http://127.0.0.1:${PREVIEW_PORT}/sxybrick/`;
// 应用为 hash 路由：同文档仅改 hash 时 Page.navigate 可能是 no-op，须带 ?t= 缓存破坏参数强制真跳转
const AI_URL = () => `${BASE}?t=${Date.now()}#/ai`;
const results = [];
const pageErrs = [];
const consoleErrs = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? '  — ' + extra : ''}`);
}
function fatal(msg) {
  console.log('FATAL: ' + msg);
  cleanup();
  process.exit(1);
}

const procs = [];
function cleanup() {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
}
process.on('exit', cleanup);

async function waitHttp(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(800) }); if (r.ok) return; } catch {}
    await sleep(400);
  }
  throw new Error('preview 未就绪: ' + url);
}

async function getWsUrl(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.find(t => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('CDP 不可用');
}

const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--host', '127.0.0.1'], { cwd: process.cwd(), stdio: 'ignore', shell: true });
procs.push(preview);
await waitHttp(BASE);

const profile = mkdtempSync(join(tmpdir(), 'sxy-aiui-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--remote-allow-origins=*',
  '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });
procs.push(chrome);

const ws = new WebSocket(await getWsUrl(CDP_PORT));
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    pageErrs.push((d && d.exception && d.exception.description) || d.text || 'exception');
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrs.push((m.params.args || []).map(a => (a.value != null ? String(a.value) : (a.description || ''))).join(' '));
  }
};
const send = (method, params) => new Promise((r) => {
  const i = ++seq; pending.set(i, r);
  ws.send(JSON.stringify({ id: i, method, params: params || {} }));
});
async function evalJs(expr) {
  const m = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (m.result?.exceptionDetails) throw new Error('eval 异常: ' + (m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text));
  return m.result?.result?.value;
}
async function nav(url, waitSel, timeout = 15000) {
  await send('Page.navigate', { url });
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const ok = await evalJs(`!!document.querySelector(${JSON.stringify(waitSel)})`).catch(() => false);
    if (ok) return;
    await sleep(200);
  }
  throw new Error('页面未就绪: ' + url + ' 等待 ' + waitSel);
}

// 1) 窄屏 → 打开 /ai，播种一条历史对话（应用先 boot 建库，再写 aiChats）
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await nav(BASE, '.app-shell', 20000);
await sleep(1200); // 等 IndexedDB schema upgrade 完成
const seeded = await evalJs(`(async () => {
  for (let i = 0; i < 30; i++) {
    try {
      const d = await new Promise((res, rej) => { const o = indexedDB.open('sxybrick'); o.onsuccess = () => res(o.result); o.onerror = () => rej(o.error); });
      await new Promise((res, rej) => {
        const tx = d.transaction('aiChats', 'readwrite');
        tx.objectStore('aiChats').put({ id: 'smoke-chat-1', title: '冒烟对话标题', messages: [{ role: 'user', content: '第一个问题' }, { role: 'assistant', content: '冒烟回复正文XYZ' }, { role: 'user', content: '第二个问题' }], createdAt: Date.now(), updatedAt: Date.now() });
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      });
      return true;
    } catch { await new Promise(r => setTimeout(r, 400)); }
  }
  return false;
})()`);
check('播种测试对话到 aiChats', seeded === true);

await nav(AI_URL(), '.chat-side');
check('演示横幅已从顶部移除', !(await evalJs(`!!document.querySelector('.demo-banner')`)));

// 2) 展开「历史对话」抽屉 → 点条目 → 应选中且抽屉收起
const clickBtnAny = (texts) => `(() => { const bs = [...document.querySelectorAll('button')]; for (const t of ${JSON.stringify(texts)}) { const p = bs.find(b => (b.textContent || '').includes(t)); if (p) { p.click(); return true; } } return false; })()`;
const openedSide = await evalJs(clickBtnAny(['📋', '历史对话', 'History']));
await sleep(400);
const sideOpen = await evalJs(`!!document.querySelector('.chat-side.expanded')`);
const sidePointer = await evalJs(`document.querySelector('.chat-side.expanded') ? getComputedStyle(document.querySelector('.chat-side.expanded')).pointerEvents : ''`);
check('窄屏 📋 展开历史抽屉', sideOpen, 'pointer-events=' + sidePointer);
const chatCount = await evalJs(`document.querySelectorAll('.chat-item').length`);
check('抽屉内有历史条目', chatCount >= 1, 'items=' + chatCount);

await evalJs(`document.querySelector('.chat-item') && document.querySelector('.chat-item').click()`);
await sleep(500);
const loaded = await evalJs(`(() => { const box = document.querySelector('.chat-box'); return box ? box.innerText.includes('冒烟回复正文XYZ') : false; })()`);
const autoClosed = await evalJs(`!document.querySelector('.chat-side.expanded')`);
check('点击历史条目真正加载对话（死区修复）', loaded === true);
check('选中后抽屉自动收起', autoClosed === true);

// 3) 提问节点抽屉
await evalJs(clickBtnAny(['📌', '提问节点', 'Nodes']));
await sleep(400);
const tlOpen = await evalJs(`!!document.querySelector('.timeline.expanded')`);
const tlNodes = await evalJs(`document.querySelectorAll('.tl-node').length`);
check('窄屏 📌 展开提问节点抽屉', tlOpen === true, 'nodes=' + tlNodes);
if (tlOpen && tlNodes >= 1) {
  const tlClickOk = await evalJs(`(() => { try { document.querySelector('.tl-node').click(); return true; } catch (e) { return 'ERR:' + e.message; } })()`);
  check('点击提问节点无异常', tlClickOk === true);
}

// 4) 桌面 hover 放大 / 离开缩小
await send('Emulation.clearDeviceMetricsOverride');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.reload', { ignoreCache: true });
await sleep(2500);
const desktopItems = await evalJs(`document.querySelectorAll('.chat-item').length`);
check('桌面布局有历史条目', desktopItems >= 1, 'items=' + desktopItems);

const hoverCapable = await evalJs(`matchMedia('(hover: hover) and (pointer: fine)').matches`);
const rulePresent = await evalJs(`(() => { for (const s of document.styleSheets) { try { for (const r of s.cssRules) { if (r.cssText && r.cssText.includes('scale(1.035)')) return true; } } catch {} } return false; })()`);
check('CSS 含 hover 放大规则 scale(1.035)', rulePresent === true);

const rect = await evalJs(`(() => { const el = document.querySelector('.chat-item'); if (!el) return null; el.scrollIntoView({ block: 'center' }); return true; })()`);
if (rect && hoverCapable) {
  // headless 下 Input.dispatchMouseEvent 不激活 :hover，改用 CSS.forcePseudoState 强制 hover 伪类做确定性验证
  await send('DOM.enable');
  await send('CSS.enable');
  const doc = await send('DOM.getDocument', { depth: -1 });
  const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '.chat-item' });
  const nodeId = q.result.nodeId;
  await send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
  await sleep(350);
  const onHover = await evalJs(`getComputedStyle(document.querySelector('.chat-item')).transform`);
  check('hover 放大生效（transform 含 1.035）', typeof onHover === 'string' && onHover.includes('1.035'), onHover);
  await send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
  await sleep(350);
  const leftT = await evalJs(`getComputedStyle(document.querySelector('.chat-item')).transform`);
  check('移开鼠标恢复原尺寸（transform=none）', leftT === 'none' || leftT === '', leftT);
} else {
  console.log('ℹ️ headless 无 (hover:hover) 能力，跳过运行时 hover 变换断言（CSS 规则已确认存在）');
}

// 5) 设置中心含演示模式入口（storage 页签）
await evalJs(clickBtnAny(['🎨']));
await sleep(600);
const demoInSettings = await evalJs(`(() => {
  const mask = [...document.querySelectorAll('.modal-mask')].find(m => (m.innerText||'').includes('设置中心') || (m.innerText||'').includes('Settings'));
  if (!mask) return false;
  const tabs = [...mask.querySelectorAll('.el-tabs__item')];
  const storageTab = tabs.find(t => (t.textContent||'').includes('存储') || (t.textContent||'').includes('Storage'));
  if (!storageTab) return 'no-storage-tab';
  storageTab.click(); return true;
})()`);
await sleep(500);
const demoBtns = await evalJs(`(() => {
  const mask = [...document.querySelectorAll('.modal-mask')].find(m => (m.innerText||'').includes('设置中心') || (m.innerText||'').includes('Settings'));
  return mask ? (mask.innerText.includes('演示模式') || mask.innerText.includes('Demo Mode')) : false;
})()`);
check('设置中心 → 存储 含演示模式区块', demoBtns === true);

console.log('\n--- 结果 ---');
let failed = 0;
for (const r of results) if (!r.ok) failed++;
if (pageErrs.length) console.log('页面运行时异常 ' + pageErrs.length + ' 条：', pageErrs.slice(0, 3));
if (consoleErrs.length) console.log('console.error ' + consoleErrs.length + ' 条（仅供参考）:', consoleErrs.slice(0, 3));
console.log(failed === 0 && pageErrs.length === 0 ? 'SMOKE PASS' : `SMOKE FAIL (${failed} 项断言失败 / ${pageErrs.length} 运行时异常)`);
process.exit(failed === 0 && pageErrs.length === 0 ? 0 : 1);
