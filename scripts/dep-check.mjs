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

// ---------- 解析 import（静态 + 动态） ----------
// .vue 只取 <script> 块内的 import；.js 直接扫
// 返回 { all, dynamic }：dynamic 是**仅通过动态 import() 到达**的依赖，
//   供报告阶段区分「纯静态环」与「含懒加载边的环」。
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
  // round142：把**动态 import()** 也纳入依赖图。
  //   旧版注释断言「动态 import() 不入图（运行时按需加载，不产生循环）」—— **该假设是错的**：
  //   实测注入一个真实动态环（meta.js 动态 import cards.js，而 cards.js 静态引入…）后，
  //   dep-check 依旧报「0 循环依赖」。动态 import 同样走 ESM 装载图，成环时一样触发
  //   TDZ（Cannot access 'X' before initialization），且 Vite 打包提升后才会暴露。
  //   ⚠️ 排除注释行（避免把「// await import(...)」的示例文案当成真依赖）。
  const code = script
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  const dyn = [];
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push(m[1]);
    dyn.push(m[1]);
  }
  return { all: out, dynamic: dyn };
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
// round142：记录**仅通过动态 import() 到达**的边（resolved 之后），用于给环分类
const dynamicDeps = new Map();

for (const r of rels) {
  const { all, dynamic } = extractImports(absOf.get(r), r);
  for (const spec of all) {
    const target = resolveSpec(absOf.get(r), spec);
    if (target) {
      graph.get(r).push(target);
      if (dynamic.includes(spec)) {
        if (!dynamicDeps.has(r)) dynamicDeps.set(r, []);
        dynamicDeps.get(r).push(target);
      }
    } else if (spec.startsWith('.')) unresolved.add(`${r} → ${spec}`);
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

// ---------- 分类：纯静态环 vs 含懒加载边的环 ----------
// round142：动态 import() 同样会成环（它也走 ESM 装载图），但**动态 import 往往正是作者
//   主动用来打断静态环的手段**（本项目就有两处，注释里写明理由，见 ai.js:22 与
//   utils/parsers.js 的 loadParser）。所以两类环的性质完全不同：
//     · 纯静态环        = 没人打断 ⇒ **构建期必炸（TDZ）**，必须为 0，exit 1。
//     · 含懒加载边的环  = 作者刻意打断 ⇒ 运行期安全，但**列出备案**供复核。
//   旧版把动态 import 完全排除在图外 ⇒ 两类都查不到（实测注入真实动态环仍报「0 循环依赖」）。
const dynEdges = new Set();
for (const [from, tos] of dynamicDeps) for (const to of tos) dynEdges.add(`${from}\u0000${to}`);

function hasDynamicEdge(cycle) {
  for (let i = 0; i + 1 < cycle.length; i++) {
    if (dynEdges.has(`${cycle[i]}\u0000${cycle[i + 1]}`)) return true;
  }
  return false;
}
const staticCycles = cycles.filter((c) => !hasDynamicEdge(c));
const lazyCycles = cycles.filter(hasDynamicEdge);

// ---------- 报告 ----------
if (unresolved.size) {
  console.warn(`⚠ ${unresolved.size} 个相对 import 未解析（可能是运行时拼接的动态路径，人工确认）：`);
  for (const u of [...unresolved].slice(0, 10)) console.warn(`   ${u}`);
}
if (staticCycles.length) {
  console.error(`✗ 发现 ${staticCycles.length} 个**纯静态**循环依赖（TDZ 风险，打包提升后必然运行时崩溃）：`);
  for (const c of staticCycles) console.error(`   ${c.join(' → ')}`);
  process.exit(1);
}
if (lazyCycles.length) {
  console.warn(`⚠ ${lazyCycles.length} 个循环含**动态 import 边**（多半是刻意打断静态环；运行期安全，列出备查）：`);
  for (const c of lazyCycles) console.warn(`   ${c.join(' → ')}`);
}
console.log(`✓ 依赖检查通过：${rels.length} 个源文件，0 纯静态循环（另有 ${lazyCycles.length} 个含懒加载边的环已备案）`);
