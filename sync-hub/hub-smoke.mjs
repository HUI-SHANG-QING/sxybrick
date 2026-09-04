// 局域网中枢冒烟测试（node sync-hub/hub-smoke.mjs，需先 npm run hub）
const B = process.argv[2] || 'http://localhost:18080';
const TOKEN = process.argv[3];
const out = [];
const log = (...a) => { out.push(a.join(' ')); console.log(...a); };

const o = await fetch(B + '/backup', { method: 'OPTIONS' });
log('OPTIONS', o.status, 'allow-headers=', o.headers.get('access-control-allow-headers'), 'allow-origin=', o.headers.get('access-control-allow-origin'));

const g1 = await fetch(B + '/backup');
log('GET no-token ->', g1.status);

const idx = await fetch(B + '/');
const h = await idx.text();
log('GET / ->', idx.status, h.includes('<div id="app">') ? 'html-ok' : 'html-BAD', 'ct=', idx.headers.get('content-type'));

// 找一个真实 dist 资源验证 base 前缀剥离
const assets = ['index-D53aKO0v.js'];
let assetOk = true;
for (const a of assets) {
  const js = await fetch(B + '/sxybrick/assets/' + a);
  const jt = await js.text();
  const isJs = jt.startsWith('import') || jt.includes('export{') || jt.includes('const ');
  log('GET', a, '->', js.status, 'is-js=', isJs);
  if (!isJs || js.status !== 200) assetOk = false;
}

const now = Date.now();
const bk = {
  version: 3, app: 'sxybrick', exportedAt: now,
  cards: [
    { id: 'smoke1', front: '冒烟测试卡1', back: '答1', subject: '测试', tags: [], type: 'basic', ease: 2.5, level: 0, intervalDays: 0, dueAt: now, createdAt: now, updatedAt: now },
    { id: 'smoke2', front: '冒烟测试卡2', back: '答2', subject: '测试', tags: [], type: 'basic', ease: 2.5, level: 0, intervalDays: 0, dueAt: now, createdAt: now, updatedAt: now },
  ],
  reviews: [], tombstones: [], images: [], aiChats: [], aiMemories: [], memos: [], plans: [], graphEdges: [], docs: [], pomoSessions: [],
  streakMeta: { goal: 20, updatedAt: now },
};

if (TOKEN) {
  const p = await fetch(B + '/backup', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-sync-token': TOKEN }, body: JSON.stringify(bk) });
  const pr = await p.json();
  log('PUT token ->', p.status, 'app=', pr.app, 'version=', pr.version, 'cards=', pr.cards?.length);

  const g2 = await fetch(B + '/backup', { headers: { 'x-sync-token': TOKEN } });
  const gr = await g2.json();
  log('GET token ->', g2.status, 'cards=', gr.cards?.length, 'goal=', gr.streakMeta?.goal);

  const bad = await fetch(B + '/backup', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-sync-token': 'wrong' }, body: JSON.stringify(bk) });
  log('PUT bad-token ->', bad.status);
}