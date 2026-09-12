// scripts/word-enrich-split.mjs
// 把词库按首字母重新分片（每片 ≤ SHARD_MAX 词），供运行时按需加载。
//
// 为什么必须分片：全量 4956 词 ≈ 11MB，单个 JSON 无法进 PWA 预缓存（单文件上限 600KB），
// 也会拖垮首屏。分片后每片 ≈300~460KB，且查词时只需加载目标词所在的那一片。
//
// 产物：
//   src/data/word-enrich.json            —— 主文件：meta + 分片索引（很小，含每片首尾词）
//   src/data/word-enrich-shards/<L>.json —— 每片 { shard, from, to, entries }
//
// 用法：node scripts/word-enrich-split.mjs [--max 200] [--check]
import { readEntries, planShards, writeBank, sizeOf } from './lib-wordbank.mjs';

const argv = process.argv.slice(2);
const maxIdx = argv.indexOf('--max');
const SHARD_MAX = maxIdx >= 0 ? Number(argv[maxIdx + 1] || 200) : 200;
const CHECK = argv.includes('--check');

const { meta, entries } = readEntries();
const total = Object.keys(entries).length;
if (!total) {
  console.error('词库为空：既无分片也无主文件 entries。');
  process.exit(1);
}

const planned = planShards(entries, SHARD_MAX);
console.log(`词条总数：${total} | 分片数：${planned.length}（每片上限 ${SHARD_MAX} 词）`);
for (const s of planned) {
  const kb = (sizeOf(s.entries) / 1024).toFixed(0);
  console.log(`  ${s.shard.padEnd(5)} ${s.from} … ${s.to}（${Object.keys(s.entries).length} 词，约 ${kb}KB）${Number(kb) > 600 ? '  ⚠ 超 600KB，请调小 --max' : ''}`);
}
if (CHECK) process.exit(0);

const { written, removed } = writeBank(entries, meta, SHARD_MAX);
console.log(`\n✅ 分片完成：重写 ${written.length} 个${written.length ? '（' + written.join(', ') + '）' : ''}${removed.length ? '，删除 ' + removed.length + ' 个' : ''}`);
console.log('   主文件已重建为「meta + 分片索引」');
