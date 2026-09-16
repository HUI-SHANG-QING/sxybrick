// tests/round99-convo-budget.test.mjs —— round99 回归（第二道压缩坎 + 意图补全 + 分类中文化）
//
// 背景：系统里其实有**两道**压缩闸门。第一道（compactToolPayload，工具级预算）上一轮已放宽；
// 第二道 = `base.js compactConvo` 的「整段对话 > 48000 字时把所有中间产物砍到 1500 字」，
// 它不认识第一道的放宽设置 → **连看几张长卡时，越是被追问的那张越先被砍残**（图靠 clipText 保住，文字丢约 88%）。
// 修复：compactConvo 改为**从最旧到最新逐个压缩、一旦回到预算内即停止**，让最新长卡正文完整保留。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { compactConvo } from '../src/agent/agents/base.js';
import { buildModuleNodesContext } from '../src/agent/context.js';
import { wantedModules } from '../src/utils/query-intent.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

test('compactConvo：超预算时从最旧开始压，最新长卡正文完整保留（第二道坎）', () => {
  const NEW_CARD = '长卡正文开始：' + '先序定根、中序分左右、递归还原整棵树。'.repeat(700); // ~1.7 万字
  const convo = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '帮我连看几张长卡' },
    { role: 'assistant', content: '甲'.repeat(30000) },                 // 旧：某步原始回复
    { role: 'user', content: '乙'.repeat(30000), __toolObs: true },     // 旧：某工具结果
    { role: 'assistant', content: '丙'.repeat(20000) },
    { role: 'user', content: NEW_CARD, __toolObs: true },               // 最新：长卡详情（应完整）
  ];
  const total0 = convo.reduce((n, m) => n + String(m.content).length, 0);
  assert.ok(total0 > 48000, `测试前提：应超 48000 预算（实际 ${total0}）`);

  const out = compactConvo(convo);
  const last = out[out.length - 1];
  assert.ok(String(last.content).includes(NEW_CARD), '最新长卡正文必须完整保留');
  assert.ok(!String(last.content).includes('已截断'), '最新长卡不应被截断');
  const total = out.reduce((n, m) => n + String(m.content).length, 0);
  assert.ok(total <= 48000, `压缩后应回到预算内，实际 ${total}`);
  assert.ok(!out.some((m) => m.__toolObs || m.__toolName), '内部标记必须被剥掉');
});

test('compactConvo：未超预算时原样返回（零改动）', () => {
  const convo = [{ role: 'system', content: 's' }, { role: 'user', content: '你好' }];
  assert.equal(compactConvo(convo), convo, '未超预算应返回同一引用');
});

test('意图：泛问全局 → 全量；复习/考试类 → 含计划/每日/单词', () => {
  assert.equal(wantedModules('我最近学得怎样'), null, '泛问全局 → null（全量）');
  assert.equal(wantedModules('帮我复盘一下'), null, '复盘 → 全量');
  const r = wantedModules('帮我复习一下线代');
  assert.ok(r.has('plans') && r.has('daily') && r.has('words'), '复习类 → 含计划/每日/单词');
  const k = wantedModules('考考我');
  assert.ok(k.has('plans') && k.has('words'), '考考我 → 含计划/单词');
  assert.equal(wantedModules('你好').size, 0, '问候语仍不命中');
});

test('笔记分类英文枚举中文化（idea → 想法）', async () => {
  await db.notes.clear();
  await db.notes.put({ id: 'n1', title: '线代第四章节笔记', content: '基础解系与通解的结构。', category: 'idea', tags: [], createdAt: Date.now(), updatedAt: Date.now() });
  const ctx = await buildModuleNodesContext('我的笔记里写了什么');
  assert.ok(ctx.includes('想法'), 'idea 应显示为「想法」');
  assert.ok(!/\bidea\b/.test(ctx), '不应再出现英文 idea');
});
