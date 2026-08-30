// tests/repo-core.test.mjs — repo.js 纯函数层单测（N9 第二刀）
// repo.js 依赖 Dexie（浏览器 IndexedDB）无法在 Node 下 import，
// 校验/过滤/排序/统计逻辑已抽至 src/repo-core.js，此处直接覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SUBJECTS,
  validateCard,
  tagFilter,
  gradeCard,
  WRONG_REASON_MAP,
  WRONG_REASONS,
  wrongReasonToCode,
  formatDue,
  filterReviewCandidates,
  rankWeakCards,
  selectZombieIds,
  buildReviewSuggestion,
  computeStats,
  groupUserOps,
} from '../src/repo-core.js';

const DAY = 86400000;
const NOW = Date.now();

function mkCard(extra = {}) {
  return {
    id: 'c1', front: '正面', back: '背面', subject: '线性代数', tags: [],
    type: 'basic', difficulty: 'basic', marked: false,
    level: 0, ease: 2.5, intervalDays: 0, dueAt: NOW - 1000,
    createdAt: NOW - 10 * DAY, updatedAt: NOW - DAY,
    ...extra,
  };
}

// ---------- validateCard ----------
test('validateCard: 正常输入规范化（trim/截断/类型收口）', () => {
  const r = validateCard({
    front: '  特征值  ', back: ' Ax=λx ', subject: ` ${'a'.repeat(40)} `,
    tags: [' t1 ', '', 't2', ...Array(20).fill('t3')], type: 'cloze', difficulty: 'challenge',
    marked: 1, mnemonic: ' 口诀 ', wrongReason: ' 概念混淆 ', sourceCardId: 12345,
  });
  assert.ok(r.value);
  assert.equal(r.value.front, '特征值');
  assert.equal(r.value.back, 'Ax=λx');
  assert.equal(r.value.subject.length, 30);
  assert.equal(r.value.tags.length, 16); // 超出 16 个截断
  assert.equal(r.value.tags[0], 't1');
  assert.equal(r.value.type, 'cloze');
  assert.equal(r.value.difficulty, 'challenge');
  assert.equal(r.value.marked, true);
  assert.equal(r.value.mnemonic, '口诀');
  assert.equal(r.value.wrongReason, '概念混淆'); // 此层不做 code 转换
  assert.equal(r.value.sourceCardId, '12345');
});

test('validateCard: 空正面 / 非cloze空背面报错', () => {
  assert.equal(validateCard({ front: '', back: 'x' }).error, '正面内容不能为空');
  assert.equal(validateCard({ front: 'x', back: '' }).error, '背面内容不能为空');
  assert.ok(validateCard({ front: 'x', back: '', type: 'cloze' }).value); // cloze 允许空背面
});

test('validateCard: 非法 type/difficulty 回退默认值', () => {
  const r = validateCard({ front: 'f', back: 'b', type: 'evil', difficulty: 'hell' });
  assert.equal(r.value.type, 'basic');
  assert.equal(r.value.difficulty, 'basic');
});

test('validateCard: 超过 8000 字报错（按 Unicode 码点计）', () => {
  const tooLong = 'a'.repeat(8001);
  assert.match(validateCard({ front: tooLong, back: 'b' }).error, /不能超过 8000 字/);
  assert.ok(validateCard({ front: 'a'.repeat(8000), back: 'b' }).value);
  // 中日韩代理对也按码点计（...spread 展开）
  assert.ok(validateCard({ front: '记'.repeat(8000), back: 'b' }).value);
});

test('validateCard: tags 非数组安全回退为空', () => {
  const r = validateCard({ front: 'f', back: 'b', tags: 'not-array' });
  assert.deepEqual(r.value.tags, []);
});

// ---------- tagFilter ----------
test('tagFilter: AND / OR / NOT / 空标签', () => {
  const cards = [
    { tags: ['a', 'b'] }, { tags: ['a'] }, { tags: ['c'] }, {},
  ];
  assert.equal(tagFilter(cards, [], 'AND').length, 4); // 空标签不过滤
  assert.deepEqual(tagFilter(cards, ['a', 'b'], 'AND'), [cards[0]]);
  assert.equal(tagFilter(cards, ['a'], 'OR').length, 2);
  assert.equal(tagFilter(cards, ['a'], 'NOT').length, 2); // 不含 a 的两张（c 和空）
});

// ---------- gradeCard ----------
test('gradeCard: marked 优先级最高，level 分档', () => {
  assert.deepEqual(gradeCard({ marked: true, level: 4 }), { label: '错题', cls: 'g-weak' });
  assert.deepEqual(gradeCard({ level: 4 }), { label: '已掌握', cls: 'g-master' });
  assert.deepEqual(gradeCard({ level: 2 }), { label: '巩固中', cls: 'g-good' });
  assert.deepEqual(gradeCard({ level: 1 }), { label: '学习中', cls: 'g-learning' });
  assert.deepEqual(gradeCard({}), { label: '未开始', cls: 'g-new' });
});

// ---------- wrongReasonToCode ----------
test('wrongReasonToCode: code 透传 / 中文转码 / 子串匹配 / 未知回退', () => {
  assert.equal(wrongReasonToCode('CARELESS'), 'CARELESS');
  assert.equal(wrongReasonToCode('概念混淆'), 'CONCEPT_MIS');
  assert.equal(wrongReasonToCode('这是概念混淆导致的'), 'CONCEPT_MIS'); // includes 子串
  assert.equal(wrongReasonToCode('完全对不上'), 'OTHER');
  assert.equal(wrongReasonToCode(''), '');
  assert.equal(wrongReasonToCode(null), '');
});

test('WRONG_REASONS 与 WRONG_REASON_MAP 一一对应', () => {
  assert.equal(WRONG_REASONS.length, Object.keys(WRONG_REASON_MAP).length);
  for (const { code, label } of WRONG_REASONS) assert.equal(WRONG_REASON_MAP[code], label);
});

// ---------- formatDue ----------
test('formatDue: 分钟/小时/绝对日期/已过期', () => {
  assert.equal(formatDue(NOW + 30 * 60000, NOW), '30 分钟后');
  assert.equal(formatDue(NOW + 2 * 3600000, NOW), '2 小时后');
  assert.match(formatDue(NOW + 3 * DAY, NOW), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatDue(NOW + 90 * 60000, NOW), '2 小时后'); // <1h 边界外
});

test('formatDue: 逾期显示「已逾期 N」，不再一律显示「1 分钟后」', () => {
  // ⚠️ 历史缺陷（2026-08-30 修复）：`diff < 3600000` 对负数恒真，
  //   于是「逾期 3 天 / 逾期 2 小时 / 逾期 1 分钟」统统显示成「1 分钟后」，
  //   用户完全看不出哪些卡已经拖了很久。
  assert.equal(formatDue(NOW - 1000, NOW), '已逾期 · 不到 1 小时');
  assert.equal(formatDue(NOW - 5 * 60000, NOW), '已逾期 · 不到 1 小时');
  assert.equal(formatDue(NOW - 2 * 3600000, NOW), '已逾期 2 小时');
  assert.equal(formatDue(NOW - 3 * DAY, NOW), '已逾期 3 天');
  assert.equal(formatDue(NOW, NOW), '已逾期 · 不到 1 小时'); // diff === 0 也算已到期
  assert.equal(formatDue(NOW + 5 * 60000, NOW), '5 分钟后'); // 未来仍走原分支
});

// ---------- filterReviewCandidates ----------
test('filterReviewCandidates: 默认只留到期卡并按 dueAt 升序', () => {
  const a = mkCard({ id: 'a', dueAt: NOW + DAY });
  const b = mkCard({ id: 'b', dueAt: NOW - DAY });
  const c = mkCard({ id: 'c', dueAt: NOW - 2 * DAY });
  const out = filterReviewCandidates([a, b, c], {}, NOW);
  assert.deepEqual(out.map(x => x.id), ['c', 'b']); // 最旧到期在前
});

test('filterReviewCandidates: includeDueOnly=false 保留未到期卡', () => {
  const a = mkCard({ id: 'a', dueAt: NOW + DAY });
  const b = mkCard({ id: 'b', dueAt: NOW - DAY });
  assert.equal(filterReviewCandidates([a, b], { includeDueOnly: false }, NOW).length, 2);
});

test('filterReviewCandidates: 科目筛选（未分类回退）+ 标签 AND/OR/NOT + 错因', () => {
  const c1 = mkCard({ id: 'c1', subject: '线性代数', tags: ['a', 'b'] });
  const c2 = mkCard({ id: 'c2', subject: '', tags: ['a'] }); // 无科目 → 未分类
  const c3 = mkCard({ id: 'c3', subject: '计算机网络', tags: ['c'], wrongReason: 'CARELESS' });
  const cards = [c1, c2, c3];
  assert.deepEqual(filterReviewCandidates(cards, { subjects: ['未分类'] }, NOW).map(x => x.id), ['c2']);
  assert.deepEqual(filterReviewCandidates(cards, { tags: ['a', 'b'], logic: 'AND' }, NOW).map(x => x.id), ['c1']);
  assert.equal(filterReviewCandidates(cards, { tags: ['a'], logic: 'OR' }, NOW).length, 2);
  assert.equal(filterReviewCandidates(cards, { tags: ['a'], logic: 'NOT' }, NOW).length, 1);
  assert.deepEqual(filterReviewCandidates(cards, { wrongReasons: ['CARELESS'] }, NOW).map(x => x.id), ['c3']);
});

test('filterReviewCandidates: 不修改输入数组（纯函数）', () => {
  const a = mkCard({ id: 'a', dueAt: NOW + DAY });
  const b = mkCard({ id: 'b', dueAt: NOW - DAY });
  const input = [a, b];
  filterReviewCandidates(input, {}, NOW);
  assert.deepEqual(input.map(x => x.id), ['a', 'b']); // 原序未变
});

// ---------- rankWeakCards ----------
test('rankWeakCards: 错次门槛 + marked 直入 + 排序 + limit', () => {
  const cards = [
    mkCard({ id: 'a', updatedAt: 1 }),
    mkCard({ id: 'b', updatedAt: 2 }),
    mkCard({ id: 'c', updatedAt: 3, marked: true }),
    mkCard({ id: 'd', updatedAt: 4 }),
  ];
  const reviews = [
    { cardId: 'a', rating: 0 }, { cardId: 'a', rating: 0 }, { cardId: 'a', rating: 2 },
    { cardId: 'b', rating: 0 },
    { cardId: 'd', rating: 2 },
  ];
  const out = rankWeakCards(cards, reviews, { limit: 10, minFail: 2 });
  // a 错 2 次（达标）；b 错 1 次不达标；c marked 直入（failCount=0）；d 无错
  assert.deepEqual(out.map(x => x.id), ['a', 'c']);
  assert.equal(out[0].failCount, 2);
  assert.equal(out[1].failCount, 0);
  // limit 截断
  assert.equal(rankWeakCards(cards, reviews, { limit: 1, minFail: 2 }).length, 1);
});

// ---------- selectZombieIds ----------
test('selectZombieIds: 超90天未复习才算僵尸，近期创建/已复习均排除', () => {
  const cards = [
    mkCard({ id: 'old-no-review', createdAt: NOW - 100 * DAY }),
    mkCard({ id: 'old-reviewed', createdAt: NOW - 100 * DAY }),
    mkCard({ id: 'new-no-review', createdAt: NOW - 10 * DAY }),
  ];
  const ids = selectZombieIds(cards, ['old-reviewed'], NOW);
  assert.deepEqual(ids, ['old-no-review']);
});

// ---------- buildReviewSuggestion ----------
test('buildReviewSuggestion: 到期分科 + 最久未复习科目 + 标记数', () => {
  const cards = [
    mkCard({ id: 'a', subject: '线性代数', dueAt: NOW - 1, createdAt: NOW - 30 * DAY }),
    mkCard({ id: 'b', subject: '线性代数', dueAt: NOW + DAY, createdAt: NOW - 1 * DAY }),
    mkCard({ id: 'c', subject: '计算机网络', dueAt: NOW - 1, createdAt: NOW - 5 * DAY, marked: true }),
  ];
  const reviews = [
    { cardId: 'a', reviewedAt: NOW - 2 * DAY },
    { cardId: 'c', reviewedAt: NOW - 1 },
  ];
  const s = buildReviewSuggestion(cards, reviews, NOW);
  assert.equal(s.dueCount, 2);
  assert.deepEqual(s.dueBySubject[0], { name: '线性代数', count: 1 }); // count 降序
  assert.equal(s.markedCount, 1);
  // 线代最久未复习 = 2 天前；计网 = 1 天前 → 线代排最前
  assert.equal(s.staleSubjects[0].name, '线性代数');
  assert.equal(s.staleSubjects[0].days, 2);
});

// ---------- computeStats ----------
test('computeStats: 基础计数 / 今日去重 / 掌握度 / 能力四维 / 标签Top', () => {
  const cards = [
    mkCard({ id: 'a', subject: '线性代数', tags: ['矩阵', '行列式'] }),
    mkCard({ id: 'b', subject: '计算机网络', tags: ['矩阵'] }),
    mkCard({ id: 'c', subject: '线性代数', tags: [] }),
  ];
  const reviews = [
    // 今天（相对 NOW 的本地当日）：卡 a 复习 2 次 → 今日只算 1 张
    { cardId: 'a', rating: 2, reviewedAt: NOW },
    { cardId: 'a', rating: 0, reviewedAt: NOW - 3600000 },
    // 90 天窗口内：计网 b
    { cardId: 'b', rating: 1, reviewedAt: NOW - 5 * DAY },
    // 超过 90 天：不进掌握度
    { cardId: 'c', rating: 2, reviewedAt: NOW - 91 * DAY },
  ];
  const s = computeStats(cards, reviews, NOW);
  assert.equal(s.totalCards, 3);
  assert.equal(s.totalReviews, 4);
  assert.equal(s.todayReviews, 1); // a 去重
  assert.equal(s.dueToday, 3); // 三张都 dueAt<=NOW
  // 掌握度：线代 = (2+0)/(2*2)=50%；计网 = 1/(2*1)=50%（91天前那条不进）
  const lin = s.mastery.find(m => m.subject === '线性代数');
  const net = s.mastery.find(m => m.subject === '计算机网络');
  assert.equal(lin.mastery, 50);
  assert.equal(net.mastery, 50);
  assert.equal(s.avgMastery, 50);
  // 能力四维：correct=2/4=50%；stable=1-1/4=75%（rating0 只有 1 条）；coverage=3/3=100%（91天前的旧复习也计入）
  assert.equal(s.ability.correct, 50);
  assert.equal(s.ability.stable, 75);
  assert.equal(s.ability.coverage, 100);
  // 评分分布与热力图
  assert.deepEqual(s.ratingDist, { 0: 1, 1: 1, 2: 2 });
  assert.equal(Object.keys(s.heatmap).length >= 1, true);
  // 标签 Top：矩阵 2 次第一
  assert.equal(s.tagCounts[0].name, '矩阵');
  assert.equal(s.tagCounts[0].count, 2);
  assert.equal(s.tagCounts.length, 2);
});

test('computeStats: 空数据不炸，除零全部兜底', () => {
  const s = computeStats([], [], NOW);
  assert.equal(s.totalCards, 0);
  assert.equal(s.totalReviews, 0);
  assert.equal(s.todayReviews, 0);
  assert.equal(s.avgMastery, 0);
  assert.deepEqual(s.ability, { mastery: 0, correct: 0, stable: 100, coverage: 0 }); // stable=1-0/1
  assert.deepEqual(s.ratingDist, { 0: 0, 1: 0, 2: 0 });
  assert.equal(s.trend.length, 14);
  assert.equal(s.forgotTrend.length, 30);
  assert.equal(s.hourly.length, 24);
});

test('computeStats: 365 天热力图窗口外的记录不计入', () => {
  const cards = [mkCard({ id: 'a' })];
  const reviews = [
    { cardId: 'a', rating: 2, reviewedAt: NOW - 100 * DAY },
    { cardId: 'a', rating: 2, reviewedAt: NOW - 400 * DAY }, // 窗口外
  ];
  const s = computeStats(cards, reviews, NOW);
  const total = Object.values(s.heatmap).reduce((a, b) => a + b, 0);
  assert.equal(total, 1);
});

// ---------- groupUserOps ----------
test('groupUserOps: day 分组按日期升序 / hour 24 桶零填充', () => {
  const t1 = NOW - 2 * DAY, t2 = NOW - 1 * DAY;
  const arr = [{ t: t2 }, { t: t2 }, { t: t1 }];
  const days = groupUserOps(arr, 'day');
  assert.equal(days.length, 2);
  assert.deepEqual(days.map(d => d.count).sort(), [1, 2]);
  assert.ok(days[0].date < days[1].date); // 升序
  const hours = groupUserOps([{ t: NOW }], 'hour');
  assert.equal(hours.length, 24);
  assert.equal(hours.reduce((s, h) => s + h.count, 0), 1);
});

test('groupUserOps: module/type/category 分组按次数降序，空值归「（空）」', () => {
  const arr = [
    { t: NOW, module: 'review' }, { t: NOW, module: 'review' }, { t: NOW, module: 'cards' }, { t: NOW },
  ];
  const m = groupUserOps(arr, 'module');
  assert.deepEqual(m[0], { key: 'review', count: 2 });
  assert.equal(m.length, 3);
  assert.ok(m.some(x => x.key === '（空）'));
  // 降序
  for (let i = 1; i < m.length; i++) assert.ok(m[i - 1].count >= m[i].count);
});

test('groupUserOps: dayHour 返回 Map，groupBy null 原样返回', () => {
  const arr = [{ t: NOW }];
  const m = groupUserOps(arr, 'dayHour');
  assert.ok(m instanceof Map);
  assert.equal(m.size, 1);
  const key = [...m.keys()][0];
  assert.match(key, /^\d{4}-\d{2}-\d{2}-\d{2}$/);
  assert.equal(groupUserOps(arr, null), arr); // 原数组引用
});

// ---------- DEFAULT_SUBJECTS ----------
test('DEFAULT_SUBJECTS 是非空去重数组', () => {
  assert.ok(Array.isArray(DEFAULT_SUBJECTS) && DEFAULT_SUBJECTS.length > 0);
  assert.equal(new Set(DEFAULT_SUBJECTS).size, DEFAULT_SUBJECTS.length);
});
