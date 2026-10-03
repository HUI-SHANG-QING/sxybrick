// scripts/check-silent-catch.mjs —— 「静默 catch」闸门
//
// 为什么要有这道闸门（round125/126 审计结论）：
//   round125 挖到一个 P0 —— 「跨 tab 数据变更广播」从未生效过。根因不是 Dexie 的 API 用错，
//   而是那个**必然抛出**的错被 `catch {}` 静默吞掉，还配了一句
//   「个别环境不支持 hooks 时静默降级」的注释 —— 把一个 100% 必现的编程错误
//   包装成了「环境差异」，于是缺陷长期不可见。
//   修复后我复查发现：全仓还有 50 处完全空的 catch。只要这个写法继续被默许，
//   下一轮「错误被静默吞掉 → 缺陷长期隐形」就会重演。
//   ⇒ 本闸门只卡「新增」：想留空 catch，必须在同一处写明为什么可以忽略。
//
// 用法：
//   node scripts/check-silent-catch.mjs                 常规检查（净增 > 0 → 失败）
//   node scripts/check-silent-catch.mjs --update-baseline   存量已消除时收紧基线
//      ⚠ 净增 > 0 拒绝写入，必须显式 --force-baseline（防「一键把新增违规洗成存量」，
//        与 i18n 闸门 round54 的同款护栏一致）。
//
// 设计沿用 i18n 闸门的成熟做法：
//   · 基线按**文件 + 数量**登记，不按行号 —— 任何插行/删行都不会让基线失配假红；
//   · 路径一律归一为 POSIX 斜杠（Windows 生成基线、Linux CI 跑闸必须能对上）；
//   · 存量只会提醒、不会阻塞，清理是渐进的。
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const rel = (abs) => relative(root, abs).replace(/\\/g, '/');
const baselineFile = join(root, 'scripts/silent-catch-baseline.json');
const args = new Set(process.argv.slice(2));
const UPDATE = args.has('--update-baseline');
const FORCE = args.has('--force-baseline');

// ── 收集源码文件 ──
const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|vue)$/.test(e.name)) files.push(p);
  }
})(join(root, 'src'));

/**
 * catch 体的三分类 —— **只有「完全空」才算静默**。
 *   empty     catch 后面跟一对空花括号                      → 没有理由也没有处理 ⇒ 本闸门拦
 *   commented catch 块里只有一段块注释（写着「忽略」「已终」等）→ 已写明为什么可忽略 ⇒ 豁免
 *   logic     catch 块里有真实语句（warn / 回退 / 上报）        → 正常
 * ⚠️ v1 教训一：最初把 empty 与 commented 合并判定（把注释也剥掉再判空），
 *    结果 145 处「已写明理由」的合规写法被误判为静默（196 vs 真实的 50），
 *    门禁会误伤、也就没人愿意用。豁免必须真的豁免。
 * ⚠️ v1 教训二：本注释最初直接写了含「块注释结束符」的示例代码，
 *    把这段块注释提前闭合 → 整个脚本 SyntaxError。示例里不要出现注释结束符。
 */
function classifyBody(body) {
  if (body.trim() === '') return 'empty';
  const noComment = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
    .trim();
  return noComment === '' ? 'commented' : 'logic';
}

/**
 * 找出文件中「完全空的 catch」（连注释都没有的那种）。
 * 两种写法都要覆盖（v1 教训）：
 *   · 单行 `try { X(); } catch {}`        —— 项目里大量使用，v1 只匹配多行 → 误报 0 处
 *   · 多行 `} catch {\n  \n}`
 * @returns {{line:number, text:string}[]}
 */
function findSilentCatches(src) {
  const lines = src.split(/\r?\n/);
  const hits = [];
  let inStyle = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^<style/.test(line)) inStyle = true;
    if (/^<\/style>/.test(line)) inStyle = false;
    if (inStyle) continue;

    if (!/\bcatch\b/.test(line)) continue;

    // 形式 A：单行（体里没有嵌套花括号）
    const one = /catch\s*(?:\([^)]*\))?\s*\{([^{}]*)\}/.exec(line);
    if (one) {
      if (classifyBody(one[1]) === 'empty') hits.push({ line: i + 1, text: line.trim().slice(0, 120) });
      continue;
    }

    // 形式 B：多行 —— `catch … {` 在行尾，向下找配对的 `}`
    if (!/catch\s*(?:\([^)]*\))?\s*\{\s*$/.test(line)) continue;
    let depth = 1;
    const body = [];
    for (let j = i + 1; j < lines.length && j < i + 80; j++) {
      const l2 = lines[j];
      for (const ch of l2) {
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; break; }
      }
      if (depth === 0) {
        if (classifyBody(body.join('\n')) === 'empty') hits.push({ line: i + 1, text: line.trim().slice(0, 120) });
        break;
      }
      body.push(l2);
    }
  }
  return hits;
}

const found = {};
let total = 0;
for (const f of files) {
  const hits = findSilentCatches(readFileSync(f, 'utf8'));
  if (!hits.length) continue;
  found[rel(f)] = { count: hits.length, hits };
  total += hits.length;
}

const old = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : {};
const oldTotal = Object.values(old).reduce((n, v) => n + (Number(v?.count) || 0), 0);

if (UPDATE) {
  const delta = total - oldTotal;
  if (delta > 0 && !FORCE) {
    console.error(`✗ 静默 catch 基线净增 ${delta} 处（${oldTotal} → ${total}）：拒绝自动认领。`);
    console.error('  · 若确认是「插行位移」导致的计数变化，请核对后加 --force-baseline 重跑；');
    console.error('  · 若确有新增的静默 catch，请在 catch 内写明为什么可以忽略（注释即豁免），');
    console.error('    或给它加真实的处理逻辑（warn / 回退 / 上报），而不是空着。');
    process.exit(1);
  }
  const next = {};
  for (const f of Object.keys(found).sort((a, b) => a.localeCompare(b))) {
    next[f] = { count: found[f].count, note: old[f]?.note || '' };
  }
  writeFileSync(baselineFile, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log(`✓ 基线已更新：scripts/silent-catch-baseline.json（${Object.keys(next).length} 文件 / ${total} 处）`);
  process.exit(0);
}

let added = 0;
const problems = [];
for (const [f, v] of Object.entries(found)) {
  const base = Number(old[f]?.count) || 0;
  if (v.count > base) {
    added += v.count - base;
    problems.push({ f, base, now: v.count, hits: v.hits });
  }
}
let shrink = 0;
for (const [f, v] of Object.entries(old)) {
  const now = Number(found[f]?.count) || 0;
  if (now < (Number(v?.count) || 0)) shrink += (Number(v?.count) || 0) - now;
}

console.log(`  静默 catch 扫描：命中 ${total} 处（基线 ${oldTotal}），新增 ${added} 处 / 已消除 ${shrink} 处`);

if (problems.length) {
  for (const p of problems) {
    console.error(`✗ 新增静默 catch：${p.f}（${p.base} → ${p.now}）`);
    for (const h of p.hits.slice(p.now - p.base)) console.error(`    ${p.f}:${h.line}  ${h.text}`);
  }
  console.error('');
  console.error('  为什么拦：round125 的「跨 tab 广播从未生效」P0，根因就是一个必然抛出的错');
  console.error('  被 `catch {}` 静默吞掉，还被注释描述成「环境差异」，导致缺陷长期隐形。');
  console.error('  想留空 catch，请在 catch 内写明为什么可以忽略（注释即豁免），或给它真实处理逻辑。');
  process.exit(1);
}

if (shrink > 0) {
  console.log(`  ✓ 已消除 ${shrink} 处，确认后可跑 \`node scripts/check-silent-catch.mjs --update-baseline\` 收紧基线`);
}
