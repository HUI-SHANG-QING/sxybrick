// tests/algo-regression.test.mjs —— 2026-08-30 算法侧修复的行为回归
// 覆盖：僵尸卡误判 / 前测科目系数失效 / 纯英文卡被误判裸 ID / 森林展开的环与去重
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectZombieIds } from '../src/repo-core.js';
import { estimateInitialStability, subjectFactorOf, difficultyToNum } from '../src/algorithms/pretest.js';
import { looksLikeRawId, edgesToForest } from '../src/algorithms/graph-resolve.js';

const DAY = 86400000;
const NOW = Date.now();

// ---------- 僵尸卡 ----------

test('僵尸卡：createdAt 缺失的新卡不会被误判（此前恒判为僵尸）', () => {
  // ⚠️ 历史缺陷：`(c.createdAt || 0) <= threshold` 对 createdAt=0/undefined 恒真，
  //   一张刚创建的新卡立刻被判成「90 天没动过的僵尸卡」。
  const fresh = [
    { id: 'a', createdAt: 0 },
    { id: 'b', createdAt: undefined },
    { id: 'c' },
  ];
  assert.deepEqual(selectZombieIds(fresh, new Set(), NOW), [], 'createdAt 缺失的新卡不该判成僵尸');

  // updatedAt 兜底：真实创建时间用 updatedAt 近似
  const withUpd = [{ id: 'd', createdAt: 0, updatedAt: NOW - 200 * DAY }];
  assert.deepEqual(selectZombieIds(withUpd, new Set(), NOW), ['d'], 'updatedAt 可兜底判定');

  // 真僵尸仍要抓到
  const real = [{ id: 'e', createdAt: NOW - 200 * DAY }];
  assert.deepEqual(selectZombieIds(real, new Set(), NOW), ['e']);

  // 复习过的卡永不判僵尸
  assert.deepEqual(selectZombieIds(real, new Set(['e']), NOW), []);
});

// ---------- 冷启动前测 ----------

test('前测科目系数：包含匹配生效（此前精确查表 → 全表静默失效）', () => {
  // ⚠️ 历史缺陷：科目名来自 DEFAULT_SUBJECTS（'计算机网络'/'高等数学'/'线性代数'…），
  //   而系数表的键是 '数学'/'计网'/'OS' —— 精确查找无一命中，全部回退 1.0，
  //   「难科打折」从来没生效过。
  assert.ok(subjectFactorOf('高等数学') < 1, '高等数学必须打折');
  assert.ok(subjectFactorOf('线性代数') < 1, '线性代数必须打折');
  assert.ok(subjectFactorOf('计算机网络') < 1, '计算机网络必须打折');
  assert.ok(subjectFactorOf('计算机组成原理') < 1, '计组必须打折');
  assert.ok(subjectFactorOf('概率论') < 1, '概率论必须打折');
  assert.equal(subjectFactorOf(''), 1, '空科目回退 1.0');
  assert.equal(subjectFactorOf('某个没登记的科目'), 1, '未命中回退 1.0');

  // 端到端：同等自评分下，难科的初始 S 必须更低
  const mathS = estimateInitialStability({ familiarity: 3, subject: '高等数学', difficulty: 'basic' });
  const engS = estimateInitialStability({ familiarity: 3, subject: '英语单词', difficulty: 'basic' });
  assert.ok(mathS < engS, `难科初始 S 应更低：数学 ${mathS} vs 英语 ${engS}`);
});

test('前测难度归一化：字符串与数字同义（此前数字 2 被当成 0）', () => {
  assert.equal(difficultyToNum('basic'), 0);
  assert.equal(difficultyToNum('applied'), 1);
  assert.equal(difficultyToNum('challenge'), 2);
  assert.equal(difficultyToNum(0), 0);
  assert.equal(difficultyToNum(1), 1);
  assert.equal(difficultyToNum(2), 2, '数字 2 必须映射到 challenge');
  assert.equal(difficultyToNum('2'), 2);
  assert.equal(difficultyToNum(undefined), 0);
  assert.equal(difficultyToNum('乱七八糟'), 0);
  // challenge 的 S 必须低于 basic
  const d0 = estimateInitialStability({ familiarity: 3, subject: '线性代数', difficulty: 'basic' });
  const d2 = estimateInitialStability({ familiarity: 3, subject: '线性代数', difficulty: 'challenge' });
  assert.ok(d2 < d0, `challenge 的初始 S 应更低：${d2} vs ${d0}`);
});

// ---------- 图谱端点 ----------

test('looksLikeRawId：普通英文卡面不再被误判为裸 ID', () => {
  // ⚠️ 历史缺陷：正则等价于「≥15 位纯 ASCII 字母数字串」，
  //   `computerNetworkArchitecture` 这类英文卡面会被判成裸 ID → 边被过滤 → 节点从图谱消失。
  for (const ok of ['computerNetworkArchitecture', 'OperatingSystemBasics', 'DataStructureAndAlgorithm']) {
    assert.equal(looksLikeRawId(ok), false, `${ok} 是人类可读文本，不该判成裸 ID`);
  }
  // 真 UUID / 旧 uid 仍要抓到
  assert.equal(looksLikeRawId('3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071'), true, 'UUID 必须识别');
  assert.equal(looksLikeRawId('mt8j0q35qzd4wkyf'), true, '旧版 uid 必须识别');
  assert.equal(looksLikeRawId(''), false);
  assert.equal(looksLikeRawId('什么是死锁'), false, '中文文本不判裸 ID');
});

// ---------- 森林展开 ----------

// edgesToForest 返回 { root, virtual }：单根时 root 即全树，多根时包一层虚拟根
function nodeNames(forest) {
  const out = [];
  const walk = (n) => { out.push(n.name); (n.children || []).forEach(walk); };
  if (forest?.root) walk(forest.root);
  return out;
}
const VIRTUAL = '📚 知识图谱';

test('edgesToForest：纯环不产生节点重复（此前 n 个节点产出 n 棵 n 深子树）', () => {
  const cycle = [
    { from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'C', to: 'A' },
  ];
  const names = nodeNames(edgesToForest(cycle, { virtualKey: '__vr__' })).filter(n => n !== VIRTUAL);
  assert.equal(names.length, 3, `环的 3 个节点各出现一次，实际 ${names.join(',')}`);
  assert.equal(new Set(names).size, 3, '不应有重复节点');
  assert.deepEqual([...names].sort(), ['A', 'B', 'C'], '三个节点都不能丢');
});

test('edgesToForest：稠密 DAG 不指数爆炸（每个节点最多出现一次）', () => {
  // 6 层 × 4 宽的稠密 DAG：旧实现会按路径数重建，展开量是指数级
  const edges = [];
  for (let layer = 0; layer < 5; layer++) {
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) {
        edges.push({ from: `L${layer}-${a}`, to: `L${layer + 1}-${b}` });
      }
    }
  }
  const t0 = Date.now();
  const forest = edgesToForest(edges, { virtualKey: '__vr__' });
  const ms = Date.now() - t0;
  const names = nodeNames(forest).filter(n => n !== VIRTUAL);
  assert.equal(names.length, 24, `24 个节点各出现一次，实际 ${names.length}`);
  assert.equal(new Set(names).size, 24, '无重复节点');
  assert.ok(ms < 1000, `展开必须在 1s 内完成，实际 ${ms}ms`);
});

test('edgesToForest：空输入与自环不崩溃', () => {
  assert.doesNotThrow(() => edgesToForest([]));
  assert.doesNotThrow(() => edgesToForest(null));
  const f = edgesToForest([{ from: 'A', to: 'A' }], { virtualKey: '__vr__' });
  assert.ok(f, '自环输入也要返回结果');
});
