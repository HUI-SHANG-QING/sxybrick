// tests/view-mount-load.test.mjs —— 「挂载即加载」闸门（round130）
//
// 症状（用户报告）：AI 文档模块刷新后看不到历史记录；从其它模块进入也看不到；
//   只有新建并提示"保存成功"后才短暂出现，再刷新又没了。
//
// 真因：Docs.vue 的 `applyRouteId()` 把 `if (!id) return;` 写在 `await load()` **之前** ——
//   URL 没有 `?id=` 时（刷新 / 从侧栏进入）直接提前返回，`load()` 永不执行，
//   `docs` 恒为空数组。只有 save() 里显式调了 load() 才会看到一次。
//   而 Memo.vue / Plans.vue 的同名函数都是 `await load();` 在最前 —— **Docs 是唯一异常**。
//
// 为什么用静态断言而不是挂载组件：本仓库测试跑在 `node --test` 下，没有
//   @vue/test-utils / vitest，无法 mount SFC。这类"语句顺序"缺陷用源码顺序断言
//   既精确又零成本（属于"断言结构性特征"，比断言某个值安全，见 RULES-vue-build §14.4c）。
//
// ⚠️ 本闸门第一版自己踩了坑（已修正，留作教训）：
//   ① 用 `/if\s*\(\s*!id\s*\)\s*return/` 无锚定匹配 → **匹配到了解释性注释里的同名文本**
//      （注释里为了说明 bug 会写 `if (!id) return`），于是在**已修复的代码上误报**。
//      修法：**行首锚定** `/^\s*if\s*\(\s*!id\s*\)\s*return;/m` —— 注释行以 `//` 开头，天然不命中。
//      （同类教训见 RULES-vue-build §14.4d/§14.5：闸门要么剥离注释，要么用行首锚定。）
//   ② 断言所有页面都是 `onMounted(applyRouteId)` 直挂 → Plans.vue 其实用 `onMounted(async () => {...})`
//      包装（内含 loading 状态），误报。修法：只断言 onMounted 的调用处**确实引用了 applyRouteId**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/** 用 applyRouteId 做挂载加载的页面 —— 它们必须"先加载、再按 ?id= 定位"。 */
const ROUTE_ID_PAGES = ['Docs.vue', 'Memo.vue', 'Plans.vue'];

/** 取出 `function <name>(` 到对应收尾 `\n}` 之间的函数体（含签名）。 */
function fnBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const end = src.indexOf('\n}', start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

/** 行首锚定的「真实语句」判定器 —— 不看注释里的同名文本。 */
const RE_LOAD = /^[ \t]*await load\(\);/m;
const RE_RET = /^[ \t]*if\s*\(\s*!id\s*\)\s*return;/m;

test('挂载加载：applyRouteId 必须先 load() 再判断 ?id=（否则刷新后列表恒为空）', () => {
  const offenders = [];
  for (const f of ROUTE_ID_PAGES) {
    const body = fnBody(read(`${SRC}/views/${f}`), 'applyRouteId');
    if (body === null) { offenders.push(`${f}: 找不到 applyRouteId()`); continue; }

    const mLoad = RE_LOAD.exec(body);
    const mRet = RE_RET.exec(body);

    if (!mLoad) { offenders.push(`${f}: applyRouteId 里没有 \`await load();\`（挂载时不会加载任何数据）`); continue; }
    if (!mRet) { offenders.push(`${f}: applyRouteId 里找不到 \`if (!id) return;\`（结构与约定不符，请人工确认）`); continue; }
    // ⭐ 核心断言：load() 必须出现在提前 return 之前（比较真实语句的位置，非注释）
    if (mLoad.index > mRet.index) {
      offenders.push(
        `${f}: \`if (!id) return;\` 出现在 \`await load();\` **之前** —— `
        + `URL 无 ?id= 时（刷新 / 从其它模块进入）会提前返回，历史列表恒为空。`,
      );
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('挂载加载：onMounted 的调用处必须真的引用了 applyRouteId', () => {
  // 只断言"引用了"，不限定写法 —— Docs/Memo 是 `onMounted(applyRouteId)`，
  // Plans 是 `onMounted(async () => { ... await applyRouteId(); ... })`，两者都合法。
  for (const f of ROUTE_ID_PAGES) {
    const src = read(`${SRC}/views/${f}`);
    const i = src.indexOf('onMounted(');
    assert.ok(i >= 0, `${f}: 找不到 onMounted(`);
    const callText = src.slice(i, i + 240);
    assert.match(
      callText, /applyRouteId/,
      `${f}: onMounted 的调用处没有引用 applyRouteId —— 挂载时不会加载数据。`
      + `（若改了挂载方式，请同步调整本闸门）`,
    );
    const body = fnBody(src, 'applyRouteId');
    assert.ok(body && /^[ \t]*await load\(\);/m.test(body), `${f}: applyRouteId 必须调用 await load();`);
  }
});

test('回归防重演：Docs.vue 的 applyRouteId 中 load() 必须在 return 之前', () => {
  // 上条的具体化（round130 的真实回归点），失败信息直接指向历史 bug。
  const body = fnBody(read(`${SRC}/views/Docs.vue`), 'applyRouteId');
  const mLoad = RE_LOAD.exec(body);
  const mRet = RE_RET.exec(body);
  assert.ok(mLoad && mRet, 'Docs.applyRouteId 结构发生变化，请人工确认本闸门仍适用');
  assert.ok(
    mLoad.index < mRet.index,
    'round130 回归：Docs.vue 的 `await load();` 又跑到 `if (!id) return;` 之后了 —— '
    + '这会让「刷新 / 从其它模块进入」看不到历史文档列表。',
  );
});

// ---------------------------------------------------------------------------
// round131：同一路由的 query 变化必须被响应（否则定位/高亮/选中不更新）
//
// 真因：`/docs`、`/memo`、`/plans` 都是**静态 path**，`?id=` 只是 query。
//   从 `#/docs?id=a` 变到 `#/docs?id=b`（浏览器前进/后退、同路由跳转）时，
//   vue-router **复用同一个组件实例**，`onMounted` 不会再次执行 ⇒ `applyRouteId()`
//   只跑过一次，`activeId` / `highlightId` 停留在旧值。
//
//   真机复现（probe178，headless Chrome + CDP）：冷启动 `?id=docB` 定位正确（BBB），
//   随后同页把 hash 改成 `?id=docA` —— 组件复用成立（window 哨兵存活），
//   但选中项**仍是 BBB**；补一条 `watch(() => route.fullPath, ...)` 后变为 AAA。
//   负向对照：临时移除该 watch → 该断言立刻报红。
//
// 为什么断言"存在 watch(route.fullPath)"而不是断言某一行位置：
//   这是"结构性特征"（RULES-vue-build §14.4c）—— 只要页面响应了 fullPath 变化即可，
//   不限定 watch 写在 onMounted 之前还是之后。
// ---------------------------------------------------------------------------
/** 页面是否响应了路由 fullPath 变化（watch(() => route.fullPath, ...)）。 */
const RE_WATCH_FULLPATH = /^[ \t]*watch\(\s*\(\)\s*=>\s*route\.fullPath\b/m;

test('round131：用 ?id= 定位的页面必须监听 route.fullPath（否则同页 query 变化不重新定位）', () => {
  const offenders = [];
  for (const f of ROUTE_ID_PAGES) {
    const src = read(`${SRC}/views/${f}`);
    if (!RE_WATCH_FULLPATH.test(src)) {
      offenders.push(
        `${f}: 找不到 \`watch(() => route.fullPath, ...)\` —— `
        + `从 #${f === 'Docs.vue' ? '/docs' : f === 'Memo.vue' ? '/memo' : '/plans'}?id=a 切到 ?id=b 时`
        + `组件会复用、onMounted 不再执行，定位/选中态会停留在旧值。`,
      );
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('round131：watch 必须真的重新走定位逻辑（引用 applyRouteId），不能是空监听', () => {
  // 防"为了过闸门而写一个什么都不做的 watch"。
  const offenders = [];
  for (const f of ROUTE_ID_PAGES) {
    const src = read(`${SRC}/views/${f}`);
    const i = src.search(RE_WATCH_FULLPATH);
    if (i < 0) { offenders.push(`${f}: 没有 watch(fullPath)`); continue; }
    // 取 watch( 起 200 字符窗口，必须含 applyRouteId（回调里重新定位）
    const win = src.slice(i, i + 200);
    if (!/applyRouteId/.test(win)) {
      offenders.push(`${f}: watch(() => route.fullPath, ...) 的回调里没有调用 applyRouteId —— 空监听无效。`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});
