// tests/round118-kg-default-and-size.test.mjs —— round118：默认界面 = AI 生成 + 容器尺寸自愈
//
// 用户报：① 「载入到画布没有显示」② 「AI 生成好几次才成功，前面生成成功但没正确显示」
//         ③ 要求「把 AI 生成的作为知识图谱的默认界面」
//
// 真因（②③ 同源）：
//   ① 渲染容器 div 由 `v-if="nodes.length"` 控制 —— 首次生成 / 载入历史时它**刚被插进 DOM**，
//      布局尚未定型（clientWidth/Height 为 0）。ECharts 在 0×0 容器上 init 出来的实例，
//      setOption 画什么都是空白，且**不会自己恢复** → 用户看到"生成成功却没显示"，
//      反复点几次、等容器定型后才偶然成功。修法：rAF 补一次 resize + ResizeObserver 盯住容器。
//   ② `loadSaved()` 里 `if (list.length) mode.value='saved'` 会把默认界面强制切成「已保存关联」；
//      且 AI 生成结果是内存态、刷新即空。修法：不再自动切 + 进页面自动载回**最近一条 AI 快照**。
//
// .vue 无法在 node --test 里挂载，沿用本项目的**源码形态闸门**兜底。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const KG = readFileSync(new URL('../src/views/KnowledgeGraph.vue', import.meta.url), 'utf8');

test('默认界面：loadSaved 不得再把 mode 强制切成「已保存关联」', () => {
  assert.ok(!/if \(list\.length\) mode\.value = 'saved'/.test(KG),
    '这行会把用户要求的「默认 AI 生成界面」直接顶掉');
});

test('默认界面：进页面要自动载回最近一条 AI 快照（AI 生成是内存态，刷新即空）', () => {
  assert.match(KG, /async function autoLoadLatest\(\)/, '要有「载回最近快照」的实现');
  assert.match(KG, /await autoLoadLatest\(\)/, 'onMounted 里必须调用');
  assert.match(KG, /if \(generatedNodes\.value\.length\) return;/, '只在本会话还没有内容时才载，不覆盖用户刚生成的结果');
  assert.match(KG, /all\.find\(\(m\) => String\(m\?\.title \|\| ''\)\.startsWith\(prefix\)\)/,
    '只认 AI 快照（按标题前缀筛），不要把用户手建的导图也载进来');
});

test('容器尺寸自愈：尺寸为 0 时必须补 resize（否则「生成好几次才成功」会复发）', () => {
  assert.match(KG, /function ensureSized\(el\)/, '要有尺寸兜底函数');
  assert.match(KG, /if \(!el\.clientWidth \|\| !el\.clientHeight\) requestAnimationFrame\(fix\)/,
    'init 当帧尺寸为 0 → 下一帧补一次');
  assert.match(KG, /new ResizeObserver/, '还要用 ResizeObserver 盯住容器：尺寸一变就 resize');
  assert.match(KG, /if \(!chart\.getWidth\(\) \|\| !chart\.getHeight\(\)\) requestAnimationFrame/,
    'setOption 之后若仍是 0×0，也要再补一次');
  assert.match(KG, /ensureSized\(el\);/, 'initChart 里必须真的调用它');
});

test('容器尺寸自愈：ResizeObserver 必须在卸载时断开（防内存泄漏）', () => {
  assert.match(KG, /ro\?\.disconnect\(\)/);
  assert.match(KG, /ro = null;/);
});
