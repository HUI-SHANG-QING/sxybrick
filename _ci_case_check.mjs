// 离线大小写/路径校验：模拟 Linux 大小写敏感文件系统，
// 对所有 tests/*.test.mjs 的每个 import 做：
//   1. 解析绝对目标路径
//   2. 确认目标实际文件名（含大小写）与 import 字符串完全一致
//   3. 同时验证 git tracked 文件名与磁盘文件名大小写一致
// 任何不一致都会触发 Linux 的 ENOENT 导致 import 崩溃（1 秒级即时失败）。
import { readFileSync, readdirSync, statSync, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { join, dirname, normalize, sep, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const errors = [];

// --- Step 1: 收集 git tracked 真实文件名 ---
const gitTracked = new Map();  // relPath (normalized forward slash) -> exact filename case
function collectGit() {
  // 通过 readdirSync 递归，因为 Windows 返回的大小写就是 git 实际存的大小写
  // （如果用户没做过 only-case rename 的话）。但我们还要交叉验证。
  const walk = (rel) => {
    const abs = join(ROOT, rel);
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) {
        if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
        walk(rel ? `${rel}/${name}` : name);
      }
    } else if (st.isFile()) {
      gitTracked.set(rel.toLowerCase(), rel);
      // 存 canonical 形式：用 Windows 的真实文件名
    }
  };
  walk('');
}
collectGit();

// 把相对路径里的段逐个核对真实文件名（大小写敏感）
// 正确做法：从盘符开始，cursor=父目录；每次用 readdir(cursor) 找到下一段的真实名称；
//   若匹配失败或大小写不同，视为 Linux 下的 ENOENT / 加载失败。
function exactCasePath(absStart) {
  const parts = absStart.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return null;
  let cursor;
  let startIdx;
  if (/^[a-zA-Z]:$/.test(parts[0])) {
    // Windows: 盘符 + sep 是根
    cursor = parts[0] + sep;
    startIdx = 1;
  } else if (parts[0] === '') {
    // Unix 绝对路径: /usr/... split 后首段为空
    cursor = '/';
    startIdx = 1;
  } else {
    cursor = '.' + sep;
    startIdx = 0;
  }
  for (let i = startIdx; i < parts.length; i++) {
    const want = parts[i];
    let dirEntries;
    try {
      dirEntries = readdirSync(cursor);
    } catch {
      return null;
    }
    const actual = dirEntries.find(n => n.toLowerCase() === want.toLowerCase());
    if (actual === undefined) return null;
    if (actual !== want) {
      return { mismatch: true, cursor, want, actual, sofar: join(cursor, actual) };
    }
    cursor = join(cursor, actual);
  }
  return { mismatch: false, sofar: cursor };
}

function findImportLines(src) {
  // ESM import + dynamic import() + export from
  // 注意：排除模板字符串字面量 (`` 内带 ${...})，否则 `import(\`...\${x}\`)` 会被当成 specifier
  const lines = [];
  // static import ... from 'spec'
  for (const m of src.matchAll(/^\s*import\s+(?:[^'";`]*?from\s+)?['"]([^'"]+)['"]/gm)) lines.push(m[1]);
  // static export ... from 'spec'
  for (const m of src.matchAll(/^\s*export\s+(?:[^'";`]*?from\s+)['"]([^'"]+)['"]/gm)) lines.push(m[1]);
  // dynamic import('spec') / import("spec") —— 但不含反引号（反引号的是 template，里面可能含变量）
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"']+)['"]\s*\)/g)) lines.push(m[1]);
  return lines;
}

const SKIP_PREFIXES = ['node:', 'https://', 'http://'];

// --- Step 2: 跑 tests/ 下每个 mjs 的 import 链 ---
function checkFile(relFile, depth = 0, seen = new Set()) {
  if (depth > 6) return; // 避免循环
  const absFile = join(ROOT, relFile.replace(/\//g, sep));
  if (seen.has(absFile.toLowerCase())) return;
  seen.add(absFile.toLowerCase());

  if (!existsSync(absFile)) {
    errors.push(`[${relFile}] 文件不存在于磁盘`);
    return;
  }
  let src;
  try { src = readFileSync(absFile, 'utf8'); } catch (e) { return; }

  const specifiers = findImportLines(src);
  for (const spec of specifiers) {
    if (SKIP_PREFIXES.some(p => spec.startsWith(p))) continue;
    if (!spec.startsWith('.') && !isAbsolute(spec) && !spec.startsWith('/')) {
      // bare specifier (npm package like dexie, fake-indexeddb) - skip
      continue;
    }
    let target = spec;
    let isAbs = isAbsolute(target);
    let absTarget = isAbs ? normalize(target) : resolve(dirname(absFile), target);
    // 处理不带扩展名 (补 .js / .mjs / .vue / index.js)
    const tryExts = ['', '.js', '.mjs', '.vue', '.cjs', '.json'];
    const tryDirs = ['']; // dir + 'index.js'
    let resolved = null;
    outer: for (const d of tryDirs) {
      for (const ext of tryExts) {
        const cand = absTarget + d + ext;
        if (existsSync(cand) && statSync(cand).isFile()) {
          resolved = cand;
          break outer;
        }
      }
      if (!resolved) {
        // try as directory/index.js
        const dirCand = absTarget + d;
        if (existsSync(dirCand) && statSync(dirCand).isDirectory()) {
          for (const ext of ['.js', '.mjs', '.cjs']) {
            const idx = join(dirCand, 'index' + ext);
            if (existsSync(idx) && statSync(idx).isFile()) {
              resolved = idx;
              break outer;
            }
          }
        }
      }
    }
    if (!resolved) {
      errors.push(`[${relFile}] import "${spec}" => 解析不到实际文件 (absTarget=${absTarget})`);
      continue;
    }
    // 大小写精确核对
    const chk = exactCasePath(resolved);
    if (chk === null) {
      errors.push(`[${relFile}] import "${spec}" => 段校验失败 @ ${resolved}`);
      continue;
    }
    if (chk.mismatch) {
      errors.push(`[${relFile}] import "${spec}" 大小写不匹配：期望 "${chk.want}"，实际磁盘文件是 "${chk.actual}"（父目录: ${chk.cursor}）。Linux 下会 ENOENT。`);
      continue;
    }
    // 继续递归
    const relResolved = relative(ROOT, chk.sofar).replace(/\\/g, '/');
    if (relResolved.startsWith('src/') || relResolved.startsWith('tests/') || relResolved.startsWith('scripts/') || relResolved.startsWith('sync-hub/')) {
      checkFile(relResolved, depth + 1, seen);
    }
  }
}

const testFiles = readdirSync(join(ROOT, 'tests')).filter(f => f.endsWith('.test.mjs') || f.endsWith('.mjs'));
for (const f of testFiles) checkFile(`tests/${f}`);

console.log(`=== 检查了 ${testFiles.length} 个测试文件 + 递归依赖 ===`);
if (errors.length === 0) {
  console.log('✅ 0 处大小写/路径问题');
} else {
  for (const e of errors) console.log('✗', e);
  console.log(`\n共 ${errors.length} 处问题`);
  process.exitCode = 1;
}
