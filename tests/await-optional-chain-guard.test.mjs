// tests/await-optional-chain-guard.test.mjs
// 「看不见的 bug」静态守卫：`await foo()?.bar` 的运算符优先级陷阱。
//
// `await` 是单目运算符，优先级**低于**成员访问。所以：
//     await db.tombstones.get(id)?.kind
//   实际解析为
//     await (db.tombstones.get(id)?.kind)   // 对 Promise 取 .kind → 恒为 undefined
// 而不是直觉以为的
//     (await db.tombstones.get(id))?.kind
//
// 后果极其隐蔽：断言/分支永远拿到 undefined，编译器不报错、linter 也不报，
// 而且写法看起来完全「正常」。本项目在回收站测试里踩过一次（2026-08-30）。
// 正确写法必须加括号：`(await db.tombstones.get(id))?.kind`。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src', 'sync-hub', 'tests'];
// 本文件自己的标题/注释里就有反例字符串，扫描时跳过自身
const SELF = fileURLToPath(import.meta.url);

// await + 一次函数调用 + 直接跟 ?. （即没有用括号把 await 表达式包起来）
// 匹配：await db.x.get(id)?.y   /   await foo(a, b)?.y
// 不匹配：(await db.x.get(id))?.y  —— 因为 ')' 插在中间
const TRAP = /await\s+[A-Za-z_$][\w.$]*\s*\([^()]*\)\s*\?\./;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      walk(p, out);
    } else if (['.js', '.mjs', '.vue'].includes(extname(p))) {
      out.push(p);
    }
  }
  return out;
}

test('全项目：禁止 await foo()?.bar（必须写成 (await foo())?.bar）', () => {
  const bad = [];
  for (const d of SCAN_DIRS) {
    const dir = join(ROOT, d);
    let files = [];
    try { files = walk(dir); } catch { continue; }
    for (const f of files) {
      if (f === SELF) continue;
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return; // 注释里的示例不算
        if (TRAP.test(line)) bad.push(`${f.replace(ROOT, '')}:${i + 1}  ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(bad, [], `发现 await 与可选链的优先级陷阱（改成 (await x)?.y）：\n${bad.join('\n')}`);
});

test('扫描覆盖面自检：确实扫到了 src 与 tests', () => {
  let n = 0;
  for (const d of SCAN_DIRS) {
    try { n += walk(join(ROOT, d)).length; } catch { /* 目录不存在则跳过 */ }
  }
  assert.ok(n > 100, `扫描到的文件数应 >100，实际 ${n}`);
});
