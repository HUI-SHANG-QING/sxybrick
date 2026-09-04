// BUG-06 回归：LLM 分解产物做 schema 校验，丢弃缺字段/类型不符的步骤。
// 直接测 pipeline-core.js（纯逻辑，无 LLM/IO 依赖），避免 pipeline.js 的循环依赖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDecomposedSteps, parseDecomposedOutput } from '../src/agent/pipeline-core.js';

test('normalizeDecomposedSteps：过滤缺字段/畸形项并 trim', () => {
  const raw = [
    { agent: 'tutor', instruction: '  讲解线性代数  ' },
    { agent: 'analyst' }, // 缺 instruction
    { instruction: '只有指令' }, // 缺 agent
    'oops', // 非对象
    null,
    { agent: 123, instruction: '数字 agent' }, // agent 非字符串
    { agent: 'cardsmith', instruction: '   ' }, // instruction 空白
    { agent: 'planner', instruction: '排计划' },
  ];
  const out = normalizeDecomposedSteps(raw, 4);
  assert.deepEqual(out, [
    { agent: 'tutor', instruction: '讲解线性代数' },
    { agent: 'planner', instruction: '排计划' },
  ]);
});

test('normalizeDecomposedSteps：超上限截断到 limit', () => {
  const raw = Array.from({ length: 6 }, (_, i) => ({ agent: `a${i}`, instruction: `i${i}` }));
  assert.equal(normalizeDecomposedSteps(raw, 4).length, 4);
});

test('normalizeDecomposedSteps：非数组返回空', () => {
  assert.deepEqual(normalizeDecomposedSteps('not-array'), []);
  assert.deepEqual(normalizeDecomposedSteps(null), []);
});

test('parseDecomposedOutput：带 markdown 代码块，过滤畸形项后仅保留合法步骤', () => {
  const out = '```json\n[{"agent":"tutor","instruction":"讲解"},{"agent":"ghost"},{"agent":"planner","instruction":"排计划"}]\n```';
  assert.deepEqual(parseDecomposedOutput(out, 4), [
    { agent: 'tutor', instruction: '讲解' },
    { agent: 'planner', instruction: '排计划' },
  ]);
});

test('parseDecomposedOutput：非 JSON 文本回退 null', () => {
  assert.equal(parseDecomposedOutput('抱歉我无法分解这个任务'), null);
});

test('parseDecomposedOutput：全是无效步骤时返回 null（不产出空流水线）', () => {
  assert.equal(parseDecomposedOutput('[{"foo":"bar"}]'), null);
});

test('parseDecomposedOutput：无代码块的纯 JSON 也能解析', () => {
  assert.deepEqual(parseDecomposedOutput('[{"agent":"tutor","instruction":"讲解"}]'), [
    { agent: 'tutor', instruction: '讲解' },
  ]);
});
