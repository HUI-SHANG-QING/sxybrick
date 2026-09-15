// round62 回归：自然语言「几点」解析的 12 小时制边界
//
// 实证缺陷（修前实测，用真实 parsePlan 调用复现）：
//   extractHour 里 12 小时制判定写作 `if (pmRe.test(s) && h <= 12) h += 12;`，
//   而出口又有 `if (h >= 0 && h <= 23) return h;` 兜底 —— 两行合起来的后果是
//   **「12 点」这一档在三种语境下全错**：
//
//     · "晚上12点" → h=12 → 24 → 越界被丢弃 → 落到「晚上」关键词映射 19  → 错 5 小时
//     · "下午12点" → h=12 → 24 → 越界被丢弃 → 落到「下午」关键词映射 14  → 错 2 小时
//     · "凌晨12点" → h=12 → 无 pm 语境 → 直接返回 12（正午！）        → 错 12 小时
//
//   而"12 点"又恰恰是用户表述「午夜截止」「正午截止」时最常用的写法。
//   端到端影响：`parsePlanWithSummary('晚上12点前复习数据结构60张')` 把任务排到 19:00，
//   比用户意图（次日 0 点前的今晚）早 5 小时，日程提醒随之在错误的时刻响起。
//
//   为什么能潜伏这么久：extractHour **此前完全没有测试覆盖**，且出口兜底把
//   「越界丢弃」伪装成「走关键词粗映射」的正常路径，肉眼读代码不易察觉。
//
// 本文件同时锁住三件容易改坏的事（修复过程中我已两次返工）：
//   ① 夜间向的 12 点 = 0；正午侧的 12 点 = 12（同一数字两种语义，必须分开判）
//   ② 「凌晨1点」必须仍是 1 点 —— 不能因为引入了"夜间"概念就把它 +12 成 13 点
//   ③ 24 小时制写法（14:30 / 23:59 / 00:30）必须原样放行，不能被 12 小时制逻辑污染
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractHour, extractQuantity, inferQuadrant, parsePlanWithSummary } from '../src/utils/plan-parser.js';
import { dueTasksOf } from '../src/utils/plan-reminder.js';

test('round62: 「12 点」在同一数字下按语境分裂成午夜/正午', () => {
  // 夜间向 → 午夜 0 点（一天结束的那个 12 点）
  assert.equal(extractHour('晚上12点'), 0, '晚上12点 应解析为午夜 0 点');
  assert.equal(extractHour('凌晨12点'), 0, '凌晨12点 应解析为午夜 0 点');
  assert.equal(extractHour('深夜12点'), 0, '深夜12点 应解析为午夜 0 点');
  assert.equal(extractHour('夜晚12点'), 0, '夜晚12点 应解析为午夜 0 点');
  assert.equal(extractHour('晚上12点半'), 0, '带分钟同样按午夜');
  assert.equal(extractHour('晚上12:30'), 0, '冒号写法同样按午夜');
  // 正午侧 → 12 点（中午那个 12 点）
  assert.equal(extractHour('中午12点'), 12, '中午12点 应解析为 12 点');
  assert.equal(extractHour('下午12点'), 12, '下午12点 应解析为 12 点');
  assert.equal(extractHour('正午12点'), 12, '正午12点 应解析为 12 点');
  // 无语境 → 保守取 12（歧义时不擅自翻转，保持旧行为）
  assert.equal(extractHour('12点'), 12, '无前缀的 12点 保守解释为正午 12 点');
});

test('round62: 1..11 点的下午侧加 12、上午侧不加（含夜间与清晨）', () => {
  // 下午侧（含晚上/傍晚/夜间）→ +12
  assert.equal(extractHour('下午1点'), 13);
  assert.equal(extractHour('下午3点'), 15);
  assert.equal(extractHour('下午11点'), 23);
  assert.equal(extractHour('晚上10点'), 22);
  assert.equal(extractHour('晚上11点'), 23);
  assert.equal(extractHour('傍晚6点'), 18);
  // 上午/凌晨侧 → 原样（**回归防护**：修复中曾把「凌晨1点」错算成 13 点）
  assert.equal(extractHour('凌晨1点'), 1, '凌晨1点 必须是 1 点，不是 13 点');
  assert.equal(extractHour('凌晨5点半'), 5);
  assert.equal(extractHour('早上8点'), 8);
  assert.equal(extractHour('清晨6点'), 6);
  assert.equal(extractHour('上午11点'), 11);
  assert.equal(extractHour('上午12点'), 12);
});

test('round62: 24 小时制写法原样放行（回归防护：修复中曾把 14:30 变 null）', () => {
  assert.equal(extractHour('14:30'), 14, '14:30 是 24 小时制，不能被 12 小时制逻辑吃掉');
  assert.equal(extractHour('14点30分'), 14);
  assert.equal(extractHour('23:59'), 23);
  assert.equal(extractHour('00:30'), 0);
  assert.equal(extractHour('0点'), 0);
  assert.equal(extractHour('9:00'), 9);
});

test('round62: 越界与空输入不得产出非法小时', () => {
  assert.equal(extractHour('25点'), null, '25 点越界');
  assert.equal(extractHour('99点'), null);
  assert.equal(extractHour(''), null);
  assert.equal(extractHour(null), null);
  assert.equal(extractHour(undefined), null);
  assert.equal(extractHour('no time here'), null);
  // 纯时段关键词映射保持既有口径
  assert.equal(extractHour('上午'), 9);
  assert.equal(extractHour('下午'), 14);
  assert.equal(extractHour('晚上'), 19);
  assert.equal(extractHour('凌晨'), 0);
  assert.equal(extractHour('中午'), 12);
});

test('round62: 端到端 —— 「晚上12点前」不得被排到晚上 19 点', () => {
  const r = parsePlanWithSummary('今天：\n晚上12点前复习数据结构60张\n下午12点整理线代笔记\n晚上8点做政治');
  const byTitle = (kw) => r.tasks.find((t) => t.title.includes(kw));
  const a = byTitle('数据结构');
  assert.ok(a, '应解析出「复习数据结构」任务');
  assert.equal(a.scheduledHour, 0, '「晚上12点前」应排到 0 点（午夜），不能被关键词兜底成 19 点');
  const b = byTitle('线代');
  assert.ok(b, '应解析出「整理线代笔记」任务');
  assert.equal(b.scheduledHour, 12, '「下午12点」应排到 12 点（正午），不能是 14 点');
  const c = byTitle('政治');
  assert.ok(c, '应解析出「做政治」任务');
  assert.equal(c.scheduledHour, 20, '「晚上8点」应排到 20 点（既有正确行为不得回退）');
});

// ─────────────────────────────────────────────────────────────
// 同族缺陷：extractQuantity 的「时长」在中文语境下同样被误杀
// ─────────────────────────────────────────────────────────────
//
// 实证缺陷：时间单位的尾部统一挂了负向先行断言 `(?![a-z\u4e00-\u9fff])`，
//   本意是防单字母 `h` 误匹配英文单词，却把**中文单位也一起封死**：
//     "做2小时数学" / "背30分钟单词" / "130分钟数学" → estimatedMinutes = null
//   ——「数字 + 小时/分钟 + 紧接着科目名」恰是中文计划文本最主流的写法。
//   丢失 estimatedMinutes 不是"少个字段"：日程时间轴的时长块（planCharts 课程表）
//   会退回 defaultDur 兜底 → 全天安排的整体时长估算系统性失真。

test('round62: 中文时间单位后紧跟中文/字母也必须识别（曾经一律失配）', () => {
  const min = (s) => extractQuantity(s).estimatedMinutes;
  assert.equal(min('做2小时数学'), 120, '「2小时」后紧跟「数学」不能失配');
  assert.equal(min('背30分钟单词'), 30, '「30分钟」后紧跟「单词」不能失配');
  assert.equal(min('130分钟数学'), 130, '三位数分钟数同样要识别（此前 100 分钟内才能过）');
  assert.equal(min('看1小时视频'), 60);
  assert.equal(min('写2小时作文'), 120);
  assert.equal(min('学100分钟'), 100, '既有正确用例不得回退');
  assert.equal(min('1.5小时'), 90);
  assert.equal(min('90分钟'), 90);
});

test('round62: 英文时间单位仍保留词边界保护（修复不得放宽到误吃英文单词）', () => {
  const min = (s) => extractQuantity(s).estimatedMinutes;
  assert.equal(min('60min'), 60);
  assert.equal(min('30 mins'), 30);
  assert.equal(min('2 hour'), 120);
  assert.equal(min('1h'), 60);
  assert.equal(min('5 hours'), 300);
  // 边界保护：这些不得被当成时长
  assert.equal(min('admin'), null, 'admin 里的 min 不是"分钟"');
  assert.equal(min('1hello'), null, '1h 不得命中 1hello');
  assert.equal(min('the h'), null, '孤立字母 h 不是时长单位');
});

test('round62: 考研高频量词不得漏检（道/讲/问/段/集/课）', () => {
  const cnt = (s) => extractQuantity(s).targetCount;
  assert.equal(cnt('刷题120道'), 120, '「道」是理科刷题最标准的量词');
  assert.equal(cnt('做8道题'), 8);
  assert.equal(cnt('看2讲'), 2);
  assert.equal(cnt('刷100问'), 100);
  assert.equal(cnt('背5段'), 5);
  assert.equal(cnt('看3集'), 3);
  assert.equal(cnt('看2课'), 2);
  // 既有量词不得回退
  assert.equal(cnt('做50题'), 50);
  assert.equal(cnt('背30个单词'), 30);
  assert.equal(cnt('写2篇作文'), 2);
  assert.equal(cnt('练5组'), 5);
  assert.equal(cnt('听1遍'), 1);
  // 无数字时仍为 null
  assert.equal(cnt('背完这一章'), null);
});

// ─────────────────────────────────────────────────────────────
// 同族缺陷：四象限的「否定词取反」缺失
// ─────────────────────────────────────────────────────────────
//
// 实证缺陷：inferQuadrant 全是 `s.includes(w)` 字面包含，于是"不急/不紧急"里的
//   `急/紧急` 照常命中 Q3 的紧急词 → urgent=true；同时"重要"命中 Q2 → important=true
//   → 判成 **Q1（最优先）**。用户明说"不急"，任务却被排到第一优先级。
//   实测："很重要但不急的复习" / "不紧急但要完成" / "重要的英语不急" → 全部 Q1。
//   四象限是每日规划的主视图，这会直接误导用户先做次要的事。

test('round62: 四象限不得忽略否定词（「不急」不能判成最紧急的 Q1）', () => {
  const q = (s) => inferQuadrant(s).quadrant;
  assert.equal(q('很重要但不急的复习'), 'Q2', '「不急」应降级为重要不紧急');
  assert.equal(q('重要的错题不急着做'), 'Q2');
  assert.equal(q('重要的英语不急'), 'Q2');
  assert.equal(q('必须但不紧急'), 'Q2');
  assert.equal(q('不紧急但要完成'), 'Q2');
  assert.equal(q('不重要且不急'), 'Q4');
  // 跨小句：前半句的否定不得误伤后半句的真实紧急
  assert.equal(q('不重要但紧急的事'), 'Q3');
});

test('round62: 四象限既有正确行为不得回退', () => {
  const q = (s) => inferQuadrant(s).quadrant;
  assert.equal(q('必须今天完成英语'), 'Q1');
  assert.equal(q('很紧急'), 'Q1', '项目刻意把「很紧急」当 Q1 强词，口径不变');
  assert.equal(q('马上做数学'), 'Q1');
  assert.equal(q('有空做数学'), 'Q4');
  assert.equal(q('尽快交作业'), 'Q3');
  assert.equal(q('紧急处理错题'), 'Q3');
  assert.equal(q(''), 'Q4');
  assert.equal(q(null), 'Q4');
});

// ─────────────────────────────────────────────────────────────
// 同族缺陷：提醒窗口的「提前量跨午夜」
// ─────────────────────────────────────────────────────────────
//
// 实证缺陷：`due = scheduledHour*60 - advanceMin` 在 0 点任务 + 提前量时得负数，
//   而 curMin 只有 0..1439，于是窗口 [-10, 5) 只在"当天 00:00~00:05"成立——
//   用户设的"提前 10 分钟"本意是**前一天 23:50**，那一刻根本不会响，
//   要等过了 0 点才提醒（此时"提前"已变成滞后）。
//   修法：窗口按 1440 取模，跨日时两段取并集（23:50~23:59 与 00:00~00:04 都算命中）。
//   修复过程中我先试过"单向回绕"，只补上 23:50~23:59 那半段，丢了 00:00 之后那截——故一并锁住。

test('round62: 0 点任务的提前量必须跨午夜生效（此前只能在 00:00 后才响）', () => {
  const at = (h, m) => new Date(2026, 8, 15, h, m);
  const hit = (h, m, adv) => dueTasksOf([{ id: 'a', scheduledHour: 0, status: 'pending' }], at(h, m), adv).length;
  // 提前 10 分钟 → 窗口 23:50~23:59 与 00:00~00:04 两段
  assert.equal(hit(23, 49, 10), 0, '23:49 未到窗口');
  assert.equal(hit(23, 50, 10), 1, '23:50 应命中（这就是"提前 10 分钟"的本意时刻）');
  assert.equal(hit(23, 59, 10), 1, '23:59 仍在窗口前半段');
  assert.equal(hit(0, 0, 10), 1, '跨日后 00:00 仍在窗口内（后半段，不得丢）');
  assert.equal(hit(0, 4, 10), 1, '00:04 是窗口最后 1 分钟');
  assert.equal(hit(0, 5, 10), 0, '00:05 已出窗口');
  // 无提前量：窗口 [0,15) 不跨日
  assert.equal(hit(0, 0, 0), 1);
  assert.equal(hit(0, 14, 0), 1);
  assert.equal(hit(0, 15, 0), 0);
  assert.equal(hit(23, 59, 0), 0);
});

test('round62: 提醒窗口的常规任务与脏数据（修复不得放宽）', () => {
  const at = (h, m) => new Date(2026, 8, 15, h, m);
  const hit = (task, h, m, adv = 0) => dueTasksOf([task], at(h, m), adv).length;
  const T = (h, st) => ({ id: 'a', scheduledHour: h, status: st || 'pending' });
  // 常规：08:00 任务、窗口 [480,495)
  assert.equal(hit(T(8), 8, 0), 1);
  assert.equal(hit(T(8), 7, 50, 10), 1, '提前 10 分钟');
  assert.equal(hit(T(8), 8, 15, 10), 0);
  // 23 点任务：窗口跨到 23:04
  assert.equal(hit(T(23), 23, 0), 1);
  assert.equal(hit(T(23), 23, 4, 10), 1);
  assert.equal(hit(T(23), 23, 5, 10), 0);
  // 1 点任务：窗口 00:50~01:04，不得被跨日逻辑误伤
  assert.equal(hit(T(1), 0, 50, 10), 1);
  assert.equal(hit(T(1), 0, 49, 10), 0);
  assert.equal(hit(T(1), 1, 5, 10), 0);
  // 状态
  assert.equal(hit(T(8, 'done'), 8, 0), 0);
  assert.equal(hit(T(8, 'skipped'), 8, 0), 0);
  // 脏数据：越界 hour 不得被取模"造出"一个提醒
  assert.equal(hit(T(25), 1, 0), 0, 'hour=25 不得经取模变成 1 点提醒');
  assert.equal(hit(T(-1), 23, 55), 0);
  assert.equal(hit({ id: 'a', scheduledHour: 'abc', status: 'pending' }, 8, 0), 0);
  assert.equal(hit({ id: 'a', scheduledHour: null, status: 'pending' }, 8, 0), 0);
});
