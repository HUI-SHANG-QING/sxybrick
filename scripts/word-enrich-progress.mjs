// scripts/word-enrich-progress.mjs
// 词库进度报告：给人工与自动化任务用 —— 一屏看清「还剩多少、下一批写哪些词」。
//
// 注意：词条已分片存放（src/data/word-enrich-shards/），必须通过 lib-wordbank 读取，
// 不能只读主文件的 entries（主文件现在只有 meta + 分片索引）。
//
// 用法：node scripts/word-enrich-progress.mjs [--next N]
//   --next N  额外打印按大纲字母序的接下来 N 个未收录词（默认 30，便于直接开写）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEntries, ROOT } from './lib-wordbank.mjs';

const { meta, entries } = readEntries();
const syllabus = (JSON.parse(readFileSync(join(ROOT, 'src/data/kaoyan-vocab-2027.json'), 'utf8')).words || [])
  .map((w) => String(w).trim().toLowerCase());

const nArg = process.argv.indexOf('--next');
const wantNext = nArg >= 0 ? Number(process.argv[nArg + 1] || 30) : 30;

const covered = new Set(Object.keys(entries).map((w) => w.toLowerCase()));
const inSyllabus = syllabus.filter((w) => covered.has(w));
const missing = syllabus.filter((w) => !covered.has(w));
const offSyllabus = Object.keys(entries).filter((w) => !syllabus.includes(w.toLowerCase()));

const pct = ((inSyllabus.length / syllabus.length) * 100).toFixed(2);
console.log('=== 英语词条库进度（word-enrich，分片存储）===');
console.log(`批次：batch-${meta.batch} | 下一批起点（meta）：${meta.nextBatchFrom}`);
console.log(`词条总数：${Object.keys(entries).length}（其中不在大纲内：${offSyllabus.length}${offSyllabus.length ? '：' + offSyllabus.join(', ') : ''}）`);
console.log(`大纲覆盖：${inSyllabus.length}/${syllabus.length} = ${pct}% | 剩余待补：${missing.length} 词`);
console.log(`按每批 30 词计，还需约 ${Math.ceil(missing.length / 30)} 批；若每小时一批，约 ${(Math.ceil(missing.length / 30) / 24).toFixed(1)} 天`);

// 字母段进度
const buckets = {};
for (const w of syllabus) {
  const k = w[0];
  buckets[k] = buckets[k] || { total: 0, done: 0 };
  buckets[k].total++;
  if (covered.has(w)) buckets[k].done++;
}
console.log('\n--- 分字母进度 ---');
console.log(Object.keys(buckets).sort().map((k) => `${k}:${buckets[k].done}/${buckets[k].total}`).join('  '));

if (wantNext > 0) {
  console.log(`\n--- 接下来 ${wantNext} 个未收录词（按大纲字母序）---`);
  console.log(missing.slice(0, wantNext).join(' '));
  console.log('\n（提示：写好的片段用 scripts/word-enrich-merge.mjs 合并，会自动校验并更新 meta）');
}
