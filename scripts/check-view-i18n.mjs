// scripts/check-view-i18n.mjs
// i18n 质量闸门（双向）：
//
//   1) 正向：每个 src/views/*.vue 里所有 t('views.<mod>.<key>') 都能在 zh 字典解析到真实值
//   2) 字典完整性：zh / en 两棵字典的键集合完全一致（缺键 ⇒ 切语言后静默回退中文）
//   3) 占位符对齐：zh / en 同键的 {param} 集合一致（不一致 ⇒ 英文界面显示裸 {n}）
//   4) 反向（--strict）：扫描 .vue 里未被 t() 包裹的硬编码中文，防「迁移完成」声明失实
//
// 用法：
//   node scripts/check-view-i18n.mjs                    正向 + 字典完整性 + 占位符（默认）
//   node scripts/check-view-i18n.mjs --strict           另加反向硬编码扫描（对照基线）
//   node scripts/check-view-i18n.mjs --update-baseline  重写反向扫描基线（认领当前存量）
//
// 反向扫描为什么用基线而非零容忍：存量里有一大类「数据常量」——选项数组、AI prompt 模板、
// 写进库的枚举值（如 PrivacyData 的 ['早餐','午餐','晚餐']）。它们不是界面文案，
// 翻译了反而污染数据。基线把存量固化并标注理由，之后只卡「新增」，防止债务继续扩大。
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const viewsDir = join(root, 'src/views');
const dictDir = join(root, 'src/i18n/views');
const baselineFile = join(root, 'scripts/i18n-hardcode-baseline.json');

const args = new Set(process.argv.slice(2));
const STRICT = args.has('--strict');
const UPDATE_BASELINE = args.has('--update-baseline');

const problems = [];
const fail = (msg) => problems.push(`✗ ${msg}`);

function resolve(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// ---------------------------------------------------------------- 1) 正向校验
const vueFiles = readdirSync(viewsDir).filter(f => f.endsWith('.vue')).sort();
const dictCache = new Map();
for (const f of vueFiles) {
  const src = readFileSync(join(viewsDir, f), 'utf8');
  // 捕获 t('views.<module>.<path>')：首段是字典模块名，其后是 zh 字典内的点号路径
  const calls = [...src.matchAll(/t\(\s*'views\.([A-Za-z0-9_.-]+)'/g)].map(m => m[1].split('.'));
  for (const parts of calls) {
    const modName = parts[0];
    const keyPath = parts.slice(1).join('.');
    // 动态拼接键（如 t('views.sync.stats.' + k)）无法静态校验，跳过
    if (keyPath.endsWith('.') || keyPath === '') continue;
    let mod = dictCache.get(modName);
    if (mod === undefined) {
      const dictFile = join(dictDir, `${modName}.js`);
      if (!existsSync(dictFile)) {
        fail(`${f}: t('views.${modName}.${keyPath}') 缺少字典模块 src/i18n/views/${modName}.js`);
        dictCache.set(modName, null);
        continue;
      }
      mod = await import(`file://${dictFile.replace(/\\/g, '/')}`);
      dictCache.set(modName, mod);
    }
    if (!mod) continue; // 已报缺模块
    if (resolve(mod.zh, keyPath) === undefined) {
      fail(`${f}: t('views.${modName}.${keyPath}') 在 zh 字典中缺失`);
    }
  }
}

// ------------------------------------------------- 2)+3) 字典完整性与占位符
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    // 数组原样占位（engine.*.impl 这类），只表示"该键存在"
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, path, out);
    else out[path] = v;
  }
  return out;
}

const placeholders = (s) => new Set([...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]));

function compareDictPair(label, a, b) {
  const fa = flatten(a), fb = flatten(b);
  const ka = Object.keys(fa), kb = Object.keys(fb);
  for (const k of ka.filter(x => !kb.includes(x))) fail(`${label}: 键 "${k}" 只在 zh 存在（en 缺失）`);
  for (const k of kb.filter(x => !ka.includes(x))) fail(`${label}: 键 "${k}" 只在 en 存在（zh 缺失）`);
  for (const k of ka.filter(x => kb.includes(x))) {
    const va = fa[k], vb = fb[k];
    if (typeof va !== 'string' || typeof vb !== 'string') continue;
    const pa = placeholders(va), pb = placeholders(vb);
    const diff = [...pa].filter(x => !pb.has(x)).concat([...pb].filter(x => !pa.has(x)));
    if (diff.length) fail(`${label}: 键 "${k}" 占位符不一致 zh={${[...pa]}} en={${[...pb]}}`);
  }
}

const i18n = await import(`file://${join(root, 'src/i18n/index.js').replace(/\\/g, '/')}`);
compareDictPair('根字典', i18n.DICTS['zh-CN'], i18n.DICTS.en);

let dictCount = 0;
for (const f of readdirSync(dictDir).filter(x => x.endsWith('.js')).sort()) {
  const mod = await import(`file://${join(dictDir, f).replace(/\\/g, '/')}`);
  compareDictPair(`字典 ${f}`, mod.zh, mod.en);
  dictCount++;
}

// ------------------------------------------------------- 4) 反向硬编码扫描
// 思路：先把"已经走 i18n 的中文"从源码里挖掉，剩下的中文才是漏网的。
// 挖掉的内容：块注释 / <style> / 行注释 / t() 类调用的参数（含中文回退字面量）。
// 整文件处理而非逐行 —— 否则跨行的 t(...) 调用会被误判成硬编码。
const blankKeepNewlines = (s) => s.replace(/[^\n]/g, ' ');
const IS_ID_START = /[A-Za-z_$]/;
const IS_ID = /[A-Za-z0-9_$]/;

/**
 * 挖空指定函数名调用的参数部分（保留换行，便于按行归因）
 * @param {string} src 源码
 * @param {Set<string>} names 函数名集合，如 t / $t / console.error / 本地别名 S
 */
function maskCallArgs(src, names) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i];
    if (IS_ID_START.test(c)) {
      let j = i; while (j < src.length && IS_ID.test(src[j])) j++;
      const name = src.slice(i, j);
      if (names.has(name) && src[j] === '(') {
        // 括号配对时跳过引号内内容，否则 '文本(含括号)' 会提前终止计数
        let depth = 0, k = j, quote = null;
        for (; k < src.length; k++) {
          const ch = src[k];
          if (quote) {
            if (ch === '\\') { k++; continue; }
            if (ch === quote) quote = null;
            continue;
          }
          if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
          if (ch === '(') depth++;
          else if (ch === ')') { depth--; if (depth === 0) break; }
        }
        if (depth === 0) { out += src.slice(i, j) + blankKeepNewlines(src.slice(j, k + 1)); i = k + 1; continue; }
      }
      out += src.slice(i, j); i = j; continue;
    }
    out += c; i++;
  }
  return out;
}

const HAS_CJK = /[一-鿿]/;
function scanHardcoded(file) {
  let src = readFileSync(join(viewsDir, file), 'utf8');
  // 本地 t 别名（如 Sync.vue 的 const S = (k, fb, v) => t(...)、UserDashboard 的 T）
  const aliases = [...src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>\s*t\s*\(/g)].map(m => m[1]);
  const names = new Set([
    't', '$t',
    ...aliases,
    ...[...src.matchAll(/console\.([a-zA-Z]+)/g)].map(m => 'console.' + m[1]),
  ]);
  src = src.replace(/\/\*[\s\S]*?\*\//g, blankKeepNewlines);   // 块注释
  src = src.replace(/<!--[\s\S]*?-->/g, blankKeepNewlines);    // HTML 注释
  src = src.replace(/<style[\s\S]*?<\/style>/g, blankKeepNewlines); // 样式表里的中文不是文案
  src = maskCallArgs(src, names);
  // 行注释：要求 // 前面是行首或空白，避免误伤 'https://'
  src = src.replace(/(^|[ \t])\/\/[^\n]*/gm, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

  const hits = [];
  src.split(/\r?\n/).forEach((line, i) => {
    if (!HAS_CJK.test(line)) return;
    hits.push({ line: i + 1, text: line.trim().slice(0, 160) });
  });
  return hits;
}

let scanTotal = 0;
if (STRICT || UPDATE_BASELINE) {
  const found = {};
  for (const f of vueFiles) {
    const hits = scanHardcoded(f);
    if (hits.length) found[f] = hits;
    scanTotal += hits.length;
  }

  if (UPDATE_BASELINE) {
    const old = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : {};
    const next = {};
    for (const [f, hits] of Object.entries(found).sort(([a], [b]) => a.localeCompare(b))) {
      const reasons = old[f]?.reasons || {};
      next[f] = {
        count: hits.length,
        note: old[f]?.note || '',
        reasons: Object.fromEntries(hits.map(h => [String(h.line), reasons[String(h.line)] || ''])),
      };
    }
    writeFileSync(baselineFile, JSON.stringify(next, null, 2) + '\n', 'utf8');
    console.log(`✓ 基线已更新：scripts/i18n-hardcode-baseline.json（${Object.keys(next).length} 文件 / ${scanTotal} 行）`);
  } else {
    const base = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : {};
    let added = 0, removed = 0;
    for (const [f, hits] of Object.entries(found)) {
      const known = new Set(Object.keys(base[f]?.reasons || {}));
      const now = new Set(hits.map(h => String(h.line)));
      for (const h of hits) {
        if (!known.has(String(h.line))) { fail(`新增硬编码中文 ${f}:${h.line}  ${h.text}`); added++; }
      }
      for (const k of known) if (!now.has(k)) removed++;
    }
    for (const f of Object.keys(base)) {
      if (base[f]?.count > 0 && !found[f]) console.log(`  可回收：${f} 已无硬编码中文，请跑 --update-baseline`);
    }
    console.log(`  反向扫描：命中 ${scanTotal} 行，较基线新增 ${added} 行 / 已消除 ${removed} 行`);

    // 空回退 t('key', '')：字典键一旦误删，UI 静默空白而非报错，排障成本极高。
    // 统一口径：不写回退就传 undefined —— 缺键时渲染裸 key，一眼能看出是哪一处。
    for (const f of vueFiles) {
      readFileSync(join(viewsDir, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
        for (const m of line.matchAll(/t\(\s*'(views\.[A-Za-z0-9_.-]+)'\s*,\s*''/g)) {
          fail(`空回退字面量 ${f}:${i + 1} t('${m[1]}', '') —— 请改用 undefined`);
        }
      });
    }
  }
}

// ------------------------------------------------------------------- 汇总
if (problems.length) {
  for (const p of problems) console.error(p);
  console.error(`✗ 发现 ${problems.length} 处问题（覆盖 ${vueFiles.length} 个视图 / ${dictCount} 个字典模块）`);
  process.exit(1);
}
console.log(`✓ i18n 闸门通过：${vueFiles.length} 个视图 t() 可解析 · ${dictCount} 个字典 zh/en 键位与占位符对齐`
  + (STRICT ? ` · 反向扫描 ${scanTotal} 行无新增` : '（加 --strict 可查硬编码中文）'));
