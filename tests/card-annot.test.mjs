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
//   · 删除 = 物理删行 + 墓碑，且墓碑经 applyTombstones 能清除对端行（跨设备删除闭环）
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
  listAnnots, addAnnot, updateAnnot, deleteAnnot,
  normalizeAnnotContent, formatAnnotTs, ANNOT_MAX_CHARS,
} from '../src/annot-repo.js';

const SRC = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

beforeEach(async () => {
  await db.cardAnnots.clear();
  await db.tombstones.clear();
});

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

  // 隔离性：卡片正/背面一个字符都不能变，也不得新增字段
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
  assert.equal((await listAnnots('c-3')).length, 0, '失败的写入不应落库');
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

test('删除 = 物理删行 + 写墓碑（跨设备删除才有效，不再用行内软删除字段）', async () => {
  const row = await addAnnot('c-6', '待删除');
  assert.equal(await deleteAnnot(row.id), true);
  assert.equal((await listAnnots('c-6')).length, 0, '删除后不应出现在列表');
  assert.equal(await db.cardAnnots.get(row.id), undefined, '行应被物理删除');

  const t = (await db.tombstones.toArray()).find((x) => x.id === row.id);
  assert.ok(t, '必须写墓碑，否则对端同 id 行下次合并会按「新行」回灌');
  assert.equal(t.kind, 'cardAnnot', 'kind 必须与 sync-manifest 登记一致');
  assert.ok(t.deletedAt > 0, '墓碑需带删除时间');

  assert.equal(await deleteAnnot(row.id), false, '重复删除应返回 false（目标已不存在）');
});

test('墓碑经 applyTombstones 能清除对端同 id 行（跨设备删除闭环）', async () => {
  const { applyTombstones } = await import('../src/sync-manifest.js');
  const row = await addAnnot('c-sync', 'A 端删除的批注');
  await deleteAnnot(row.id);
  const tombs = (await db.tombstones.toArray()).filter((t) => t.kind === 'cardAnnot');
  assert.equal(tombs.length, 1);

  // 模拟对端：还留着这行（其 liveness 早于墓碑）
  const out = applyTombstones([{ ...row }], tombs, 'cardAnnot', Date.now() + 1000);
  assert.deepEqual(out.removed, [row.id], '对端同 id 行应被墓碑清除');
  assert.equal(out.rows.length, 0, '清除后对端不应残留该行');

  // 反向：若对端在墓碑之后又编辑过（行更新），墓碑判为 stale（不误删）
  const newer = [{ ...row, updatedAt: Date.now() + 2000 }];
  const out2 = applyTombstones(newer, tombs, 'cardAnnot', Date.now() + 1000);
  assert.equal(out2.removed.length, 0, '比墓碑更新的行不应被删（避免时钟异常误删）');
  assert.deepEqual(out2.stale, [row.id]);
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
  // 回归：初版写成 `Number(ms) || 0`，NaN 被兜成 0 → 非法输入会显示 1970-01-01（falsy 陷阱）
  assert.equal(formatAnnotTs('not-a-time'), '');
  assert.equal(formatAnnotTs(NaN), '');
  assert.equal(formatAnnotTs(undefined), '');
});

test('读接口对故障宽容：库异常时返回空值而不抛出（不阻塞背诵主流程）', async () => {
  const orig = db.cardAnnots.where;
  db.cardAnnots.where = () => { throw new Error('boom'); };
  try {
    assert.deepEqual(await listAnnots('c-x'), [], '加载失败必须退化为空列表而非抛错');
  } finally {
    db.cardAnnots.where = orig;
  }
});

test('删除失败要抛错（事务原子性）：不会出现「行删了但墓碑没写」', async () => {
  const row = await addAnnot('c-atom', '原子性验证');
  const origPut = db.tombstones.put;
  db.tombstones.put = () => { throw new Error('tombstone-write-failed'); };
  let threw = false;
  try {
    await deleteAnnot(row.id);
  } catch {
    threw = true;
  } finally {
    db.tombstones.put = origPut;
  }
  assert.equal(threw, true, '墓碑写失败必须抛出（由事务回滚，而非静默成功）');
  assert.ok(await db.cardAnnots.get(row.id), '墓碑写失败时行必须保留（事务回滚）');
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

test('CardAnnotation 面板：scoped 隔离、宽度自管、Esc 避让卡片全屏、防竞态', () => {
  const src = read(`${SRC}/components/CardAnnotation.vue`);
  assert.match(src, /<style scoped>/, '样式必须 scoped，禁止污染全局');
  assert.match(src, /flex:\s*0 0 auto;[\s\S]{0,80}width:\s*clamp\(/, '面板宽度由组件自管（多根 Fragment，父级 scoped 选不中）');
  assert.match(src, /@media \(max-width:\s*720px\)[\s\S]{0,120}width:\s*100%/, '窄屏改整宽（不挤压卡片）');
  assert.match(src, /document\.querySelector\('\.content-fs-overlay'\)/, 'Esc 必须先避让卡片内容全屏，不能一键关两层');
  // 只在**非注释行**里找（注释里会解释"为什么不能用它"，直接全文匹配会误伤注释）
  const codeOnly = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(codeOnly, /\.stopPropagation\(\)/,
    '审计修正：document 上的 stopPropagation 无效（对同元素其他监听器不生效），不应作为拦截手段');
  assert.match(src, /reqSeq/, '异步加载必须有请求序号防竞态');
  assert.match(src, /addEventListener\('keydown', onDocKey\)/, 'Esc 监听应为面板展开时挂载');
  assert.doesNotMatch(src, /confirm\(/, '不得用原生 confirm（项目统一 confirmDialog）');
});

test('组件：保存回调只在同一张卡时才清草稿（防切卡后清掉新草稿）', () => {
  const src = read(`${SRC}/components/CardAnnotation.vue`);
  const m = src.match(/if \(String\(props\.cardId\) === id\) \{[\s\S]*?\n    \}/);
  assert.ok(m, '保存回调里应有「仍停在同一张卡」的判断');
  assert.match(m[0], /draft\.value = ''/,
    '草稿清空必须在同一张卡判断**之内** —— 否则保存期间切卡会清掉用户在新卡上刚输入的内容');
});

test('组件：删除走 deleteAnnot（墓碑语义），不得残留行内软删除调用', () => {
  const src = read(`${SRC}/components/CardAnnotation.vue`);
  assert.match(src, /deleteAnnot/, '应调用 deleteAnnot');
  assert.doesNotMatch(src, /softDeleteAnnot|restoreAnnot/, '不应再有行内软删除 API');
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
  // 审计修正：不得再用行内软删除字段（与墓碑表的 deletedAt 同名不同义）
  assert.doesNotMatch(src, /row\.deletedAt|deletedAt:\s*null|!row\.deletedAt/,
    '不应再有行内软删除字段；删除语义统一走 tombstones');
});

// ---------------------------------------------------------------- v35：删卡级联 + 跨设备残留兜底

test('删卡片：级联物理删除它的批注并逐条写墓碑（v35 P1）', async () => {
  const { deleteCard } = await import('../src/repo.js');
  await db.cards.put({ id: 'c-del', front: '待删卡', back: '答案', subject: '计组', createdAt: 1, updatedAt: 1 });
  const a1 = await addAnnot('c-del', '批注一');
  const a2 = await addAnnot('c-del', '批注二');

  await deleteCard('c-del');

  assert.equal(await db.cards.get('c-del'), undefined, '卡片本身应被删除');
  assert.equal((await listAnnots('c-del')).length, 0, '删卡后批注不应残留');
  assert.equal(await db.cardAnnots.get(a1.id), undefined, '批注行应被物理删除');
  assert.equal(await db.cardAnnots.get(a2.id), undefined);

  // 不写墓碑的话，对端残留的批注行会随增量包反复回传，永远删不掉
  const tombs = (await db.tombstones.toArray()).filter((t) => t.kind === 'cardAnnot');
  assert.equal(tombs.length, 2, '每条批注都要写墓碑');
  assert.ok(tombs.every((t) => [a1.id, a2.id].includes(t.id)), '墓碑 id 必须是批注 id');
});

test('删卡后从回收站恢复：批注一并还原，且清掉墓碑（v35）', async () => {
  const { deleteCard, restoreFromTrash } = await import('../src/repo.js');
  await db.cards.put({ id: 'c-re', front: '会恢复的卡', back: '答案', subject: '计组', createdAt: 1, updatedAt: 1 });
  const a = await addAnnot('c-re', '要恢复的批注');

  await deleteCard('c-re');
  assert.equal((await listAnnots('c-re')).length, 0, '删掉后确实没了');

  const t = await db.trash.get('c-re');
  assert.ok(t, '删卡应进回收站');
  await restoreFromTrash(t);

  const back = await listAnnots('c-re');
  assert.equal(back.length, 1, '恢复后批注应跟着回来');
  assert.equal(back[0].content, '要恢复的批注');
  assert.equal(await db.cards.get('c-re') !== undefined, true, '卡片本体也应恢复');
  // 墓碑不清 → 下轮同步墓碑回灌，把刚恢复的批注再删一遍（「恢复即消失」）
  assert.equal((await db.tombstones.toArray()).filter((x) => x.id === a.id).length, 0, '恢复必须清墓碑');
});

test('sweepOrphanRows：清掉卡片已不存在的孤儿批注并写墓碑（跨设备残留兜底）', async () => {
  const { sweepOrphanRows } = await import('../src/repo.js');
  await db.cards.put({ id: 'c-live', front: '活着的卡', back: '答案', subject: '计组', createdAt: 1, updatedAt: 1 });
  const keep = await addAnnot('c-live', '活卡的批注');
  // 跨设备典型坏状态：对端删卡只发 kind='card' 墓碑，本端卡片被级联删除，
  // 但批注行没有对应墓碑 → 永久残留。
  const orphan = await addAnnot('c-ghost', '卡没了但批注还在');

  const n = await sweepOrphanRows();
  assert.ok(n >= 1, `应清掉孤儿批注，实际清理行数 ${n}`);
  assert.notEqual(await db.cardAnnots.get(keep.id), undefined, '活着的卡的批注必须保留');
  assert.equal(await db.cardAnnots.get(orphan.id), undefined, '孤儿批注应被清掉');
  const t = (await db.tombstones.toArray()).find((x) => x.id === orphan.id);
  assert.ok(t, '清理也必须写墓碑，否则对端同 id 行会回灌');
  assert.equal(t.kind, 'cardAnnot');
});

test('importBackup：对端经卡片墓碑删卡时，本端该卡批注级联清除（v35 补漏回归）', async () => {
  const { importBackup } = await import('../src/sync.js');
  await db.cards.clear();
  const T = Date.now();
  await db.cards.bulkPut([
    { id: 'c-del', front: '将被对端删除的卡', back: 'x', subject: '测试', type: 'basic', tags: [], createdAt: T, updatedAt: T },
    { id: 'c-keep', front: '对端保留的卡', back: 'y', subject: '测试', type: 'basic', tags: [], createdAt: T, updatedAt: T },
  ]);
  const a1 = await addAnnot('c-del', '这条批注应随卡一起消失');
  const a2 = await addAnnot('c-keep', '这条批注应保留');

  // 模拟对端备份：cards 数组不含 c-del，只带 c-del 的卡片墓碑（对端 deleteCard 的产物）。
  const backup = {
    app: 'sxybrick',
    version: 11,
    tombstones: [{ id: 'c-del', kind: 'card', deletedAt: T }],
  };
  const stats = await importBackup(backup, { skipSnapshot: true });

  assert.equal(await db.cards.get('c-del'), undefined, '被墓碑标记的卡应删除');
  assert.ok(await db.cards.get('c-keep'), '无墓碑的卡应保留');
  assert.equal(await db.cardAnnots.get(a1.id), undefined,
    '指向已删卡的批注必须级联清除（此前漏删 → 幽灵批注残留，只能靠 sweep 兜底）');
  assert.equal((await listAnnots('c-del')).length, 0);
  const kept = await db.cardAnnots.get(a2.id);
  assert.equal(kept?.content, '这条批注应保留', '存活卡的批注不受影响');
  assert.ok(stats.cards >= 0, 'importBackup 应正常返回统计');
});

test('复习次数快照必须排除「快速校验」（type=quick）——全项目统一口径', async () => {
  // 快速校验不是真正的复习（不计入 SRS 排期），全项目其它统计点一律过滤 type='quick'
  // （repo.js reviewsToday/last10、streak.getTodayCount、achievements、analytics、
  //  graphAuto、intelligence）。此处若漏过滤，批注上「第 N 次复习」会把快速校验也算进去。
  const cardId = 'c-qc';
  await db.cards.put({ id: cardId, front: 'f', back: 'b', subject: 's', createdAt: 1, updatedAt: 1 });
  await db.reviews.clear();
  await db.reviews.bulkPut([
    { id: 'rv-real-1', cardId, reviewedAt: 1, rating: 2, type: 'review' },
    { id: 'rv-real-2', cardId, reviewedAt: 2, rating: 2 }, // 无 type 的老数据也属真复习
    { id: 'rv-quick-1', cardId, reviewedAt: 3, rating: 2, type: 'quick' },
    { id: 'rv-quick-2', cardId, reviewedAt: 4, rating: 0, type: 'quick' },
  ]);
  const a = await addAnnot(cardId, '快照校验');
  assert.equal(a.reviewCount, 2, `应只计 2 次真实复习（排除 2 条 quick），实际 ${a.reviewCount}`);
});

test('批注正文里的图片引用受孤儿清理保护（v35 P2）', () => {
  const src = read(`${SRC}/images.js`);
  assert.match(src, /IMAGE_REF_TABLES = \[[^\]]*'cardAnnots'/,
    '批注必须登记进图片引用清单，否则批注里的图会被当孤儿物理删掉（永久裂图）');
});
