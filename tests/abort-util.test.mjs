// tests/abort-util.test.mjs —— round82：跨浏览器中止信号助手（修 round78 P2-1）
//
// 背景：项目声明构建目标 es2020（≈ chrome87 / safari14），但代码里散落 9 处
// `AbortSignal.timeout()` / `AbortSignal.any()`——这两个 API 都是 **Safari 16+** 才有。
// vite 只转译语法、不 polyfill 运行时 API，于是旧 Safari（iOS 15 机型）上同步 / AI 对话 /
// 图片分析 / 资料解析**整条失效**，还被 sync.js 的 catch 误报成"连不上中枢、防火墙没放行"。
// 本文件既测助手行为，也用**结构性闸门**禁止再出现裸调（含注释剥离，避免被解释性注释误报）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { timeoutSignal, anySignal } from '../src/utils/abort.js';
import { deepClone } from '../src/utils/clone.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('timeoutSignal：到点即中止，且 reason.name 为 TimeoutError（消费方按此判定）', async () => {
  const s = timeoutSignal(20);
  assert.equal(s.aborted, false);
  await sleep(60);
  assert.equal(s.aborted, true);
  assert.equal(s.reason?.name, 'TimeoutError');
});

test('timeoutSignal：**删掉原生 API 也必须可用**（旧 Safari 的核心回归）', async () => {
  const nativeTimeout = AbortSignal.timeout;
  const nativeAny = AbortSignal.any;
  try {
    // 模拟 Safari 15：两个 API 都不存在
    AbortSignal.timeout = undefined;
    AbortSignal.any = undefined;
    const s = timeoutSignal(20);
    assert.ok(s, '没有原生 API 时也必须返回一个 signal（旧实现直接抛 TypeError）');
    await sleep(60);
    assert.equal(s.aborted, true);
    assert.equal(s.reason?.name, 'TimeoutError', '兜底路径也要保持 TimeoutError 语义');

    // 同理：anySignal 在无原生 any 时也要能把多个信号合起来
    const ctrl = new AbortController();
    const merged = anySignal([s, ctrl.signal]);
    assert.equal(merged.aborted, true, '已中止的输入应让合并信号立即中止');
    const ctrl2 = new AbortController();
    const merged2 = anySignal([timeoutSignal(10_000), ctrl2.signal]);
    assert.equal(merged2.aborted, false);
    ctrl2.abort();
    assert.equal(merged2.aborted, true, '任一输入中止 → 合并信号中止');
  } finally {
    AbortSignal.timeout = nativeTimeout;
    AbortSignal.any = nativeAny;
  }
});

test('anySignal：透传中止原因 / 单个信号直返 / 空输入返回 undefined', () => {
  const a = new AbortController();
  const merged = anySignal([a.signal, new AbortController().signal]);
  const err = new Error('boom');
  err.name = 'TimeoutError';
  a.abort(err);
  assert.equal(merged.aborted, true);
  assert.equal(merged.reason?.name, 'TimeoutError', '中止原因必须透传（否则消费方判不出超时）');

  const only = new AbortController();
  assert.equal(anySignal([only.signal]), only.signal, '只有一个信号时应直返，避免多余包装');
  assert.equal(anySignal([]), undefined);
  assert.equal(anySignal([null, undefined]), undefined);
});

test('闸门：全仓禁止裸调 Safari 16+ 才有的运行时 API（AbortSignal.timeout/any、structuredClone）', () => {
  const SRC = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const files = [];
  (function walk(dir) {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|vue)$/.test(n)) files.push(p);
    }
  }(SRC));

  // 兼容 API 白名单：只允许在实现它们的助手内部出现
  const HELPER_FILES = [join('utils', 'abort.js'), join('utils', 'clone.js')];
  const BARE = [
    { name: 'AbortSignal.timeout / AbortSignal.any', re: /AbortSignal\s*\.\s*(timeout|any)\s*\(/ },
    { name: 'structuredClone', re: /(^|[^.\w])structuredClone\s*\(/ },
  ];

  const offenders = [];
  for (const f of files) {
    if (HELPER_FILES.some((h) => f.endsWith(h))) continue;
    // 必须剥注释再扫：解释性注释里写 API 名是正常的（本项目已吃过一次误报）
    const code = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((l) => l.replace(/(^|[^:'"`])\/\/[^\n]*/, '$1'))
      .join('\n');
    for (const { name, re } of BARE) {
      if (re.test(code)) offenders.push(f.replace(SRC, 'src').replace(/\\/g, '/') + ' → ' + name);
    }
  }
  assert.deepEqual(
    offenders, [],
    '这些文件裸调了 Safari 16+ 才有的 API：' + offenders.join('、')
      + '。请改用 src/utils/abort.js 的 timeoutSignal()/anySignal()，或 src/utils/clone.js 的 deepClone()。',
  );
});

test('deepClone：删掉原生 structuredClone 也要能深拷贝（旧 Safari 的插件路径不崩）', () => {
  const src = { a: 1, b: { c: [1, 2, 3] }, d: 'x' };
  const native = globalThis.structuredClone;
  try {
    // 新浏览器路径
    const c1 = deepClone(src);
    assert.notEqual(c1, src);
    assert.notEqual(c1.b, src.b, '必须是深拷贝');
    assert.deepEqual(c1, src);

    // 模拟 Safari 15.3：没有 structuredClone
    delete globalThis.structuredClone;
    const c2 = deepClone(src);
    assert.deepEqual(c2, src, '兜底路径也要给出等值副本');
    assert.notEqual(c2.b, src.b);
    assert.equal(deepClone(undefined), null, 'undefined 不得抛错（JSON.stringify(undefined) 会返回 undefined）');
    assert.equal(deepClone(null), null);
  } finally {
    globalThis.structuredClone = native;
  }
});
