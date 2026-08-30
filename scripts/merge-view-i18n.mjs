// scripts/merge-view-i18n.mjs
// 自动把 src/i18n/views/*.js 全部合并进 src/i18n/index.js：
//   - 在「合并业务视图字典」标记与 `export const DICTS` 之间生成 import + 赋值块
//   - 每个模块文件名 <name>.js 对应 zh.views.<name> / en.views.<name>（与视图里 t('views.<name>.*') 一致）
// 用法：新增视图模块后执行 `node scripts/merge-view-i18n.mjs`。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const indexFile = join(root, 'src/i18n/index.js');
const viewsDir = join(root, 'src/i18n/views');

const files = readdirSync(viewsDir).filter(f => f.endsWith('.js')).sort();
if (!files.length) {
  console.error('src/i18n/views/ 下没有字典模块');
  process.exit(1);
}

const startMark = '// —— 合并业务视图字典（每个视图一个模块，见 src/i18n/views/*.js） ——';
const endMark = "export const DICTS = { 'zh-CN': zh, en };";

let src = readFileSync(indexFile, 'utf8');
const startIdx = src.indexOf(startMark);
const endIdx = src.indexOf(endMark);
if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
  console.error('index.js 中找不到合并标记，结构可能已变');
  process.exit(1);
}

const imports = files.map(f => {
  const name = f.replace(/\.js$/, '');
  const ident = name.replace(/[^A-Za-z0-9_]/g, '_');
  return `import { zh as ${ident}Zh, en as ${ident}En } from './views/${name}.js';`;
});
const assigns = files.flatMap(f => {
  const name = f.replace(/\.js$/, '');
  const ident = name.replace(/[^A-Za-z0-9_]/g, '_');
  return [`zh.views.${name} = ${ident}Zh;`, `en.views.${name} = ${ident}En;`];
});

const block = [
  startMark,
  ...imports,
  '',
  ...assigns,
  '',
  endMark,
].join('\n');

src = src.slice(0, startIdx) + block + src.slice(endIdx + endMark.length);
writeFileSync(indexFile, src, 'utf8');
console.log(`OK: merged ${files.length} view module(s) -> ${files.join(', ')}`);
