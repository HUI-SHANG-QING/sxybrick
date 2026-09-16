// tests/agent-image-truncation.test.mjs —— round91
//
// 用户反馈复现：「图片明明在本机，AI 却说『本机图库里没有这张图』」。
//
// 根因（实证后定性，不靠猜）：列表/搜索/薄弱卡等**摘要工具**用裸 `String(c.front).slice(0, 60)`
// 截断卡片正文。`sxy-img://<36位uuid>` 单个标记就 52 字符，正文前面只要写几个字，
// slice 就会把它**拦腰截断**，产出半截 id（如 `sxy-img://550e8400-e29b-41d4-a716-446655`）。
// 这半截 id 随工具结果进 ReAct 上下文 → `enrichForLlm` 用 `extractImageIds` 扫到它 →
// `db.images.get(半截id)` 查不到 → 标注「本机图库里没有这张图」。
//
// 真相是图就在库里（完整 id 对应的行存在），是摘要把 id 切坏了 —— 这正是用户说的
// 「明明在的图片它却说缺失了」。clip.js 早就备好了 `stripImageRefs`（去引用，适合摘要）
// 与 `clipText`（保引用完整，适合全文），但摘要工具一直没用，裸 slice 直到现在。
//
// 本文件钉住两件事：
//   ① 摘要工具（search_cards / get_weak_cards / smart_review_plan 的路径卡）
//      的 front/back 预览**不得**含任何 `sxy-img://` 片段（摘要意图本就不含图，hasImage 已标）；
//   ② 把摘要结果当成工具观察喂给 enrichForLlm，**不得**触发「本机没有这张图」的假报缺失。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { toolRegistry } from '../src/agent/registry.js';
import '../src/agent/tools/index.js';
import { db } from '../src/db.js';
import { putImage } from '../src/images.js';
import { enrichForLlm } from '../src/services/image-analysis.js';
import { stripImageRefs } from '../src/utils/clip.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const VISION = { imageAnalysis: { mode: 'visionFirst', visionLimit: 4, imageQuality: 'high' } };

/** 1×1 透明 PNG（最小合法图，用于证明「完整 id 对应的行确实在库里」） */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pngBlob = () => new Blob([Buffer.from(PNG_B64, 'base64')], { type: 'image/png' });

// 用一个标准 36 位 uuid 当图片 id（与生产 uid() 主路径一致）
const IMG_ID = '550e8400-e29b-41d4-a716-446655440000';
const IMG_REF = `![image](sxy-img://${IMG_ID})`;

// 关键：正文前先写 10 个字，让图片标记**起始于第 19 字符**（10 CJK + 9 ASCII 前缀）。
// slice(0, 60) 会从 uuid 中段切断 → 产出半截 id。这正是用户库里的真实形态
// （卡片正面几乎不会以图片标记开头，前面总有几个字）。
const FRONT_WITH_EARLY_IMG = `停止等待协议${IMG_REF}\n超时重传机制说明`;

async function seedCardAndImage() {
  await db.cards.clear();
  await db.images.clear();
  await db.reviews.clear();
  // 卡片正面带图（图在很前面 → 摘要必切坏）
  await db.cards.put({
    id: 'card-1', front: FRONT_WITH_EARLY_IMG, back: `背面也带图${IMG_REF}`,
    subject: '计算机网络', tags: ['错题'], source: 'OTHER', createdAt: Date.now(),
    updatedAt: Date.now(), failCount: 3, level: 2, ease: 2.5,
  });
  // weakCards 按 reviews 里 rating=0 的次数排名（不是 card.failCount 字段）→ 必须种复习记录
  await db.reviews.put({ id: 'rv-1', cardId: 'card-1', reviewedAt: Date.now() - 86400000, rating: 0, type: 'grade' });
  await db.reviews.put({ id: 'rv-2', cardId: 'card-1', reviewedAt: Date.now() - 43200000, rating: 0, type: 'grade' });
  // 图片**确实在**本机图库（完整 id 对应的行存在）
  await putImage(IMG_ID, pngBlob(), 'image/png');
}

/** 把工具 data 包成 ReAct 循环里那种「工具观察」消息（与 base.js toolObservation 同构） */
function toolObservation(name, data) {
  return { role: 'user', content: `工具 ${name} 返回：\n${JSON.stringify(data)}`, __toolObs: true, __toolName: name };
}

// ---------------- A. 复现：摘要工具切坏图片 id ----------------

test('复现+回归：search_cards 列出卡片时 front 预览不得含 sxy-img:// 片段（半截 id 会引发假报缺失）', async () => {
  await seedCardAndImage();
  const tool = toolRegistry.get('search_cards');
  // 不带关键词取全量（list 行为）——这是「列出库里有哪些卡」的主路径
  const res = await tool.execute({ limit: 10 }, {});
  assert.ok(res?.ok, 'search_cards 应成功');
  assert.ok(res.data.items.length >= 1, '必须命中刚种的带图卡');
  const item = res.data.items[0];
  // hasImage 必须为 true（图确实在卡里）——这是引导模型去取详情的正确信号
  assert.equal(item.hasImage, true, 'hasImage 必须为 true：图在卡里，只是摘要不含全文');
  // 摘要不得泄漏半截 sxy-img:// —— 半截 id 会让 enrichForLlm 去查一个永远查不到的 id
  assert.ok(!/sxy-img:\/\//.test(String(item.front)), `front 预览泄漏了图片引用片段：${String(item.front)}`);
  assert.ok(!/sxy-img:\/\//.test(String(item.back || '')), `back 预览泄漏了图片引用片段：${String(item.back || '')}`);
});

test('复现+回归：search_cards 的 front/back 预览不得含 sxy-img:// 片段', async () => {
  await seedCardAndImage();
  const tool = toolRegistry.get('search_cards');
  const res = await tool.execute({ q: '停止等待', limit: 10 }, {});
  assert.ok(res?.ok);
  for (const it of res.data.items) {
    assert.ok(!/sxy-img:\/\//.test(String(it.front)), `search front 泄漏：${String(it.front)}`);
    assert.ok(!/sxy-img:\/\//.test(String(it.back || '')), `search back 泄漏：${String(it.back || '')}`);
  }
});

test('复现+回归：get_weak_cards 的 front 预览不得含 sxy-img:// 片段', async () => {
  await seedCardAndImage();
  const tool = toolRegistry.get('get_weak_cards');
  const res = await tool.execute({ limit: 10 }, {});
  assert.ok(res?.ok);
  assert.ok(res.data.items.length >= 1, 'weakCards 必须命中带图的薄弱卡（已种 2 条 rating=0 复习记录）');
  for (const it of res.data.items) {
    assert.ok(!/sxy-img:\/\//.test(String(it.front)), `weak front 泄漏：${String(it.front)}`);
  }
});

// ---------------- B. 复现：切坏的 id 进上下文 → enrichForLlm 假报「本机没有这张图」 ----------------

test('回归：把 search_cards 结果当工具观察喂给 enrichForLlm，不得对库里存在的图报「本机没有这张图」', async () => {
  await seedCardAndImage();
  const res = await toolRegistry.get('search_cards').execute({ limit: 10 }, {});
  assert.ok(res.data.items.length >= 1);
  // 模拟 ReAct 循环里这一轮的真实上下文：用户问 + 工具观察
  const convo = [
    { role: 'user', content: '我库里有哪些带图的卡？' },
    toolObservation('search_cards', res.data),
  ];
  const { messages } = await enrichForLlm(convo, { settings: VISION });
  const out = messages.map((m) => JSON.stringify(m.content)).join('\n');
  // 图明明在库里（IMG_ID 对应的行存在），只是摘要不该带它的半截引用
  // → 任何形式的「本机没有这张图 / 不存在 / 未同步」都是假报缺失，必须杜绝
  assert.ok(
    !/本机图库里没有这张图|本机没有这张图/.test(out),
    `明明在库里的图被报成缺失（半截 id 触发的假告警）：${out.slice(0, 300)}`,
  );
});

// ---------------- C. 对照组：完整引用必须正常解析（证明改的是摘要，不是读路径） ----------------

test('对照组：卡片正文带完整引用时，enrichForLlm 必须把图送出去（读路径无缺陷）', async () => {
  await seedCardAndImage();
  // 这条消息里是**完整**引用 —— 与摘要切坏的半截引用相对照
  const { messages, vision } = await enrichForLlm(
    [{ role: 'user', content: `看这张图：\n${IMG_REF}` }],
    { settings: VISION },
  );
  assert.equal(vision, 1, '完整引用 → 必须送出 1 张图');
  // content 可能是多模态数组，统一 JSON.stringify 取文本
  const out = messages.map((m) => JSON.stringify(m.content)).join('\n');
  assert.match(out, /已作为附图发送/, '完整引用的图必须正常送出，不得误报缺失');
});

// ---------------- D. stripImageRefs 单元（摘要工具内部应依赖它，而非裸 slice） ----------------

test('工具约定：stripImageRefs 必须把带图正文压成纯文字摘要（摘要工具的实现依据）', () => {
  const out = stripImageRefs(FRONT_WITH_EARLY_IMG);
  assert.ok(!/sxy-img/.test(out), 'stripImageRefs 必须移除全部图片引用');
  assert.match(out, /停止等待协议/, '正文文字必须保留');
  assert.match(out, /超时重传机制说明/, '引用之后的文字也必须保留');
});
