// 无依赖的 CDP 冒烟脚本：用系统 Chrome headless + 原生 WebSocket
// 逐个访问关键路由，收集 console error / 未捕获异常 / Vue 告警。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:5199/sxybrick/';

// 路由表直接从 router.js 解析，避免新增页面后漏测
import { readFileSync } from 'node:fs';
const routerSrc = readFileSync(new URL('../src/router.js', import.meta.url), 'utf8');
const ROUTES = [];
for (const m of routerSrc.matchAll(/path:\s*'([^']+)'\s*,\s*component:\s*\(\)\s*=>\s*import\('[^']*\/([^/']+)\.vue'\)/g)) {
  ROUTES.push([m[1], m[2]]);
}
if (!ROUTES.length) {
  ROUTES.push(['/search', 'Search'], ['/graph', 'KnowledgeGraph'], ['/mindmap', 'Mindmap']);
}

const profile = mkdtempSync(join(tmpdir(), 'sxy-smoke-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-dev-shm-usage',
  '--window-size=1280,900',
  'about:blank',
], { stdio: 'ignore' });

const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('拿不到 CDP 调试地址');
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const events = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    events.push({ kind: 'exception', text: d.exception?.description || d.text || 'unknown' });
  } else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    const text = (m.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ');
    events.push({ kind: m.params.type, text });
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    events.push({ kind: 'log', text: m.params.entry.text });
  }
};

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

// 用演示模式（自动播种示例数据），这样图谱/导图/分类页都有真实数据可跑
await send('Page.navigate', { url: `${BASE}#/` });
await sleep(800);
await send('Runtime.evaluate', { expression: `localStorage.setItem('sxy_app_mode','test')`, awaitPromise: false });

const report = [];
for (const [route, name] of ROUTES) {
  events.length = 0;
  // 加变化的 query 强制整页加载（只改 hash 属于同文档导航，CDP 可能 no-op）
  await send('Page.navigate', { url: `${BASE}?t=${Date.now()}#${route}` });
  await sleep(2400); // 等路由懒加载 + 数据查询 + ECharts 渲染

  const dom = await send('Runtime.evaluate', {
    expression: `(() => {
      const app = document.querySelector('#app');
      const txt = (app?.innerText || '').trim();
      // ErrorBoundary 兜底时会渲染「重试」按钮 —— 这是「页面其实崩了但没白屏」的信号
      const crashed = [...document.querySelectorAll('button')].some(b => (b.innerText || '').trim() === '重试');
      const body = (document.querySelector('.view, main, .page') || app)?.innerText || txt;
      return {
        len: txt.length,
        bodyLen: String(body).trim().length,
        canvas: document.querySelectorAll('canvas').length,
        crashed,
      };
    })()`,
    returnByValue: true,
  });
  const v = dom.result?.result?.value || {};
  const errs = events.filter(e => e.kind === 'exception' || e.kind === 'error' || e.kind === 'log');
  const warns = events.filter(e => e.kind === 'warning');
  if (v.crashed) errs.push({ text: '页面被 ErrorBoundary 兜底（出现「重试」按钮）= 组件挂载时抛错' });

  report.push({
    route, name,
    textLen: v.len || 0,
    canvas: v.canvas || 0,
    errors: errs.map(e => e.text.slice(0, 200)),
    warns: warns.length,
  });
}

console.log('\n================ 冒烟结果 ================');
for (const r of report) {
  const ok = r.errors.length === 0 && r.textLen > 5;
  console.log(`${ok ? '✅' : '❌'} ${String(r.name).padEnd(20)} ${String(r.route).padEnd(24)} 文本=${String(r.textLen).padStart(5)} canvas=${r.canvas}`);
  for (const e of r.errors) console.log(`     ⛔ ${e}`);
}
const bad = report.filter(r => r.errors.length || r.textLen <= 5);
console.log(`\n合计 ${report.length} 页，异常 ${bad.length} 页`);

ws.close();
cleanup();
process.exit(bad.length ? 1 : 0);
