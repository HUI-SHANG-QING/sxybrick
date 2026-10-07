// tests/gate-selftest.test.mjs —— 门禁**自检**闸门（round143）
//
// 起因：连续两轮都在门禁工具上翻车 ——
//   · round142：统计脚本漏了 `export { … }` 形态 ⇒ 下了「门面多导出 4 个符号」的**错误结论**，
//     并写进了提交信息与记忆，几乎酿成事故（那 4 个符号正被 Review.vue / Cards.vue 使用）。
//   · round142：dep-check 完全看不见 `import()`（全仓 101 处动态加载全在盲区）。
//   · round143：i18n 闸的「写法变形盲区」经实测**恰好不覆盖任何真实缺陷**，
//     但当时我并不知道，只是凭印象记成了「需要修」。
//
// 三次的共同根因：**把「门禁通过」当成了「事实完整」，却没问「这门禁查不到什么」。**
// 本文件把这句话变成可执行的断言。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve('.');
const NODE = process.execPath;
const run = (args) => execFileSync(NODE, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

test('① dep-check 能抓到纯静态循环（含负向对照自证）', () => {
  // round144（审计）：探针从「改真实源码」改为「临时文件」——原实现把 import 注入
  //   shared.js，若测试进程被强杀（OOM/磁盘/超时），finally 恢复不执行 ⇒ 源码被污染，
  //   build/全量测试当场红（2026-10-07 实测发生：shared.js 残留坏语法探针）。
  //   临时文件方案：进程被强杀最多残留 __probe_*.js（git status 可见、可清理），
  //   不碰任何真实源码。
  const a = path.join(ROOT, 'src/repo/__probe_a.js');
  const b = path.join(ROOT, 'src/repo/__probe_b.js');
  try {
    fs.writeFileSync(a, "import { probe } from './__probe_b.js';\nexport const probe = 1;\n", 'utf8');
    fs.writeFileSync(b, "import { probe } from './__probe_a.js';\nexport const probe = 2;\n", 'utf8');
    let failed = false, msg = '';
    try { run(['scripts/dep-check.mjs']); } catch (e) {
      failed = true; msg = (e.stdout || '') + (e.stderr || '');
    }
    assert.ok(failed, 'dep-check 必须以非 0 退出码拦住纯静态循环');
    assert.match(msg, /纯静态/, '报错须明确指出是「纯静态」环');
    assert.match(msg, /__probe/, '报错须指出涉事文件');
  } finally {
    try { fs.rmSync(a); } catch {}
    try { fs.rmSync(b); } catch {}
  }
});

test('② dep-check 当前真实状态：0 纯静态环（含懒加载边的环允许存在）', () => {
  const out = run(['scripts/dep-check.mjs']);
  assert.match(out, /0 纯静态循环/, `当前应 0 纯静态环，实际输出：${out.slice(0, 200)}`);
});

test('③ i18n 闸能抓到不存在的 key（负向对照自证）', () => {
  // round144：同样改为临时文件——不碰 Cards.vue 本体。在 src/views 放一个 __probe
  //   副本（把其中一个 t() key 换成假 key），i18n 闸按目录扫描会命中并报缺失。
  //   进程被强杀最多残留副本，git status 可见、可清理，不污染任何真实视图。
  const f = 'src/views/__probe-cards.vue';
  const src = fs.readFileSync(path.join(ROOT, 'src/views/Cards.vue'), 'utf8');
  try {
    fs.writeFileSync(path.join(ROOT, f),
      src.replace("t('views.cards.title')", "t('views.cards.__GATE_PROBE_MISSING__')"), 'utf8');
    let failed = false, msg = '';
    try { run(['scripts/check-view-i18n.mjs', '--strict']); } catch (e) {
      failed = true; msg = (e.stdout || '') + (e.stderr || '');
    }
    assert.ok(failed, 'i18n 闸必须以非 0 退出码抓到不存在的 key');
    assert.match(msg, /__GATE_PROBE_MISSING__/, '报错须指出缺失的 key');
  } finally {
    try { fs.rmSync(path.join(ROOT, f)); } catch {}
  }
});

test('④ 门禁脚本自身须语法正确（它们不在 eslint 的常规扫描里）', () => {
  const dir = path.join(ROOT, 'scripts');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length >= 8, `门禁脚本数量异常：${files.length}`);
  for (const f of files) {
    // node --check 是语法级校验，不执行
    try {
      execFileSync(NODE, ['--check', path.join(dir, f)], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      assert.fail(`scripts/${f} 语法错误：${(e.stderr || '').toString().slice(0, 200)}`);
    }
  }
});

test('⑤ 防御链分工确认：语法错误由 eslint 兜住（门禁不重复承担）', () => {
  // round144：探针从「改 shared.js + 全量 eslint .」改为「临时文件 + 指定路径 eslint」——
  //   原实现注入坏语法到 shared.js 后跑全量 eslint，进程被强杀同样会污染源码。
  //   现在只 lint 一个临时坏文件，eslint 指定路径即可，不扫全项目、不碰真实源码。
  const f = path.join(ROOT, 'src/__probe-bad.js');
  try {
    fs.writeFileSync(f, 'const __probe = {{{;\n', 'utf8');
    let eslintFailed = false;
    try {
      execFileSync(NODE, ['node_modules/eslint/bin/eslint.js', 'src/__probe-bad.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { eslintFailed = true; }
    assert.ok(eslintFailed, 'eslint 必须拦下语法错误（这是防御链的最后一环）');
  } finally {
    try { fs.rmSync(f); } catch {}
  }
});

test('⑥ 全部门禁此刻应为「通过」状态（本文件不改变任何门禁结论）', () => {
  const out = run(['scripts/dep-check.mjs']);
  assert.match(out, /✓|通过/);
  const i18n = run(['scripts/check-view-i18n.mjs', '--strict']);
  assert.match(i18n, /✓|通过/);
});