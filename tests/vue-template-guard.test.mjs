// 模板渲染护栏：守住两类「编译不报错、运行时整页崩」的坑
//
// 坑 1：v-for 与 v-if 写在同一元素上。
//   Vue 3 里 v-if 优先级更高，条件先求值，此时 v-for 的变量还没定义，
//   编译产物是 `_ctx.m.items.length`（去实例上找 m）→ 渲染时 TypeError → 白屏。
//   搜索页 /search 就是被这一行搞崩的。
//
// 坑 2：源文件里混入 NUL 字节。人工/脚本编辑都可能引入，
//   会被工具链当成二进制文件，排查成本极高。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'vue/compiler-sfc';

const SRC = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith('.vue')) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const TAG = /<(\w+[\w-]*)((?:\s+[^<>]*?)?)\/?>/g;

test('全部 .vue 模板：不得出现 v-for 与 v-if 同元素', () => {
  const bad = [];
  for (const f of files) {
    let d;
    try { d = parse(readFileSync(f, 'utf8'), { filename: f }).descriptor; } catch { continue; }
    const t = d.template?.content;
    if (!t) continue;
    let m;
    TAG.lastIndex = 0;
    while ((m = TAG.exec(t))) {
      const a = m[2] || '';
      if (/\bv-for\s*=/.test(a) && /\bv-(if|else-if)\s*=/.test(a)) {
        const line = t.slice(0, m.index).split('\n').length;
        bad.push(`${relative(SRC, f)}:${line} <${m[1]} ${a.trim().slice(0, 100)}>`);
      }
    }
  }
  assert.deepEqual(bad, [], `以下位置 v-if 会先于 v-for 求值，运行时必然崩页：\n${bad.join('\n')}`);
});

test('全部 .vue/.js 源文件：不得含 NUL 字节', () => {
  const bad = [];
  const scan = (dir) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) { scan(p); continue; }
      if (!/\.(vue|js|css|json|html)$/.test(n)) continue;
      if (readFileSync(p).includes(0)) bad.push(relative(SRC, p));
    }
  };
  scan(SRC);
  assert.deepEqual(bad, [], `这些文件混入了 NUL 字节：${bad.join(', ')}`);
});

test('扫描覆盖面自检：确实扫到了视图目录', () => {
  assert.ok(files.length > 40, `只扫到 ${files.length} 个 .vue，路径可能不对`);
  assert.ok(files.some(f => f.endsWith('Search.vue')));
});
