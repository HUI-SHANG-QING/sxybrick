// tests/round50-n1-n2.test.mjs —— round50 两个 P3 的回归测试
// N1：写入边界长度上限（词卡侧软截断；卡片侧 MAX_CHARS 已有，补边界断言）
// N2：AI 上下文出口码点安全截断（emoji 不被劈成半个）
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { createWordCard } from '../src/word-repo.js';
import { validateCard } from '../src/repo-core.js';
import { compactConvo } from '../src/agent/agents/base.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

test('round50 N1：词卡字段超长静默截断（word/meaning/note 等写入边界）', async () => {
  const long = 'x'.repeat(10000);
  const card = await createWordCard({
    word: long,            // 200 上限
    meaning: long,         // 5000 上限
    note: long,            // 5000 上限
    source: long,          // 60 上限
    subject: long,         // 30 上限
  });
  assert.equal(card.word.length, 200);
  assert.equal(card.meaning.length, 5000);
  assert.equal(card.note.length, 5000);
  assert.equal(card.source.length, 60);
  assert.equal(card.subject.length, 30);
});

test('round50 N1：卡片侧 MAX_CHARS 上限拒绝超长 front/back（既有防线边界断言）', () => {
  const long = 'y'.repeat(9000);
  const r = validateCard({ front: long, back: 'ok', type: 'basic' });
  assert.ok(r.error && r.error.includes('8000'), '超 8000 字应被拒绝');
  // 码点安全：emoji 计 1 个"字"，7999 个 ASCII + 1 个 emoji 应放行
  const ok = validateCard({ front: 'a'.repeat(7999) + '😀', back: 'ok', type: 'basic' });
  assert.equal(ok.error, undefined, 'emoji 按码点计长，不应误伤');
});

test('round50 N2：AI 上下文出口截断不劈开 emoji（码点安全）', () => {
  // compactConvo 只在总量超 CONVO_CHAR_BUDGET(48000) 时才截断 → 需要 30000 个
  // emoji（UTF-16 length=60000 > 48000）触发；截断后应为 1500 个完整 emoji。
  const convo = [{ role: 'assistant', content: '😀'.repeat(30000) }];
  const out = compactConvo(convo);
  const head = String(out[0].content);
  // 截断后的正文不含半个 surrogate：去掉尾部"已截断"提示后，
  // Array.from 逐码点检查——劈开的半代理会变成 U+FFFD 替换符，被 every 抓住
  const body = head.replace(/…（已截断以控制上下文长度）$/, '');
  assert.ok(Array.from(body).length === 1500, '截断后应为 1500 个完整码点');
  assert.ok(Array.from(body).every((ch) => ch === '😀'), '每个字符都是完整 emoji（无劈开的代理对）');
});
