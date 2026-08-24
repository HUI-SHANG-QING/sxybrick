// 局域网同步中枢 —— 在家里的电脑上运行，手机/平板连同一 WiFi 即可一键同步
// 用法：在 new_card 目录下运行  npm run hub  （或 node sync-hub/hub.js）
// 作用：
//   1) 提供 GET/PUT /backup 接口，用「最后修改时间谁新听谁」把多台设备的数据合并到一起；
//   2) 同时把打包好的前端（dist/）直接提供出来，手机浏览器打开 http://<电脑IP>:4780 即用。
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'dist');
const DATA_FILE = join(__dirname, 'hub-data.json');
const TOKEN_FILE = join(__dirname, 'hub-token.txt');
const PORT = Number(process.env.PORT || process.argv[2] || 4780);

// 同步密码：首次启动自动生成并保存，之后每次启动复用；打印给用户填到手机端
function loadToken() {
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim();
  const t = randomBytes(16).toString('hex');
  writeFileSync(TOKEN_FILE, t);
  return t;
}
const TOKEN = loadToken();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function loadData() {
  if (!existsSync(DATA_FILE)) return { cards: [], reviews: [], tombstones: [], images: [] };
  try { return JSON.parse(readFileSync(DATA_FILE, 'utf8')); }
  catch { return { cards: [], reviews: [], tombstones: [], images: [] }; }
}

function saveData(data) {
  writeFileSync(DATA_FILE, JSON.stringify(data));
}

// 全量合并：卡片按 updatedAt 谁新听谁；墓碑按 deletedAt 谁新听谁；复习/图片按 id 幂等
function merge(base, incoming) {
  const cards = new Map(base.cards.map(c => [c.id, c]));
  for (const c of incoming.cards || []) {
    const cur = cards.get(c.id);
    if (!cur || (c.updatedAt || 0) >= (cur.updatedAt || 0)) cards.set(c.id, c);
  }
  const tombstones = new Map((base.tombstones || []).map(t => [t.id, t]));
  for (const t of incoming.tombstones || []) {
    const cur = tombstones.get(t.id);
    if (!cur || (t.deletedAt || 0) >= (cur.deletedAt || 0)) tombstones.set(t.id, t);
  }
  const byId = (baseArr, incArr) => {
    const m = new Map((baseArr || []).map(x => [x.id, x]));
    for (const x of incArr || []) if (!m.has(x.id)) m.set(x.id, x);
    return m;
  };
  // AI 对话：按 updatedAt 谁新听谁
  const aiChats = new Map((base.aiChats || []).map(c => [c.id, c]));
  for (const c of incoming.aiChats || []) {
    const cur = aiChats.get(c.id);
    if (!cur || (c.updatedAt || 0) >= (cur.updatedAt || 0)) aiChats.set(c.id, c);
  }
  // Agent 记忆：按 updatedAt 谁新听谁
  const aiMemories = new Map((base.aiMemories || []).map(m => [m.id, m]));
  for (const m of incoming.aiMemories || []) {
    const cur = aiMemories.get(m.id);
    if (!cur || (m.updatedAt || 0) >= (cur.updatedAt || 0)) aiMemories.set(m.id, m);
  }
  // 备忘录：按 id 谁新听谁
  const memos = new Map((base.memos || []).map(m => [m.id, m]));
  for (const m of incoming.memos || []) {
    const cur = memos.get(m.id);
    if (!cur || (m.updatedAt || 0) >= (cur.updatedAt || 0)) memos.set(m.id, m);
  }
  // 通用「按 id 幂等 + updatedAt 谁新听谁」合并器（学习计划/图谱边/AI文档/番茄专注）
  const mergeUpdated = (baseArr, incArr) => {
    const m = new Map((baseArr || []).map(x => [x.id, x]));
    for (const x of incArr || []) {
      const cur = m.get(x.id);
      if (!cur || (x.updatedAt ?? x.createdAt ?? 0) >= (cur.updatedAt ?? cur.createdAt ?? 0)) m.set(x.id, x);
    }
    return [...m.values()];
  };
  const plans = mergeUpdated(base.plans, incoming.plans);
  const graphEdges = mergeUpdated(base.graphEdges, incoming.graphEdges);
  const docs = mergeUpdated(base.docs, incoming.docs);
  const pomoSessions = mergeUpdated(base.pomoSessions, incoming.pomoSessions);
  return {
    cards: [...cards.values()],
    tombstones: [...tombstones.values()],
    reviews: [...byId(base.reviews, incoming.reviews).values()],
    images: [...byId(base.images, incoming.images).values()],
    aiChats: [...aiChats.values()],
    aiMemories: [...aiMemories.values()],
    memos: [...memos.values()],
    plans,
    graphEdges,
    docs,
    pomoSessions,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function serveStatic(res, pathname) {
  // 防目录穿越，归档到 dist 目录内
  let p = normalize(join(DIST, pathname === '/' ? 'index.html' : pathname));
  if (!p.startsWith(DIST)) p = join(DIST, 'index.html');
  if (!existsSync(p) || extname(p) === '') p = join(DIST, 'index.html'); // SPA 回退
  const body = readFileSync(p);
  res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  if (pathname === '/backup') {
    if (req.headers['x-sync-token'] !== TOKEN) {
      return json(res, 401, { error: '同步密码错误，请在 App「同步」页填写正确密码' });
    }
    if (req.method === 'GET') {
      return json(res, 200, { version: 1, app: 'sxybrick', exportedAt: Date.now(), ...loadData() });
    }
    if (req.method === 'PUT') {
      try {
        const incoming = await readBody(req);
        if (!incoming || incoming.app !== 'sxybrick') return json(res, 400, { error: '无效数据包' });
        const merged = merge(loadData(), incoming);
        saveData(merged);
        return json(res, 200, { version: 1, app: 'sxybrick', exportedAt: Date.now(), ...merged });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  return serveStatic(res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n✅ SxyBrick 局域网同步中枢已启动');
  console.log(`   端口：${PORT}`);
  console.log('   手机/平板连同一 WiFi 后，在浏览器打开以下任一地址即可：\n');
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const it of ifaces[name] || []) {
      if (it.family === 'IPv4' && !it.internal) {
        console.log(`   http://${it.address}:${PORT}`);
      }
    }
  }
  console.log(`   同步密码：${TOKEN}`);
  console.log('   在 App「同步」页里，把「电脑端地址」和上面这个「同步密码」都填上，即可安全同步。');
  if (!existsSync(DIST)) console.log('\n⚠ 尚未找到 dist/，请先运行 npm run build 再访问网页。');
});