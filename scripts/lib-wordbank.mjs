// scripts/lib-wordbank.mjs —— 词库分片读写的唯一实现（split 与 merge 共用）
//
// 分片规则（稳定命名，便于缓存与最小 diff）：
//   · 每个首字母一个分片文件 `<letter>.json`；
//   · 该字母词条超过 max 时按顺序拆为 `<letter>.json`、`<letter>-2.json`、…；
//   · 主文件 src/data/word-enrich.json 只存 meta + 分片索引（很小，可作为同步定位依据）。
// 写入策略：**只重写内容发生变化的分片**（逐片与现有文件比较），避免每次合并都全量重写。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
export const BANK = join(ROOT, 'src', 'data', 'word-enrich.json');
export const SHARD_DIR = join(ROOT, 'src', 'data', 'word-enrich-shards');

/** 读主文件（meta + 索引） */
export function readMain() {
  return JSON.parse(readFileSync(BANK, 'utf8'));
}

/** 读全部词条（主文件内嵌的 entries 优先；否则读分片） */
export function readEntries() {
  const main = readMain();
  if (main.entries && typeof main.entries === 'object') return { meta: main.meta, entries: main.entries };
  const entries = {};
  if (existsSync(SHARD_DIR)) {
    for (const f of readdirSync(SHARD_DIR)) {
      if (!f.endsWith('.json')) continue;
      const payload = JSON.parse(readFileSync(join(SHARD_DIR, f), 'utf8'));
      Object.assign(entries, payload.entries || {});
    }
  }
  return { meta: main.meta, entries };
}

/** 按首字母 + max 切片：返回 [{ shard, from, to, entries }] */
export function planShards(entries, max = 200) {
  const groups = new Map();
  for (const [w, v] of Object.entries(entries)) {
    const letter = (w[0] || '_').toLowerCase();
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push([w, v]);
  }
  const out = [];
  for (const letter of [...groups.keys()].sort()) {
    const list = groups.get(letter).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (let i = 0; i < list.length; i += max) {
      const chunk = list.slice(i, i + max);
      const idx = i / max;
      out.push({
        shard: idx === 0 ? letter : `${letter}-${idx + 1}`,
        from: chunk[0][0],
        to: chunk[chunk.length - 1][0],
        entries: Object.fromEntries(chunk),
      });
    }
  }
  return out;
}

/**
 * 写入：重建分片与主文件索引，仅重写内容变化的分片。
 * @returns {{written:string[], removed:string[], shards:object[], main:object}}
 */
export function writeBank(entries, meta, max = 200) {
  const shards = planShards(entries, max);
  mkdirSync(SHARD_DIR, { recursive: true });

  const keep = new Set(shards.map((s) => `${s.shard}.json`));
  const existing = existsSync(SHARD_DIR) ? readdirSync(SHARD_DIR).filter((f) => f.endsWith('.json')) : [];
  const removed = existing.filter((f) => !keep.has(f));
  for (const f of removed) rmSync(join(SHARD_DIR, f), { force: true });

  const written = [];
  for (const s of shards) {
    const payload = { shard: s.shard, from: s.from, to: s.to, entries: s.entries };
    const body = JSON.stringify(payload, null, 2) + '\n';
    const file = join(SHARD_DIR, `${s.shard}.json`);
    const old = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (old !== body) {
      writeFileSync(file, body, 'utf8');
      written.push(s.shard);
    }
  }

  const main = {
    meta,
    shards: shards.map((s) => ({ shard: s.shard, from: s.from, to: s.to, count: Object.keys(s.entries).length })),
  };
  writeFileSync(BANK, JSON.stringify(main, null, 2) + '\n', 'utf8');
  return { written, removed, shards, main };
}

/** 词条大小（字节） */
export const sizeOf = (v) => Buffer.byteLength(JSON.stringify(v));
