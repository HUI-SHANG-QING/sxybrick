// scripts/check-view-i18n.mjs
// 质量闸门：校验每个 src/views/*.vue 里所有 t('views.<name>.<key>') 调用，
// 在对应 src/i18n/views/<name>.js 的 zh 字典中都能解析到真实值（非 undefined）。
// 同时校验该视图的字典模块存在（已迁移视图若缺模块会在此暴露）。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const viewsDir = join(root, 'src/views');
const dictDir = join(root, 'src/i18n/views');

function resolve(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

let bad = 0;
const vueFiles = readdirSync(viewsDir).filter(f => f.endsWith('.vue')).sort();
const dictCache = new Map();
for (const f of vueFiles) {
  const src = readFileSync(join(viewsDir, f), 'utf8');
  // 捕获 t('views.<module>.<path>')：首段是字典模块名，其后是 zh 字典内的点号路径
  const calls = [...src.matchAll(/t\(\s*'views\.([A-Za-z0-9_.-]+)'/g)].map(m => m[1].split('.'));
  if (!calls.length) continue;

  for (const parts of calls) {
    const modName = parts[0];
    const keyPath = parts.slice(1).join('.');
    // 动态拼接键（如 t('views.sync.stats.' + k)）无法静态校验，跳过
    if (keyPath.endsWith('.') || keyPath === '') continue;
    let mod = dictCache.get(modName);
    if (mod === undefined) {
      const dictFile = join(dictDir, `${modName}.js`);
      if (!exists(dictFile)) {
        console.error(`✗ ${f}: t('views.${modName}.${keyPath}') 缺少字典模块 src/i18n/views/${modName}.js`);
        bad++;
        dictCache.set(modName, null);
        continue;
      }
      mod = await import(`file://${dictFile.replace(/\\/g, '/')}`);
      dictCache.set(modName, mod);
    }
    if (!mod) continue; // 已报缺模块
    if (resolve(mod.zh, keyPath) === undefined) {
      console.error(`✗ ${f}: t('views.${modName}.${keyPath}') 在 zh 字典中缺失`);
      bad++;
    }
  }
}
console.log(bad ? `✗ 发现 ${bad} 处问题` : '✓ 所有视图的 t() 调用都能在对应 zh 字典解析');
process.exit(bad ? 1 : 0);

function exists(p) {
  try { readFileSync(p); return true; } catch { return false; }
}
