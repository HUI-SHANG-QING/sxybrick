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

// ---------- 坑 3：v-for 变量遮蔽模板中被调用的函数名（典型：i18n 的 t） ----------
//
// 现象（2026-09-13 用户实测「每日规划」整页崩）：
//   <span v-for="t in board.unscheduled"
//         :title="t.title + t('views.dailyPlan.boardTitleEdit')">
// 循环变量 t 在子树内遮蔽了 import 进来的 i18n 函数 t → t('...') 变成「调用一个对象」，
// 开发环境报 `t is not a function`，生产压缩后变量被重命名，用户看到的是
// `e is not a function`（极难从字面定位）。
// 这个坑已经复发过一次（824dbb5 只修了一处、漏了另一处），所以固化成闸门。
//
// 判定：对每个带 v-for 的元素，取其 loc 范围源码，检查 v-for 声明的名字是否以 `name(`
// 形式出现在该范围内（属性表达式与插值都在范围内）。
// 注意 compiler-sfc 的 template ast 节点 loc.offset 是**相对整个 SFC 文件**的，
// 必须用 src.slice（用 tpl.content.slice 会切片错位 → 假阴性）。
export function findShadowedCalls(src, filename = 'x.vue') {
  const { descriptor } = parse(src, { filename });
  const tpl = descriptor.template;
  if (!tpl || !tpl.ast) return [];
  const hits = [];
  const visit = (node) => {
    if (node.type === 1) {
      const vfor = (node.props || []).find((p) => p.type === 7 && p.name === 'for');
      if (vfor) {
        const expr = vfor.exp?.content || '';
        const names = new Set();
        const m1 = expr.match(/^\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s+in\s/);
        if (m1) { names.add(m1[1]); names.add(m1[2]); } else {
          const m2 = expr.match(/^\s*([A-Za-z_$][\w$]*)\s+in\s/);
          if (m2) names.add(m2[1]);
        }
        const seg = src.slice(node.loc.start.offset, node.loc.end.offset);
        for (const nm of names) {
          const re = new RegExp('(^|[^\\w$.])' + nm.replace(/\$/g, '\\$') + '\\s*\\(');
          if (re.test(seg)) {
            hits.push({
              name: nm,
              expr: expr.trim(),
              line: src.slice(0, node.loc.start.offset).split('\n').length,
            });
          }
        }
      }
    }
    for (const ch of node.children || []) visit(ch);
  };
  visit(tpl.ast);
  return hits;
}

test('v-for 遮蔽检测器自检：必须能抓出 i18n t 被遮蔽的负例', () => {
  // 防「检测器失效导致闸门空转」：先喂一个明确违规的片段，必须命中；
  // 再喂一个把变量改名（正确写法）的版本，必须不命中。
  const BAD = `<script setup>
import { t } from '../i18n/index.js';
</script>
<template>
  <div>
    <span v-for="t in list" :key="t.id" :title="t('a.b')">{{ t.name }}</span>
  </div>
</template>
`;
  const GOOD = BAD.replace('v-for="t in list"', 'v-for="tsk in list"')
    .replace(/:key="t\.id"/, ':key="tsk.id"')
    .replace(/:title="t\('a\.b'\)"/, ':title="t(\'a.b\')"')
    .replace('{{ t.name }}', '{{ tsk.name }}');
  const badHits = findShadowedCalls(BAD, 'Bad.vue');
  assert.equal(badHits.length, 1, `负例必须被检出，实际 ${badHits.length} 处`);
  assert.equal(badHits[0].name, 't');
  assert.deepEqual(findShadowedCalls(GOOD, 'Good.vue'), [], '正例不得误报');
});

test('全部 .vue 模板：v-for 变量不得遮蔽模板内被调用的函数名', () => {
  const bad = [];
  for (const f of files) {
    let hits;
    try { hits = findShadowedCalls(readFileSync(f, 'utf8'), f); } catch { continue; }
    for (const h of hits) {
      bad.push(`${relative(SRC, f)}:${h.line} v-for "${h.expr}" 的变量 "${h.name}" 在子树内被当函数调用（生产环境报 e is not a function）`);
    }
  }
  assert.deepEqual(bad, [], `以下位置 v-for 变量遮蔽了函数名，改个名字（如 tsk/item/row）：\n${bad.join('\n')}`);
});

// ---------- 坑 3b：v-for 变量直接叫 t（预防性） ----------
//
// 上面那个闸门只能抓到「已经调用」的遮蔽；而 `v-for="t in list"` 即使当前没在子树里
// 调用 t('...')，也只是「暂时没炸」——后人随手加一句翻译就复现生产崩溃
// （2026-09-14 审计发现 PlanReminderLayer.vue / Sync.vue 两处如此）。
// t 是本项目 i18n 函数的固定名字，因此直接禁止用它当循环变量：简单、无歧义、可执行。
export function findVForVarNamedT(src, filename = 'x.vue') {
  const { descriptor } = parse(src, { filename });
  const tpl = descriptor.template;
  if (!tpl || !tpl.ast) return [];
  const out = [];
  const visit = (node) => {
    if (node.type === 1) {
      const vfor = (node.props || []).find((p) => p.type === 7 && p.name === 'for');
      if (vfor) {
        const expr = String(vfor.exp?.content || '');
        const names = new Set();
        const m1 = expr.match(/^\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s+in\s/);
        if (m1) { names.add(m1[1]); names.add(m1[2]); } else {
          const m2 = expr.match(/^\s*([A-Za-z_$][\w$]*)\s+in\s/);
          if (m2) names.add(m2[1]);
        }
        if (names.has('t')) {
          out.push({ expr: expr.trim(), line: src.slice(0, node.loc.start.offset).split('\n').length });
        }
      }
    }
    for (const ch of node.children || []) visit(ch);
  };
  visit(tpl.ast);
  return out;
}

test('v-for 变量名 detect 器自检：能抓出 t、不误报 task', () => {
  const BAD = `<template><div><span v-for="t in list">{{ t.title }}</span></div></template>`;
  const GOOD = `<template><div><span v-for="task in list">{{ task.title }}</span></div></template>`;
  assert.equal(findVForVarNamedT(BAD, 'B.vue').length, 1);
  assert.deepEqual(findVForVarNamedT(GOOD, 'G.vue'), []);
});

test('全部 .vue 模板：v-for 循环变量不得命名为 t', () => {
  const bad = [];
  for (const f of files) {
    let hits;
    try { hits = findVForVarNamedT(readFileSync(f, 'utf8'), f); } catch { continue; }
    for (const h of hits) {
      bad.push(`${relative(SRC, f)}:${h.line} v-for "${h.expr}" 用了变量名 t（会遮蔽 i18n 的 t 函数）`);
    }
  }
  assert.deepEqual(bad, [], `以下 v-for 变量叫 t，请改成 task/tip/item 之类：\n${bad.join('\n')}`);
});

// ---------------- 坑 3（round75 新增）：.js 里把 t 用作局部变量，遮蔽 i18n 的 t() ----------------
//
// 与坑 2（模板 v-for 变量名 t）同源，但发生在**脚本**里：文件顶部 `import { t } from '.../i18n'`，
// 同一作用域又写了 `const t = await res.text()` / `.map((t) => …)` / `catch (t)`。
// 后者会**静默遮蔽**前者：同段代码里所有 `t('some.key')` 都会抛 `t is not a function`。
// 实测踩到（round75）：llm.js 用 `const t = await res.text()` 存响应文本，新加的
// `t('agent.llm.retried', …)` 直接变成「调用字符串」→ 重试耗尽后的错误信息整段构造失败。
// 编译/静态检查都不会报它，只在运行到那一行时才炸。
function walkScripts(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walkScripts(p, out);
    else if (n.endsWith('.js') || n.endsWith('.mjs')) out.push(p);
  }
  return out;
}

/** 该文件是否从 i18n 引入了 t */
const importsI18nT = (src) => /import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*['"][^'"]*i18n\/index\.js['"]/.test(src);

/** 是否把 t 用作局部变量 / 形参（会遮蔽 import 进来的 t） */
const shadowsT = (src) => /(?:const|let|var)\s+t\s*=/.test(src)
  || /\(\s*t\s*\)\s*=>/.test(src)
  || /(^|[^.\w])t\s*=>/.test(src)
  || /catch\s*\(\s*t\s*\)/.test(src);

test('t 遮蔽检测器自检：能抓出负例、不误报 task / t 开头的词', () => {
  assert.ok(shadowsT("const t = await res.text();"), '应抓出 const t =');
  assert.ok(shadowsT('items.map((t) => t.trim())'), '应抓出箭头参数 t');
  assert.ok(shadowsT('try {} catch (t) {}'), '应抓出 catch(t)');
  assert.ok(!shadowsT('const task = 1; items.map((task) => task.id)'), '不得误报 task');
  assert.ok(!shadowsT("const txt = 'a'; const total = 1;"), '不得误报 t 开头的其它标识符');
  assert.ok(!shadowsT("import { t } from '../i18n/index.js'; t('k', 'v');"), '正常调用不应误报');
});

test('src/agent 下引入 i18n t 的文件：不得把 t 用作局部变量/形参（会遮蔽 t()）', () => {
  const files = walkScripts(join(SRC, 'agent'));
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (!importsI18nT(src)) continue;
    if (shadowsT(src)) offenders.push(relative(SRC, f).replace(/\\/g, '/'));
  }
  assert.deepEqual(offenders, [], '这些文件里 t(\'key\') 会抛「t is not a function」，请把局部变量改名（如 bodyText）');
});

