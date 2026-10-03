// tests/srs-invariants.test.mjs —— SM-2 调度算法的**枚举式**不变量门禁（round127）
//
// 为什么是「枚举」而不是「举例」：
//   round124 我用 16 个典型公式当样本，漏掉了 KaTeX 的「SVG 绘制型」→ 误杀 4/16。
//   教训：改核心算法时，举例会被形态覆盖不全反噬。⇒ 这里遍历各维度的**边界值**
//   与极端组合，断言输出的**不变量**，而不是断言具体数值。
//
// 最关键的一条不变量：**dueAt 必须是有限可比较的时间戳**。
//   一旦变成 NaN，`dueAt <= now` 恒为 false → 这张卡**永久消失于复习队列**、
//   不报错、不告警（srs.js:71 的注释记录过这个真实事故）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeNext, scheduleReview } from '../src/srs.js';

const NOW = 1_800_000_000_000;

function violations(r) {
  const bad = [];
  if (!Number.isFinite(r.dueAt)) bad.push(`dueAt 非有限数（${r.dueAt}）→ 卡会永久消失于队列`);
  if (!Number.isFinite(r.intervalDays) || r.intervalDays <= 0) bad.push(`intervalDays 非法（${r.intervalDays}）`);
  if (r.intervalDays > 365.0001) bad.push(`intervalDays 越界（${r.intervalDays} > 365）`);
  if (!Number.isFinite(r.level) || r.level < 0) bad.push(`level 非法（${r.level}）`);
  if (!Number.isFinite(r.ease)) bad.push(`ease 非有限数（${r.ease}）`);
  else if (r.ease < 1.2999 || r.ease > 2.8001) bad.push(`ease 越界（${r.ease}，应在 1.3~2.8）`);
  if (r.consolidation !== null && ![1, 2].includes(r.consolidation)) bad.push(`consolidation 非法（${r.consolidation}）`);
  return bad;
}

const BASE = { level: 2, ease: 2.5, dueAt: NOW };

test('不变量：遍历各维度边界值 + 极端组合，输出必须始终合法', () => {
  const bad = [];
  const probe = (tag, card, rating, intensity, guessed, opts) => {
    let r;
    try { r = computeNext(card, rating, intensity, guessed, { now: NOW, ...opts }); }
    catch (e) { bad.push(`[${tag}] 抛错：${e.message}`); return; }
    for (const b of violations(r)) bad.push(`[${tag}] ${b}`);
  };

  for (const lvl of [0, 1, 2, 3, 4, 5, 10, 30, 100, 400, NaN, undefined, null, -3, 2.7, Infinity]) {
    probe(`level=${String(lvl)}`, { ...BASE, level: lvl }, 2, 1, false, {});
  }
  // ease 的越界值是 round127 实测发现的口径缺口（原先只封上界、不封下界）
  for (const e of [1.3, 1, 2, 2.5, 2.8, 0.5, 5, NaN, undefined, -1, Infinity, 0, 0.8]) {
    probe(`ease=${String(e)}`, { ...BASE, ease: e }, 2, 1, false, {});
  }
  for (const rt of [0, 1, 2]) probe(`rating=${rt}`, BASE, rt, 1, false, {});
  for (const d of [undefined, 'basic', 'applied', 'challenge', 0, 1, 2, 5, -1, 'x', NaN]) {
    probe(`difficulty=${String(d)}`, { ...BASE, difficulty: d }, 2, 1, false, { difficulty: d });
  }
  // consolidation 的脏值曾被原样写回数据库
  for (const c of [null, 0, 1, 2, 3, undefined, NaN, 99, -1]) {
    probe(`consolidation=${String(c)}`, { ...BASE, consolidation: c }, 2, 1, false, {});
  }
  for (const it of [undefined, 0.5, 1, 1.5, 2, 99, 0, -1, NaN, Infinity]) {
    probe(`intensity=${String(it)}`, BASE, 2, it, false, {});
  }
  for (const w of ['', 'CONCEPT_MIS', 'MEMORY_WEAK', 'CARELESS', 'xxx']) {
    probe(`wrongReason=${w}`, { ...BASE, wrongReason: w }, 2, 1, false, { wrongReason: w });
  }
  for (const g of [true, false]) probe(`guessed=${g}`, BASE, 2, 1, g, {});

  // 极端组合：6 个维度各取 2~4 个极值，全遍历
  const DIMS = {
    level: [0, 4, 30, NaN], ease: [1.3, 2.8, NaN], consolidation: [null, 1, 2],
    difficulty: ['basic', 'challenge', 0, 2], rating: [0, 2], guessed: [true, false],
  };
  const keys = Object.keys(DIMS);
  for (let mask = 0; mask < (1 << keys.length); mask++) {
    const card = { dueAt: NOW };
    let rating = 2, guessed = false, opts = {};
    keys.forEach((k, i) => {
      const v = DIMS[k][(mask >> i) % DIMS[k].length];
      if (k === 'rating') rating = v;
      else if (k === 'guessed') guessed = v;
      else if (k === 'difficulty') { card.difficulty = v; opts.difficulty = v; }
      else card[k] = v;
    });
    probe('极端组合', card, rating, 1, guessed, opts);
  }

  // 检索强度乘子（scheduleReview 层的后处理，会再乘一次系数并重算 dueAt）
  for (const rs of [undefined, 'recognize', 'recall', 'generate', 'explain', 'bogus']) {
    for (const lvl of [0, 4, 30]) {
      const r = scheduleReview({ level: lvl, ease: 2.8, dueAt: NOW }, 2, 1, false,
        { retrievalStrength: rs, now: NOW, scheduler: 'sm2' });
      for (const b of violations(r)) bad.push(`[rs=${rs}/lvl=${lvl}] ${b}`);
    }
  }

  assert.deepEqual(bad, [], `调度算法在边界输入下违反不变量：\n${bad.join('\n')}`);
});

test('单调性：已开始的卡（level≥1）评分越高间隔越长', () => {
  for (const lvl of [1, 3, 4, 8]) {
    const d = [0, 1, 2].map((rt) => computeNext({ level: lvl, ease: 2.5, dueAt: NOW }, rt, 1, false, { now: NOW }).intervalDays);
    assert.ok(d[0] < d[1] && d[1] < d[2], `level=${lvl} 间隔非单调：忘了 ${d[0]} < 模糊 ${d[1]} < 记住 ${d[2]}`);
  }
});

test('结构闸门：computeNext 必须在入口同时归一 ease 的上下界', () => {
  // 降 ease 的分支都带 Math.max(1.3,…)，而 rating=2 的加分支原先只写了 Math.min(2.8,…)
  // ⇒ 上界封了、下界没封，ease<1.3 的卡会一直漂在区间外（round127 实测发现）。
  const src = readFileSync(new URL('../src/srs.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:'"`])\/\/[^\n]*/, '$1'))
    .join('\n');
  assert.match(
    src, /ease\s*=\s*Number\.isFinite\(Number\(ease\)\)\s*\?\s*Math\.min\(\s*2\.8\s*,\s*Math\.max\(\s*1\.3/,
    'computeNext 入口必须同时对 ease 的上下界做归一（与 level 的 Math.max(0, Math.trunc(…)) 同款思路）',
  );
});
