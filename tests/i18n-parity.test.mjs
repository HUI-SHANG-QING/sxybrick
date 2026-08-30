// tests/i18n-parity.test.mjs
// i18n 质量铁律：zh-CN 与 en 字典键结构必须完全一致。
// 任意一方缺键（漏翻英文）或多出键（中文键名漂移）立即红 —— 杜绝「中文有、英文回退中文」的半截翻译。
import assert from 'node:assert/strict';
import test from 'node:test';
import { DICTS } from '../src/i18n/index.js';

// 数组（如 engine.sm2.impl）视为叶子值，不递归展开；其余对象递归收集点号路径键
function collectKeys(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...collectKeys(v, key));
    else out.push(key);
  }
  return out;
}

const zhKeys = new Set(collectKeys(DICTS['zh-CN']));
const enKeys = new Set(collectKeys(DICTS.en));

test('zh-CN 与 en 字典键结构完全一致（无缺翻 / 无漂移）', () => {
  const missingInEn = [...zhKeys].filter(k => !enKeys.has(k)).sort();
  const extraInEn = [...enKeys].filter(k => !zhKeys.has(k)).sort();
  assert.deepStrictEqual(missingInEn, [], `en 缺少以下键（需补英文翻译）：${missingInEn.join(', ')}`);
  assert.deepStrictEqual(extraInEn, [], `en 多出以下键（中文侧无对应）：${extraInEn.join(', ')}`);
});

test('字典覆盖应有命名空间', () => {
  for (const ns of ['nav', 'settings', 'engine', 'workspace', 'views', 'common']) {
    assert.ok(DICTS['zh-CN'][ns], `zh 缺少命名空间 ${ns}`);
    assert.ok(DICTS.en[ns], `en 缺少命名空间 ${ns}`);
  }
});
