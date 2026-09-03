// tests/encrypted-backup.test.mjs —— M14 加密备份（.sxybrick）回归
// 覆盖：加密产出非明文 / 正确口令往返恢复 / 错误口令与损坏文件明确报错
// 判定背景：privacyRecords 落盘静态加密与既有跨设备隐私同步(opt-in)语义冲突
// （设备密钥对端不可解），故采用审计列出的最小可接受方案：离设备备份文件加密。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { createCard } from '../src/repo.js';
import { buildEncryptedBackup, importEncryptedBackup } from '../src/sync.js';

after(async () => { try { await db.close(); } catch {} });

const PW = 'SxyTest-Pw-2026';

test('M14 加密备份：产出非明文，正确口令可往返恢复', async () => {
  const c = await createCard({ front: '绝密正面XYZ', back: '绝密背面ABC', subject: '隐私科目' });
  const { payload, cardCount } = await buildEncryptedBackup(PW);
  assert.ok(payload, '应产出加密容器');
  assert.ok(cardCount >= 1);
  // 核心断言：加密包不得泄露明文（离设备文件不含裸数据）
  assert.ok(!payload.includes('绝密正面XYZ'), '加密包不得包含明文卡片内容');
  assert.ok(!payload.includes('隐私科目'), '加密包不得包含明文科目');

  // 清空本地后从加密包恢复
  await db.cards.clear();
  assert.equal((await db.cards.toArray()).length, 0);
  await importEncryptedBackup(payload, PW);
  const restored = await db.cards.get(c.id);
  assert.ok(restored, '卡片应随加密包恢复');
  assert.equal(restored.front, '绝密正面XYZ');
  assert.equal(restored.back, '绝密背面ABC');
});

test('M14 错误口令 / 损坏文件：明确报错，不静默导入脏数据', async () => {
  const { payload } = await buildEncryptedBackup(PW);
  await assert.rejects(() => importEncryptedBackup(payload, 'wrong-password'), /解密失败|口令错误/);
  await assert.rejects(() => importEncryptedBackup('this-is-not-valid-base64!!', PW), /解密失败|口令错误/);
  await assert.rejects(() => importEncryptedBackup(payload, ''), /请输入加密口令/);
  await assert.rejects(() => buildEncryptedBackup(''), /口令/);
});
