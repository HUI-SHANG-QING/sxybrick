// 文件上传冒烟：用 CDP 的 DOM.setFileInputFiles 真实注入文件，观察解析结果
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:5200/sxybrick/';

// 准备一个真实上传文件（Markdown 讲义）
const upDir = mkdtempSync(join(tmpdir(), 'sxy-up-'));
const file = join(upDir, '操作系统-死锁讲义.md');
writeFileSync(file, '# 死锁\n\n死锁产生的四个必要条件：互斥、占有且等待、不可抢占、循环等待。\n\n银行家算法用于避免死锁。\n', 'utf8');

const profile = mkdtempSync(join(tmpdir(), 'sxy-prof-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

async function getWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find(t => t.type === 'page');
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('CDP 不可用');
}
const ws = new WebSocket(await getWs());
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map(); const errs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.text || 'err');
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 200) };
  return r.result?.result?.value;
};

await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
await send('Page.navigate', { url: `${BASE}#/materials` });
await sleep(1200);
await evalJs(`localStorage.setItem('sxy_app_mode','test')`);
await send('Page.reload', { ignoreCache: true });
await sleep(3000);

console.log('OPFS 能力:', await evalJs(`({
  getDirectory: !!navigator.storage?.getDirectory,
  createWritable: typeof FileSystemFileHandle !== 'undefined'
    && typeof FileSystemFileHandle.prototype.createWritable === 'function',
})`));

// 找到隐藏的 file input 并注入文件
const doc = await send('DOM.getDocument', { depth: -1 });
function findInput(node, out = null) {
  if (out) return out;
  if (node.nodeName === 'INPUT' && node.attributes) {
    const attrs = Object.fromEntries(node.attributes.map((v, i, a) => [v, a[i + 1]]).length
      ? node.attributes.map((v, i, a) => (i % 2 === 0 ? [v, a[i + 1]] : null)).filter(Boolean) : []);
    if (attrs.type === 'file') return { nodeId: node.nodeId };
  }
  for (const c of node.children || []) { const r = findInput(c); if (r) return r; }
  return null;
}
const input = findInput(doc.result.root);
console.log('找到 file input:', !!input);

if (input) {
  await send('DOM.setFileInputFiles', { files: [file], nodeId: input.nodeId });
  await sleep(6000); // 等上传 + 解析队列
}

const state = await evalJs(`(() => {
  const t = document.querySelector('#app').innerText;
  return {
    rows: (t.match(/\\d+\\.\\d+\\s*KB|\\d+\\s*B/g) || []).slice(0,3),
    ready: /就绪/.test(t),
    failed: /失败/.test(t),
    parsing: /解析中/.test(t),
    hasName: /死锁讲义/.test(t),
    errMsg: (t.match(/失败：([^\\n]{0,120})/) || [])[1] || '',
  };
})()`);
console.log('上传结果:', JSON.stringify(state));

const dbState = await evalJs(`(async () => {
  const m = await import('/sxybrick/src/db.js');
  const rows = await m.db.docFiles.toArray();
  const texts = await m.db.docTexts.toArray();
  const blobs = await m.db.docBlobs.toArray();
  return {
    files: rows.map(r => ({ name: r.name, status: r.status, storage: r.storage, err: r.error || null })),
    textLen: texts.map(t => t.textLen),
    docFilesHasBlob: rows.some(r => 'blob' in r && r.blob),
    docBlobs: blobs.length,
  };
})()`);
console.log('库内状态:', JSON.stringify(dbState, null, 1));
console.log('未捕获异常:', errs.length ? errs : '无');
ws.close(); cleanup(); process.exit(0);
