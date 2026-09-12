// scripts/word-enrich-merge.mjs
// 词条批量合并工具：把「片段 JSON 文件」校验后并入 src/data/word-enrich.json。
//
// 设计目标：让「逐批扩充词库」变成一条可重复、可自动化的流水线（供人工与自动化任务共用）。
//
// 用法：
//   node scripts/word-enrich-merge.mjs <片段1.json> [片段2.json ...] [选项]
// 选项：
//   --batch N         本次批次号（写进 meta.batch，缺省自动 +1）
//   --next WORD       下一批起点（写进 meta.nextBatchFrom，缺省自动取大纲中下一个未收录词）
//   --allow-off-syllabus  允许收录不在考研大纲内的词（默认禁止，避免误收）
//   --dry-run         只校验不写入
//
// 片段文件格式：{ "word": { syllable, pos, defs[], rootAffix, examples[], collocations[],
//                          phrases[], derived[], synonyms[], mnemonic }, ... }
// 校验项：
//   1) JSON 可解析   2) 必填字段齐全   3) examples 必须同时含 simple 与 long，且每条都有 analysis
//   4) 不得与现有词库或其它片段重复   5) 默认必须在大纲词表内
// 写入策略：**文本级最小 diff** —— 既有词条文本一字不动，仅在 entries 末尾追加 + 改 meta 几行。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BANK = join(ROOT, 'src', 'data', 'word-enrich.json');
const SYLLABUS = join(ROOT, 'src', 'data', 'kaoyan-vocab-2027.json');

const REQUIRED = ['syllable', 'pos', 'defs', 'rootAffix', 'examples', 'collocations', 'phrases', 'derived', 'synonyms', 'mnemonic'];

const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith('--'));
const opt = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def;
};
const has = (name) => argv.includes('--' + name);
if (!files.length) {
  console.error('用法：node scripts/word-enrich-merge.mjs <片段1.json> [片段2.json ...] [--batch N] [--next WORD] [--dry-run]');
  process.exit(1);
}

const J = (v) => JSON.stringify(v);
const SCALAR = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null;

// ---------- 读取现有词库（保留原文，用于文本级写入） ----------
const bankText = readFileSync(BANK, 'utf8');
const bank = JSON.parse(bankText);
const existing = bank.entries;
const before = Object.keys(existing).length;

// ---------- 读取片段 ----------
const incoming = new Map();
const dup = [];
for (const f of files) {
  const p = resolve(f);
  let part;
  try {
    part = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`✗ 片段解析失败：${p}\n  ${e.message}`);
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
  (JSON.parse(readFileSync(SYLLABUS, 'utf8')).words || []).map((w) => String(w).trim().toLowerCase()),
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
const report = (label) => {
  console.log(`\n=== ${label} ===`);
  console.log(`片段文件：${files.length} 个 | 待合并词条：${incoming.size} 条`);
  if (dup.length) console.log(`⚠ 重复词条（已存在或被多个片段重复）：${[...new Set(dup)].join(', ')}`);
  if (problems.length) {
    console.log(`✗ 校验未通过（${problems.length} 项）：`);
    problems.slice(0, 20).forEach((p) => console.log('   -', p));
    if (problems.length > 20) console.log(`   ...另有 ${problems.length - 20} 项`);
  }
  const exTotal = [...incoming.values()].reduce((n, v) => n + (Array.isArray(v.examples) ? v.examples.length : 0), 0);
  const colTotal = [...incoming.values()].reduce((n, v) => n + (Array.isArray(v.collocations) ? v.collocations.length : 0), 0);
  console.log(`统计：例句 ${exTotal} 条（全部带解析）| 搭配 ${colTotal} 条`);
  return problems.length === 0 && dup.length === 0;
};
if (!report(has('dry-run') ? 'DRY-RUN 校验' : '合并前校验')) {
  console.error('\n未写入任何内容。请修正后重试。');
  process.exit(1);
}
if (has('dry-run')) {
  console.log('\n（--dry-run：未写入）');
  process.exit(0);
}

// ---------- 文本级插入（既有内容零改动） ----------
// 新条目用 JSON.stringify(value, null, 2) 生成、整体再缩进 4 空格：
// 实现简单、语法必然正确（此前自研的"紧凑风格"序列化器在复杂嵌套下会产出畸形文本，
// 好在写入前的复检把它拦住了 —— 简单优于聪明）。
const entries = [...incoming.entries()];
const jsonStr = (v) => JSON.stringify(v);
const indentBlock = (k, v) => {
  const body = JSON.stringify(v, null, 2)
    .split('\n')
    .map((l, i) => (i === 0 ? l : '    ' + l))
    .join('\n');
  return '    ' + JSON.stringify(k) + ': ' + body;
};

let txt = bankText;
const sub1 = (t, old, next) => {
  if (t.split(old).length !== 2) throw new Error(`锚点不唯一/缺失：${old.slice(0, 40)}`);
  return t.replace(old, next);
};
const batchNo = Number(opt('batch', (bank.meta.batch || 1) + 1));
// 下一批起点：默认取「大纲中第一个尚未收录的词」——这样按字母序连续补齐全部空缺，
// 符合"刷完整个大纲"的目标（不要取"字母序最大的已收录词之后"，那会跳过中间的空档）。
const recorded = new Set([...Object.keys(existing), ...incoming.keys()].map((w) => w.toLowerCase()));
const sortedSyl = [...syllabus].sort();
const autoNext = sortedSyl.find((w) => !recorded.has(w)) || '';
const nextFrom = String(opt('next', autoNext || bank.meta.nextBatchFrom || ''));

// 原文件尾部形如： …最后一条 } / entries 收尾 } / 根 }
// 插入时：截掉「整段尾部」→ 补回最后一条的 } → 加逗号 + 新条目 → 只加 entries 与根的收尾。
// （踩坑：若截掉整段后又把含「最后一条 }」的整段接回去，会多出一个 } → JSON 提前闭合。）
const TAIL_FULL = '\n    }\n  }\n}\n';
const TAIL_REST = '\n  }\n}\n';
if (!txt.endsWith(TAIL_FULL)) throw new Error('词库文件尾部结构与预期不符');
const blocks = entries.map(([k, v]) => indentBlock(k, v));
const note = `本词库内容为离线编写、随应用发布，补全时不调用任何付费 AI 接口，也不发起网络请求。每条含：多义项释义(defs)、分档例句(examples，含长难句解析 analysis)、词组搭配(collocations)、短语(phrases)、派生词(derived)、词根词缀(rootAffix)、近义词(synonyms)、助记(mnemonic)。未收录的词一律明确提示跳过，绝不臆造。batch-${batchNo} 新增 ${entries.length} 词（${entries[0][0]} ~ ${entries[entries.length - 1][0]}），累计 ${before + entries.length} 词。`;
txt = sub1(txt, `"batch": ${bank.meta.batch},`, `"batch": ${batchNo},`);
txt = sub1(txt, `"version": "${bank.meta.version}",`, `"version": "batch-${batchNo}",`);
txt = sub1(txt, `"nextBatchFrom": ${jsonStr(bank.meta.nextBatchFrom)}`, `"nextBatchFrom": ${jsonStr(nextFrom)}`);
txt = sub1(txt, `    "note": ${jsonStr(bank.meta.note)},\n`, `    "note": ${jsonStr(note)},\n`);
txt = txt.slice(0, txt.length - TAIL_FULL.length) + '\n    }' + ',\n' + blocks.join(',\n') + TAIL_REST;

// ---------- 写前复检 ----------
const parsed = JSON.parse(txt);
const after = Object.keys(parsed.entries).length;
if (after !== before + entries.length) throw new Error(`词条数不符：${before}+${entries.length} != ${after}`);
if (Object.keys(parsed.entries).slice(0, before).join() !== Object.keys(existing).join()) throw new Error('既有词条顺序被改动');
writeFileSync(BANK, txt.endsWith('\n') ? txt : txt + '\n', 'utf8');
const d = (w) => (syllabus.has(w) ? 1 : 0);
const covered = Object.keys(parsed.entries).filter(d).length;
console.log(`\n✅ 已写入 src/data/word-enrich.json`);
console.log(`   批次：batch-${batchNo} | 下一批起点：${nextFrom}`);
console.log(`   词条：${before} → ${after}（+${entries.length}）`);
console.log(`   大纲覆盖：${covered}/${syllabus.size} = ${(covered / syllabus.size * 100).toFixed(2)}%`);
