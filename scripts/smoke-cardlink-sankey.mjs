import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN || 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9341;
const BASE = 'http://127.0.0.1:5199/sxybrick/';
const profile = mkdtempSync(join(tmpdir(), 'sxy-cl-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try { const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const p = list.find(t => t.type === 'page'); if (p && p.webSocketDebuggerUrl) return p.webSocketDebuggerUrl; } catch {}
    await sleep(250);
  }
  throw new Error('CDP 不可用');
}
const ws = new WebSocket(await getWsUrl());
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map(); const pageErrs = []; const consoleErrs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails; pageErrs.push((d && d.exception && d.exception.description) || (d && d.text) || 'err');
  }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    consoleErrs.push((m.params.args || []).map(a => a.value != null ? String(a.value) : (a.description || '')).join(' '));
  }
};
const send = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) throw new Error('EVAL: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result && r.result.result && r.result.result.value;
};
async function navigate(hash) {
  await send('Page.navigate', { url: BASE + '?t=' + Date.now() + (hash ? '#' + hash : '') });
  await sleep(1600);
}
async function clickText(text) {
  return evalJs('(() => { const els=[...document.querySelectorAll("button,a,.chip,.btn")]; const hit=els.find(e=>(e.innerText||"").includes(' + JSON.stringify(text) + ')); if(!hit) return false; hit.click(); return true; })()');
}

let failures = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + ' ' + (extra || '')); if (!cond) failures++; };

try {
  await navigate('');
  await sleep(600);
  const entered = await clickText('进入演示模式');
  if (entered) await sleep(3000);

  // 1) 联动分析写库：点预设触发 ensureSession + pushResult（旧代码 DataCloneError）
  await navigate('/analysis/card-link');
  await sleep(1200);
  const presetClicked = await clickText('关系图谱');
  await sleep(1800);
  const sessCount = await evalJs('(async () => { const m=await import("/sxybrick/src/db.js"); try { return await m.db.analysisSessions.count(); } catch(e){ return "ERR:"+e.message; } })()');
  check('联动分析：点预设后会话落库（修复 DataCloneError）', typeof sessCount === 'number' && sessCount >= 1, 'count=' + sessCount + ' clicked=' + presetClicked);

  // 2) 导图桑基：用页面算法验证节点仅含 name、links 用 name
  const sankey = await evalJs('(async () => { const { sankeyFromTree }=await import("/sxybrick/src/algorithms/mindmap-graph.js"); const root={id:"a1",label:"中心主题",children:[{id:"b1",label:"子节点一",children:[]},{id:"b2",label:"子节点二",children:[]}]}; const toChart=n=>({name:n.label,id:n.id,children:(n.children||[]).map(toChart)}); const r=sankeyFromTree(toChart(root)); return { names:r.nodes.map(n=>n.name), hasId:r.nodes.some(n=>"id" in n), linkSrc:r.links[0]&&r.links[0].source }; })()');
  check('导图桑基：节点仅含 name、无 id', sankey && sankey.hasId === false, JSON.stringify(sankey));
  check('导图桑基：links 用 name 匹配（非字母 id）', sankey && sankey.linkSrc === '中心主题', 'linkSrc=' + (sankey && sankey.linkSrc));

  // 真实渲染：新建导图并切桑基，确认 canvas 存在
  await navigate('/mindmap');
  await sleep(1000);
  await clickText('新导图');
  await sleep(800);
  await clickText('桑基图');
  await sleep(1400);
  const canvasOk = await evalJs('(() => document.querySelectorAll("canvas").length > 0)()');
  check('导图桑基：切换后页面存在 canvas（已渲染）', canvasOk === true);
} catch (e) {
  console.log('SCRIPT_ERROR', e.message); failures++;
} finally {
  console.log('--- page exceptions ---');
  pageErrs.slice(0, 8).forEach(e => console.log('  PAGEERR:', String(e).slice(0, 200)));
  const cloneErr = pageErrs.concat(consoleErrs).some(t => /DataCloneError|could not be cloned/i.test(t));
  check('全局无 DataCloneError', !cloneErr);
  console.log(failures === 0 ? '\nALL_PASS' : '\nFAILURES=' + failures);
  try { chrome.kill('SIGKILL'); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
