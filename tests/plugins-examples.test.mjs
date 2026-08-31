// 官方示例插件测试：静态校验（manifest/导出/钩子/Agent）+ mock ctx 功能测试
// 示例插件是纯 ESM（无浏览器 API 依赖），可直接 import 单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, validateModuleExports, SUPPORTED_HOOKS } from '../src/plugins/manifest.js';
import { parseAgentDefs } from '../src/plugins/agent-bridge.js';
import * as weekly from '../src/plugins/examples/weekly-review.js';
import * as pomo from '../src/plugins/examples/pomo-stats.js';
import * as due from '../src/plugins/examples/due-alert.js';

const EXAMPLES = [
  { id: 'weekly-review', mod: weekly },
  { id: 'pomo-stats', mod: pomo },
  { id: 'due-alert', mod: due },
];

// ---------- 静态校验 ----------
test('三个官方示例的 manifest 均通过校验', () => {
  for (const { id, mod } of EXAMPLES) {
    const v = validateManifest(mod.manifest);
    assert.equal(v.ok, true, `${id} manifest 校验失败: ${v.errors?.join(';')}`);
    assert.ok(mod.manifest.version, `${id} 缺 version`);
    assert.ok(mod.manifest.description, `${id} 缺 description`);
  }
});

test('manifest 声明的工具都有同名导出函数', () => {
  for (const { id, mod } of EXAMPLES) {
    for (const t of mod.manifest.tools || []) {
      assert.equal(typeof mod[t.name], 'function', `${id} 缺工具函数 ${t.name}`);
      assert.ok(t.inputSchema, `${id} 工具 ${t.name} 缺 inputSchema`);
      assert.equal(t.inputSchema.type, 'object', `${id} 工具 ${t.name} schema 类型应为 object`);
    }
  }
});

test('hooks 声明合法：钩子名在 SUPPORTED_HOOKS 且函数已导出', () => {
  for (const { id, mod } of EXAMPLES) {
    for (const [event, fnName] of Object.entries(mod.manifest.hooks || {})) {
      assert.ok(SUPPORTED_HOOKS[event], `${id} 钩子 ${event} 不在 SUPPORTED_HOOKS`);
      assert.equal(typeof mod[fnName], 'function', `${id} 缺钩子函数 ${fnName}`);
    }
  }
});

test('Agent 定义合法（id/name 齐全）且引用本插件工具', () => {
  for (const { id, mod } of EXAMPLES) {
    const agents = parseAgentDefs(mod);
    assert.ok(agents.length >= 1, `${id} 应至少导出 1 个 Agent`);
    for (const a of agents) {
      assert.ok(a.id && a.name, `${id} Agent 缺 id/name`);
      for (const tool of a.tools) {
        assert.ok((mod.manifest.tools || []).some(t => t.name === tool), `${id} Agent ${a.id} 引用了未声明工具 ${tool}`);
      }
    }
  }
});

test('validateModuleExports 对示例模块整体通过', () => {
  for (const { id, mod } of EXAMPLES) {
    const ev = validateModuleExports(mod, mod.manifest);
    assert.equal(ev.ok, true, `${id} 模块导出校验失败: ${ev.errors?.join(';')}`);
  }
});

// ---------- mock ctx 功能测试 ----------
function makeCtx(overrides = {}) {
  return {
    analytics: {
      getRecentMistakes: async () => [],
      getDueForecast: async () => ({ daily: [] }),
      ...overrides.analytics,
    },
    data: {
      listPomoSessions: async () => [],
      ...overrides.data,
    },
    notify: overrides.notify || (() => {}),
    log: () => {},
    // 时钟注入点：缺省回落真实时间；测试注入固定时刻后，
    // 「今日 / 本周」判定不再随真实运行日期漂移（曾导致周一必红的假失败）
    now: overrides.now || (() => Date.now()),
    pluginId: 'test', scope: 'test',
  };
}

// 固定参考时刻：2026-08-26（周三）14:00 本地时间。
// 选周三是因为「今日 / 本周内非今日 / 本周外」三个区间都真实存在，
// 断言因此与测试的真实运行时刻完全无关。
const REF = new Date(2026, 7, 26, 14, 0, 0, 0).getTime();
const HOUR = 3600_000;

test('weekly-review.mistake_report：按天聚合 + 科目归纳 + 正确率', async () => {
  const ctx = makeCtx({
    analytics: {
      getRecentMistakes: async (days) => {
        assert.equal(days, 7, '应默认 7 天');
        return [
          { id: 'a', subject: '数学', front: '极限定义', wrongCount: 3, total: 5 },
          { id: 'b', subject: '数学', front: '导数', wrongCount: 1, total: 4 },
          { id: 'c', subject: '英语', front: '长难句', wrongCount: 2, total: 2 },
        ];
      },
    },
  });
  const r = await weekly.mistake_report({}, ctx);
  assert.equal(r.days, 7);
  assert.equal(r.totalMistakes, 3);
  assert.equal(r.reviewedCount, 11);
  assert.ok(Math.abs(r.accuracy - (1 - 6 / 11)) < 0.001, 'accuracy 应为 1 - 错/总（3 位小数）');
  // 科目归纳：数学 2 卡 4 错，英语 1 卡 2 错
  const math = r.bySubject.find(s => s.subject === '数学');
  assert.equal(math.wrong, 4);
  assert.equal(math.total, 9);
  // top 降序：错误次数最多在前
  assert.equal(r.top[0].id, 'a');
  assert.equal(r.top[2].id, 'c');
  // limit 生效
  const r2 = await weekly.mistake_report({ limit: 2 }, ctx);
  assert.equal(r2.top.length, 2);
});

test('weekly-review.mistake_report：days 越界被钳制在 1~90，0 视为缺省 7', async () => {
  const seen = [];
  const ctx = makeCtx({
    analytics: { getRecentMistakes: async (days) => { seen.push(days); return []; } },
  });
  await weekly.mistake_report({ days: 999 }, ctx);
  assert.equal(seen.at(-1), 90);
  await weekly.mistake_report({ days: -5 }, ctx); // truthy 负数 → 钳制到 1
  assert.equal(seen.at(-1), 1);
  await weekly.mistake_report({ days: 0 }, ctx);  // falsy 0 → 走默认 7
  assert.equal(seen.at(-1), 7);
});

test('pomo-stats.pomo_stats：今日/本周/标签聚合', async () => {
  // 时刻由 ctx.now() 注入（固定周三 14:00），与真实运行日期无关
  const sessions = [
    { startedAt: REF - 1 * HOUR, duration: 25, tag: '数学' },   // 今日
    { startedAt: REF - 3 * HOUR, duration: 50, tag: '数学' },   // 今日
    { startedAt: REF - 30 * HOUR, duration: 25, tag: '英语' },  // 本周内（周二）
    { startedAt: REF - 200 * HOUR, duration: 25, tag: '数学' }, // 本周外（8 天前）
  ];
  const ctx = makeCtx({
    now: () => REF,
    data: { listPomoSessions: async () => sessions },
  });
  const r = await pomo.pomo_stats({}, ctx);
  assert.equal(r.today.sessions, 2);
  assert.equal(r.today.minutes, 75);
  assert.equal(r.week.sessions, 3);
  assert.equal(r.week.minutes, 100);
  assert.equal(r.byTag[0].tag, '数学'); // 按时长降序
  assert.equal(r.byTag[0].minutes, 75);
  // 周三 → 本周已过 3 天，日均按 3 天折算（而非恒 /7）
  assert.equal(r.week.avgDailyBasis, 3);
  assert.equal(r.week.avgDailyMinutes, Math.round(100 / 3));
  // 按标签过滤
  const rEn = await pomo.pomo_stats({ tag: '英语' }, ctx);
  assert.equal(rEn.today.sessions, 0);
  assert.equal(rEn.week.sessions, 1);
  assert.equal(rEn.week.minutes, 25);
});

test('pomo-stats.pomo_stats：周一凌晨边界（本周起点=当日 00:00，日均分母=1）', async () => {
  // 2026-08-31（周一）00:30。此刻「本周内非今日」这个区间不存在：
  // 30h 前（上周日 18:30）已落在本周起点之前。旧实现用 now−30h 当"本周内"样本，
  // 因此每周一必红——这是本回归用例守护的边界。
  const monday = new Date(2026, 7, 31, 0, 30, 0, 0).getTime();
  const sessions = [
    { startedAt: monday - 0.25 * HOUR, duration: 25, tag: '数学' }, // 今日 00:15
    { startedAt: monday - 30 * HOUR, duration: 25, tag: '英语' },   // 上周日 → 本周外
  ];
  const ctx = makeCtx({ now: () => monday, data: { listPomoSessions: async () => sessions } });
  const r = await pomo.pomo_stats({}, ctx);
  assert.equal(r.today.sessions, 1);
  assert.equal(r.today.minutes, 25);
  assert.equal(r.week.sessions, 1, '30h 前的记录已属上周，不应计入本周');
  assert.equal(r.week.avgDailyBasis, 1, '周一已过 1 天');
  assert.equal(r.week.avgDailyMinutes, 25, '周一日均不应被 /7 稀释成 4 分钟');
});

test('pomo-stats.pomo_stats：周一起点当日 00:00 精确命中，未来时间戳被排除', async () => {
  const monday = new Date(2026, 7, 31, 0, 30, 0, 0).getTime();
  const dayStart = new Date(2026, 7, 31, 0, 0, 0, 0).getTime();
  const sessions = [
    { startedAt: dayStart, duration: 25, tag: '数学' },          // 恰好 00:00 → 计入
    { startedAt: dayStart - 1, duration: 25, tag: '数学' },      // 00:00 前 1ms → 上周
    { startedAt: monday + 2 * HOUR, duration: 25, tag: '英语' }, // 未来（时钟回拨/脏数据）→ 排除
  ];
  const ctx = makeCtx({ now: () => monday, data: { listPomoSessions: async () => sessions } });
  const r = await pomo.pomo_stats({}, ctx);
  assert.equal(r.week.sessions, 1, '仅计入落在 [本周一 00:00, now] 内的记录');
  assert.equal(r.byTag.length, 1);
  assert.equal(r.byTag[0].tag, '数学');
});

test('pomo-stats.pomo_stats：数据层返回异常形态时不崩溃', async () => {
  for (const bad of [null, undefined, {}, 'oops']) {
    const ctx = makeCtx({ now: () => REF, data: { listPomoSessions: async () => bad } });
    const r = await pomo.pomo_stats({}, ctx);
    assert.equal(r.week.sessions, 0, `listPomoSessions 返回 ${String(bad)} 时应降级为空`);
    assert.equal(r.week.minutes, 0);
  }
  // 单条记录 duration 为字符串/缺失时按 0 计，不影响其余记录
  const ctx2 = makeCtx({
    now: () => REF,
    data: { listPomoSessions: async () => [
      { startedAt: REF - HOUR, duration: '25', tag: '数学' }, // 数值字符串 → 25
      { startedAt: REF - 2 * HOUR, tag: '数学' },             // 缺 duration → 0
      { startedAt: null, duration: 25, tag: '英语' },         // 缺 startedAt → 排除
    ] },
  });
  const r2 = await pomo.pomo_stats({}, ctx2);
  assert.equal(r2.week.sessions, 2);
  assert.equal(r2.week.minutes, 25);
});

test('due-alert.due_forecast：峰值与总量', async () => {
  const ctx = makeCtx({
    analytics: {
      getDueForecast: async (days) => {
        assert.equal(days, 14, '默认 14 天');
        return { daily: [
          { date: '08-28', count: 10 }, { date: '08-29', count: 40 }, { date: '08-30', count: 5 },
        ] };
      },
    },
  });
  const r = await due.due_forecast({}, ctx);
  assert.equal(r.days, 14);
  assert.equal(r.totalDue, 55);
  assert.equal(r.peak.date, '08-29');
  assert.equal(r.peak.count, 40);
  assert.equal(r.daily.length, 3);
});

test('due-alert.onReviewRated：超阈值触发 notify，未超不触发', async () => {
  const notified = [];
  const ctx = makeCtx({
    analytics: {
      getDueForecast: async () => ({ daily: [{ count: 40 }, { count: 5 }, { count: 2 }] }),
    },
    notify: (t) => notified.push(t),
  });
  await due.onReviewRated({ rating: 1 }, ctx);
  assert.equal(notified.length, 1, '未来 3 天 47 张 > 30 阈值应通知');
  assert.match(notified[0], /47/);
  // 未超阈值
  const ctx2 = makeCtx({
    analytics: { getDueForecast: async () => ({ daily: [{ count: 5 }, { count: 5 }, { count: 2 }] }) },
    notify: (t) => notified.push(t),
  });
  await due.onReviewRated({ rating: 1 }, ctx2);
  assert.equal(notified.length, 1, '12 张未超阈值不应再通知');
});
