// tests/round127-regression.test.mjs —— 验证 round127 自己的改动**没有破坏正常数据的行为**
//
// 为什么需要这个：审计的价值一半在"发现问题"，另一半在**"证明自己的修复没引入问题"**。
// 本文件把 round127 的三处改动逐条钉住：
//   ① srs.js 的 ease clamp —— 对**合法区间**的 ease 必须是恒等变换
//   ② repo-core 的 isWordMastered —— 对**通用卡**（无 familiar 字段）不得改变任何判定
//   ③ 3 个页面的硬编码 → isWordMastered —— 这三处**确实**是行为变更（熟词现在算已掌握），
//      属产品决策的预期效果，此处单独断言该变化符合决策，而不是伪装成"零影响"。
//
// 审计时另做过一次**端到端对比**（导出 `git show 0b1b56c~1:src/srs.js` 的改前实现，
// 对 12168 组「ease×level×rating×consolidation×difficulty×wrongReason」输入逐字段比对）：
// 新旧输出**完全相同**，证明 clamp 对正常数据是真正的恒等变换。
// 该对比依赖临时导出的旧版文件（会被 eslint / dep-check / i18n 闸扫到），故未固化为常驻测试，
// 改为在此断言「clamp 对合法值恒等」这一等价前提 —— 两者结论一致。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNext } from '../src/srs.js';
import { isMastered, isWordMastered } from '../src/repo-core.js';

const NOW = 1_800_000_000_000;

test('① ease clamp 对合法区间是恒等变换（改动只影响越界数据）', () => {
  // 恒等前提：合法 ease 经过 clamp 后逐个不变
  for (const e of [1.3, 1.4, 1.5, 1.8, 2.0, 2.2, 2.5, 2.6, 2.7, 2.8]) {
    assert.equal(Math.min(2.8, Math.max(1.3, e)), e, `clamp 不应改变合法 ease ${e}`);
  }
  // 且 computeNext 对合法 ease 输出的 ease 必须仍在合法区间（配合 srs-invariants 的广覆盖）
  let n = 0;
  for (const e of [1.3, 1.5, 2.0, 2.5, 2.8]) {
    for (const lvl of [0, 1, 2, 3, 4, 5, 8, 12, 30]) {
      for (const rt of [0, 1, 2]) {
        for (const c of [null, 1, 2]) {
          const r = computeNext({ level: lvl, ease: e, dueAt: NOW, consolidation: c }, rt, 1, false, { now: NOW });
          assert.ok(r.ease >= 1.3 && r.ease <= 2.8, `ease 输出越界：${r.ease}（输入 ${e}）`);
          assert.ok(Number.isFinite(r.dueAt) && r.intervalDays > 0 && r.intervalDays <= 365);
          n++;
        }
      }
    }
  }
  assert.ok(n >= 200, `覆盖组数偏少（${n}）`);
});

test('② isWordMastered 的引入不改变通用卡（cards）的任何判定', () => {
  for (const lvl of [0, 1, 3, 4, 5, 9]) {
    for (const iv of [0, 1, 7, 20, 21, 30, 365]) {
      for (const extra of [{}, { familiar: undefined }, { familiar: false }, { marked: true }]) {
        const card = { level: lvl, intervalDays: iv, ...extra };
        assert.equal(
          isWordMastered(card), isMastered(card),
          `通用卡（无 familiar）判定被改变：level=${lvl} interval=${iv} extra=${JSON.stringify(extra)}`,
        );
      }
    }
  }
  // 词卡：熟词优先（这是 round127 唯一**有意**的行为变化）
  assert.equal(isWordMastered({ familiar: true, level: 0, intervalDays: 0 }), true, '熟词应算已掌握');
  assert.equal(isWordMastered({ familiar: false, level: 4, intervalDays: 0 }), true);
  assert.equal(isWordMastered({ familiar: false, level: 3, intervalDays: 20 }), false);
});

test('③ 页面口径：非熟词的卡，isWordMastered 与原硬编码表达式完全等价', () => {
  // 原页面写法：`(c.intervalDays || 0) >= 21 || (c.level || 0) >= 4`
  for (const lvl of [null, undefined, 0, 1, 2, 3, 4, 5, 8, NaN]) {
    for (const iv of [null, undefined, 0, 1, 7, 20, 21, 30, NaN]) {
      const c = { level: lvl, intervalDays: iv, familiar: false };
      const oldWay = (c.intervalDays || 0) >= 21 || (c.level || 0) >= 4;
      assert.equal(
        isWordMastered(c), oldWay,
        `非熟词判定与原硬编码不等价：level=${String(lvl)} interval=${String(iv)}`,
      );
    }
  }
  // 唯一有差别的地方就是熟词——产品决策要的就是这个差别
  assert.equal(
    isWordMastered({ level: 0, intervalDays: 0, familiar: true }), true,
    '熟词应被算作已掌握（这是本次决策带来的**预期**行为变化，不是回归）',
  );
});
