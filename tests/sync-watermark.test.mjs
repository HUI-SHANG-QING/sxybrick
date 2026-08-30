// tests/sync-watermark.test.mjs —— 同步水位与数据域校验（2026-08-30 P0 修复）
// 背景（P0）：原实现只有一个全局水位 `sxy_hub_last_sync`。
//   单模块同步（opts.table）时其它表被写成空数组上传，中枢毫无变化，
//   但水位仍被推到 startedAt —— 那些表里「时间戳早于 startedAt 的未推送变更」
//   从此 `livenessTs(row) > since` 恒为假，**永久静默丢失**。
// 修法：拆成「全局水位 + 每表独立水位」。
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tableSyncKeyOf, resolveSince, advanceWatermark, assertBackupScope,
} from '../src/sync.js';

// localStorage 桩（不依赖真实浏览器全局，便于纯逻辑单测）
function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

const GLOBAL = 'sxy_hub_last_sync';
const ALL = ['cards', 'reviews', 'memos', 'notes', 'docFiles'];

test('tableSyncKeyOf：每表一个独立键', () => {
  assert.equal(tableSyncKeyOf(GLOBAL, 'cards'), 'sxy_hub_last_sync__t_cards');
  assert.notEqual(tableSyncKeyOf(GLOBAL, 'cards'), tableSyncKeyOf(GLOBAL, 'reviews'));
});

test('resolveSince：单模块读该表水位，全量读全局水位', () => {
  const s = memStore({ [GLOBAL]: '1000', [tableSyncKeyOf(GLOBAL, 'cards')]: '5000' });
  assert.equal(resolveSince(s, { globalKey: GLOBAL, table: 'cards' }), 5000);
  assert.equal(resolveSince(s, { globalKey: GLOBAL, table: 'memos' }), 0, '未同步过的表 → 0（全量）');
  assert.equal(resolveSince(s, { globalKey: GLOBAL, table: null }), 1000);
});

test('P0 回归：单模块同步只推进该表水位，绝不动全局水位', () => {
  const s = memStore({ [GLOBAL]: '1000' });
  advanceWatermark(s, { globalKey: GLOBAL, table: 'cards', value: 2000, allTables: ALL });
  assert.equal(s.getItem(GLOBAL), '1000', '全局水位必须原地不动');
  assert.equal(s.getItem(tableSyncKeyOf(GLOBAL, 'cards')), '2000');
  assert.equal(s.getItem(tableSyncKeyOf(GLOBAL, 'memos')), null, '其它表水位不推进');
  // 关键：其它表下次同步仍从旧的全局水位上传，未推送的变更不会丢
  assert.equal(resolveSince(s, { globalKey: GLOBAL, table: 'memos' }), 0);
});

test('P0 回归：单模块同步后再全量同步，仍从旧全局水位起传（不漏数据）', () => {
  const s = memStore({ [GLOBAL]: '1000' });
  advanceWatermark(s, { globalKey: GLOBAL, table: 'notes', value: 9000, allTables: ALL });
  // 用户在 t=3000 改了 memos，单模块同步 notes 不该把它吞掉
  assert.equal(resolveSince(s, { globalKey: GLOBAL, table: 'memos' }), 0);
  assert.equal(resolveSince(s, { globalKey: GLOBAL, table: null }), 1000, '全量仍用旧全局水位');
});

test('全量同步：全局与所有表水位一起拉齐', () => {
  const s = memStore({ [GLOBAL]: '1000', [tableSyncKeyOf(GLOBAL, 'cards')]: '5000' });
  advanceWatermark(s, { globalKey: GLOBAL, table: null, value: 7000, allTables: ALL });
  assert.equal(s.getItem(GLOBAL), '7000');
  for (const t of ALL) assert.equal(s.getItem(tableSyncKeyOf(GLOBAL, t)), '7000', `${t} 水位应拉齐`);
  // 拉齐后单模块同步从新水位起，不会重复上传
  assert.equal(resolveSince(s, { globalKey: GLOBAL, table: 'cards' }), 7000);
});

test('水位值 -1 的边界：同毫秒落库的变更不会被永久跳过', () => {
  // syncWithHub 里：watermark = max(0, min(startedAt, exportedAt) - 1)
  const startedAt = 1000;
  const exportedAt = 1200;
  const wm = Math.max(0, Math.min(startedAt, exportedAt) - 1);
  assert.equal(wm, 999);
  // 一条 ts=1000 的行：若水位取 1000，则 1000 > 1000 为假 → 永久漏传；取 999 则可传
  assert.equal(1000 > wm, true, '边界行必须能被选出');
  assert.equal(1000 > 1000, false, '这正是原实现漏传的原因');
});

test('storage 不可用时不抛错（隐私模式 / 配额耗尽）', () => {
  assert.doesNotThrow(() => resolveSince(undefined, { globalKey: GLOBAL, table: 'cards' }));
  assert.doesNotThrow(() => advanceWatermark({}, { globalKey: GLOBAL, value: 1, allTables: ALL }));
  assert.equal(resolveSince(undefined, { globalKey: GLOBAL, table: 'cards' }), 0);
});

// ---------- 数据域校验（文件导入通道） ----------

test('assertBackupScope：历史包无 scope → 放行（不误伤）', () => {
  assert.doesNotThrow(() => assertBackupScope({ app: 'sxybrick' }));
  assert.doesNotThrow(() => assertBackupScope({ app: 'sxybrick', scope: '' }));
});

test('assertBackupScope：scope 与当前域不一致 → 抛出可读错误', () => {
  // 默认 real 域（_env.mjs 未设置演示模式）
  assert.doesNotThrow(() => assertBackupScope({ app: 'sxybrick', scope: 'real' }));
  assert.throws(
    () => assertBackupScope({ app: 'sxybrick', scope: 'test' }),
    /数据域不匹配/,
    '演示模式包导入真实库必须被拦住',
  );
});
