// tests/i18n-dynamic-family.test.mjs —— P3-4（round14）：动态拼接键家族完整性
// 背景：正向闸用 (?=[,)]) 前瞻豁免了 t('views.x.' + key) 动态拼接的存在性校验，
// 「43 视图 t() 可解析」不含动态键——新增动态键家族漏配字典项时正向闸不报、
// 运行时回退 key 原文（英文界面显示 views.x.xxx）。
// 本测试：自动扫描所有 .vue 的动态拼接前缀（family），验证 zh/en 两字典
// 在该前缀下的成员键集一致且非空、成员子树键位一致（防 Name/Desc 漏配与 zh/en 漂移）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const viewsDir = join(__dirname, '..', 'src', 'views');
const dictDir = join(__dirname, '..', 'src', 'i18n', 'views');

// 扫描 .vue 里 t('views.<mod>.<family>' + …) 的动态拼接前缀
// 返回 [{ prefix, hasFallback }]：hasFallback = 调用带第二参（t(key, fb)），
// 有 fallback 的动态键字典缺成员是设计使然（如 PrivacyData 的 type./sub./portion./bristol），
// 只做弱校验；无 fallback 的必须字典有成员（漏配 = 运行时回退 key 原文）。
function scanDynamicFamilies() {
  const files = readdirSync(viewsDir).filter(f => f.endsWith('.vue')).sort();
  const families = new Map();
  for (const f of files) {
    const src = readFileSync(join(viewsDir, f), 'utf8');
    for (const m of src.matchAll(/t\(\s*'views\.[A-Za-z0-9_.-]+'\s*\+/g)) {
      const prefix = m[0].replace(/^t\(\s*'/, '').replace(/'\s*\+$/, '');
      // 从匹配起点向后找该调用结束的 ')'，期间出现逗号 → 有 fallback
      const tail = src.slice(m.index, src.indexOf(')', m.index + m[0].length) + 1);
      const hasFallback = /,\s*[^,)]/.test(tail.slice(m[0].length));
      families.set(prefix, { prefix, hasFallback });
    }
  }
  return [...families.values()].sort((a, b) => a.prefix.localeCompare(b.prefix));
}

// 展平字典：{ 'a.b': 'v' }
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, path, out);
    else out[path] = v;
  }
  return out;
}

test('P3-4：动态拼接键家族在 zh/en 字典中成员键集一致且非空', async () => {
  const families = scanDynamicFamilies();
  assert.ok(families.length >= 8, `应扫描到 ≥8 个动态家族，实际 ${families.length}`);
  const dicts = {};
  for (const mod of new Set(families.map(f => f.prefix.split('.')[1]))) {
    const { zh, en } = await import(`file://${join(dictDir, `${mod}.js`).replace(/\\/g, '/')}`);
    dicts[mod] = { zh: flatten(zh), en: flatten(en) };
  }

  const strictFamilies = families.filter(f => !f.hasFallback);
  const weakFamilies = families.filter(f => f.hasFallback);
  assert.ok(strictFamilies.length >= 6, `无 fallback 动态家族应 ≥6，实际 ${strictFamilies.length}`);

  const strictKeys = new Set(strictFamilies.map(f => f.prefix));
  const weakKeys = new Set(weakFamilies.map(f => f.prefix));
  for (const { prefix } of [...strictFamilies, ...weakFamilies]) {
    const mod = prefix.split('.')[1];
    const { zh, en } = dicts[mod];
    if (!zh || !en) {
      assert.fail(`${prefix}: 字典模块 ${mod}.js 不存在`);
      continue;
    }
    // 字典模块内路径（flatten 键不带 'views.<mod>.' 前缀）：
    // 'views.wordBook.kind' → 'kind'（部分前缀，匹配 kindWord/kindPhrase…）
    // 'views.plugins.' → ''（对象家族，匹配全部顶级键）
    const inner = prefix.split('.').slice(2).join('.');
    // 成员 = 以模块内前缀开头的路径的「下一段」
    const member = (paths) => {
      const set = new Set();
      for (const p of Object.keys(paths)) {
        if (inner && p === inner) continue;            // 前缀本身不是成员
        if (inner && !p.startsWith(inner)) continue;
        const rest = inner ? p.slice(inner.length) : p;
        if (rest.startsWith('.')) set.add(rest.split('.')[1]);
        else if (rest) set.add(rest); // 部分前缀（kindWord 去掉 kind 剩 Word）
      }
      return set;
    };
    const zhMembers = member(zh);
    const enMembers = member(en);
    if (strictKeys.has(prefix)) { // 无 fallback：字典必须有成员
      assert.ok(zhMembers.size > 0, `${prefix}: zh 字典应有动态成员`);
      assert.ok(enMembers.size > 0, `${prefix}: en 字典应有动态成员`);
    }
    // 有成员时必须 zh/en 一致（弱校验也拦漂移）
    if (zhMembers.size || enMembers.size) {
      const diff = [...zhMembers].filter(x => !enMembers.has(x)).concat([...enMembers].filter(x => !zhMembers.has(x)));
      assert.equal(diff.length, 0, `${prefix}: zh/en 成员键集漂移 ${JSON.stringify(diff)}`);
    }

    // 每个成员的子树键位一致（如 plugins.<key> 的 Name/Desc 缺一即报）
    const base = inner || '';
    for (const mem of zhMembers) {
      const memPrefix = `${base}${base && !base.endsWith('.') ? '.' : ''}${mem}`;
      const zhSub = Object.keys(zh).filter(p => p === memPrefix || p.startsWith(`${memPrefix}.`)).sort();
      const enSub = Object.keys(en).filter(p => p === memPrefix || p.startsWith(`${memPrefix}.`)).sort();
      assert.equal(zhSub.length, enSub.length, `${prefix}.${mem}: zh/en 子键数量不一致`);
      for (let i = 0; i < zhSub.length; i++) {
        assert.equal(zhSub[i], enSub[i], `${prefix}.${mem}: zh/en 子键漂移`);
      }
    }
  }
});

test('P3-4：扫描到的动态家族与已知清单吻合（防扫描正则退化）', async () => {
  const families = scanDynamicFamilies();
  const keys = families.map(f => f.prefix);
  // 关键家族必须存在（正则退化时此处拦截）
  for (const must of ['views.wordBook.kind', 'views.cardLinkAnalysis.preset.', 'views.plugins.', 'views.plans.', 'views.knowledgeGraph.']) {
    assert.ok(keys.includes(must), `动态家族 ${must} 应被扫描到`);
  }
  // PrivacyData 的 fallback 型家族应被识别为弱校验（否则强校验误报）
  const privacy = families.find(f => f.prefix === 'views.privacyData.type.');
  assert.ok(privacy && privacy.hasFallback, 'views.privacyData.type. 应识别为有 fallback（弱校验）');
});
