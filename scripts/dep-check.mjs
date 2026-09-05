// scripts/dep-check.mjs
// 循环依赖构建期检查（round37 E1）：
// 背景：round35 的 TDZ 事故（offlineAI↔genDeck 大环）在 `node --test` 下全绿、
//   只有 Vite 打包提升后才在运行时崩——因为 node ESM 按 import 图顺序求值，
//   打包器 chunk 合并/提升会改变初始化顺序，大环里的 const/let 读到未初始化
//   binding 就抛 "Cannot access before initialization"。
// 本脚本把这类问题左移到提交前：解析 src/**/*.{js,vue} 的静态 import 图，
//   DFS 找环，报出环路径。动态 import() 不入图（运行时按需加载，不产生
//   打包期初始化顺序问题）。
// 用法：node scripts/dep-check.mjs
//   零环 → exit 0；有环 → 打印每条环路径 → exit 1
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(root, 'src');

// ---------- 收集源文件 ----------
const files = [];
(function walk(p) {
  for (const f of readdirSync(p)) {
    const abs = join(p, f);
    const st = statSync(abs);
    if (st.isDirectory()) { walk(abs); continue; }
    if (/\.(js|mjs|vue)$/.test(f)) files.push(abs);
  }
})(SRC);

// ---------- 解析 import（静态） ----------
// .vue 只取 <script> 块内的 import；.js 直接扫
function extractImports(abs, rel) {
  const src = readFileSync(abs, 'utf8');
  const script = rel.endsWith('.vue')
    ? (src.match(/<script[^>]*>([\s\S]*?)<\/script>/) || [])[1] || ''
    : src;
  const out = [];
  for (const m of script.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
    out.push(m[1]);
  }
  for (const m of script.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    out.push(m[1]); // 副作用 import
  }
  return out;
}

// 相对 specifier → 解析到文件（尝试 .js / .mjs / .vue / /index.js）
function resolveSpec(fromAbs, spec) {
  if (!spec.startsWith('.')) return null; // 裸模块（vue/echarts）不在图内
  spec = spec.split('?')[0]; // Vite 后缀（?raw 等）不入路径
  const dir = fromAbs.replace(/[^/\\]*$/, ''); // 去掉文件名，保留目录
  const cands = [
    dir + spec,
    dir + spec + '.js',
    dir + spec + '.mjs',
    dir + spec + '.vue',
    dir + spec.replace(/^\.\//, '') + '/index.js',
  ];
  for (const c of cands) {
    try {
      const st = statSync(c);
      if (st.isFile()) return relative(root, c).split(/[\\/]/).join('/');
    } catch { /* try next */ }
  }
  return null;
}

// ---------- 建图 + DFS 找环 ----------
const rels = files.map(f => relative(root, f).split(/[\\/]/).join('/'));
const absOf = new Map(rels.map(r => [r, join(root, r)]));
const graph = new Map(rels.map(r => [r, []]));
const unresolved = new Set();

for (const r of rels) {
  for (const spec of extractImports(absOf.get(r), r)) {
    const target = resolveSpec(absOf.get(r), spec);
    if (target) graph.get(r).push(target);
    else if (spec.startsWith('.')) unresolved.add(`${r} → ${spec}`);
  }
}

const WHITE = 0, GRAY = 1, BLACK = 2;
const color = new Map(rels.map(r => [r, WHITE]));
const cycles = [];
const stack = [];

function dfs(u) {
  color.set(u, GRAY);
  stack.push(u);
  for (const v of graph.get(u)) {
    if (!color.has(v)) continue;
    if (color.get(v) === GRAY) {
      // 找到环：从 v 在 stack 中的位置截出
      const i = stack.lastIndexOf(v);
      cycles.push([...stack.slice(i), v]);
    } else if (color.get(v) === WHITE) {
      dfs(v);
    }
  }
  stack.pop();
  color.set(u, BLACK);
}
for (const r of rels) if (color.get(r) === WHITE) dfs(r);

// ---------- 报告 ----------
if (unresolved.size) {
  console.warn(`⚠ ${unresolved.size} 个相对 import 未解析（可能是运行时拼接的动态路径，人工确认）：`);
  for (const u of [...unresolved].slice(0, 10)) console.warn(`   ${u}`);
}
if (cycles.length) {
  console.error(`✗ 发现 ${cycles.length} 个循环依赖（TDZ 风险，打包提升后可能运行时崩溃）：`);
  for (const c of cycles) console.error(`   ${c.join(' → ')}`);
  process.exit(1);
}
console.log(`✓ 依赖检查通过：${rels.length} 个源文件，0 循环依赖`);
