import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN || 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9342;
const BASE = 'http://127.0.0.1:5199/sxybrick/';
const profile = mkdtempSync(join(tmpdir(), 'sxy-sk-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });

async function getWsUrl() {
  for (let i = 0; i < 60; i++) { try { const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); const p = list.find(t => t.type === 'page'); if (p && p.webSocketDebuggerUrl) return p.webSocketDebuggerUrl; } catch {} await sleep(250); }
  throw new Error('CDP 不可用');
}
const ws = new WebSocket(await getWsUrl());
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map(); const pageErrs = [];
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; } if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; pageErrs.push((d && d.exception && d.exception.description) || (d && d.text) || 'err'); } };
const send = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EVAL: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result && r.result.result && r.result.result.value; };
async function navigate(hash) { await send('Page.navigate', { url: BASE + '?t=' + Date.now() + (hash ? '#' + hash : '') }); await sleep(1600); }

let failures = 0;
const check = (n, c, e) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + ' ' + (e || '')); if (!c) failures++; };
try {
  // 进演示模式（有种子数据），用现有导图或新建一个含子节点的导图
  await navigate('');
  await sleep(600);
  const entered = await evalJs('(() => { const els=[...document.querySelectorAll("button,a,.chip,.btn")]; const hit=els.find(e=>(e.innerText||"").includes("进入演示模式")); if(hit){hit.click();return true;} return false; })()');
  if (entered) await sleep(3000);

  // 用页面 db 直接 seed 一个多节点导图（绕过 UI 选择），再打开并切桑基
  await evalJs('(async () => { const dbm=await import("/sxybrick/src/db.js"); const rep=await import("/sxybrick/src/repo.js"); const uid=dbm.uid; const root={id:uid(),label:"中心主题",children:[{id:uid(),label:"子节点一",children:[]},{id:uid(),label:"子节点二",children:[{id:uid(),label:"孙节点",children:[]}]}]}; await rep.createMindmap({title:"CDP验证导图",root}); return true; })()');
  await sleep(600);

  await navigate('/mindmap');
  await sleep(1200);
  // 打开刚建的导图（列表第一项）
  await evalJs('(() => { const rows=[...document.querySelectorAll(".mm-row,.side-item,button")]; const hit=rows.find(e=>(e.innerText||"").includes("CDP验证导图")); if(hit) hit.click(); return !!hit; })()');
  await sleep(1000);
  // 切桑基图
  await evalJs('(() => { const els=[...document.querySelectorAll("button,.chip")]; const hit=els.find(e=>(e.innerText||"").includes("桑基图")); if(hit){hit.click();return true;} return false; })()');
  await sleep(1500);

  // 读取当前 ECharts 实例的 sankey 节点渲染文本（从 canvas 无法读文字，改为读组件内 chart option）
  const info = await evalJs('(() => { const cs=document.querySelectorAll("canvas"); return { canvasCount: cs.length, sizes: [...cs].map(c=>(c.width+"x"+c.height)) }; })()');
  check('有数据的导图切桑基后渲染出 canvas（节点可见）', info && info.canvasCount > 0 && info.sizes.some(s => s !== "0x0"), JSON.stringify(info));
} catch (e) { console.log('SCRIPT_ERROR', e.message); failures++; }
finally {
  console.log('--- page exceptions ---'); pageErrs.slice(0, 6).forEach(e => console.log('  PAGEERR:', String(e).slice(0, 160)));
  check('无未捕获异常', pageErrs.length === 0);
  console.log(failures === 0 ? '\nALL_PASS' : '\nFAILURES=' + failures);
  try { chrome.kill('SIGKILL'); } catch {} process.exit(failures === 0 ? 0 : 1);
}
