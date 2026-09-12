// scripts/word-enrich-merge.mjs
// 词条批量合并工具：把「片段 JSON 文件」校验后并入分片词库（只重写变化的分片）。
//
// 设计目标：让「逐批扩充词库」成为一条可重复、可自动化的流水线（人工与自动化任务共用）。
//
// 用法：
//   node scripts/word-enrich-merge.mjs <片段1.json> [片段2.json ...] [选项]
// 选项：
//   --batch N             本次批次号（写进 meta.batch，缺省自动 +1）
//   --next WORD           下一批起点（缺省自动取大纲中第一个未收录词）
//   --max N               每个分片最大词数（默认 200）
//   --allow-off-syllabus  允许收录不在考研大纲内的词（默认禁止，避免误收）
//   --dry-run             只校验不写入
//
// 片段格式：{ "word": { syllable, pos, defs[], rootAffix, examples[], collocations[],
//                       phrases[], derived[], synonyms[], mnemonic }, ... }
// 校验：JSON 可解析 / 必填字段齐全 / examples 必须同时含 simple 与 long 且每条都有 analysis /
//       不与现有或片段间重复 / 默认必须在大纲词表内
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readEntries, writeBank, BANK, ROOT } from './lib-wordbank.mjs';

const REQUIRED = ['syllable', 'pos', 'defs', 'rootAffix', 'examples', 'collocations', 'phrases', 'derived', 'synonyms', 'mnemonic'];

const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith('--'));
const has = (name) => argv.includes('--' + name);
const opt = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def;
};
if (!files.length) {
  console.error('用法：node scripts/word-enrich-merge.mjs <片段1.json> [片段2.json ...] [--batch N] [--next WORD] [--dry-run]');
  process.exit(1);
}

const { meta, entries: existing } = readEntries();
const before = Object.keys(existing).length;

// ---------- 读取片段 ----------
const incoming = new Map();
const dup = [];
for (const f of files) {
  let part;
  try {
    part = JSON.parse(readFileSync(resolve(f), 'utf8'));
  } catch (e) {
    console.error(`✗ 片段解析失败：${f}\n  ${e.message}`);
    process.exit(1);
  }
  for (const [k, v] of Object.entries(part)) {
    const key = String(k).trim().toLowerCase();
    if (existing[key] || incoming.has(key)) dup.push(key);
    incoming.set(key, v);
  }
}

// ---------- 校验 ----------
const syllabus = new Set(
  (JSON.parse(readFileSync(resolve(ROOT, 'src/data/kaoyan-vocab-2027.json'), 'utf8')).words || [])
    .map((w) => String(w).trim().toLowerCase()),
);
const problems = [];
for (const [w, v] of incoming) {
  if (!v || typeof v !== 'object') { problems.push(`${w}: 条目不是对象`); continue; }
  const miss = REQUIRED.filter((f) => !(f in v));
  if (miss.length) problems.push(`${w}: 缺字段 ${miss.join(',')}`);
  const ex = Array.isArray(v.examples) ? v.examples : [];
  const levels = new Set(ex.map((e) => String(e?.level || '').toLowerCase()));
  if (!levels.has('simple')) problems.push(`${w}: 缺 simple 例句`);
  if (!levels.has('long')) problems.push(`${w}: 缺 long 长难句`);
  for (const e of ex) {
    if (!String(e?.sentence || '').trim()) problems.push(`${w}: 例句缺 sentence`);
    if (!String(e?.translation || '').trim()) problems.push(`${w}: 例句缺 translation`);
    if (!String(e?.analysis || '').trim()) problems.push(`${w}: 例句缺 analysis（长难句解析）`);
  }
  if (!Array.isArray(v.defs) || !v.defs.length) problems.push(`${w}: defs 为空`);
  if (!has('allow-off-syllabus') && !syllabus.has(w)) problems.push(`${w}: 不在考研大纲词表内`);
}

const exTotal = [...incoming.values()].reduce((n, v) => n + (Array.isArray(v.examples) ? v.examples.length : 0), 0);
const colTotal = [...incoming.values()].reduce((n, v) => n + (Array.isArray(v.collocations) ? v.collocations.length : 0), 0);
console.log(`\n=== ${has('dry-run') ? 'DRY-RUN 校验' : '合并前校验'} ===`);
console.log(`片段文件：${files.length} 个 | 待合并词条：${incoming.size} 条 | 例句 ${exTotal} 条 | 搭配 ${colTotal} 条`);
if (dup.length) console.log(`⚠ 重复词条：${[...new Set(dup)].join(', ')}`);
if (problems.length) {
  console.log(`✗ 校验未通过（${problems.length} 项）：`);
  problems.slice(0, 20).forEach((p) => console.log('   -', p));
  if (problems.length > 20) console.log(`   ...另有 ${problems.length - 20} 项`);
  console.error('\n未写入任何内容。请修正后重试。');
  process.exit(1);
}
if (has('dry-run')) {
  console.log('\n（--dry-run：未写入）');
  process.exit(0);
}

// ---------- 合并 + 分片写入 ----------
const merged = { ...existing, ...Object.fromEntries(incoming) };
const batchNo = Number(opt('batch', (meta.batch || 1) + 1));
const recorded = new Set(Object.keys(merged).map((w) => w.toLowerCase()));
const sortedSyl = [...syllabus].sort();
const autoNext = sortedSyl.find((w) => !recorded.has(w)) || '';
const nextFrom = String(opt('next', autoNext || meta.nextBatchFrom || ''));
const addedWords = [...incoming.keys()];
const total = Object.keys(merged).length;

const newMeta = {
  ...meta,
  version: `batch-${batchNo}`,
  batch: batchNo,
  nextBatchFrom: nextFrom,
  note: `本词库内容为离线编写、随应用发布，补全时不调用任何付费 AI 接口，也不发起网络请求。每条含：多义项释义(defs)、分档例句(examples，含长难句解析 analysis)、词组搭配(collocations)、短语(phrases)、派生词(derived)、词根词缀(rootAffix)、近义词(synonyms)、助记(mnemonic)。未收录的词一律明确提示跳过，绝不臆造。batch-${batchNo} 新增 ${addedWords.length} 词（${addedWords[0]} ~ ${addedWords[addedWords.length - 1]}），累计 ${total} 词。`,
};

// 写前复检：合并后必须包含全部旧词 + 新词
if (Object.keys(merged).length !== before + addedWords.length) throw new Error('合并计数异常');
for (const w of addedWords) if (!merged[w]) throw new Error(`写入前复检失败：缺 ${w}`);

const { written, removed } = writeBank(merged, newMeta, Number(opt('max', 200)));
const covered = Object.keys(merged).filter((w) => syllabus.has(w.toLowerCase())).length;
console.log(`\n✅ 已写入词库（分片存储 src/data/word-enrich-shards/）`);
console.log(`   批次：batch-${batchNo} | 下一批起点：${nextFrom}`);
console.log(`   词条：${before} → ${total}（+${addedWords.length}）`);
console.log(`   分片：重写 ${written.length} 个${written.length ? '（' + written.join(', ') + '）' : ''}${removed.length ? '，删除 ' + removed.length + ' 个' : ''}`);
console.log(`   大纲覆盖：${covered}/${syllabus.size} = ${(covered / syllabus.size * 100).toFixed(2)}%`);
console.log(`   主文件：${BANK}`);
