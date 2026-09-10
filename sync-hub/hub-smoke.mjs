// 局域网中枢冒烟测试（node sync-hub/hub-smoke.mjs [http://IP:18080] <同步密码>，需先启动中枢）
//
// ⚠️ 用例顺序很重要（round39 修复）：中枢对「鉴权失败」有渐进退避（首次失败即锁 ~1s，
// 反复失败指数增长到 15min）。旧版脚本**先把"故意不带 token"的负向用例放在最前**，
// 那次 401 会立刻触发锁定，导致紧随其后的**正确 token 请求也被连坐返回 401**
// —— 表现为「PUT token -> 401」，会被误判成"中枢鉴权坏了"。
// 现在：正向用例全部前置；负向用例放最后，且彼此间隔超过锁定窗口。
const B = (process.argv[2] || 'http://localhost:18080').replace(/\/+$/, '');
const TOKEN = process.argv[3];
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 1) 正向：只读探活
const o = await fetch(B + '/backup', { method: 'OPTIONS' });
log('OPTIONS', o.status, 'allow-headers=', o.headers.get('access-control-allow-headers'), 'allow-origin=', o.headers.get('access-control-allow-origin'));

const idx = await fetch(B + '/');
const h = await idx.text();
log('GET / ->', idx.status, h.includes('<div id="app">') ? 'html-ok' : 'html-BAD', 'ct=', idx.headers.get('content-type'));

// 从 index.html 动态解析真实资源名（产物哈希每次构建都会变；硬编码会误报）
// round40：① 兼容双引号/单引号/无引号（旧正则只认双引号，构建工具换引号风格会**静默**
//            跳过这条检查 = 测试悄悄失效）；② 解析不到就报错退出（不再静默跳过）。
const assetMatch = h.match(/(?:src|href)=["']?([^"'\s>]*assets\/[^"'\s>]+\.js)["']?/);
const assetPath = assetMatch ? assetMatch[1] : null;
if (assetPath) {
  const js = await fetch(B + (assetPath.startsWith('/') ? assetPath : '/' + assetPath));
  const jt = await js.text();
  // 判 JS 的判据保持宽松（只要求像 JS），但**必须**同时确认 HTTP 200 且不是 HTML 错误页
  const looksJs = jt.startsWith('import') || jt.includes('export{') || jt.includes('const ') || jt.includes('function');
  const isHtml = /^\s*<(!doctype|html)/i.test(jt);
  const isJs = looksJs && !isHtml;
  log('GET', assetPath, '->', js.status, 'is-js=', isJs);
  if (js.status !== 200 || !isJs) process.exitCode = 1;
} else {
  // 关键：不再静默跳过——解析规则失效必须让脚本变红，否则这条检查会悄悄消失
  log('GET assets/*.js -> ✗ 未能从 index.html 解析出 JS 资源引用（解析规则可能已失效，请更新正则）');
  process.exitCode = 1;
}

// —— 2) 正向：带密码读写（必须在任何失败请求之前）
if (TOKEN) {
  const now = Date.now();
  const g1 = await fetch(B + '/backup', { headers: { 'x-sync-token': TOKEN } });
  log('GET /backup +token ->', g1.status, g1.ok ? '' : '(密码是否等于中枢启动时打印的同步密码？)');

  const bk = {
    version: 8, app: 'sxybrick', scope: 'real', exportedAt: now,
    cards: [
      { id: 'smoke1', front: '冒烟测试卡1', back: '答1', subject: '测试', tags: [], type: 'basic', ease: 2.5, level: 0, intervalDays: 0, dueAt: now, createdAt: now, updatedAt: now },
      { id: 'smoke2', front: '冒烟测试卡2', back: '答2', subject: '测试', tags: [], type: 'basic', ease: 2.5, level: 0, intervalDays: 0, dueAt: now, createdAt: now, updatedAt: now },
    ],
    reviews: [], tombstones: [], images: [],
  };
  const p = await fetch(B + '/backup/real', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': TOKEN },
    body: JSON.stringify(bk),
  });
  const pr = await p.json().catch(() => ({}));
  log('PUT /backup/real +token ->', p.status, 'app=', pr.app, 'version=', pr.version, 'cards=', pr.cards?.length);

  const g2 = await fetch(B + '/backup/real', { headers: { 'x-sync-token': TOKEN } });
  const gr = await g2.json().catch(() => ({}));
  log('GET /backup/real +token ->', g2.status, 'cards=', gr.cards?.length, 'goal=', gr.streakMeta?.goal);
} else {
  log('（未提供同步密码，跳过鉴权读写用例：node sync-hub/hub-smoke.mjs http://IP:18080 <密码>）');
}

// —— 3) 负向：放最后，且间隔 > 锁定窗口，避免连坐后续用例
await sleep(1300);
const noTok = await fetch(B + '/backup');
log('GET 无 token ->', noTok.status, '(期望 401)');

await sleep(1300);
const bad = await fetch(B + '/backup', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'x-sync-token': 'wrong' },
  body: JSON.stringify({ app: 'sxybrick' }),
});
log('PUT 错误 token ->', bad.status, '(期望 401)');
