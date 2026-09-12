// scripts/word-enrich-progress.mjs
// 词库进度报告：给人工与自动化任务用 —— 一屏看清「还剩多少、下一批写哪些词」。
//
// 用法：node scripts/word-enrich-progress.mjs [--next N]
//   --next N  额外打印按大纲字母序的接下来 N 个未收录词（默认 30，便于直接开写）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const bank = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'word-enrich.json'), 'utf8'));
const syllabus = (JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'kaoyan-vocab-2027.json'), 'utf8')).words || [])
  .map((w) => String(w).trim().toLowerCase());

const nArg = process.argv.indexOf('--next');
const wantNext = nArg >= 0 ? Number(process.argv[nArg + 1] || 30) : 30;

const entries = bank.entries || {};
const covered = new Set(Object.keys(entries).map((w) => w.toLowerCase()));
const inSyllabus = syllabus.filter((w) => covered.has(w));
const missing = syllabus.filter((w) => !covered.has(w));
const offSyllabus = Object.keys(entries).filter((w) => !syllabus.includes(w.toLowerCase()));

const pct = ((inSyllabus.length / syllabus.length) * 100).toFixed(2);
console.log('=== 英语词条库进度（word-enrich）===');
console.log(`批次：batch-${bank.meta.batch} | 下一批起点（meta）：${bank.meta.nextBatchFrom}`);
console.log(`词条总数：${Object.keys(entries).length}（其中不在大纲内：${offSyllabus.length}${offSyllabus.length ? '：' + offSyllabus.join(', ') : ''}）`);
console.log(`大纲覆盖：${inSyllabus.length}/${syllabus.length} = ${pct}% | 剩余待补：${missing.length} 词`);
console.log(`按当前每批 30 词计，还需约 ${Math.ceil(missing.length / 30)} 批`);

// 字母段进度
const buckets = {};
for (const w of syllabus) {
  const k = w[0];
  buckets[k] = buckets[k] || { total: 0, done: 0 };
  buckets[k].total++;
  if (covered.has(w)) buckets[k].done++;
}
const line = Object.keys(buckets).sort().map((k) => `${k}:${buckets[k].done}/${buckets[k].total}`).join('  ');
console.log('\n--- 分字母进度 ---');
console.log(line);

if (wantNext > 0) {
  console.log(`\n--- 接下来 ${wantNext} 个未收录词（按大纲字母序）---`);
  console.log(missing.slice(0, wantNext).join(' '));
  console.log('\n（提示：写好的片段用 scripts/word-enrich-merge.mjs 合并，会自动校验并更新 meta）');
}
