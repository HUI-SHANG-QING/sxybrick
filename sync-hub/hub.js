// 局域网同步中枢 —— 在家里的电脑上运行，手机/平板连同一 WiFi 即可一键同步
// 用法：在 new_card 目录下运行  npm run hub  （或 node sync-hub/hub.js）
// 作用：
//   1) 提供 GET/PUT /backup 接口，与前端共用 src/sync-manifest.js 的合并规则，
//      把多台设备的数据合并到一起（卡片=内容/SRS 双时间戳，其余=updatedAt 或 id 幂等，删除走墓碑）；
//   2) 同时把打包好的前端（dist/）直接提供出来，手机浏览器打开 http://<电脑IP>:4780 即用。
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  BACKUP_VERSION, SYNC_TABLES,
  mergeRows, mergeTombstones, applyTombstones,
} from '../src/sync-manifest.js';

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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function emptyData() {
  const out = { tombstones: [], streakMeta: null };
  for (const t of SYNC_TABLES) out[t.table] = [];
  return out;
}

function loadData() {
  if (!existsSync(DATA_FILE)) return emptyData();
  try {
    const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    return { ...emptyData(), ...raw }; // 旧版本数据文件缺新表时自动补齐空数组
  } catch {
    return emptyData();
  }
}

// 原子写入：先写临时文件再改名，避免写入中途崩溃损坏数据文件
function saveData(data) {
  const tmp = DATA_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, DATA_FILE);
}

// 提取正文中的 sxy-img:// 图片 id（hub 运行于 Node，不能 import 浏览器模块，此处内联同款正则）
function imageIdsOf(card) {
  const ids = [];
  const re = /sxy-img:\/\/([0-9a-fA-F-]+)/g;
  const text = `${card.front || ''}\n${card.back || ''}`;
  let m;
  while ((m = re.exec(text))) ids.push(m[1]);
  return ids;
}

// 全量合并：与前端 importBackup 共用 sync-manifest 的纯函数，保证两端合并语义一致
function merge(base, incoming) {
  const out = {};
  out.tombstones = mergeTombstones(base.tombstones, incoming.tombstones);
  for (const t of SYNC_TABLES) {
    out[t.table] = mergeRows(base[t.table], incoming[t.table], t.merge);
  }

  // 卡片：应用墓碑（删除跨设备传播）+ 级联清理复习记录与孤儿图片 + 复活卡清除墓碑
  const cardRes = applyTombstones(out.cards, out.tombstones, 'card');
  out.cards = cardRes.rows;
  out.tombstones = out.tombstones.filter(t => !cardRes.stale.includes(t.id));
  if (cardRes.removed.length) {
    const alive = new Set(out.cards.map(c => c.id));
    out.reviews = (out.reviews || []).filter(r => alive.has(r.cardId));
    const used = new Set();
    for (const c of out.cards) for (const id of imageIdsOf(c)) used.add(id);
    out.images = (out.images || []).filter(i => used.has(i.id));
  }

  // 其余各表：应用墓碑（备忘/计划/图谱边/文档/对话/记忆的删除跨设备传播）
  for (const t of SYNC_TABLES) {
    if (t.kind === 'card') continue;
    const res = applyTombstones(out[t.table] || [], out.tombstones, t.kind);
    out[t.table] = res.rows;
  }

  // 打卡元数据（每日目标 goal）：updatedAt 谁新听谁
  let streakMeta = base.streakMeta || null;
  if (incoming.streakMeta && (!streakMeta || (incoming.streakMeta.updatedAt || 0) >= (streakMeta.updatedAt || 0))) {
    streakMeta = incoming.streakMeta;
  }
  out.streakMeta = streakMeta;
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
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
  // 防目录穿越，归档到 dist 目录内。
  // 打包产物 base 为 /sxybrick/（GitHub Pages 用），本地中枢直接提供 dist 时把该前缀剥掉，
  // 否则手机会因资源路径不匹配而 404、应用白屏。
  const rel = pathname.replace(/^\/sxybrick\b/, '');
  let p = normalize(join(DIST, (!rel || rel === '/') ? 'index.html' : rel));
  if (!p.startsWith(DIST)) p = join(DIST, 'index.html');
  if (!existsSync(p) || extname(p) === '') p = join(DIST, 'index.html'); // SPA 回退
  const body = readFileSync(p);
  res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS 预检：必须放行 x-sync-token 请求头，否则浏览器会拦截真实的 PUT/GET 请求
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-sync-token',
    });
    return res.end();
  }

  if (pathname === '/backup') {
    if (req.headers['x-sync-token'] !== TOKEN) {
      return json(res, 401, { error: '同步密码错误，请在 App「同步」页填写正确密码' });
    }
    if (req.method === 'GET') {
      return json(res, 200, { version: BACKUP_VERSION, app: 'sxybrick', exportedAt: Date.now(), ...loadData() });
    }
    if (req.method === 'PUT') {
      try {
        const incoming = await readBody(req);
        if (!incoming || incoming.app !== 'sxybrick') return json(res, 400, { error: '无效数据包' });
        const merged = merge(loadData(), incoming);
        saveData(merged);
        return json(res, 200, { version: BACKUP_VERSION, app: 'sxybrick', exportedAt: Date.now(), ...merged });
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