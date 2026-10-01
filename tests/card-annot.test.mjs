// tests/card-annot.test.mjs —— 背诵卡片批注（数据层 + 防回归结构约束）
//
// 覆盖需求里的验收点：
//   · 时间戳自动生成、格式 YYYY-MM-DD HH:mm:ss
//   · 多条批注按时间倒序
//   · 空内容不能保存
//   · 刷新后仍在（落 IndexedDB，非内存）
//   · 切换卡片批注不串数据
//   · 旧卡片无批注时正常（返回空数组，不抛错）
//   · 批注**不写进卡片正/背面字段**（隔离性，硬性要求）
//   · 加载失败不阻塞复习（读接口对错误宽容）
//
// ⚠️ 无法在 node 环境真实点击的项（点击不触发翻转 / 桌面右侧布局 / 移动端不挤压），
//    用**源码结构断言**守住关键约束（@click.stop、默认关闭、flex 规则），并在测试名里标明。
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import 'fake-indexeddb/auto';
import './_env.mjs';
import { db } from '../src/db.js';
import {
  listAnnots, countAnnots, addAnnot, updateAnnot, softDeleteAnnot, restoreAnnot,
  normalizeAnnotContent, formatAnnotTs, ANNOT_MAX_CHARS,
} from '../src/annot-repo.js';

const SRC = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

beforeEach(async () => { await db.cardAnnots.clear(); });

// ---------------------------------------------------------------- 数据层

test('新增批注：自动生成时间戳，且内容独立存放（不写卡片字段）', async () => {
  await db.cards.put({ id: 'c-1', front: '正面原文', back: '背面原文', subject: '计组' });
  const before = await db.cards.get('c-1');

  const row = await addAnnot('c-1', '  停止-等待协议要记窗口大小  ');
  assert.ok(row.id, '应生成 id');
  assert.equal(row.cardId, 'c-1');
  assert.equal(row.content, '停止-等待协议要记窗口大小', '首尾空白应被裁掉');
  assert.ok(Number.isFinite(row.createdAt) && row.createdAt > 0, 'createdAt 应自动生成');
  assert.equal(row.createdAt, row.updatedAt, '新建时两个时间戳一致');
  assert.equal(row.deletedAt, null);

  // 隔离性：卡片正/背面一个字符都不能变
  const after = await db.cards.get('c-1');
  assert.equal(after.front, before.front, '批注不得修改卡片正面');
  assert.equal(after.back, before.back, '批注不得修改卡片背面');
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), '不得往卡片对象上挂新字段');
});

test('多条批注按 createdAt 倒序（最新在最上）', async () => {
  for (const [i, text] of [[1, '第一条'], [2, '第二条'], [3, '第三条']]) {
    const r = await addAnnot('c-2', text);
    await db.cardAnnots.put({ ...r, createdAt: 1000 * i, updatedAt: 1000 * i }); // 固定时间，避免同毫秒
  }
  const list = await listAnnots('c-2');
  assert.deepEqual(list.map((a) => a.content), ['第三条', '第二条', '第一条']);
});

test('空内容 / 纯空白不允许保存', async () => {
  await assert.rejects(() => addAnnot('c-3', ''), /ANN_EMPTY/);
  await assert.rejects(() => addAnnot('c-3', '   \n\t '), /ANN_EMPTY/);
  await assert.rejects(() => addAnnot('', '有内容但没卡'), /ANN_NO_CARD/);
  assert.equal(await countAnnots('c-3'), 0, '失败的写入不应落库');
});

test(`超长内容被截断到 ${ANNOT_MAX_CHARS} 字（写入边界收口）`, async () => {
  const row = await addAnnot('c-4', 'x'.repeat(ANNOT_MAX_CHARS + 500));
  assert.equal(row.content.length, ANNOT_MAX_CHARS);
  assert.equal(normalizeAnnotContent('  a  '), 'a');
});

test('编辑只改内容，保留原 createdAt（时间戳不可手动修改）', async () => {
  const row = await addAnnot('c-5', '原始心得');
  await new Promise((r) => setTimeout(r, 5));
  const next = await updateAnnot(row.id, '修改后的心得');
  assert.equal(next.content, '修改后的心得');
  assert.equal(next.createdAt, row.createdAt, 'createdAt 必须原样保留');
  assert.ok(next.updatedAt >= row.updatedAt, 'updatedAt 应推进');
});

test('删除为软删除：列表不再返回，但行还在且可恢复', async () => {
  const row = await addAnnot('c-6', '待删除');
  assert.equal(await softDeleteAnnot(row.id), true);
  assert.equal((await listAnnots('c-6')).length, 0, '软删除后不应出现在列表');
  assert.equal(await countAnnots('c-6'), 0);

  const raw = await db.cardAnnots.get(row.id);
  assert.ok(raw, '软删除不物理删行（可撤销、删除状态可跨设备同步）');
  assert.ok(raw.deletedAt > 0);

  assert.equal(await restoreAnnot(row.id), true);
  assert.equal((await listAnnots('c-6')).length, 1, '恢复后应重新出现');
});

test('切换卡片：批注按 cardId 隔离，绝不串数据', async () => {
  await addAnnot('c-A', 'A 卡的心得');
  await addAnnot('c-B', 'B 卡的心得');
  const a = await listAnnots('c-A');
  const b = await listAnnots('c-B');
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].content, 'A 卡的心得');
  assert.equal(b[0].content, 'B 卡的心得');
});

test('旧卡片（无任何批注）正常：返回空数组，不抛错', async () => {
  assert.deepEqual(await listAnnots('never-annotated'), []);
  assert.equal(await countAnnots('never-annotated'), 0);
  assert.deepEqual(await listAnnots(''), []);
  assert.deepEqual(await listAnnots(null), []);
});

test('复习上下文快照：自动记录第几次复习与当时等级；取不到也不阻塞保存', async () => {
  await db.cards.put({ id: 'c-7', front: 'F', back: 'B', level: 4, subject: '线代' });
  await db.reviews.put({ id: 'rv-1', cardId: 'c-7', reviewedAt: Date.now() });
  await db.reviews.put({ id: 'rv-2', cardId: 'c-7', reviewedAt: Date.now() + 1 });
  const row = await addAnnot('c-7', '第二次复习的心得');
  assert.equal(row.reviewCount, 2);
  assert.equal(row.level, 4);

  // 卡片不存在 / 从未复习：快照为 null 或 0，但批注本体必须存下来
  const orphan = await addAnnot('c-ghost', '孤儿卡心得');
  assert.ok(orphan.id, '快照取不到时仍要保存成功');
  assert.equal(orphan.reviewCount, 0);
  assert.equal(orphan.level, null);
});

test('时间戳格式为 YYYY-MM-DD HH:mm:ss（本地时区）', () => {
  const d = new Date(2026, 8, 24, 9, 5, 7); // 2026-09-24 09:05:07 本地时间
  assert.equal(formatAnnotTs(d.getTime()), '2026-09-24 09:05:07');
  assert.match(formatAnnotTs(Date.now()), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(formatAnnotTs('not-a-time'), '');
});

test('读接口对故障宽容：库异常时返回空值而不抛出（不阻塞背诵主流程）', async () => {
  const orig = db.cardAnnots.where;
  db.cardAnnots.where = () => { throw new Error('boom'); };
  try {
    assert.deepEqual(await listAnnots('c-x'), [], '加载失败必须退化为空列表而非抛错');
    assert.equal(await countAnnots('c-x'), 0);
  } finally {
    db.cardAnnots.where = orig;
  }
});

// ------------------------------------------------- 防回归：结构与集成约束

test('FlipCard 的批注入口默认关闭，且不冒泡（防触发翻面/评分）', () => {
  const src = read(`${SRC}/components/FlipCard.vue`);
  assert.match(src, /showAnnot:\s*\{\s*type:\s*Boolean,\s*default:\s*false\s*\}/,
    'showAnnot 必须默认 false —— 其他使用方（Exam/卡片预览）零变化');
  assert.match(src, /annotOpen:\s*\{\s*type:\s*Boolean,\s*default:\s*false\s*\}/);
  assert.match(src, /annotCount:\s*\{\s*type:\s*Number,\s*default:\s*0\s*\}/);
  assert.match(src, /@click\.stop="emit\('annot'\)"/, '批注按钮必须 @click.stop，否则会冒泡触发卡片翻面');
  assert.match(src, /aria-expanded="annotOpen \? 'true' : 'false'"/, '可访问性：需要 aria-expanded');
  assert.match(src, /aria-controls="card-annot-panel"/, '可访问性：需要 aria-controls 指向面板');
  assert.match(src, /v-if="showAnnot"/, '未开启时不应渲染批注入口（零 DOM）');
});

test('CardAnnotation 面板：多根 Fragment、宽度自管、escoped 隔离、Esc 避让卡片全屏', () => {
  const src = read(`${SRC}/components/CardAnnotation.vue`);
  assert.match(src, /<style scoped>/, '样式必须 scoped，禁止污染全局');
  assert.match(src, /flex:\s*0 0 auto;[\s\S]{0,80}width:\s*clamp\(/, '面板宽度由组件自管（多根 Fragment，父级 scoped 选不中）');
  assert.match(src, /@media \(max-width:\s*720px\)[\s\S]{0,120}width:\s*100%/, '窄屏改整宽（不挤压卡片）');
  assert.match(src, /document\.querySelector\('\.content-fs-overlay'\)/, 'Esc 必须先避让卡片内容全屏，不能一键关两层');
  assert.match(src, /reqSeq/, '异步加载必须有请求序号防竞态');
  assert.match(src, /addEventListener\('keydown', onDocKey\)/, 'Esc 监听应为面板展开时挂载');
  assert.doesNotMatch(src, /confirm\(/, '不得用原生 confirm（项目统一 confirmDialog）');
});

test('Review.vue：切换卡片时收起批注面板，并把状态留在页面层', () => {
  const src = read(`${SRC}/views/Review.vue`);
  assert.match(src, /const annotOpen = ref\(false\)/);
  assert.match(src, /watch\(\[idx, queue\][\s\S]{0,220}annotOpen\.value = false/,
    '切卡必须自动收起（需求 3）');
  assert.match(src, /:show-annot="true"/, '只有复习页开启批注入口');
  assert.match(src, /\.review-card-wrap\.has-annot[\s\S]{0,160}display:\s*flex/, '桌面端并排');
  assert.match(src, /align-items:\s*stretch/, '面板需与卡片等高');
});

test('批注表已登记同步清单，且 BACKUP_VERSION 已提升', () => {
  const manifest = read(`${SRC}/sync-manifest.js`);
  assert.match(manifest, /\{\s*table:\s*'cardAnnots'/, '新表必须登记（否则 sync-coverage-audit 闸门报红）');
  assert.match(manifest, /BACKUP_VERSION = 11/, '同步集合演进必须 +1');
  const dbSrc = read(`${SRC}/db.js`);
  assert.match(dbSrc, /d\.version\(35\)\.stores\(\{[\s\S]{0,200}cardAnnots:/, 'db 需有 v35 声明该表');
});

test('数据层只碰 cardAnnots：绝不写 cards 表（硬性要求）', () => {
  const src = read(`${SRC}/annot-repo.js`);
  assert.match(src, /db\.cardAnnots\./);
  assert.doesNotMatch(src, /db\.cards\.(put|add|update|delete|bulkPut|bulkAdd)\b/,
    'annot-repo 不得写入 cards（只能 get 读取，用于复习上下文快照）');
  assert.match(src, /db\.cards\.get\(/, '允许读卡片取 level 快照');
});
