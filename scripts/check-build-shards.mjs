#!/usr/bin/env node
// scripts/check-build-shards.mjs
// 构建产物校验：本地词库分片必须真的被打进 dist。
//
// 为什么单独成脚本（而不是只写在测试里）：
//   2026-09-14 事故 —— src/services/word-enrich.js 用 `typeof import.meta.glob === 'function'`
//   判定 Vite 环境，而 Vite 只替换 glob 的**调用**、不替换 typeof 引用 → 产物里该判定恒为 false
//   → 52 个分片加载器被丢弃成 {} → 浏览器端任何单词都查不到（"该词暂无完整词条/暂无释义"），
//   单词本、背诵 13 模式、AI 智能模式、选择题选项因此全都没数据。
//   而 npm test 里的产物断言在 CI 上会跳过（CI 顺序是 test → build，跑测试时 dist 还不存在），
//   所以必须在 build 之后单独跑一次本脚本。
//
// 用法：npm run build && node scripts/check-build-shards.mjs   （CI 已挂在 build 之后）
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'dist', 'assets');
const SHARDS_DIR = join(ROOT, 'src', 'data', 'word-enrich-shards');

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

if (!existsSync(ASSETS)) {
  fail('dist/assets 不存在 —— 请先 `npm run build` 再跑本脚本（CI 里它必须排在 build 之后）');
}

const files = readdirSync(ASSETS).filter((n) => n.endsWith('.js'));
if (!files.length) fail('dist/assets 下没有任何 js 产物');

// ① 不得残留未替换的 glob 调用：残留 = 该处逻辑在运行时必然走空分支
const leftovers = files.filter((n) => readFileSync(join(ASSETS, n), 'utf8').includes('import.meta.glob'));
if (leftovers.length) {
  fail(`产物里残留 import.meta.glob（Vite 未替换）：${leftovers.join(', ')}`);
}

// ② 找到加载器映射所在的 chunk
const host = files.find((n) => readFileSync(join(ASSETS, n), 'utf8').includes('word-enrich-shards/'));
if (!host) fail('产物里找不到词库分片路径映射 —— 加载器表被条件判定丢弃了（词库将完全不可用）');

const body = readFileSync(join(ASSETS, host), 'utf8');
const refs = [...new Set([...body.matchAll(/import\("\.\/([^"]+\.js)"\)/g)].map((m) => m[1]))];

const srcShardCount = existsSync(SHARDS_DIR) ? readdirSync(SHARDS_DIR).filter((n) => n.endsWith('.json')).length : 0;
if (refs.length < 50) {
  fail(`映射表只引用 ${refs.length} 个分片 chunk（源分片 ${srcShardCount} 个）—— 加载器表被截断了`);
}
if (srcShardCount && refs.length !== srcShardCount) {
  fail(`映射表 ${refs.length} 条 != 源分片 ${srcShardCount} 个 —— 有分片没被打包，对应字母段的词将查不到`);
}

// ③ 每条引用都必须能落地
const missing = refs.filter((n) => !existsSync(join(ASSETS, n)));
if (missing.length) {
  fail(`有 ${missing.length} 个分片 chunk 在产物里缺失（对应分片的词全部查不到）：${missing.slice(0, 8).join(', ')}`);
}

console.log(`✓ 构建产物校验通过：${refs.length} 个词库分片全部就位（host chunk: ${host}）`);
