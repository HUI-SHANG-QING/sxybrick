// tests/heatmap-option-contract.test.mjs —— 365 天热力图 visualMap 维度契约（round38 回归防护）
//
// 背景（真实事故）：buildHeatSeries 生成的是 4 元组 [x, y, count, date]（第 4 维给 tooltip 用），
// 而 ECharts 的 visualMap **默认取「最后一个维度」**当数值 → 它拿到 date 字符串，无法映射到色带，
// 于是所有格子都按「无值」渲染成 0 值浅灰：图表看着是空的（只有坐标轴 + 色条），
// 数据一天都不上色。168h 热力图的 data 是 3 元组（value 在末维）所以一直正常 —— 差异极隐蔽。
//
// 这条测试是「源码契约」：一旦有人改回 3 元组、或删掉 `dimension: 2`、或调换 count/date 顺序，
// 立即失败。图形渲染本身由浏览器探针验证（CDP），单测只锁结构与一致性。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'src', 'views', 'UserDashboard.vue'), 'utf8');

test('365 天热力图：series data 含 date 维 → visualMap 必须显式 dimension: 2', () => {
  // 1) series 数据确实是 4 元组，且第 3 位是 count、第 4 位是 date
  assert.match(
    SRC,
    /out\.push\(\[String\(x\), WEEK_SUN_AXIS\.value\[y\], c\.count, c\.date\]\)/,
    'buildHeatSeries 应输出 [x, y, count, date] 四元组（date 供 tooltip 使用）',
  );

  // 2) 对应的 visualMap 必须指定 dimension: 2（取 count），否则 ECharts 会去取 date 字符串
  const hasDim = /visualMap:\s*\{\s*dimension:\s*2,/.test(SRC);
  assert.ok(hasDim, '365 天热力图的 visualMap 必须写 dimension: 2 —— 否则所有格子不上色（图看着是空的）');

  // 3) tooltip 仍取第 4 维（date），确认两边没有一起被改错
  assert.match(SRC, /p\[0\]\.data\[3\]/, 'tooltip 应从 data[3] 取日期');
});
