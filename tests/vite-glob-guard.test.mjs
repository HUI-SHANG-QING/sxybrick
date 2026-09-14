// tests/vite-glob-guard.test.mjs —— 禁止「产物中恒假」的 Vite 环境判定
//
// 事故（2026-09-14）：src/services/word-enrich.js 用
//     const IS_VITE = typeof import.meta.glob === 'function';
// 来区分「浏览器(Vite) / Node」。但 Vite 只把 `import.meta.glob(...)` 这个**调用**
// 替换成对象字面量，**不会替换 `typeof` 引用** → 产物里该判定恒为 false
// （实测 dist: `Z = typeof import.meta.glob == "function"` → false）→
// 52 个分片加载器被丢弃成 {} → 浏览器端任何单词都查不到（"该词暂无完整词条"）。
//
// 为什么测试没抓到：node --test 走 tests/_env.mjs 的 ingestShardPayload 注入分片，
// 完全绕开了 glob 路径 —— 单测全绿、线上全崩。所以必须有一条**针对源码形态**的闸门。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = new URL('../dist', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|vue|mjs)$/.test(n)) out.push(p);
  }
  return out;
}

test('源码：不得用 typeof import.meta.glob 判定 Vite 环境（产物中恒假）', () => {
  const bad = [];
  for (const f of walk(SRC)) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((ln, i) => {
      const t = ln.trim();
      // 跳过注释行：文档里提到这个写法（说明为什么禁止）是应该的，只有真用它判定才算违规
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      if (/typeof\s+import\.meta\.glob/.test(ln)) {
        bad.push(`${relative(SRC, f)}:${i + 1} 用 typeof 判定 import.meta.glob —— 产物里恒为 'undefined'，判定必然为 false`);
      }
    });
  }
  assert.deepEqual(bad, [], `以下位置用了会在产物里失效的环境判定，改用 try/catch 包 import.meta.glob：\n${bad.join('\n')}`);
});

test('word-enrich：分片加载器必须直接调用 glob，并由 try/catch 兜 Node', () => {
  const s = readFileSync(join(SRC, 'services/word-enrich.js'), 'utf8');
  assert.match(s, /import\.meta\.glob\(\s*'\.\.\/data\/word-enrich-shards\/\*\.json'\s*\)/, '必须直接调用 glob（Vite 才会替换）');
  assert.match(s, /function\s+loadShardLoaders\s*\(/, '应通过 loadShardLoaders() 包装，便于 Node 下 catch 降级');
  assert.match(s, /try\s*\{[\s\S]{0,200}import\.meta\.glob/, 'glob 调用必须在 try 块内（Node 下不是函数会抛 TypeError）');
});

test('构建产物（若已 build）：产品必须真的带上分片加载器', () => {
  if (!existsSync(join(DIST, 'assets'))) {
    // 未构建：不做产物断言（源码闸门已保证形态正确）。CI 在 build 之后跑本文件即生效。
    console.log('[skip] dist 不存在，跳过产物校验（源码闸门已覆盖）');
    return;
  }
  const files = readdirSync(join(DIST, 'assets')).filter((n) => n.endsWith('.js'));
  assert.ok(files.length > 0, 'dist/assets 下没有 js 产物');

  // ① 不得残留未替换的 glob 调用（残留 = 该处逻辑在运行时必然走空分支）
  const leftovers = files.filter((n) => readFileSync(join(DIST, 'assets', n), 'utf8').includes('import.meta.glob'));
  assert.deepEqual(leftovers, [], `产物里残留 import.meta.glob（未被 Vite 替换）：${leftovers.join(', ')}`);

  // ② 找到加载器映射所在的 chunk，提取每个 loader 指向的分片 chunk 并**逐个校验存在**
  //    不靠文件名模式猜：分片 chunk 名含多段/hash，模式匹配会漏计数（曾数成 26/52 而误判失败）
  const host = files.find((n) => readFileSync(join(DIST, 'assets', n), 'utf8').includes('word-enrich-shards/'));
  assert.ok(host, '产物里找不到分片路径映射 —— 加载器表可能被条件判定丢弃');
  const body = readFileSync(join(DIST, 'assets', host), 'utf8');

  const refs = [...body.matchAll(/import\("\.\/([^"]+\.js)"\)/g)].map((m) => m[1]);
  const uniq = [...new Set(refs)];
  assert.ok(uniq.length >= 50, `映射表只引用 ${uniq.length} 个分片 chunk（应 ≥50）——加载器表被截断了`);

  // ③ 引用必须都能落地：缺一个 chunk，就是该分片的词在线上全部查不到
  const missing = uniq.filter((n) => !existsSync(join(DIST, 'assets', n)));
  assert.deepEqual(missing, [], `有 ${missing.length} 个分片 chunk 在产物里缺失（线上对应分片的词全部查不到）：${missing.slice(0, 8).join(', ')}`);
});

// ---------- 第二个「产物正确但运行时全空」的事故：渲染函数定义了从不调用 ----------
// 事故（2026-09-14）：MarkdownRenderer 的 watch 只剩灯箱清理逻辑，update() 的调用被整段删掉。
// html 只在 update() 里赋值 → v-html 永远空串 → 卡片正反面/编辑预览/图片/AI 回复全部空白，
// 全屏因只剩黑底而表现为「黑屏」。组件级测试要编译 .vue（node --test 做不到），
// 所以这里用源码形态闸门兜住：「定义了渲染函数就必须有人调用它」。
test('MarkdownRenderer：update() 必须被 watch(immediate) 或 onMounted 调用', () => {
  const s = readFileSync(join(SRC, 'components/MarkdownRenderer.vue'), 'utf8');
  assert.match(s, /function update\s*\(/, '应保留 update() 渲染函数');
  const called = /await update\(\)|\bupdate\(\);|onMounted\(update\)|onMounted\(\s*\(\s*\)\s*=>\s*\{[^}]*update\(\)/.test(s);
  assert.ok(called, 'update() 从未被调用 → html 恒为空串，所有 markdown 内容都会消失');
  assert.match(s, /watch\([\s\S]{0,400}?\{\s*immediate:\s*true\s*\}/, 'watch 必须带 immediate:true（否则首次渲染不触发、内容空白）');
});
