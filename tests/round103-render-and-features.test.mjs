// tests/round103-render-and-features.test.mjs —— round103 回归
//
// 用户反馈三件事：
//   ① 卡片联动分析输出「JSON 原文」没渲染（尤其预设）；② 费曼学习法是否也能读到详细数据；
//   ③ 英语单词本要能批量删除。
// 本文件锁定：
//   A. 结构化输出被**截断**时能被修复解析（此前 JSON.parse 失败 → 上层把裸 JSON 当正文甩给用户）；
//   B. timeline 类型在通用渲染路径下有可读输出（此前落到 genericToMd，接近裸 JSON）；
//   C. 费曼上下文用 clipText 给**完整正文 + 图片引用**（此前 .slice(0,100/140) 砍掉详情还切坏引用）；
//   D. 单词本有批量删除（多选 + 一次删除）且文案走 i18n（zh/en 都在）。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tryParseLLMJson } from '../src/utils/llm-json.js';
import { structuredToMarkdown, STRUCTURED_TYPES } from '../src/utils/ai-structured.js';
import '../src/agent/tools/index.js';
import { db } from '../src/db.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const src = (rel) => readFileSync(fileURLToPath(new URL('../' + rel, import.meta.url)), 'utf8');

test('A. 被截断的结构化输出能被修复解析（此前直接降级成裸 JSON）', () => {
  const truncated = '{"type":"timeline","data":{"steps":[{"step":1,"title":"拓扑起点","detail":"d"},{"step":2,"title":"第二步"';
  const r = tryParseLLMJson(truncated);
  assert.ok(r, '截断的 JSON 必须能修复解析（而不是返回 null 让上层把裸 JSON 当正文）');
  assert.equal(r.type, 'timeline');
  assert.equal(r.data.steps.length, 2, '应救回已生成的条目');
});

test('A2. 正常 JSON 不受截断修复影响（含字符串里的花括号 P^{-1}AP）', () => {
  const ok = '{"type":"list","data":{"items":[{"title":"t","detail":"P^{-1}AP 不能随意交换"}]},"note":"n"}';
  const r = tryParseLLMJson(ok);
  assert.equal(r.type, 'list');
  assert.ok(r.data.items[0].detail.includes('P^{-1}AP'));
});

test('B. timeline 在通用渲染路径下有可读输出（不是裸 JSON）', () => {
  assert.ok(STRUCTURED_TYPES.includes('timeline'), 'timeline 必须被列为支持的结构化类型');
  const md = structuredToMarkdown({ type: 'timeline', data: { steps: [{ step: 1, title: '数据结构', detail: '复杂度基础' }, { step: 2, title: '矩阵乘法' }] }, note: '按依赖排序' });
  assert.ok(md.includes('数据结构'), '必须渲染出步骤标题');
  assert.ok(md.includes('矩阵乘法'));
  assert.ok(!md.includes('{"'), '不得把裸 JSON 当渲染结果');
});

test('C. 费曼上下文给完整正文 + 图片引用（不再是 100/140 字切片）', () => {
  const fey = src('src/views/Feynman.vue');
  assert.match(fey, /import \{ clipText \} from '\.\.\/utils\/clip\.js'/, '费曼必须用 clipText 保护图片引用');
  // 正文构建处必须用 clipText，且不再出现旧的裸 slice 截断
  assert.ok(/clipText\(String\(c\.front\)/.test(fey) && /clipText\(String\(c\.back\)/.test(fey), 'front/back 必须经 clipText');
  assert.ok(!/String\(c\.front\)[^;]*\.slice\(0, 100\)/.test(fey), '不应再有 100 字裸切');
  assert.ok(!/String\(c\.back\)[^;]*\.slice\(0, 140\)/.test(fey), '不应再有 140 字裸切');
});

test('D. 单词本有批量删除（多选 + 一次删除），且文案 zh/en 齐备', () => {
  const wb = src('src/views/WordBook.vue');
  for (const token of ['batchMode', 'selIds', 'toggleSel', 'removeSelected', 'selectAllVisible']) {
    assert.ok(wb.includes(token), `WordBook 缺少批量删除相关实现：${token}`);
  }
  assert.match(wb, /t\('views\.wordBook\.batchDelete'\)/, '批量删除按钮必须走 i18n');
  const dict = src('src/i18n/views/wordBook.js');
  for (const k of ['batchManage', 'batchDelete', 'batchSelected', 'confirmBatchDelete', 'batchDeleted']) {
    const hits = dict.split(new RegExp(`\\b${k}:`)).length - 1;
    assert.equal(hits, 2, `i18n 键 ${k} 必须 zh/en 各一份（实际 ${hits}）`);
  }
});
