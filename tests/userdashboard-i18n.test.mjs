// tests/userdashboard-i18n.test.mjs —— 仪表盘 i18n 的三道护栏
//
// 背景：scripts/check-view-i18n.mjs 只认字面量 t('views.xxx.yyy')。
// UserDashboard.vue 用的是本地包装函数 T('key')（内部拼成 'views.userDashboard.'+key），
// 静态正则抓不到 —— 一旦字典键改名或漏译，闸门不会报，页面会直接显示裸 key。
// 这几条用例把「动态键」这个盲区补上，并顺带锁住跨层约定：
// 领域层（repo.bestWorstPartners）只回 i18n code + params，不许再产中文散文。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vue = readFileSync(join(root, 'src/views/UserDashboard.vue'), 'utf8');
const dict = await import('../src/i18n/views/userDashboard.js');

function resolve(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// 从 T('xxx') 里抠出所有字面量键（T('a.b', {..}) 也匹配）
const usedKeys = [...new Set([...vue.matchAll(/\bT\(\s*'([A-Za-z0-9_.-]+)'/g)].map(m => m[1]))];

test('扫描自检：确实抓到了 T() 键（防止正则失效后用例空跑）', () => {
  assert.ok(usedKeys.length >= 20, `应抓到 20+ 个键，实际 ${usedKeys.length}`);
  assert.ok(usedKeys.includes('title'));
  assert.ok(usedKeys.includes('chart.heatmap'));
  assert.ok(usedKeys.includes('partner.head'));
});

test('UserDashboard：所有 T() 键在 zh / en 字典中都存在且是字符串', () => {
  for (const k of usedKeys) {
    const zhV = resolve(dict.zh, k);
    const enV = resolve(dict.en, k);
    assert.notEqual(zhV, undefined, `zh 缺键：${k}`);
    assert.notEqual(enV, undefined, `en 缺键：${k}`);
    assert.equal(typeof zhV, 'string', `zh 的 ${k} 应为字符串（对象需拆叶键）`);
    assert.equal(typeof enV, 'string', `en 的 ${k} 应为字符串`);
  }
});

// repo.bestWorstPartners 会产出的全部 code（新增分支时必须同步字典 + 这里）
const PARTNER_CODES = [
  'notEnough', 'a.best', 'a.worst', 'b.best', 'b.worst', 'c.best', 'c.worst', 'd.best', 'd.worst',
];

test('UserDashboard：拍档 16 组合用到的 9 个 code × 3 段文案齐全', () => {
  for (const code of PARTNER_CODES) {
    for (const seg of ['title', 'desc', 'suggest']) {
      const k = `partner.${code}.${seg}`;
      assert.equal(typeof resolve(dict.zh, k), 'string', `zh 缺 ${k}`);
      assert.equal(typeof resolve(dict.en, k), 'string', `en 缺 ${k}`);
    }
  }
});

test('UserDashboard：字典与 repo 的拍档 code 集合完全一致（不多不少）', () => {
  const inDict = ['notEnough'];
  for (const g of ['a', 'b', 'c', 'd']) for (const p of ['best', 'worst']) inDict.push(`${g}.${p}`);
  for (const code of inDict) {
    for (const seg of ['title', 'desc', 'suggest']) {
      assert.notEqual(resolve(dict.zh, `partner.${code}.${seg}`), undefined, `字典多出 ${code}.${seg}`);
    }
  }
  for (const code of PARTNER_CODES) assert.ok(inDict.includes(code), `repo 会产出字典里没有的 code：${code}`);
  assert.equal(inDict.length, PARTNER_CODES.length);
});

test('UserDashboard：带占位符的键，zh/en 的 {param} 集合一致', () => {
  const ph = (s) => new Set([...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]));
  const walk = (obj, prefix, out) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object') walk(v, p, out);
      else if (typeof v === 'string') out[p] = v;
    }
    return out;
  };
  const zh = walk(dict.zh, '', {});
  const en = walk(dict.en, '', {});
  for (const [k, v] of Object.entries(zh)) {
    const a = ph(v), b = ph(en[k] ?? '');
    const diff = [...a].filter(x => !b.has(x)).concat([...b].filter(x => !a.has(x)));
    assert.equal(diff.length, 0, `${k} 占位符不一致：${diff.join(',')}`);
  }
});

// ---------------------------------------------------------------------------
// 全站字典结构自检：键名里不能带点
// ---------------------------------------------------------------------------
test('全部字典：键名不得含点号（t() 按点切分路径，含点键永远取不到）', async () => {
  const { readdirSync } = await import('node:fs');
  const dir = join(root, 'src/i18n/views');
  const found = [];
  const check = (obj, path, where) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (k.includes('.')) found.push(`${where}: ${path}${k}`);
      if (v && typeof v === 'object' && !Array.isArray(v)) check(v, `${path}${k}.`, where);
    }
  };
  const { DICTS } = await import('../src/i18n/index.js');
  check(DICTS['zh-CN'], '', '根字典');
  check(DICTS.en, '', '根字典(en)');
  for (const f of readdirSync(dir).filter(x => x.endsWith('.js'))) {
    const m = await import(`../src/i18n/views/${f}`);
    check(m.zh, '', f);
    check(m.en, '', f);
  }
  assert.deepEqual(found, [], `以下字典键含点号，t() 无法解析：\n${found.join('\n')}`);
});

// ---------------------------------------------------------------------------
// 跨层约定：领域层不许再产 localized 散文
// ---------------------------------------------------------------------------
const { bestWorstPartners } = await import('../src/repo.js');
const HAS_CJK = /[一-鿿]/;

test('repo.bestWorstPartners：空库回 not-enough，只给 i18n code + params（无中文散文）', async () => {
  const r = await bestWorstPartners({ rangeDays: 7, kind: 'A', worst: false });
  assert.equal(r.notEnough, true);
  assert.equal(r.i18n.code, 'notEnough');
  assert.deepEqual(r.i18n.params, { days: 7 });
  // 旧实现在这里塞了 title/desc 两段中文，切英文后整块仍是中文
  assert.equal(r.title, undefined, '领域层不应再返回 title（文案归视图层）');
  assert.equal(r.desc, undefined, '领域层不应再返回 desc');
  assert.equal(r.suggest, undefined, '领域层不应再返回 suggest');
  assert.equal(HAS_CJK.test(JSON.stringify(r.i18n)), false, 'i18n 载荷里不允许出现中文');
});

test('repo.bestWorstPartners：四种 kind × best/worst 都不抛错，且必定带合法 i18n code', async () => {
  const codes = new Set(PARTNER_CODES);
  for (const kind of ['A', 'B', 'C', 'D']) {
    for (const worst of [false, true]) {
      const r = await bestWorstPartners({ rangeDays: 7, kind, worst });
      assert.ok(r && typeof r === 'object', `kind=${kind} worst=${worst} 应返回对象`);
      assert.ok(Array.isArray(r.items), 'items 必须是数组（视图依赖 .length）');
      assert.ok(codes.has(r.i18n?.code), `未知 code：${r.i18n?.code}`);
      assert.equal(HAS_CJK.test(JSON.stringify(r.i18n)), false, `kind=${kind} 的 i18n 载荷含中文`);
    }
  }
});
