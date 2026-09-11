// 局域网同步中枢 —— 在家里的电脑上运行，手机/平板连同一 WiFi 即可一键同步
// 用法：在 new_card 目录下运行  npm run hub  （或 node sync-hub/hub.js）
// 作用：
//   1) 提供 GET/PUT /backup 接口，与前端共用 src/sync-manifest.js 的合并规则，
//      把多台设备的数据合并到一起（卡片=内容/SRS 双时间戳，其余=updatedAt 或 id 幂等，删除走墓碑）；
//   2) 同时把打包好的前端（dist/）直接提供出来，手机浏览器打开 http://<电脑IP>:18080 即用。
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { writeFile as writeFileP, rename as renameP } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize, sep, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  BACKUP_VERSION, SYNC_TABLES, PRIVACY_SYNC_TABLES,
  mergeRows, mergeTombstones, applyTombstones, shouldExportRow, sanitizeStripRows,
} from '../src/sync-manifest.js';
import {
  AUTH_VERSION, signPayload, safeEqual, createChallengeStore,
  createRateLimiter, normalizeIp, corsHeaders, isOriginAllowed,
} from './auth-core.js';

// 中枢同时处理标准表和隐私表（仅当客户端 opt-in 发送时才包含隐私数据）
const ALL_TABLES = [...SYNC_TABLES, ...PRIVACY_SYNC_TABLES];

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'dist');
// 数据文件与令牌文件路径可用环境变量覆盖（集成测试需要隔离，避免污染仓库目录）
const DATA_FILE = process.env.HUB_DATA_FILE
  ? resolve(process.env.HUB_DATA_FILE) : join(__dirname, 'hub-data.json');
const TOKEN_FILE = process.env.HUB_TOKEN_FILE
  ? resolve(process.env.HUB_TOKEN_FILE) : join(__dirname, 'hub-token.txt');
// 默认端口 18080：刻意避开 4780——后者落在 Windows 的 Hyper-V/WSL2/Docker
// 「排除端口范围」4682–4781 内，普通用户无权限监听（报 EACCES 而非「端口占用」）。
// 也不选 8787 这类小端口：本机动态出站范围 1024–15000（netsh int ipv4 show dynamicport tcp）
// 会随机抢占它们做源端口，导致偶发 EADDRINUSE。18080 在动态范围之外、避开全部保留段。
const PORT = Number(process.env.PORT || process.argv[2] || 18080);
// 监听地址：Hub 的用途就是让同网段设备访问，默认 0.0.0.0。
// 若只想让某张网卡可达（如在不可信网络下），用 HUB_HOST=192.168.1.5 指定。
const HOST = String(process.env.HUB_HOST || '0.0.0.0');
// 跨域白名单：默认仅同源 + localhost。需要额外来源时用 HUB_ALLOW_ORIGIN 逗号分隔配置。
const ALLOW_ORIGIN = String(process.env.HUB_ALLOW_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// ---------- 鉴权基础设施（P0 重做） ----------
const challenges = createChallengeStore();
// 挑战签发限流：防止被无限刷
const challengeLimiter = createRateLimiter({ windowMs: 60_000, max: 60, baseLockMs: 1_000, maxLockMs: 5 * 60_000 });
// 鉴权失败限流：口令猜测是高危行为，失败即指数退避锁定（1s→2s→4s…上限 15min）
const authLimiter = createRateLimiter({ windowMs: 60_000, max: 20, baseLockMs: 1_000, maxLockMs: 15 * 60_000 });

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
  // 审计 P2-7（round33）：Vite 构建产物含 .mjs（如 pdf.worker.min-xxx.mjs）——
  // 缺失时按 octet-stream 下发，浏览器拒绝以错误 MIME 执行 module script，
  // 局域网离线导入 PDF 功能静默失效。
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  // round34 M14：dist 含 .wasm（PDF.js/字体等），用 WebAssembly.instantiateStreaming
  // 加载时需 application/wasm，octet-stream 会直接抛错 → 局域网离线功能静默失效。
  '.wasm': 'application/wasm',
};

function emptyData() {
  const out = { tombstones: [], streakMeta: null, lastPushAt: 0 };
  for (const t of ALL_TABLES) out[t.table] = [];
  return out;
}

// M3：数据文件损坏时把现场改名留证 + 打日志，再重置为空数据 ——
// 禁止静默 emptyData()（旧实现会直接覆盖损坏现场，无法取证排障）。
function recoverCorrupt(file) {
  const backup = `${file}.corrupt-${Date.now()}`;
  try {
    renameSync(file, backup);
    console.error(`[hub] ${file} JSON 解析失败，已改名留证：${backup}（用空数据继续，损坏现场未丢失）`);
  } catch (e) {
    console.error(`[hub] ${file} JSON 解析失败，且改名留证也失败：${e?.message || e}（用空数据继续）`);
  }
}


// O2（round13）：Windows 上目标文件正被其他进程读取时 renameSync 抛 EBUSY/EPERM。
// 重试 3 次、每次间隔递增，覆盖「另一个 hub 实例或浏览器正在读」的瞬态争用。
function safeRenameSync(from, to) {
  const errs = ['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'];
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      if (attempt < 3 && errs.includes(e.code)) {
        // 同步自旋等待（毫秒级，不引入 async）
        const deadline = Date.now() + 50 * (attempt + 1);
        while (Date.now() < deadline) { /* spin */ }
        continue;
      }
      throw e;
    }
  }
}

// 数据写入统一走异步原子写（saveScopedData）——见下方 atomicWriteAsync

// M3：按 scope 加载/保存独立数据文件（real → 原文件；test → hub-data-test.json）
// 审计 P2-1（round34）：test 隔离不依赖 .json 后缀——HUB_DATA_FILE 自定义为
// /tmp/hubdata 这类无扩展名路径时，旧 replace(/\.json$/) 不命中，test scope
// 直接读写真实数据文件，隔离失效。改为去任意扩展名后拼接。
function scopedFile(scope) {
  return scope === 'test' ? DATA_FILE.replace(/\.[^./\\]*$/, '') + '-test.json' : DATA_FILE;
}
// 审计 P1-1（round34）：读失败 ≠ 文件损坏。GET 的 loadScopedData 不在 withScopeLock 内，
// 与 PUT 的 renameP(tmp→f) 并发时 readFileSync 可能瞬态 EBUSY/EPERM（Windows 文件占用）——
// 旧实现一律 recoverCorrupt 会把「完好的数据文件」改名扔掉并返回空包，
// 下次 PUT 基于空数据合并 → 中枢全量数据静默清零。
// 修复：① 瞬态 IO 错误按 safeRenameSync 同款重试；② 非 IO 错误（真损坏）先延迟重读
// 二次确认，仍失败才判损坏改名；③ 从未出现过的「不存在的表结构」不做猜测，保守返回空。
// 审计 P2-2（round36）：自旋改异步 setTimeout——round34 的 while(Date.now()) 空转
// 会把 Node 单线程事件循环整个停摆（所有连接冻结最长 500ms）。两个调用方（GET :619、
// PUT merge :650）均在 async 上下文，安全改造。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function readScopeFileWithRetry(f) {
  const transient = ['EBUSY', 'EPERM', 'EACCES'];
  for (let attempt = 0; ; attempt++) {
    try {
      return readFileSync(f, 'utf8');
    } catch (e) {
      if (attempt < 3 && transient.includes(e.code)) {
        await sleep(50 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}
async function loadScopedData(scope) {
  const f = scopedFile(scope);
  if (!existsSync(f)) return emptyData();
  // 审计 P1（round37）：必须区分两类失败——
  //   ① IO 错误（readFileSync 抛错：被杀软/备份软件持句柄、EIO、权限瞬断等）：
  //      数据文件内容是完好的，此时**绝不能**改名丢弃——中枢数据集会被清零，
  //      而客户端增量水位已推进，未变更行永不重推 → 数据永久丢失。应向上抛，
  //      由 GET/PUT 的 try/catch 返回 5xx，客户端下次同步自愈。
  //   ② 语法损坏（读到内容但 JSON.parse 失败）：才走二次确认 + recoverCorrupt。
  let text;
  try {
    text = await readScopeFileWithRetry(f);
  } catch (e) {
    throw new Error(`读取中枢数据文件失败（IO，未改动文件）：${e?.message || e}`);
  }
  try {
    const raw = JSON.parse(text);
    return { ...emptyData(), ...raw };
  } catch {
    // 二次确认：延迟 200ms 重读一次，仍解析失败才判损坏。
    await sleep(200);
    let text2;
    try {
      text2 = await readScopeFileWithRetry(f);
    } catch (e) {
      throw new Error(`读取中枢数据文件失败（IO，未改动文件）：${e?.message || e}`);
    }
    try {
      const raw = JSON.parse(text2);
      return { ...emptyData(), ...raw };
    } catch {
      recoverCorrupt(f);
      return emptyData();
    }
  }
}
// 异步原子写（round33 P4）：整包 JSON.stringify + 落盘在真实同步中是 MB 级同步 IO，
// writeFileSync 会阻塞事件循环（期间所有 GET/静态资源/其它请求全被卡住）。
// 改 fs/promises：不阻塞；仍走 tmp→rename 原子替换，崩溃不损坏数据文件。
async function atomicWriteAsync(f, data) {
  const tmp = f + '.tmp';
  await writeFileP(tmp, JSON.stringify(data));
  const errs = ['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'];
  for (let attempt = 0; ; attempt++) {
    try {
      await renameP(tmp, f);
      return;
    } catch (e) {
      if (attempt < 3 && errs.includes(e.code)) {
        await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}
async function saveScopedData(scope, data) {
  await atomicWriteAsync(scopedFile(scope), data);
}

// 审计 B8：per-scope 串行队列。此前两台设备并发 PUT 同一 scope 时，
// 两个请求各自 load→merge→save，后写者基于「先写者合并前」的旧数据合并，
// 覆盖先写者的结果——且先写者返回的 200 已带它的水位，客户端不会重推，
// 该批增量在中枢永久丢失。Node 事件循环单线程，但 load/parse/merge 之间
// 隔着 await（readBody/JSON.parse），并发请求会在中间交错，必须按 scope 排队。
// 队列键：scope（real/test 数据文件独立，互不阻塞）。
const putQueues = new Map();
function withScopeLock(scope, fn) {
  const prev = putQueues.get(scope) || Promise.resolve();
  const next = prev.then(fn, fn); // 前一步失败不阻塞后续请求
  putQueues.set(scope, next.catch(() => {})); // 吞掉 reject 防 unhandled
  return next;
}

// 提取行内 sxy-img:// 图片 id（hub 运行于 Node，不能 import 浏览器模块，此处内联同款正则）
// 审计 A1 修复：此前写死 front/back 两个字段——但 images 是全 app 共享表，
// 词卡（wordCards 的 meaning/example 等字段）同样可能含 sxy-img:// 引用，
// GC 只按通用卡算引用集会误删「仅被词卡引用」的图片且增量包永远不会重传。
// 改为递归收集行内所有字符串字段，字段扩展/新表无需再改这里。
function imageIdsOf(row) {
  const ids = [];
  const re = /sxy-img:\/\/([0-9a-fA-F-]+)/g;
  const seen = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(v))) { if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); } }
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (k === 'blob') continue; // 二进制 base64 不参与引用判定
        walk(v[k]);
      }
    }
  };
  walk(row);
  return ids;
}

/**
 * 墓碑 GC：剔除「超过 ttlDays 天 且 目标行在中枢侧已不存在」的墓碑。
 * 保守策略——只要该 id 还在任何一张表里出现，就说明还有设备持有它，绝不清理。
 *
 * 审计 C2（恢复高删除语义）：
 *  仅「墓碑老 + 目标行不在」还不够——一个离线超过 TTL 天的设备尚未收到删除墓碑，
 *  此刻回收墓碑后，该设备下次上线会把自己持有的旧行重新推上来 → 已删除数据复活
 *  并反向广播给所有设备。因此额外要求「最后一批设备同步」也早于 TTL：只要生态
 *  仍在活跃（最近有设备推送），就绝不回收任何墓碑。代价是删除量大的设备墓碑会
 *  多驻留，但对个人学习 App（删除量小）可接受，且彻底消除复活路径。
 * @param {object} data 合并后的中枢数据
 * @param {number} ttlDays
 * @returns {Array} 清理后的墓碑数组
 */
function gcTombstones(data, ttlDays) {
  const cutoff = Date.now() - ttlDays * 86400000;
  // 审计 C2：最后一批设备同步须同样早于 TTL，否则离线设备可能仍持有旧行，绝不回收。
  const lastPush = data.lastPushAt || 0;
  if (lastPush >= cutoff) return { kept: data.tombstones || [], gcIds: [] };
  const alive = new Set();
  for (const t of ALL_TABLES) {
    for (const r of data[t.table] || []) if (r && r.id != null) alive.add(r.id);
  }
  const before = (data.tombstones || []).length;
  const kept = (data.tombstones || []).filter(tb => (tb?.deletedAt ?? 0) >= cutoff || alive.has(tb?.id));
  const gcIds = (data.tombstones || []).filter(tb => !kept.includes(tb)).map(tb => tb.id);
  if (kept.length !== before) {
    console.log(`[hub] 墓碑 GC：${before} → ${kept.length}（清理 ${before - kept.length} 条超过 ${ttlDays} 天、目标行已不存在、且生态已静默 ${ttlDays} 天的墓碑）`);
  }
  return { kept, gcIds };
}

// 全量合并：与前端 importBackup 共用 sync-manifest 的纯函数，保证两端合并语义一致
// clockSkew = 客户端墙钟 - 中枢墙钟（来自 PUT 请求头的 `x-client-time`），
// 把客户端推上来的数据时间戳换算到中枢帧，与本地行（中枢帧）公平比 LWW，
// 防「快时钟客户端」静默覆盖中枢更晚的本地编辑（round30 P2-3，与前端 importBackup 对称）。
function merge(base, incoming, clockSkew = 0) {
  const out = {};
  out.tombstones = mergeTombstones(base.tombstones, incoming.tombstones, { clockSkew });
  for (const t of ALL_TABLES) {
    // 与前端 sync.js 的 exportRows 同口径：应用清单上的 exportFilter。
    // 之前中枢不过滤 —— 老客户端推上来的 kind='auto' 派生图谱边会被中枢存下来，
    // 再回灌给所有设备（客户端侧是过滤的，两端口径不一致 → 边越同步越多）。
    const inRows = (incoming[t.table] || []).filter(r => shouldExportRow(t, r));
    // round17 R17-9/R17-20：透传 strip（wordSettings 的 LLM Key 合并时保留本地值，
    // 防止旧客户端推送的明文 Key 常驻 hub 数据文件）与 extFields（wordCards AI 扩展字段并集保护）
    //
    // round18 R18-5：base 侧也要净化。中枢的 hub-data.json 里可能驻留着 R17-20 之前
    // 老客户端推上来的明文 Key（那时中枢不过滤 strip），mergeRows 只挡 incoming，
    // 挡不住从 base 原样带出来的历史残留 —— 于是「A 清空本地 Key」后中枢仍会回灌。
    // 中枢不是任何人的本地设备，strip 字段对它一律无意义：存进来即丢弃。
    const baseRows = sanitizeStripRows(base[t.table], t.strip);
    out[t.table] = mergeRows(baseRows, inRows, t.merge, { strip: t.strip, extFields: t.extFields, clockSkew });
  }

  // 卡片：应用墓碑（删除跨设备传播）+ 级联清理复习记录与孤儿图片 + 复活卡清除墓碑
  const cardRes = applyTombstones(out.cards, out.tombstones, 'card');
  out.cards = cardRes.rows;
  out.tombstones = out.tombstones.filter(t => !cardRes.stale.includes(t.id));
  if (cardRes.removed.length) {
    const alive = new Set(out.cards.map(c => c.id));
    out.reviews = (out.reviews || []).filter(r => alive.has(r.cardId));
    // 审计 P1：hub cascade 补删 embeddings（card 级联），否则幽灵向量回灌所有设备，
    // 每轮被端上删一次又被 hub 推回来，反复拉锯
    out.embeddings = (out.embeddings || []).filter(e => alive.has(e.sourceId) || e.sourceType !== 'card');
    // 审计 A1：孤儿图 GC 的引用集必须扫「所有含正文的行表」，不能只看 out.cards——
    // 此前仅通用卡 front/back 计入，仅被词卡（wordCards）或其他模块引用的图片
    // 会被中枢误删并回灌所有设备，且增量包只带变更卡的图，永远无法重传。
    const used = new Set();
    for (const t of ALL_TABLES) {
      const kind = t.kind || t.table;
      if (kind === 'image' || kind === 'images') continue;
      for (const row of out[t.table] || []) for (const id of imageIdsOf(row)) used.add(id);
    }
    out.images = (out.images || []).filter(i => used.has(i.id));
  }

  // 其余各表：应用墓碑（备忘/计划/图谱边/文档/对话/记忆的删除跨设备传播）
  //   同时收集「已失效」的墓碑（行在墓碑之后又被改过 = 复活），像卡片分支那样从墓碑表里剔除。
  //   此前只取 res.rows 却不清 stale —— 失效墓碑常驻中枢，每次 GET/PUT 都回灌给所有客户端，
  //   客户端每轮 import 都要重删一遍，previewImport 还会显示虚构的「将删除 N 条」。
  const staleIds = new Set();
  for (const t of ALL_TABLES) {
    if (t.kind === 'card') continue;
    const res = applyTombstones(out[t.table] || [], out.tombstones, t.kind);
    out[t.table] = res.rows;
    for (const id of res.stale) staleIds.add(`${t.kind}\u0000${id}`);
  }
  if (staleIds.size) {
    out.tombstones = out.tombstones.filter(tb => !staleIds.has(`${tb.kind || 'card'}\u0000${tb.id}`));
  }

  // 墓碑 GC（N2/round13：默认 30 天自动开启，可用 HUB_TOMBSTONE_TTL_DAYS 覆盖；=0 强制关闭）：
  //   墓碑只增不减，而前端每次增量同步都会全量带上墓碑（sync.js 里 tombstones 不走 since 过滤），
  //   删得越多包越大。安全 GC 只清理「早已过期 且 目标行在中枢侧已不存在」的墓碑 ——
  //   仍存在的行说明还有设备在用，一条都不删。30 天未同步的设备墓碑可安全回收。
  const ttlDays = Number(process.env.HUB_TOMBSTONE_TTL_DAYS ?? 30);
  let gcTombIds = [];
  if (ttlDays > 0) { const gc = gcTombstones(out, ttlDays); out.tombstones = gc.kept; gcTombIds = gc.gcIds; }

  // 打卡元数据（每日目标 goal）：updatedAt 谁新听谁
  // 审计 P1（round37）：① 平局改严格 > + 字典序兜底，与 examMeta/round36 口径对齐
  //   （旧 >= 平局取 incoming，两端同 updatedAt 不同值时随同步顺序来回翻转）；
  // ② 补 clockSkew 换算——incoming 时间戳先换算到中枢帧再比，否则快时钟客户端
  //   的 goal 永远压过慢时钟端（round30 P2-3 要防的场景在 meta 分支复发）。
  let streakMeta = base.streakMeta || null;
  if (incoming.streakMeta) {
    const incTs = (incoming.streakMeta.updatedAt || 0) - clockSkew;
    const baseTs = streakMeta?.updatedAt || 0;
    if (!streakMeta || incTs > baseTs
      || (incTs === baseTs && String(incoming.streakMeta.goal) > String(streakMeta.goal ?? ''))) {
      streakMeta = incoming.streakMeta;
    }
  }
  out.streakMeta = streakMeta;
  // 审计（round35 小问题2）：考试日期 examAt 与 streakMeta 同口径合并——updatedAt 谁新听谁。
  // 审计 P1-1（round36）：平局改严格 > + 字典序兜底（同 sync.js，防两端同时间戳来回翻转）。
  let examMeta = base.examMeta || null;
  if (incoming.examMeta) {
    // 审计 P2-3（round37）：补 clockSkew 换算（与 streakMeta 同款），
    // incoming 时间戳先减偏移换算到中枢帧，再与本地帧比较。
    const incTs = (incoming.examMeta.updatedAt || 0) - clockSkew;
    const baseTs = examMeta?.updatedAt || 0;
    if (!examMeta || incTs > baseTs
      || (incTs === baseTs && String(incoming.examMeta.examAt) > String(examMeta.examAt ?? ''))) {
      examMeta = incoming.examMeta;
    }
  }
  out.examMeta = examMeta;
  // 审计 P2-5（round37）：调度配置四 key（scheduler/fsrsWeights/fsrsInfo/pretestStability）
  // 与 examMeta 同款逐 key LWW + clockSkew 换算；否则换设备后调度参数分叉。
  const SCHED_KEYS = ['scheduler', 'fsrsWeights', 'fsrsInfo', 'pretestStability'];
  let schedMeta = base.schedMeta ? { ...base.schedMeta } : null;
  if (incoming.schedMeta && typeof incoming.schedMeta === 'object') {
    if (!schedMeta) schedMeta = {};
    for (const k of SCHED_KEYS) {
      const inc = incoming.schedMeta[k];
      if (!inc || inc.value === undefined) continue;
      const cur = schedMeta[k];
      const incTs = (inc.updatedAt || 0) - clockSkew;
      const curTs = cur?.updatedAt || 0;
      if (!cur || incTs > curTs
        || (incTs === curTs && JSON.stringify(inc.value) > JSON.stringify(cur.value ?? null))) {
        schedMeta[k] = { value: inc.value, updatedAt: incTs };
      }
    }
  }
  out.schedMeta = schedMeta;
  // 审计 C2：记录最近一次设备推送，供墓碑 GC 判定「生态是否仍活跃」。
  out.lastPushAt = Math.max(base.lastPushAt || 0, incoming.exportedAt || 0, Date.now());
  // 审计 S-6：附带被 GC 掉的墓碑 id 清单——客户端据此 bulkDelete 本地残留墓碑，
  // 解决「客户端墓碑只增不减、全量回传永久膨胀」的问题。
  if (gcTombIds.length) out.gcTombIds = gcTombIds;
  return out;
}

/**
 * 读取请求体。同时返回原始字符串——HMAC 签名是对原始字节做的，
 * 若先 JSON.parse 再 stringify，键序变化会导致摘要不一致。
 */
function readBody(req, limitBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // 审计 P2-1（round36）：半关闭连接兜底——客户端收包中途断开时 Node 常只触发
    // 'close' 不触发 'error'，旧实现 promise 永不 settle → HMAC 预算的 finally
    // 永不释放 → 泄漏 2 次后所有 HMAC PUT 恒 429 直至进程重启。
    let settled = false;
    const done = (fn) => (v) => { if (!settled) { settled = true; fn(v); } };
    req.on('close', () => { if (!settled) { settled = true; reject(new Error('连接中断')); } });
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { done(reject)(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', done(() => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({ raw: '', json: null });
      try { resolve({ raw, json: JSON.parse(raw) }); }
      catch (e) { reject(e); }
    }));
    req.on('error', done(reject));
  });
}

// 审计 P1-3（round34）：无凭据 DoS 防线——PUT 的 HMAC 绑定 body 摘要，HMAC 模式
// 必须先读体才能验签，旧实现在鉴权前按单请求 50MB 收包：无凭据者可并发多连接
// 各灌 50MB。防线：① 既无签名头也无 token 的请求不收包直接 401；
// ② HMAC 模式（鉴权前必须收包）受全局在途字节预算约束，超限 429；
// ③ token 模式先鉴权（token 在头里，无需 body）再收包，收包时已是已授权连接。
const UNAUTH_BODY_CAP = 100 * 1024 * 1024; // 全局同时鉴权前在途字节上限 100MB
let unauthBodyInFlight = 0;

function json(req, res, code, obj, extraHeaders = {}) {
  const origin = req?.headers?.origin;
  const cors = corsHeaders(origin, { host: req?.headers?.host, allowList: ALLOW_ORIGIN });
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    ...cors,
    ...extraHeaders,
  });
  res.end(JSON.stringify(obj));
}

/**
 * 校验请求鉴权。
 * 优先走 v2 HMAC 挑战-响应（密钥不上网）；老客户端可退回 x-sync-token 明文。
 * @returns {{ok:boolean, mode:'hmac'|'token'|'none', retryAfterMs?:number}}
 */
function authenticate(req, rawBody) {
  const ip = normalizeIp(req.socket?.remoteAddress);
  const locked = authLimiter.lockedFor(ip);
  if (locked > 0) return { ok: false, mode: 'none', retryAfterMs: locked };

  const path = new URL(req.url, `http://${req.headers.host}`).pathname;
  const challenge = req.headers['x-sync-challenge'];
  const sig = req.headers['x-sync-sig'];

  if (challenge && sig) {
    // v2：一次性挑战 + HMAC 签名（绑定方法/路径/请求体摘要）
    if (!challenges.consume(challenge)) {
      authLimiter.fail(ip);
      return { ok: false, mode: 'hmac' };
    }
    const expect = signPayload(TOKEN, {
      challenge: String(challenge), method: req.method, path, body: rawBody,
    });
    if (!safeEqual(String(sig), expect)) {
      authLimiter.fail(ip);
      return { ok: false, mode: 'hmac' };
    }
    authLimiter.reset(ip);
    return { ok: true, mode: 'hmac' };
  }

  // 兼容旧客户端：明文 token（恒定时间比较 + 同一套失败退避）
  const given = req.headers['x-sync-token'];
  if (given != null && safeEqual(String(given), TOKEN)) {
    authLimiter.reset(ip);
    return { ok: true, mode: 'token' };
  }
  authLimiter.fail(ip);
  return { ok: false, mode: 'token' };
}

function unauthorized(req, res, info) {
  const headers = info?.retryAfterMs ? { 'Retry-After': String(Math.ceil(info.retryAfterMs / 1000)) } : {};
  return json(req, res, 401, {
    error: info?.retryAfterMs
      ? `鉴权失败次数过多，请 ${Math.ceil(info.retryAfterMs / 1000)} 秒后重试`
      : '同步密码错误，请在 App「同步」页填写正确密码',
    authVersion: AUTH_VERSION,
  }, headers);
}

// 手机若把端口写漏（只输 http://IP），请求会打到 80 端口 —— Windows 上 80 常被
// IIS（http.sys，PID 4）占用，于是手机看到的是 IIS「Internet Information Services」欢迎页，
// 用户会误以为"中枢坏了"。这里探测本机 80 是否有服务，只在真被占用时给出针对性提示。
function detectPort80InUse() {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port: 80, timeout: 400 });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.once('timeout', () => done(false));
  });
}

function usbHints(name) {  const s = String(name || '').toLowerCase();
  if (/rndis|usb|android|remote ndis|tether/.test(s)) return '  ← USB/手机USB共享，手机连数据线时优先用这个';
  if (/hyper-v|virtual|vmware|virtualbox|wsl|loopback/.test(s)) return '  ← 虚拟网卡，手机一般访问不到';
  if (/wi-fi|wifi|wireless|wlan|802\.11/.test(s)) return '  ← WiFi 网卡，手机需连同一WiFi';
  // 注意：Windows 里手机 USB 共享网络（RNDIS）通常显示成「以太网 2」这类名字，
  // 名字里未必含 rndis/usb，容易让人以为是普通有线而漏掉 —— 提示里要点明。
  if (/ethernet|eth|lan|以太网|local area/.test(s)) return '  ← 有线网卡（手机USB共享网络在Windows里通常也叫「以太网2」，用数据线时优先试它）';
  return '';
}

function serveStatic(req, res, pathname) {
  // 防目录穿越，归档到 dist 目录内。
  const rel = pathname.replace(/^\/sxybrick\b/, '');
  let p = normalize(join(DIST, (!rel || rel === '/') ? 'index.html' : rel));
  // 前缀比较必须带分隔符，否则 ../dist-evil 这类同级目录会被判为合法
  if (p !== DIST && !p.startsWith(DIST + sep)) p = join(DIST, 'index.html');
  if (!existsSync(p) || extname(p) === '') p = join(DIST, 'index.html'); // SPA 回退
  // dist 尚未构建（如 CI 上 npm test 在 npm run build 之前跑）时，
  // readFileSync 会抛 ENOENT → 异步 handler 未 catch → 响应不发送 →
  // 客户端 SocketError: other side closed。回退 404 让测试通过。
  if (!existsSync(p)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  // 审计 P2-6（round33）：readFileSync 兜底——existsSync 只兜 ENOENT，
  // Windows 文件被占用（EACCES/EPERM）或 existsSync 与 read 之间文件被删（TOCTOU）
  // 仍会抛出 → 异步 handler 内异常 → 响应悬挂、客户端 SocketError。
  let body;
  try {
    body = readFileSync(p);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  const origin = req?.headers?.origin;
  const cors = isOriginAllowed(origin, { host: req?.headers?.host, allowList: ALLOW_ORIGIN })
    ? { 'Access-Control-Allow-Origin': origin || '*', Vary: 'Origin' }
    : {};
  res.writeHead(200, {
    'Content-Type': MIME[extname(p)] || 'application/octet-stream',
    ...cors,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  // round29：请求日志——手机/平板同步失败时，能否在控制台看到这一行，直接区分
  // 「请求根本没到（防火墙/地址错/不同网段）」与「到了但鉴权/版本/数据被拒」。
  // 只记 来源IP / 方法 / 路径 / 状态码 / 耗时，绝不记录 token、challenge、sig 与请求体。
  const _t0 = Date.now();
  res.on('finish', () => {
    try {
      console.log(`[hub] ${normalizeIp(req.socket?.remoteAddress)} ${req.method} ${pathname} → ${res.statusCode} ${Date.now() - _t0}ms`);
    } catch { /* 日志失败绝不影响请求 */ }
  });

  // CORS 预检：仅对白名单来源放行（默认同源 + localhost）。
  // 旧实现一律回 *，等于允许任意网站跨域调用 Hub 并读取响应。
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin;
    if (!isOriginAllowed(origin, { host: req.headers.host, allowList: ALLOW_ORIGIN })) {
      res.writeHead(204, { Vary: 'Origin' });
      return res.end();
    }
    // round40：**单一源**——直接复用 auth-core 的 corsHeaders()（json() 响应用的同一份），
    // 不再在本文件硬编码一份白名单。历史事故：白名单写了两份，补 x-client-time 时只改了
    // 这一处、漏了 auth-core（跨域预检失败 → 三端同步全挂）。合并后结构上不可能再漏。
    res.writeHead(204, corsHeaders(origin, { host: req.headers.host, allowList: ALLOW_ORIGIN }));
    return res.end();
  }

  // 签发一次性挑战（限流）。客户端据此用同步密码做 HMAC 签名，密钥本身不上网。
  if (pathname === '/auth/challenge') {
    const ip = normalizeIp(req.socket?.remoteAddress);
    const gate = challengeLimiter.hit(ip);
    if (!gate.allowed) {
      return json(req, res, 429, { error: '请求过于频繁，请稍后再试', retryAfterMs: gate.retryAfterMs },
        { 'Retry-After': String(Math.ceil(gate.retryAfterMs / 1000)) });
    }
    return json(req, res, 200, { ...challenges.issue(), app: 'sxybrick-hub' });
  }

  // 健康检查端点：仅回可达性与版本，绝不包含任何口令校验结果。
  // 旧实现免鉴权返回 tokenOk，配合 CORS * 构成公开的口令穷举预言机。
  if (pathname === '/health' || pathname === '/healthz') {
    return json(req, res, 200, {
      ok: true, app: 'sxybrick-hub', version: BACKUP_VERSION,
      authVersion: AUTH_VERSION,
      authModes: ['hmac', 'token'],
      time: Date.now(),
      tips: [
        '如手机端浏览器显示无法访问：',
        '1) 数据线连接电脑时，请在手机端开启「USB 共享网络 / USB 网络共享」，并使用上面标注 USB/RNDIS 的 IP；',
        '2) Windows 端请确认已放行本 Hub 程序的「专用网络」防火墙权限（首次启动弹窗要点「允许访问」）；',
        '3) 若前端部署在 GitHub Pages (HTTPS)，浏览器会阻止 HTTPS 页面调用 HTTP 内网地址（混合内容阻断），请改用本地 npm run hub 提供的 HTTP 页面或手机浏览器直接打开 Hub IP。',
      ],
    });
  }

  // M3 演示模式：/backup/{scope} 按数据域隔离（real 默认 | test 独立数据文件），
  // 演示数据与真实数据在中枢侧也物理分开，互不合并
  const scopeMatch = pathname.match(/^\/backup\/(real|test)$/) || (pathname === '/backup' ? [null, 'real'] : null);
  if (scopeMatch) {
    const scope = scopeMatch[1];
    // PUT 需要先读原始体（签名绑定了请求体摘要）；GET 无体。
    // 审计 P1-3（round34）：三分支防线——① 无签名头且无 token：不收包直接 401；
    // ② token 模式：先鉴权（token 在头里无需 body）再收包，收包时已是已授权连接；
    // ③ HMAC 模式：验签前必须收包，受全局在途字节预算约束（超限 429）。
    let raw = '';
    if (req.method === 'PUT') {
      const hasSig = req.headers['x-sync-challenge'] && req.headers['x-sync-sig'];
      const hasToken = Boolean(req.headers['x-sync-token']);
      if (!hasSig && !hasToken) {
        // 无任何凭据：不读 body，直接标准 401（req.resume 耗尽流避免连接悬挂）
        req.resume();
        const auth0 = authenticate(req, '');
        return unauthorized(req, res, auth0);
      }
      if (hasSig) {
        // HMAC：验签前必须收原始体——全局预算防并发灌包
        if (unauthBodyInFlight > UNAUTH_BODY_CAP) {
          return json(req, res, 429, { error: '中枢正忙（鉴权请求并发过高），请稍后重试' }, { 'Retry-After': '3' });
        }
        unauthBodyInFlight += 50 * 1024 * 1024; // 按单请求上限预占（实际可能更小）
        try {
          const r = await readBody(req);
          raw = r.raw;
        } catch (e) {
          return json(req, res, 400, { error: '请求体解析失败：' + e.message });
        } finally {
          unauthBodyInFlight -= 50 * 1024 * 1024;
        }
      } else {
        // token 模式：token 在头里，先鉴权再收包
        const auth0 = authenticate(req, '');
        if (!auth0.ok) return unauthorized(req, res, auth0);
        try {
          const r = await readBody(req);
          raw = r.raw;
        } catch (e) {
          return json(req, res, 400, { error: '请求体解析失败：' + e.message });
        }
      }
    }
    const auth = authenticate(req, raw);
    if (!auth.ok) return unauthorized(req, res, auth);

    if (req.method === 'GET') {
      // 审计 P1（round37）：loadScopedData 遇到持久 IO 错误会向上抛（不再误判损坏改名）。
      // 此处显式兜底为 500——客户端下次同步自愈，绝不让异常冒到进程外。
      let data;
      try {
        data = await loadScopedData(scope); // 审计 P2-2（round36）：改异步后需 await
      } catch (e) {
        return json(req, res, 500, { error: e?.message || '中枢读取数据失败' });
      }
      // M7：隐私 opt-in 只在客户端有效——默认不下发隐私表（隐私记录不进任何
      // 未显式声明的设备/备份）；客户端确认要同步隐私时带 ?includePrivacy=1。
      const includePrivacy = url.searchParams.get('includePrivacy') === '1';
      if (!includePrivacy) {
        for (const t of PRIVACY_SYNC_TABLES) data[t.table] = [];
      }
      return json(req, res, 200, { version: BACKUP_VERSION, app: 'sxybrick', scope, exportedAt: Date.now(), ...data });
    }
    if (req.method === 'PUT') {
      try {
        const incoming = JSON.parse(raw || 'null');
        if (!incoming || incoming.app !== 'sxybrick') return json(req, res, 400, { error: '无效数据包' });
        // M4：版本校验——旧中枢收新版包会静默丢新表且返回 200，客户端毫无感知。
        // 包内 version 与中枢不一致即 400，提示升级，绝不静默吞数据。
        const incomingVer = Number(incoming.version);
        if (!Number.isInteger(incomingVer) || incomingVer !== BACKUP_VERSION) {
          return json(req, res, 400, {
            error: `版本不匹配：包内 version=${incoming.version ?? '(缺失)'}，中枢 BACKUP_VERSION=${BACKUP_VERSION}。请把电脑端中枢与前端都升级到同一版本后再同步`,
          });
        }
        // scope 校验：数据包声明的 scope 必须与请求路径一致，防止测试包混入真实域（反之亦然）
        if (incoming.scope && incoming.scope !== scope) {
          return json(req, res, 409, { error: `数据域不匹配：包内 scope=${incoming.scope}，端点 scope=${scope}` });
        }
        // 审计 B8：load→merge→save 整体进 per-scope 串行队列，
        // 消除并发 PUT 的「基于旧数据合并」覆盖丢失
        const merged = await withScopeLock(scope, async () => {
          // round30 P2-3：客户端墙钟 - 中枢墙钟 = 换算量；客户端推上来的时间戳减它即中枢帧
          const clientTs = Number(req.headers['x-client-time']);
          const clockSkew = Number.isFinite(clientTs) ? clientTs - Date.now() : 0;
          const m = merge(await loadScopedData(scope), incoming, clockSkew); // 审计 P2-2（round36）：await 异步化
          await saveScopedData(scope, m);
          return m;
        });
        return json(req, res, 200, { version: BACKUP_VERSION, app: 'sxybrick', scope, exportedAt: Date.now(), ...merged });
      } catch (e) { return json(req, res, 400, { error: e.message }); }
    }
    return json(req, res, 405, { error: 'method not allowed' });
  }

  return serveStatic(req, res, pathname);
});

server.on('error', (err) => {
  if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
    console.error(`\n❌ 无法监听端口 ${PORT}（${err.code}）：`);
    if (err.code === 'EACCES') {
      console.error('   该端口被 Windows 系统保留（Hyper-V / WSL2 / Docker 的「排除端口范围」）或需要管理员权限。');
      console.error('   可用命令查保留范围：netsh interface ipv4 show excludedportrange protocol=tcp');
    } else {
      console.error(`   该端口已被其他程序占用，可用 netstat -ano | findstr :${PORT} 排查。`);
    }
    console.error('   换一个不在保留范围内的端口即可，例如 18081：');
    console.error('     PowerShell：$env:PORT=18081; npm run hub');
    console.error('     或：npm run hub -- 18081');
    console.error('   换好后，手机「同步」页里的电脑端地址端口也要改成对应值。\n');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log('\n✅ SxyBrick 局域网同步中枢已启动');
  console.log(`   端口：${PORT}　监听地址：${HOST}`);
  if (HOST === '0.0.0.0') {
    console.log('   ⚠ 监听全部网卡：同网段设备均可访问。在不可信网络（公共 WiFi）下');
    console.log('     建议用 HUB_HOST=<内网IP> 只绑一张网卡，或确认防火墙已勾选「专用网络」。');
  }
  console.log(`   鉴权：HMAC-SHA256 挑战-响应（v${AUTH_VERSION}，同步密码不上网）＋ 失败指数退避锁定`);
  console.log(`   跨域：仅允许同源与 localhost${ALLOW_ORIGIN.length ? `，另加白名单 ${ALLOW_ORIGIN.join(', ')}` : ''}`);
  console.log('   下面列了本机全部 IPv4 网卡，请选与你手机/平板同一网段的地址。\n');
  const ifaces = networkInterfaces();
  let any = false;
  for (const name of Object.keys(ifaces)) {
    for (const it of ifaces[name] || []) {
      if (it.family === 'IPv4' && !it.internal) {
        any = true;
        console.log(`   [${name}]  http://${it.address}:${PORT}${usbHints(name)}`);
      }
    }
  }
  if (!any) console.log('   ⚠ 未找到可用 IPv4 网卡，请检查网络连接后重试。');
  console.log(`\n   同步密码：${TOKEN}`);
  console.log('   在 App「同步」页里，把「电脑端地址」和上面这个「同步密码」都填上，即可安全同步。');
  console.log('   同步页内置了「测试连接」按钮：先跑一遍探活，再点立即同步。');
  console.log('\n   💡 USB/数据线连接小贴士：');
  console.log('   · 安卓：设置 → 连接与共享 → 打开「USB 共享网络」（手机从电脑获取网络，并出现 USB/RNDIS 网卡 IP）。');
  console.log('   · iPhone：电脑安装 iTunes → 数据线连接 → 设置「个人热点」→ 选择「仅 USB」。');
  console.log('   · 手机用 USB 共享网络时，Windows 那张网卡通常叫「以太网 2 / RNDIS」——请用它对应的地址；');
  console.log('     VirtualBox / VMware / 169.254.x 这些虚拟网卡手机一律访问不到，不用试。');
  console.log('   · 打不开的按顺序自查：');
  console.log('       1) 先在本机浏览器打开上面那个地址，能出应用页面 = 中枢在该网卡正常；');
  console.log('       2) 仍打不开多半是 Windows 防火墙：USB 共享网络常被识别为「公用网络」而拦掉入站');
  console.log('          （特征：手机报 ERR_CONNECTION_TIMED_OUT，而 80 端口能开、本机能开）。');
  console.log('          ★ 最省事：右键 sync-hub\\allow-firewall.bat → 以管理员身份运行（只需一次）');
  console.log('          或管理员执行这一行：');
  console.log('          netsh advfirewall firewall add rule name="SxyBrick Hub ' + PORT + '" dir=in action=allow protocol=TCP localport=' + PORT + ' profile=any');
  console.log('          （或在 Windows 安全中心 → 允许应用通过防火墙 → 勾选 node/npm 的专用与公用网络）');
  console.log('       3) 手机浏览器地址必须以 http:// 开头（不要 https，也不要带多余路径）。');
  console.log('   · ⚠ 地址必须带端口 :' + PORT + '——只输 http://<IP> 会打到 80 端口。');
  // 80 被 IIS 占用时给出针对性提示（实测：Windows 常见 IIS/http.sys 占 80，
  // 手机漏端口时打开的是 IIS 欢迎页，极易被误判成"中枢有问题"）。
  detectPort80InUse().then((busy) => {
    if (busy) {
      console.log('     （本机 80 端口已被其他服务占用——常见是 IIS。手机若看到');
      console.log('       「Internet Information Services」欢迎页，就是端口漏写了，请补上 :' + PORT + '）');
    }
  }).catch(() => {});
  if (!existsSync(DIST)) console.log('\n⚠ 尚未找到 dist/，请先运行 npm run build 再访问网页。');
});