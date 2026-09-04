// scripts/smoke-cardlink-presets.mjs —— 联动分析「预设按钮」真实产出冒烟测试
//
// 背景：预设曾出现「对话返回空白行、没有真实分析内容和图表数据」。
// 根因（已修）：renderGraphs() 先 dispose 所有 ECharts 实例却不清 el._chart，
//   下次 `if (!el._chart)` 判为已存在 → 复用已销毁实例 → setOption 静默失效 → 380px 空白块。
// 本测试在真实浏览器里逐个点击 6 个预设，断言：
//   1) 每次点击后，历史图表依然有绘制像素（不复现「旧图变空白」）
//   2) graph 类预设产出真实节点/边且画布有内容
//   3) list / timeline 类预设产出非空文本
//   4) 无未捕获异常
//
// 用法：先 `npx vite preview --port 4173 --host 127.0.0.1`，再 `node scripts/smoke-cardlink-presets.mjs`
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN || 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9344;
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:4173/sxybrick/';
const profile = mkdtempSync(join(tmpdir(), 'sxy-clp-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const p = list.find(t => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('CDP 不可用');
}
const ws = new WebSocket(await getWsUrl());
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
const pageErrs = [];
const consoleErrs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    pageErrs.push((d && d.exception && d.exception.description) || d.text || 'err');
  }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error')) {
    consoleErrs.push((m.params.args || []).map(a => (a.value != null ? String(a.value) : (a.description || ''))).join(' '));
  }
};
const send = (method, params) => new Promise((r) => {
  const i = ++id; pending.set(i, r);
  ws.send(JSON.stringify({ id: i, method, params: params || {} }));
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) throw new Error('EVAL: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result && r.result.result && r.result.result.value;
};
async function navigate(hash) {
  await send('Page.navigate', { url: BASE + '?t=' + Date.now() + (hash ? '#' + hash : '') });
  await sleep(1800);
}
const clickText = (text) => evalJs('(() => { const els=[...document.querySelectorAll("button,a,.chip,.btn")]; const hit=els.find(e=>(e.innerText||"").includes(' + JSON.stringify(text) + ')); if(!hit) return false; hit.click(); return true; })()');

let failures = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + ' ' + (extra || '')); if (!cond) failures++; };

// 页面探针：图表绘制像素 + 各 assistant 消息的文本量
const PROBE = `(() => {
  const graphs = [...document.querySelectorAll('.al-graph')].map((el, i) => {
    const cvs = el.querySelector('canvas');
    const base = { i, hasCanvas: !!cvs, hasChart: !!el._chart, ow: el.offsetWidth, oh: el.offsetHeight, html: (el.innerHTML||'').slice(0,60) };
    if (!cvs) return Object.assign(base, { canvas: false, painted: 0 });
    const w = cvs.width || 0, h = cvs.height || 0;
    if (!w || !h) return Object.assign(base, { canvas: true, w: 0, h: 0, painted: 0 });
    let painted = 0;
    try {
      const d = cvs.getContext('2d').getImageData(0, 0, w, h).data;
      for (let p = 3; p < d.length; p += 4 * 32) if (d[p] > 8) painted++;
    } catch (e) { return Object.assign(base, { canvas: true, w, h, painted: -1, err: e.message }); }
    return Object.assign(base, { canvas: true, w, h, painted });
  });
  const msgs = [...document.querySelectorAll('.msg.assistant')].map(el => ({
    len: (el.innerText || '').replace(/\\s+/g, ' ').trim().length,
    tl: el.querySelectorAll('.tl-item').length,
    items: el.querySelectorAll('.res-item').length,
    kind: el.querySelector('.al-graph') ? 'graph' : (el.querySelector('.timeline') ? 'timeline' : (el.querySelector('.res-list') ? 'list' : (el.querySelector('.msg-text') ? 'text' : '?'))),
    html: (el.querySelector('.timeline, .res-list, .msg-text') || {}).innerHTML ? (el.querySelector('.timeline, .res-list, .msg-text').innerHTML || '').replace(/\\s+/g, ' ').slice(0, 160) : '(empty)',
    text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 50),
  }));
  return JSON.stringify({ graphs, msgs });
})()`;

try {
  await navigate('');
  await sleep(600);
  const entered = await clickText('进入演示模式');
  console.log('DIAG 进入演示模式 clicked=' + entered);
  if (entered) await sleep(6000); // 演示模式整页 reload + 播种，需给足时间

  await navigate('/analysis/card-link');
  await sleep(2500);
  const diag = await evalJs('JSON.stringify({ href: location.href.slice(0,90), demo: !!document.querySelector(".demo-banner"), h1: (document.querySelector("h1")||{}).innerText||"", side: document.querySelectorAll(".side-item").length, body: (document.body.innerText||"").replace(/\\s+/g," ").slice(0,140) })');
  console.log('DIAG ' + diag);
  const cardCount = await evalJs('document.querySelectorAll(".side-item").length');
  check('联动分析页：已选卡片非空', cardCount > 0, 'cards=' + cardCount);

  // 逐个点击 6 个预设，每次都复查全部历史图表（验证旧图不会变空白）
  const PRESETS = [
    { key: 'graph', label: '关系图谱', kind: 'graph' },
    { key: 'topo', label: '拓扑排序', kind: 'graph' },
    { key: 'critical', label: '关键路径', kind: 'graph' },
    { key: 'common', label: '共同知识点', kind: 'list' },
    { key: 'path', label: '学习顺序', kind: 'timeline' },
    { key: 'compare', label: '对比前两张', kind: 'list' },
  ];
  let expectedGraphs = 0;
  for (const p of PRESETS) {
    const clicked = await clickText(p.label);
    await sleep(1600);
    if (p.kind === 'graph') expectedGraphs++;
    const raw = await evalJs(PROBE);
    const st = JSON.parse(raw || '{}');
    const graphs = st.graphs || [];
    const msgs = st.msgs || [];
    const last = msgs[msgs.length - 1] || {};

    // 1) 内容非空
    if (p.kind === 'graph') {
      const g = graphs[graphs.length - 1];
      check('预设 ' + p.key + '：最新画布有绘制内容',
        !!g && g.canvas && g.painted > 0,
        'graphs=' + graphs.length + ' hasCanvas=' + (g ? g.hasCanvas : '?') + ' hasChart=' + (g ? g.hasChart : '?')
        + ' box=' + (g ? g.ow + 'x' + g.oh : '?') + ' painted=' + (g ? g.painted : 'n/a'));
    } else if (p.kind === 'timeline') {
      check('预设 ' + p.key + '：timeline 有步骤项', (last.tl || 0) > 0, 'kind=' + last.kind + ' tl=' + last.tl + ' html=' + last.html);
    } else {
      check('预设 ' + p.key + '：list 有条目', (last.items || 0) > 0, 'kind=' + last.kind + ' items=' + last.items + ' html=' + last.html);
    }

    // 2) 历史图表不被新渲染搞成空白（核心回归点）
    if (graphs.length > 1) {
      const blank = graphs.filter(g => g.canvas && g.w > 0 && g.painted <= 0).map(g => g.i);
      check('预设 ' + p.key + '：历史图表未变空白', blank.length === 0,
        '总图=' + graphs.length + ' 空白索引=[' + blank.join(',') + '] painted=' + graphs.map(g => g.painted).join('/'));
    }
    void clicked;
  }

  check('无未捕获异常', pageErrs.length === 0, pageErrs.slice(0, 2).join(' | '));
  const realErrs = consoleErrs.filter(e => !/favicon|Failed to load resource/i.test(e));
  check('无 console.error', realErrs.length === 0, realErrs.slice(0, 2).join(' | '));
} catch (e) {
  console.log('FAIL  脚本异常: ' + (e && e.message));
  failures++;
} finally {
  try { ws.close(); } catch {}
  try { chrome.kill('SIGKILL'); } catch {}
}

console.log(failures ? '\n== ' + failures + " 项失败 ==" : '\n== 全部通过 ==');
process.exit(failures ? 1 : 0);
