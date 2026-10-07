// tests/resource-lifecycle.test.mjs —— 资源生命周期门禁（round145）
//
// 背景：长跑型本地应用（PWA，用户一开就是几小时）最典型的隐形缺陷是
//   **定时器 / 事件监听器泄漏** —— 反复进出会累积，定时器还在跑。
//   这类问题**不报错、不崩溃、测试全绿**，只表现为"用久了越来越卡 / 电量掉得快"。
//
// 本门禁按「组件内定时器必须有清理」这一条**可机械判定**的规则扫：
//   · 组件（.vue）里 new 出的 setInterval ⇒ 必须在 onUnmounted/onBeforeUnmount 里 clearInterval
//   · 组件里 addEventListener ⇒ 必须有对应的 removeEventListener（或 `{ once: true }` 自动移除）
//   · 模块级（.js 工具）里的单例定时器 ⇒ **不在本门禁范围**（应用生命周期内只跑一次，属设计）
//
// ⚠️ 已知的**刻意豁免**（round145 逐一核实过的真实文件）：
//   · Pomodoro.vue —— grep 命中 5 处 setInterval，实为 1 个真定时器 + 4 处注释；已在 onBeforeUnmount 清理
//   · perf.js / pwa.js / telemetry.js —— 模块级单例，非组件，不适用
//   · llm.js:89 —— addEventListener 带 `{ once: true }`，浏览器自动移除
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');

/** 只取 .vue 的 <script> 块，并剥掉注释行（否则注释里的代码会被当成真代码） */
function scriptOf(file) {
  const raw = readFileSync(file, 'utf8');
  const m = raw.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return '';
  return m[1].split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

function vueFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') vueFiles(p, out); }
    else if (e.name.endsWith('.vue')) out.push(p);
  }
  return out;
}

test('组件里的定时器必须有清理（onUnmounted / onBeforeUnmount 中 clearInterval）', () => {
  const bad = [];
  for (const f of vueFiles(SRC)) {
    const s = scriptOf(f);
    const hasTimer = /setInterval\s*\(/.test(s);
    if (!hasTimer) continue;
    const hasClear = /clearInterval\s*\(/.test(s);
    const hasHook = /onUnmounted|onBeforeUnmount/.test(s);
    if (!hasClear || !hasHook) {
      bad.push(`${f.replace(process.cwd() + '\\', '')}: setInterval=${hasTimer} clearInterval=${hasClear} 卸载钩子=${hasHook}`);
    }
  }
  assert.deepEqual(bad, [],
    `以下组件创建了定时器但缺少清理（长跑应用会累积泄漏）：\n${bad.join('\n')}`);
});

test('组件里成对的 addEventListener / removeEventListener 数量匹配', () => {
  const bad = [];
  for (const f of vueFiles(SRC)) {
    const s = scriptOf(f);
    const adds = (s.match(/addEventListener\s*\(/g) || []).length;
    if (!adds) continue;
    const removes = (s.match(/removeEventListener\s*\(/g) || []).length;
    const once = (s.match(/addEventListener\s*\([^)]*\{\s*once\s*:\s*true/g) || []).length;
    if (removes + once < adds) {
      bad.push(`${f.replace(process.cwd() + '\\', '')}: add=${adds} remove=${removes} once=${once}`);
    }
  }
  assert.deepEqual(bad, [],
    `以下组件添加了监听但清理次数不足（含 once 自动移除）：\n${bad.join('\n')}`);
});

test('门禁对「模块级单例定时器」不误报（.js 文件不在扫描范围）', () => {
  // 这三个文件确有 setInterval，但都是模块级单例（应用生命周期内只跑一次）
  const jsFiles = ['utils/perf.js', 'utils/pwa.js', 'utils/telemetry.js']
    .map((f) => join(SRC, f))
    .filter((f) => existsSync(f));
  assert.ok(jsFiles.length === 3, '这三个文件应存在（若被重命名，本用例提醒更新豁免名单）');
  for (const f of jsFiles) {
    const s = readFileSync(f, 'utf8');
    assert.match(s, /setInterval\s*\(/, `${f} 预期确有模块级 setInterval（豁免前提）`);
  }
});