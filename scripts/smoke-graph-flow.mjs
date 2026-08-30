// 端到端验证「知识图谱真的有关联」：
//   1) 演示库播种 20 张卡（5 科目）
//   2) 图谱页点「🔗 智能推荐关联」→ 全部保存（本地算法，无需 AI key）
//   3) 校验图谱页显示的是卡片正文（不是裸 ID），且渲染出 canvas
//   4) 导图页「从知识图谱」生成 → 切力导向 → 校验仍渲染 canvas
//   5) 模拟历史脏数据（把卡片 UUID 直接写进 graphEdges）→ 校验被正确解析而非显示成 ID
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:5199/sxybrick/';

const profile = mkdtempSync(join(tmpdir(), 'sxy-flow-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(t => t.type === 'page');
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('CDP 不可用');
}
const ws = new WebSocket(await getWsUrl());
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let id = 0; const pending = new Map(); const errs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'err');
  }
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
const clickText = async (text, exact = false) => {
  const r = await evalJs(`(() => {
    const els = [...document.querySelectorAll('button, a, .chip, .btn')];
    const hit = els.find(e => ${exact}
      ? (e.innerText || '').trim() === ${JSON.stringify(text)}
      : (e.innerText || '').includes(${JSON.stringify(text)}));
    if (!hit) return false;
    hit.click(); return true;
  })()`);
  return r;
};
// 注意：只改 hash 属于同文档导航，CDP 的 Page.navigate 可能是 no-op，
// 加一个变化的 query 强制整页加载，保证路由组件重新挂载
const go = async (hash) => {
  await send('Page.navigate', { url: `${BASE}?t=${Date.now()}#${hash}` });
  await sleep(2600);
};
// 切模式必须整页 reload：hash 变化不会重跑 appMode.init()，演示库也不会播种
const reload = async () => { await send('Page.reload', { ignoreCache: true }); await sleep(2600); };

await send('Runtime.enable'); await send('Page.enable');
await go('/');
await evalJs(`localStorage.setItem('sxy_app_mode','test')`);
await reload(); // 演示模式生效 + 自动播种 20 张示例卡
console.log('演示库卡片数:', await evalJs(`(async () => {
  const m = await import('/sxybrick/src/db.js'); return (await m.db.cards.toArray()).length;
})()`));
await go('/graph');

console.log('步骤 1：图谱页点「智能推荐关联」');
let clicked = await clickText('智能推荐关联');
if (!clicked) { await sleep(3000); clicked = await clickText('智能推荐关联'); }
if (!clicked) {
  const btns = await evalJs(`[...document.querySelectorAll('button')].map(b=>(b.innerText||'').trim().slice(0,20))`);
  console.log('  ⚠️ 未找到按钮，当前页面按钮:', JSON.stringify(btns));
  console.log('  当前 hash:', await evalJs('location.hash'));
}
console.log('  点击结果:', clicked);
await sleep(2500);

let info = await evalJs(`(() => {
  const t = document.querySelector('#app').innerText;
  const m = t.match(/智能推荐 (\\d+) 条关联/);
  return { rec: m ? Number(m[1]) : 0, hasBox: /智能推荐/.test(t) };
})()`);
console.log('  推荐条数:', info.rec);

if (info.rec > 0) {
  await clickText('全部保存');
  await sleep(2000);
}

info = await evalJs(`(() => {
  const t = document.querySelector('#app').innerText;
  const m = t.match(/已保存的知识图谱（(\\d+) 条关联 · (\\d+) 个章节/);
  const canvas = document.querySelectorAll('canvas').length;
  return { edges: m ? Number(m[1]) : 0, clusters: m ? Number(m[2]) : 0, canvas,
           sample: (t.match(/已保存的知识图谱[\\s\\S]{0,200}/) || [''])[0].replace(/\\n/g, ' | ') };
})()`);
console.log('步骤 2：已保存关联:', JSON.stringify(info, null, 0));

console.log('\n步骤 3：注入历史脏数据（from/to 直接是卡片 UUID，无 label/subject）');
const injected = await evalJs(`(async () => {
  const mod = await import('/sxybrick/src/db.js');
  const db = mod.db;
  const cards = await db.cards.toArray();
  if (cards.length < 2) return { ok:false, reason:'卡片不足' };
  const rows = [];
  for (let i = 1; i < Math.min(cards.length, 12); i++) {
    rows.push({ id: 'auto-'+cards[0].id+'-'+cards[i].id, from: cards[0].id, to: cards[i].id,
                kind: 'auto', weight: 0.6, createdAt: Date.now(), updatedAt: Date.now() });
  }
  await db.graphEdges.bulkPut(rows);
  return { ok:true, n: rows.length, sampleFrom: rows[0].from };
})()`);
console.log('  注入:', JSON.stringify(injected));

await reload(); // 必须整页重载：同 hash 跳转不会重跑 loadSaved
const after = await evalJs(`(() => {
  const t = document.querySelector('#app').innerText;
  const m = t.match(/已保存的知识图谱（(\\d+) 条关联 · (\\d+) 个章节/);
  const warn = (t.match(/有 (\\d+) 条关联的两端找不到对应卡片/) || [])[1];
  // 页面上是否出现裸 UUID（说明解析失败）
  const uuidShown = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(
    (document.querySelector('.saved-box') || document.body).innerText
  );
  return { edges: m ? Number(m[1]) : 0, clusters: m ? Number(m[2]) : 0, deadWarn: warn || 0, uuidShown };
})()`);
console.log('  注入后:', JSON.stringify(after));
console.log('  → 裸 UUID 泄漏到界面:', after.uuidShown ? '❌ 是' : '✅ 否');
console.log('  → 失效提示:', after.deadWarn);

console.log('\n步骤 4：导图页「从知识图谱」→ 切力导向');
await go('/mindmap');
const g = await clickText('从知识图谱');
console.log('  点击「从知识图谱」:', g);
await sleep(2200);
await clickText('力导向', true);
await sleep(1800);
const mm = await evalJs(`(() => ({
  canvas: document.querySelectorAll('canvas').length,
  maps: document.querySelectorAll('.mm-item').length,
  txt: (document.querySelector('.mm-main') || {}).innerText?.slice(0,80) || '',
}))()`);
console.log('  导图状态:', JSON.stringify(mm));

console.log('\n未捕获异常:', errs.length ? errs : '无');
ws.close(); cleanup();
process.exit(0);
