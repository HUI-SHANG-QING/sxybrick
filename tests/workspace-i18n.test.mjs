// tests/workspace-i18n.test.mjs
// 工作台 i18n 回归测试：
// 1) 每个模块 key 在 zh / en 下都有 workspace.mod.<key>.label 与 .desc（返回字符串，不是对象 / undefined）。
//    这类测试专门堵住「dict 键名与 modules.js 的 key 对不上」的翻译缺口（如 user-dashboard vs dashboard）。
// 2) 每个分组 i18nKey 在 zh / en 下都存在。
import assert from 'node:assert/strict';
import test from 'node:test';
import { MODULE_GROUPS } from '../src/workspace/modules.js';
import { t, setLocale } from '../src/i18n/index.js';

const moduleKeys = MODULE_GROUPS.flatMap(g => g.modules.map(m => m.key));
const groupKeys = MODULE_GROUPS.map(g => g.i18nKey.replace('workspace.group.', ''));

test('每个模块 label/desc 在中文下为真实字符串（非对象 / 非缺失）', () => {
  setLocale('zh-CN');
  for (const k of moduleKeys) {
    const label = t('workspace.mod.' + k + '.label', 'FALLBACK');
    const desc = t('workspace.mod.' + k + '.desc', 'FALLBACK');
    assert.equal(typeof label, 'string', `zh: workspace.mod.${k}.label 应返回字符串，实际=${JSON.stringify(label)}`);
    assert.equal(typeof desc, 'string', `zh: workspace.mod.${k}.desc 应返回字符串，实际=${JSON.stringify(desc)}`);
    assert.notEqual(label, 'FALLBACK', `zh: workspace.mod.${k}.label 缺失（dict 键名与 modules.js key 对不上？）`);
    assert.notEqual(desc, 'FALLBACK', `zh: workspace.mod.${k}.desc 缺失`);
  }
});

test('每个模块 label/desc 在英文下为真实字符串（非对象 / 非缺失）', () => {
  setLocale('en');
  for (const k of moduleKeys) {
    const label = t('workspace.mod.' + k + '.label', 'FALLBACK');
    const desc = t('workspace.mod.' + k + '.desc', 'FALLBACK');
    assert.equal(typeof label, 'string', `en: workspace.mod.${k}.label 应返回字符串，实际=${JSON.stringify(label)}`);
    assert.equal(typeof desc, 'string', `en: workspace.mod.${k}.desc 应返回字符串，实际=${JSON.stringify(desc)}`);
    assert.notEqual(label, 'FALLBACK', `en: workspace.mod.${k}.label 缺失（dict 键名与 modules.js key 对不上？）`);
    assert.notEqual(desc, 'FALLBACK', `en: workspace.mod.${k}.desc 缺失`);
  }
  setLocale('zh-CN'); // 复位，避免影响其它测试文件
});

test('每个分组标题在 zh / en 下都存在', () => {
  for (const lang of ['zh-CN', 'en']) {
    setLocale(lang);
    for (const gk of groupKeys) {
      const v = t('workspace.group.' + gk, 'FALLBACK');
      assert.notEqual(v, 'FALLBACK', `${lang}: workspace.group.${gk} 缺失`);
    }
  }
  setLocale('zh-CN');
});

test('workspace 核心 chrome 键在两个语言下都存在', () => {
  const chromeKeys = [
    'title', 'sub', 'offline', 'backup', 'loading', 'refresh', 'todayDue',
    'startReview', 'startReviewNone', 'overdueHint', 'miniDoneToday', 'miniMastery',
    'miniRisk', 'matrix', 'searchPlaceholder', 'noMatch', 'secRisk', 'secHealth',
    'secDiag', 'noRisk', 'notifications', 'unread', 'noNotify', 'recentActivity',
    'noActivity', 'deletedCard', 'loadingAgg', 'noSync', 'healthDup', 'healthZombie',
    'healthOrphan', 'rateOk', 'rateWarn', 'rateFail',
  ];
  for (const lang of ['zh-CN', 'en']) {
    setLocale(lang);
    for (const ck of chromeKeys) {
      const v = t('workspace.' + ck, 'FALLBACK');
      assert.notEqual(v, 'FALLBACK', `${lang}: workspace.${ck} 缺失`);
    }
  }
  setLocale('zh-CN');
});
