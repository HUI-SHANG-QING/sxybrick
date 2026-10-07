// tests/repo-shared-constants.test.mjs —— 数据层共享常量/纯函数的单一来源门禁（round142）
//
// 背景：拆分成 cards/plans/meta 三块时，有 6 个「原本是 repo.js 顶层、被多域共用」的
//   常量/纯函数（MAX_ESTIMATED_MINUTES / now / plain / localDateStr / TOMB_KIND_TABLE /
//   fireHook）被**各复制了一份**。复制本身安全（值相同、无状态），但埋了维护隐患：
//   改一处漏另一处 ⇒ 两侧行为漂移且**不会有任何报错**。
//   已收拢到 src/repo/shared.js，本测试锁住「三块都从 shared 取、不再有本地副本」。
//
// ⚠️ 本文件在 round142 首次加入时就抓到了自己的盲区：把 MAX_ESTIMATED_MINUTES 改成
//   999999 后全量测试**仍然全过**（1611/1611）—— 说明此前**没有任何测试断言这个上限**。
//   故本测试显式补上该断言。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  MAX_ESTIMATED_MINUTES, now, plain, localDateStr, TOMB_KIND_TABLE, fireHook,
} from '../src/repo/shared.js';
import * as repoFacade from '../src/repo.js';

const SRC = path.resolve('src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('① shared.js 是这些量的唯一声明处（三块不得再有本地副本）', () => {
  for (const f of ['repo/cards.js', 'repo/plans.js', 'repo/meta.js']) {
    const src = read(f);
    for (const name of ['MAX_ESTIMATED_MINUTES', 'localDateStr', 'TOMB_KIND_TABLE',
                        'plain', 'now', 'fireHook']) {
      assert.doesNotMatch(src, new RegExp(`^(?:const|let|function)\\s+${name}\\b`, 'm'),
        `${f} 仍有本地定义 ${name} —— 应一律从 ./shared.js 导入（副本会导致改一处漏一处）`);
    }
  }
});

test('② 共享常量的取值符合业务约定（round142 补：此前无任何测试断言 MAX_ESTIMATED_MINUTES）', () => {
  // 计划/任务的预计分钟上限 = 1 天。与 plan-parser 的 clamp 同值（两处独立实现，
  // 任一处被改都应先想到另一处 —— 断言把它们钉在一起）。
  assert.equal(MAX_ESTIMATED_MINUTES, 1440, '单次任务预计分钟上限应为 1440（1 天）');
  assert.equal(typeof now(), 'number', 'now() 必须返回时间戳');
  assert.deepEqual(plain({ a: 1, b: { c: 2 } }), { a: 1, b: { c: 2 } }, 'plain 必须是深拷贝');
  assert.equal(typeof localDateStr(Date.now()), 'string', 'localDateStr 必须返回字符串');
  assert.ok(TOMB_KIND_TABLE && typeof TOMB_KIND_TABLE === 'object', 'TOMB_KIND_TABLE 必须是对象');
  assert.equal(typeof fireHook, 'function');
});

test('③ fireHook 是 fire-and-forget：不能因钩子抛错而中断业务流程', () => {
  // 原实现：triggerHook(...).catch(() => {})。传一个必然 reject 的事件也不应抛出。
  assert.doesNotThrow(() => fireHook('__audit_nonexistent_hook__', 1, 2, 3));
});

test('④ shared.js 不依赖 cards.js（避免 cards → shared → cards 成环）', () => {
  const src = read('repo/shared.js');
  assert.doesNotMatch(src, /from\s+'\.\/cards\.js'/, 'shared.js 绝不能 import cards.js');
});

test('⑤ 对外 API 不泄漏 shared 内部量（它们原本都是 repo.js 模块私有）', () => {
  for (const name of ['MAX_ESTIMATED_MINUTES', 'localDateStr', 'TOMB_KIND_TABLE', 'plain', 'now', 'fireHook']) {
    assert.ok(!(name in repoFacade),
      `${name} 泄漏到对外门面 —— 它原本是 repo.js 的模块私有，收拢后也不该出现在 ./repo.js 的导出里`);
  }
  // 而原本就是 export 的 TRASH_TTL_DAYS 必须仍在（RecycleBin.vue 依赖）
  assert.equal(repoFacade.TRASH_TTL_DAYS, 30, 'TRASH_TTL_DAYS 是原本就 export 的，必须仍可用');
});