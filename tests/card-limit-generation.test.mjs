// tests/card-limit-generation.test.mjs —— AI 生成链路的卡片上限回归（round129）
//
// 背景：卡片上限由 8000 提升到 50000 时，一并清掉了 6 条生成链路里**各自写死**的
// 截断值（genDeck 8000 / genCardDeck front 200 + back 2000 / genVariants 8000 /
// offlineAI 8000 / wrongToCards 8000 / WrongBook 8000）。
// 本文件直接验证「生成出来的卡片内容不再被旧的 8000/2000 砍掉」——这是用户可感知的行为。
//
// 为什么单独一个文件：这些链路依赖 localStorage 垫片 + 需要 fake-indexeddb
// （genDeck/genVariants 会间接 import repo.js → Dexie），与「单一来源」静态闸门
// （tests/card-limit-single-source.test.mjs，纯静态、无浏览器依赖）分开更清晰。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { CARD_MAX_CHARS } from '../src/utils/card-limits.js';
import { parseCards } from '../src/utils/genDeck.js';
import { genCardDeck } from '../src/utils/genCardDeck.js';

/** 确保走离线分支（无密钥 ⇒ shouldFallback() === true），避免测试真的发网络请求。 */
function clearAiConfig() {
  localStorage.removeItem('sxy_ai_config');
}

test('genDeck.parseCards：AI 产出的长内容不再被砍到 8000', () => {
  const longBack = 'B'.repeat(20000);
  const out = parseCards(JSON.stringify([{ front: '问题', back: longBack }]));
  assert.equal(out.length, 1, '应解析出 1 张卡');
  assert.equal(
    out[0].back.length, 20000,
    `back 应完整保留 20000 字（旧版会砍到 8000）`,
  );
  assert.ok(out[0].back.length <= CARD_MAX_CHARS, '但仍不得超过上限');
});

test('genDeck.parseCards：超过上限时仍按上限截断（上界不失守）', () => {
  const tooLong = 'C'.repeat(CARD_MAX_CHARS + 5000);
  const out = parseCards(JSON.stringify([{ front: '问题', back: tooLong }]));
  assert.equal(out.length, 1);
  assert.equal(out[0].back.length, CARD_MAX_CHARS, `应截断到 ${CARD_MAX_CHARS}`);
});

test('genCardDeck 离线兜底：段落长内容不再被砍到 2000', async () => {
  clearAiConfig();
  // 一段 5000 字的正文（首句 2 字 + 后续长内容），无空行 ⇒ 只切出 1 张卡
  const long = 'X'.repeat(5000);
  const text = `短句。${long} 这是足够长的笔记内容以便通过最少 20 字的校验。`;
  const cards = await genCardDeck(text, { count: 1, subject: '计算机网络' });
  assert.ok(cards.length >= 1, '应至少产出 1 张卡');
  const back = String(cards[0].back || '');
  assert.ok(
    back.length > 2000,
    `离线兜底的 back 应超过旧上限 2000（实际 ${back.length}）——说明 2000 的硬截断已移除`,
  );
  assert.ok(back.length <= CARD_MAX_CHARS, 'back 不得超过新上限');
  assert.ok(String(cards[0].front || '').length <= CARD_MAX_CHARS, 'front 不得超过新上限');
});

test('genCardDeck：文本太短仍按原契约报错（扩容不该放宽输入校验）', async () => {
  clearAiConfig();
  await assert.rejects(
    () => genCardDeck('太短', { count: 1 }),
    /至少 20 字/,
    '输入长度下限（20 字）是与卡片上限无关的另一道校验，不应被本次扩容影响',
  );
});
