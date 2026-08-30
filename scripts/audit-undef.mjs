// 静态审计：模板里引用了 script 中不存在的标识符
// 这类问题编译不报错，运行时表现为「页面某块渲染不出来」或直接抛 TypeError。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';

const SRC = join(process.cwd(), 'src');
function walk(d, out = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith('.vue')) out.push(p);
  }
  return out;
}

const hits = [];
for (const f of walk(SRC)) {
  const rel = relative(SRC, f);
  let d;
  try { d = parse(readFileSync(f, 'utf8'), { filename: f }).descriptor; } catch { continue; }
  if (!d.template?.content) continue;

  let bindings = null;
  if (d.scriptSetup || d.script) {
    try { bindings = compileScript(d, { id: rel, inlineTemplate: false }).bindings; } catch { continue; }
  }
  let res;
  try {
    res = compileTemplate({
      source: d.template.content, filename: rel, id: rel,
      compilerOptions: { bindingMetadata: bindings || undefined, prefixIdentifiers: true },
    });
  } catch (e) { hits.push([rel, 'FATAL', String(e.message || e).slice(0, 140)]); continue; }

  for (const e of res.errors || []) {
    const msg = String(e.message || e);
    if (/not defined|not exist/i.test(msg)) hits.push([rel, 'UNDEF', msg.slice(0, 160)]);
  }
}

console.log(`扫描 ${walk(SRC).length} 个 .vue\n`);
if (!hits.length) console.log('未发现未定义标识符引用');
else for (const [f, k, m] of hits) console.log(`${k}  ${f}\n      ${m}`);
