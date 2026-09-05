// scripts/sync-coverage-audit.mjs
// 同步覆盖审计：比对 IndexedDB 全表（db.js schema）与同步清单（sync-manifest.js），
// 列出「库里有但没进同步」的表 —— 这类表跨设备/备份导入会静默丢失。
// 用法：node scripts/sync-coverage-audit.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYNC_TABLES, EXCLUDED_FROM_SYNC, PRIVACY_SYNC_TABLES } from '../src/sync-manifest.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const dbSrc = readFileSync(join(root, 'src', 'db.js'), 'utf8');

// 解析所有 d.version(N).stores({ ... }) 块，提取表名
const tables = new Map(); // name -> 首次出现的 version
for (const m of dbSrc.matchAll(/d\.version\((\d+)\)\.stores\(\{([\s\S]*?)\n\}\);/g)) {
  const ver = Number(m[1]);
  for (const line of m[2].split('\n')) {
    const tm = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (tm && !tables.has(tm[1])) tables.set(tm[1], ver);
  }
}

const synced = new Set(SYNC_TABLES.map(t => t.table));
const excluded = new Set(EXCLUDED_FROM_SYNC);
const privacy = new Set(PRIVACY_SYNC_TABLES.map(t => (typeof t === 'string' ? t : t.table)));

// 特殊通道表：不进 SYNC_TABLES，但导出/导入走独立字段（见 sync.js buildBackup/importBackup）。
// 这些不是漏同步，但同步范围可能与整表不同 —— 注释里写明真实口径，便于人工核对。
const SPECIAL_CASED = {
  tombstones: '经 backup.tombstones 全量传播（删除语义，必须同步）',
  meta: '经 backup.streakMeta 同步【仅 goal 打卡目标】，其余 meta 键不同步',
};

const missing = [];
for (const [name, ver] of tables) {
  if (synced.has(name)) continue;
  if (excluded.has(name)) continue;
  if (privacy.has(name)) continue; // opt-in：设置开启后并入 SYNC_TABLES（getEffectiveSyncTables）
  if (SPECIAL_CASED[name]) continue;
  missing.push({ name, ver });
}

// 反向：同步清单里有但 db schema 里没有（清单写错/表已下线）
const orphan = [...synced].filter(t => !tables.has(t));

console.log(`db.js 表总数：${tables.size}｜同步清单：${synced.size}｜隐私 opt-in：${privacy.size}｜显式排除：${excluded.size}`);

if (missing.length) {
  console.error(`\n✗ 未进同步且未显式排除的表（${missing.length}）——跨设备/备份导入会丢失：`);
  for (const t of missing.sort((a, b) => a.name.localeCompare(b.name))) {
    console.error(`   ${t.name}  (v${t.ver})${privacy.has(t.name) ? '  [隐私 opt-in 表]' : ''}`);
  }
} else {
  console.log('\n✓ 所有表均已纳入同步或被显式排除');
}
if (orphan.length) {
  console.error(`\n✗ 同步清单引用了 db schema 中不存在的表（${orphan.length}）：${orphan.join(', ')}`);
}

// 打印完整覆盖明细，便于人工核对
console.log('\n── 同步覆盖明细 ──');
const rows = [...tables.entries()].sort((a, b) => a[0].localeCompare(b[0]));
for (const [name, ver] of rows) {
  let state = '漏同步';
  if (synced.has(name)) state = '同步';
  else if (excluded.has(name)) state = '排除';
  else if (privacy.has(name)) state = '隐私opt-in';
  else if (SPECIAL_CASED[name]) state = '特殊通道';
  console.log(`   ${name.padEnd(22)} v${String(ver).padEnd(3)} ${state}`);
}
if (Object.keys(SPECIAL_CASED).length) {
  console.log('\n── 特殊通道口径（务必人工确认）──');
  for (const [k, v] of Object.entries(SPECIAL_CASED)) console.log(`   ${k}: ${v}`);
}

process.exit(missing.length || orphan.length ? 1 : 0);
