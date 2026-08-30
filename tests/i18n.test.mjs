// i18n 地基测试：t() 取词 / 中英文切换 / 缺失回退 / 算法说明可遍历
import 'fake-indexeddb/auto';
import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t, locale, setLocale, LOCALES } from '../src/i18n/index.js';

test('zh-CN 默认取中文词', () => {
  setLocale('zh-CN');
  assert.equal(t('nav.cards'), '卡片');
  assert.equal(t('settings.engine'), '🧠 学习引擎');
  assert.equal(t('nav.privacy'), '超级监控');
});

test('切 en 后取英文词，且 locale 同步', () => {
  setLocale('en');
  assert.equal(locale.value, 'en');
  assert.equal(t('nav.cards'), 'Cards');
  assert.equal(t('settings.engine'), '🧠 Learning Engine');
  assert.equal(t('nav.privacy'), 'Super Monitor');
  setLocale('zh-CN'); // 复原，避免影响后续用例
});

test('缺失键：英文缺失→回退中文；再缺失→回退 fallback/key', () => {
  setLocale('en');
  // engine.fsrs.trainBtn 在 en 中存在
  assert.equal(t('engine.fsrs.trainBtn'), 'Training…');
  // 完全不存在的键 → 回退传入的 fallback
  assert.equal(t('totally.unknown.key', '兜底文案'), '兜底文案');
  setLocale('zh-CN');
});

test('engine 算法说明为数组且可遍历', () => {
  const sm2 = t('engine.sm2.impl', []);
  const fsrs = t('engine.fsrs.impl', []);
  assert.ok(Array.isArray(sm2) && sm2.length >= 5, 'SM-2 实现要点可遍历');
  assert.ok(Array.isArray(fsrs) && fsrs.length >= 3, 'FSRS 实现要点可遍历');
  assert.ok(t('engine.fsrs.weights').includes('19'), '权重说明含 19 个');
});

test('LOCALES 含中英文两档', () => {
  const codes = LOCALES.map((l) => l.code);
  assert.ok(codes.includes('zh-CN') && codes.includes('en'));
});
