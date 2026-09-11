// 同步清单与合并语义回归测试（node --test）
// 覆盖：18 表登记（v18 新增 notes，含 embeddings + docFiles，不含 privacyRecords 默认）、
//   卡片双时间戳字段级合并、consolidation(R2) / wrongReasonAt(R1) 跨设备保留、
//   三种 merge 策略、墓碑 kind 传播与复活
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNC_TABLES, BACKUP_VERSION,
  EXCLUDED_FROM_SYNC, PRIVACY_SYNC_TABLES,
  CARD_SRS_FIELDS, WORD_EXT_FIELDS,
  mergeCardPair, mergeRows, mergeTombstones, applyTombstones, kindOf, shiftRowClock,
  mergeByFieldTs, tombKindTable,
} from '../src/sync-manifest.js';

test('清单：38 张表全部登记且策略合法', () => {
  // v19 → 20；v22（M1）cardGroups + cardGroupLinks → 22；v23（M2）analysisSessions + analysisMessages → 24；
  // v25（英语单词模块）wordCards + wordReviews + wordGroups + wordGroupLinks → 28；
  // v26（英语模块升级）wordSettings + wordCheckins + wordSyllabusMeta → 31
  // v30（大纲中文释义）syllabusMeanings → 32
  // v31（通用卡↔英语词卡链接）cardWordLinks → 33
  // v33（round38，用户要求）notifications/errors/aiUsage/wordExportHistory/wordStudyLog → 38
  // 审查：userOps 保留在同步清单（分析用），由 repo.pruneUserOps() 做 365 天保留期清理（写墓碑）
  assert.equal(SYNC_TABLES.length, 38);
  assert.equal(BACKUP_VERSION, 9);
  const names = SYNC_TABLES.map(t => t.table);
  // privacyRecords 不在默认同步清单
  assert.ok(!names.includes('privacyRecords'), 'privacyRecords 不应默认入同步');
  // round38：原「仅本机」的 5 张表已并入同步
  for (const t of ['notifications', 'errors', 'aiUsage', 'wordExportHistory', 'wordStudyLog']) {
    assert.ok(names.includes(t), `${t} 应入同步（round38）`);
  }
  for (const need of ['cards', 'reviews', 'images', 'aiChats', 'aiMemories', 'memos', 'plans', 'graphEdges', 'docs', 'docFiles', 'pomoSessions', 'mindmaps', 'weeklyReports', 'achievements', 'exams', 'embeddings', 'userOps', 'notes', 'dailyPlans', 'dailyTasks', 'cardGroups', 'cardGroupLinks', 'cardWordLinks', 'analysisSessions', 'analysisMessages', 'wordCards', 'wordReviews', 'wordGroups', 'wordGroupLinks', 'wordSettings', 'wordCheckins', 'wordSyllabusMeta']) {
    assert.ok(names.includes(need), `缺少表 ${need}`);
  }
  for (const t of SYNC_TABLES) {
    assert.ok(['card', 'chat', 'updatedAt', 'idOnly', 'review'].includes(t.merge), `${t.table} 策略非法`);
    assert.ok(t.kind, `${t.table} 缺 kind`);
  }
});

test('v26 钩子：wordSettings 跨设备 strip 敏感字段（llmApiKey/llmBase）', () => {
  // 导出侧 strip 钩子：同步/全量导出时剔除 LLM Key，对端保留自己的本地 Key，互不泄露
  const entry = SYNC_TABLES.find(t => t.table === 'wordSettings');
  assert.ok(entry, 'wordSettings 应登记');
  assert.deepEqual(entry.strip, ['llmApiKey', 'llmBase'], 'strip 必须精确剔除这两个敏感字段');
  // 合并策略：按 updatedAt 谁新听谁（设置单行 id='me'）
  assert.equal(entry.merge, 'updatedAt');
  // 模拟导出侧剔除：strip 命中字段被删除，其余字段保留
  const row = { id: 'me', tts: 'edge', dailyGoal: 20, llmApiKey: 'sk-xxxx', llmBase: 'https://api.x', updatedAt: 123 };
  const exported = { ...row };
  for (const k of entry.strip || []) delete exported[k];
  assert.equal(exported.llmApiKey, undefined, 'llmApiKey 必须被剔除');
  assert.equal(exported.llmBase, undefined, 'llmBase 必须被剔除');
  assert.equal(exported.tts, 'edge', '非敏感字段保留');
  assert.equal(exported.dailyGoal, 20, '非敏感字段保留');
});

test('round38：原「仅本机」5 表已并入同步，且有硬性障碍的 2 表仍排除', () => {
  for (const t of ['notifications', 'errors', 'aiUsage', 'wordExportHistory', 'wordStudyLog']) {
    assert.ok(!EXCLUDED_FROM_SYNC.includes(t), `${t} 不应再在排除清单（round38 已入同步）`);
  }
  // snapshots（整库 dump）与 plugins（可执行代码/可能含密钥）保持本机
  assert.ok(EXCLUDED_FROM_SYNC.includes('snapshots'));
  assert.ok(EXCLUDED_FROM_SYNC.includes('plugins'));
});

test('隐私表：默认不入同步，opt-in 清单存在', () => {
  assert.ok(PRIVACY_SYNC_TABLES.some(t => t.table === 'privacyRecords'));
  assert.ok(!SYNC_TABLES.some(t => t.table === 'privacyRecords'));
});

test('R2: consolidation 已入 CARD_SRS_FIELDS', () => {
  assert.ok(CARD_SRS_FIELDS.includes('consolidation'), 'consolidation 必须在 SRS 字段列表中');
});

test('R2 回归：consolidation 跨设备合并保留（复习推进不 bump updatedAt）', () => {
  // 设备A：复习把 consolidation 推进 1→2（不 bump updatedAt）
  const local = { id: 'c1', front: '旧文', back: '旧答', ease: 2.5, level: 2, consolidation: 2, reviewedAt: 2000, updatedAt: 1000 };
  // 设备B：编辑文字（bump updatedAt），consolidation 未变
  const incoming = { id: 'c1', front: '新文', back: '新答', ease: 2.0, level: 1, consolidation: 1, reviewedAt: 900, updatedAt: 2000 };
  const m = mergeCardPair(local, incoming);
  assert.equal(m.front, '新文'); // 内容取 updatedAt 新者（设备B）
  assert.equal(m.consolidation, 2); // SRS 取 reviewedAt 新者（设备A），consolidation 必须保留
  assert.equal(m.ease, 2.5);
  assert.equal(m.level, 2);
});

test('R1 回归：wrongReason 用独立时间戳合并，不随 updatedAt 丢失', () => {
  // 设备A：复习写错因 wrongReason='概念混淆'，wrongReasonAt=3000（不 bump updatedAt=1000）
  const local = { id: 'c2', front: '旧文', back: '旧答', wrongReason: '概念混淆', wrongReasonAt: 3000, updatedAt: 1000, reviewedAt: 1000, ease: 2.5, level: 1 };
  // 设备B：编辑文字（bump updatedAt=2000），不写错因
  const incoming = { id: 'c2', front: '新文', back: '新答', updatedAt: 2000, reviewedAt: 900, ease: 2.0, level: 2 };
  const m = mergeCardPair(local, incoming);
  assert.equal(m.front, '新文'); // 内容取设备B
  assert.equal(m.wrongReason, '概念混淆'); // 错因必须保留（设备A 的 wrongReasonAt 更新）
  assert.equal(m.wrongReasonAt, 3000);
});

test('R1 回归：wrongReason 反向场景（设备B 写了更新的错因）', () => {
  // 设备A：旧错因，wrongReasonAt=1000
  const local = { id: 'c3', front: '文', back: '答', wrongReason: '粗心', wrongReasonAt: 1000, updatedAt: 500, reviewedAt: 500, ease: 2.5, level: 1 };
  // 设备B：复习写新错因，wrongReasonAt=4000
  const incoming = { id: 'c3', front: '文', back: '答', wrongReason: '记忆不牢', wrongReasonAt: 4000, updatedAt: 500, reviewedAt: 4000, ease: 2.0, level: 2 };
  const m = mergeCardPair(local, incoming);
  assert.equal(m.wrongReason, '记忆不牢'); // 取 wrongReasonAt 更新者
  assert.equal(m.wrongReasonAt, 4000);
});

test('卡片双时间戳：内容按 updatedAt、SRS 按 reviewedAt 字段级合并', () => {
  const local = { id: 'c1', front: '旧文', back: '旧答', tags: ['a'], ease: 2.5, level: 2, dueAt: 100, updatedAt: 1000, reviewedAt: 1000 };
  const incoming = { id: 'c1', front: '新文', back: '新答', tags: ['b'], ease: 2.0, level: 0, dueAt: 500, updatedAt: 2000, reviewedAt: 900 };
  const m = mergeCardPair(local, incoming);
  assert.equal(m.front, '新文'); // 内容取 updatedAt 新者
  assert.deepEqual(m.tags, ['b']);
  assert.equal(m.ease, 2.5);    // SRS 取 reviewedAt 新者（本地）
  assert.equal(m.level, 2);
  assert.equal(m.dueAt, 100);
  assert.equal(m.updatedAt, 2000);
});

test('卡片双时间戳：复习新于编辑时，编辑内容不被复习覆盖', () => {
  const local = { id: 'c2', front: '我新编辑的内容', back: 'b', updatedAt: 3000, reviewedAt: 1000, ease: 2.5, level: 1, dueAt: 111 };
  const incoming = { id: 'c2', front: '旧内容', back: 'b', updatedAt: 1500, reviewedAt: 4000, ease: 1.8, level: 3, dueAt: 999 };
  const m = mergeCardPair(local, incoming);
  assert.equal(m.front, '我新编辑的内容'); // 内容不丢
  assert.equal(m.ease, 1.8);               // SRS 取复习新者
  assert.equal(m.dueAt, 999);
});

test('旧数据无 reviewedAt：退化为 updatedAt（向后兼容）', () => {
  const a = { id: 'x', front: 'A', updatedAt: 5, ease: 2.5, level: 2 };
  const b = { id: 'x', front: 'B', updatedAt: 9, ease: 1.8, level: 1, reviewedAt: 9 };
  const m = mergeCardPair(a, b);
  assert.equal(m.front, 'B');
  assert.equal(m.ease, 1.8);
});

test('mergeRows：updatedAt 谁新听谁 / idOnly 幂等', () => {
  const r1 = mergeRows([{ id: 'x', v: 1, updatedAt: 5 }, { id: 'y', v: 1, createdAt: 3 }], [{ id: 'x', v: 2, updatedAt: 4 }, { id: 'y', v: 2, updatedAt: 9 }], 'updatedAt');
  assert.equal(r1.find(r => r.id === 'x').v, 1);
  assert.equal(r1.find(r => r.id === 'y').v, 2);
  const r2 = mergeRows([{ id: 'a', unlockedAt: 1 }], [{ id: 'a', unlockedAt: 2 }], 'idOnly');
  assert.equal(r2.length, 1);
  assert.equal(r2[0].unlockedAt, 1); // 已存在即保留
});

test('mergeRows：strip 表合并保留本地敏感字段（P1-C 回归）', () => {
  // 本地有 LLM Key；对端导出前 strip 剔除该字段，且 updatedAt 更新 → 整行替换会清空 Key
  const local = [{ id: 's1', llmApiKey: 'sk-local-abc', llmBase: 'https://local', mode: 'off', updatedAt: 100 }];
  const incoming = [{ id: 's1', mode: 'on', updatedAt: 200 }]; // 无 Key（已被 strip）
  const m = mergeRows(local, incoming, 'updatedAt', { strip: ['llmApiKey', 'llmBase'] });
  assert.equal(m[0].mode, 'on'); // 非敏感字段正常取新
  assert.equal(m[0].llmApiKey, 'sk-local-abc'); // 敏感字段保留本地值
  assert.equal(m[0].llmBase, 'https://local');
  // 本地无该字段时（首装导入对端行）→ 落 incoming 的值（undefined 保持）
  const m2 = mergeRows([], incoming, 'updatedAt', { strip: ['llmApiKey', 'llmBase'] });
  assert.equal(m2[0].llmApiKey, undefined);
  // 无 strip 参数时行为不变（不破坏旧调用）
  const m3 = mergeRows(local, incoming, 'updatedAt');
  assert.equal(m3[0].llmApiKey, undefined);
  assert.equal(m3[0].mode, 'on');
  // 对端旧版未 strip（带 Key）时：仍保留本地值（本地凭证优先，互不泄露）
  const incomingLegacy = [{ id: 's1', mode: 'on', llmApiKey: 'sk-remote', updatedAt: 200 }];
  const m4 = mergeRows(local, incomingLegacy, 'updatedAt', { strip: ['llmApiKey', 'llmBase'] });
  assert.equal(m4[0].llmApiKey, 'sk-local-abc');
});

test('mergeRows：review 策略——主体不可变、selfExplanation 按 selfExplainAt 取新', () => {
  // 本地已有复习记录（无反思）；远端来了同一 id、带更新的反思
  const local = [{ id: 'r1', rating: 0, reviewedAt: 1000 }];
  const incoming = [{ id: 'r1', rating: 0, reviewedAt: 1000, selfExplanation: '我把死锁和饥饿搞混了', selfExplainAt: 2000 }];
  const m = mergeRows(local, incoming, 'review');
  assert.equal(m[0].rating, 0); // 主体字段不变
  assert.equal(m[0].selfExplanation, '我把死锁和饥饿搞混了'); // 反思合并进来
  assert.equal(m[0].selfExplainAt, 2000);
});

test('mergeRows：review 策略——反思谁新听谁（旧反思不被覆盖）', () => {
  const local = [{ id: 'r1', selfExplanation: '旧反思', selfExplainAt: 5000 }];
  const incoming = [{ id: 'r1', selfExplanation: '旧反思(远端)', selfExplainAt: 3000 }];
  const m = mergeRows(local, incoming, 'review');
  assert.equal(m[0].selfExplanation, '旧反思'); // 本地反思更新，保留
  assert.equal(m[0].selfExplainAt, 5000);
});

test('墓碑：kind 泛化 + deletedAt 谁新听谁 + 缺省 kind=card', () => {
  const tb = mergeTombstones(
    [{ id: 't1', kind: 'card', deletedAt: 10 }],
    [{ id: 't1', deletedAt: 5 }, { id: 't2', kind: 'doc', deletedAt: 7 }],
  );
  const t1 = tb.find(t => t.id === 't1');
  assert.equal(t1.deletedAt, 10);
  assert.equal(kindOf(t1), 'card');
  assert.equal(tb.find(t => t.id === 't2').kind, 'doc');
});

test('applyTombstones：旧行删除 / 新行复活标记 stale / kind 隔离', () => {
  const tombs = [
    { id: 'a', kind: 'mindmap', deletedAt: 8 },
    { id: 'b', kind: 'doc', deletedAt: 3 },
  ];
  const rows = [{ id: 'a', updatedAt: 5 }, { id: 'b', updatedAt: 20 }];
  const rMind = applyTombstones(rows, tombs, 'mindmap');
  assert.deepEqual(rMind.removed, ['a']);
  assert.equal(rMind.rows.length, 1);
  const rDoc = applyTombstones(rows, tombs, 'doc');
  assert.deepEqual(rDoc.stale, ['b']); // b 编辑晚于删除 → 复活，墓碑应清除
  assert.deepEqual(rDoc.removed, []);
});

// ---------- round15 P2：清空水位 + 本地表登记 ----------

test('EXCLUDED_FROM_SYNC：本地表 docTexts/docBlobs/trash 已登记（清单=唯一事实来源）', () => {
  // round38：aiUsage/wordExportHistory 已转入 SYNC_TABLES；imageRefs 已删除（v33）
  for (const t of ['docTexts', 'docBlobs', 'trash', 'snapshots', 'plugins']) {
    assert.ok(EXCLUDED_FROM_SYNC.includes(t), `本地表 ${t} 应登记在排除清单`);
  }
});

test('round38 ①：mergeByFieldTs 平局按字典序确定性收敛（不再两端各取对方）', () => {
  const ts = 1000;
  const a = { id: 'n1', title: 'AAA', fieldTs: { title: ts }, updatedAt: ts };
  const b = { id: 'n1', title: 'BBB', fieldTs: { title: ts }, updatedAt: ts };
  const ab = mergeByFieldTs(a, b); // A 合并「对端 B」
  const ba = mergeByFieldTs(b, a); // B 合并「对端 A」
  assert.equal(ab.title, ba.title, '两端必须收敛到同一值（否则永久横跳）');
  assert.equal(ab.title, 'AAA', '平局取字典序小者（"AAA" < "BBB"）');
  // 较新时间戳仍按字段级 LWW 胜出（回归保护）
  const newer = { id: 'n1', title: 'ZZZ', fieldTs: { title: ts + 1 }, updatedAt: ts + 1 };
  assert.equal(mergeByFieldTs(a, newer).title, 'ZZZ', '对端较新 → 取对端');
  assert.equal(mergeByFieldTs(newer, a).title, 'ZZZ', '本端较新 → 保留本端');
  // 对端独有字段直接采纳（无冲突）
  const only = mergeByFieldTs({ id: 'n1', fieldTs: {} }, { id: 'n1', subject: 'X', fieldTs: { subject: 5 } });
  assert.equal(only.subject, 'X', '对端独有字段应采纳');
  // strip 字段永不采纳 incoming
  assert.equal(mergeByFieldTs({ id: 'n1', fieldTs: {} }, { id: 'n1', k: 'SECRET', fieldTs: { k: 5 } }, ['k']).k, undefined);
});

test('round38 ④：墓碑 kind→表 由同步清单自动派生（无漏登记，含历史漏网 kind）', () => {
  const map = tombKindTable();
  for (const t of [...SYNC_TABLES, ...PRIVACY_SYNC_TABLES]) {
    assert.equal(map[t.kind || t.table], t.table, `kind ${t.kind} 应映射到 ${t.table}`);
  }
  // 历史手写清单漏登记的 kind（曾导致这些墓碑永不 GC）——自动派生后必须已覆盖
  for (const [k, tbl] of [
    ['groupLink', 'cardGroupLinks'], ['pomo', 'pomoSessions'], ['memory', 'aiMemories'],
    ['privacy', 'privacyRecords'], ['userOp', 'userOps'], ['card', 'cards'],
  ]) {
    assert.equal(map[k], tbl, `kind ${k} 应映射到 ${tbl}`);
  }
});

test('round38 ④b：源码里所有墓碑 kind 都能在派生映射中找到表（防未来手滑）', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.js')) files.push(p);
    }
  };
  for (const r of ['src', 'sync-hub']) walk(r);
  assert.ok(files.length > 40, `扫描文件数异常（${files.length}）——测试可能空跑`);
  const map = tombKindTable();
  const missing = [];
  let scannedKinds = 0;
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('deletedAt')) continue; // 墓碑行形状：{ id, kind: 'x', deletedAt }
      const m = line.match(/kind:\s*'([a-zA-Z][a-zA-Z0-9]*)'/);
      if (m) { scannedKinds++; if (!map[m[1]]) missing.push(`${f.replace(/\\/g, '/')}: kind '${m[1]}'`); }
    }
  }
  assert.ok(scannedKinds > 5, `墓碑 kind 采样数异常（${scannedKinds}）——测试可能空跑`);
  assert.deepEqual(missing, [],
    `以下墓碑 kind 未映射到表 → pruneTombstones 将永不回收它们：\n  ${missing.join('\n  ')}`);
});

test('round38 ②：notifications 用 updatedAt 策略——已读状态跨设备传播且两端收敛', () => {
  const entry = SYNC_TABLES.find(t => t.table === 'notifications');
  assert.equal(entry.merge, 'updatedAt', '已读状态需靠 updatedAt 传播（idOnly 不会传播已存在行的更新）');
  const unread = { id: 'n1', read: 0, updatedAt: 100 };
  const readLater = { id: 'n1', read: 1, updatedAt: 200 };
  const ab = mergeRows([unread], [readLater], 'updatedAt');
  const ba = mergeRows([readLater], [unread], 'updatedAt');
  assert.equal(ab[0].read, 1, '较晚的已读状态应胜出');
  assert.equal(ba[0].read, 1, '反序合并也应得到同一结果（收敛，红点不再各亮各的）');
});

test('filterClearedRows：水位之前的历史行被过滤（隐私删除语义）', async () => {
  const { filterClearedRows, livenessTs } = await import('../src/sync-manifest.js');
  const rows = [
    { id: 'a', updatedAt: 100 },           // 水位前：应被滤掉
    { id: 'b', updatedAt: 500 },           // 水位后：保留
    { id: 'c', createdAt: 600 },           // 无 updatedAt，用 createdAt（水位后保留）
  ];
  const out = filterClearedRows(rows, 400);
  assert.deepEqual(out.map(r => r.id), ['b', 'c'], '水位 400 之前的历史行被过滤，之后保留');
  assert.equal(filterClearedRows(rows, 0).length, 3, '水位 0 = 未清空，原样返回');
  assert.equal(filterClearedRows(null, 400).length, 0, '空入站安全');
  assert.equal(livenessTs({ updatedAt: 100 }), 100);
});

// ---------- round17 R17-9：wordCards AI 扩展字段并集保护 ----------

test('R17-9 mergeCardPair：扩展字段并集保留，形状较简的设备不覆盖对端 AI 扩展字段', () => {
  // 本地：形状较简但 updatedAt 新（设备B 编辑过 word/note → 成为内容赢家）
  const local = { id: 'w1', word: 'abandon', meaning: '放弃', updatedAt: 2000 };
  // 远端：形状更全（AI 生成扩展字段），updatedAt 旧
  const incoming = {
    id: 'w1', word: 'abandon', meaning: '放弃；遗弃', updatedAt: 1000,
    defs: [{ meaning: 'v. 放弃；抛弃' }], synonyms: ['give up', 'forsake'],
    examples: [{ level: 'simple', sentence: 'Never abandon hope.' }], mnemonics: ['a-bandon = 一(ban)顿丢(don)'],
  };
  const merged = mergeCardPair(local, incoming, WORD_EXT_FIELDS);
  assert.equal(merged.meaning, '放弃', '用户可编辑内容按 updatedAt 赢家（本地新）');
  assert.deepEqual(merged.synonyms, ['give up', 'forsake'], '扩展字段并集保留（远端有值，不能被整行覆盖）');
  assert.ok(merged.defs && merged.examples && merged.mnemonics, 'defs/examples/mnemonics 保留');
  // 反向：incoming 更全且更新 → incoming 的扩展字段照样胜出
  const merged2 = mergeCardPair({ id: 'w1', word: 'abandon', updatedAt: 500 }, { ...incoming, updatedAt: 3000 });
  assert.deepEqual(merged2.synonyms, ['give up', 'forsake'], 'incoming 新时扩展字段随内容赢家');
});

test('round42 F3：mergeCardPair 保留本地独有（未登记 fieldTs 的扩展）字段，不被内容赢家整行覆盖', () => {
  // 本地卡有个未来扩展字段 extraLocal（不在 CARD_CONTENT_FIELDS、未 bump fieldTs、不在 CARD_SRS_FIELDS），
  // 对端同卡内容更新（成为内容赢家）但不含该字段——修复前会整行覆盖把 extraLocal 丢进对端。
  const local = { id: 'c1', front: 'Q', back: 'A', updatedAt: 1000, extraLocal: '本地独有值' };
  const incoming = { id: 'c1', front: 'Q+', back: 'A+', updatedAt: 2000 };
  const merged = mergeCardPair(local, incoming);
  assert.equal(merged.front, 'Q+', '内容按 updatedAt 赢家（对端新）');
  assert.equal(merged.extraLocal, '本地独有值', 'F3：本地独有字段在跨设备冲突合并中被保留（修复前会丢失）');

  // 本地为内容赢家时独有字段本就保留（不依赖兜底，回归确认）
  const local2 = { id: 'c1', front: 'Q+', back: 'A+', updatedAt: 2000, extraLocal: 'v2' };
  const incoming2 = { id: 'c1', front: 'Q', back: 'A', updatedAt: 1000 };
  assert.equal(mergeCardPair(local2, incoming2).extraLocal, 'v2', '本地为内容赢家时独有字段本就保留');

  // 对端独有字段（本地没有）随内容赢家进入，不被兜底误删
  const incoming3 = { id: 'c1', front: 'Q+', back: 'A+', updatedAt: 2000, extraRemote: '对端独有' };
  assert.equal(mergeCardPair({ id: 'c1', front: 'Q', back: 'A', updatedAt: 1000 }, incoming3).extraRemote, '对端独有', '对端独有字段随内容赢家进入');
});

// ---------- round30 P2-3：跨设备时钟偏移补偿 ----------

test('P2-3 shiftRowClock：把时间戳从对端时钟帧换算到本机帧（减 skew）', () => {
  const row = {
    id: 'x', updatedAt: 1100, reviewedAt: 1200, dueAt: 1300,
    fieldTs: { front: 1100, back: 1150, marked: 500 },
    word: '保持原值', t: 100, // t 为 userOps 活跃字段
  };
  const out = shiftRowClock(row, 200); // 对端快 200ms
  assert.equal(out.updatedAt, 900);
  assert.equal(out.reviewedAt, 1000);
  assert.equal(out.dueAt, 1100);
  assert.equal(out.t, -100, 't 字段同样换算（可为负，仅用于比较）');
  assert.deepEqual(out.fieldTs, { front: 900, back: 950, marked: 300 }, 'fieldTs 逐字段换算');
  assert.equal(out.word, '保持原值', '非时间字段不动');
  assert.equal(row.updatedAt, 1100, '不修改入参');
  assert.equal(shiftRowClock(row, 0), row, 'skew=0 零拷贝返回');
  assert.equal(shiftRowClock(row, NaN), row, '非法 skew 零拷贝返回');
});

test('P2-3 mergeRows：快时钟对端「物理更早」的编辑不再静默覆盖本机更晚编辑', () => {
  // 本机 local 编辑发生在本地 1000（updatedAt=1000）；对端墙钟快 200ms，
  // 其对端 900（物理上=本地 700）的编辑序列化 raw updatedAt=1100。
  // 不做补偿：1100 > 1000 → 对端旧编辑错误覆盖本机新编辑（P2-3 缺陷）。
  // 补偿：incoming 换算到本地帧 = 1100-200 = 900 < 1000 → 本机保留（正确）。
  const local = { id: 'x', updatedAt: 1000, text: '本机更晚的编辑' };
  const incoming = { id: 'x', updatedAt: 1100, text: '对端更早的编辑(快时钟)' };
  const bad = mergeRows([local], [incoming], 'updatedAt', {});
  assert.equal(bad[0].text, '对端更早的编辑(快时钟)', '无补偿时快时钟对端静默覆盖（缺陷复现）');
  const good = mergeRows([local], [incoming], 'updatedAt', { clockSkew: 200 });
  assert.equal(good[0].text, '本机更晚的编辑', '补偿后本机更晚编辑胜出');
  assert.equal(good[0].updatedAt, 1000, '本机行保留本机帧时间戳');
});

test('P2-3 mergeRows：补偿后 incoming 时间戳换算进本机帧存储', () => {
  // 全新行（本地无此 id）：入站行应换算为本机帧后落库，保证本机存储统一在本机帧
  const incoming = { id: 'x', updatedAt: 1100, title: '对端新行' };
  const out = mergeRows([], [incoming], 'updatedAt', { clockSkew: 200 });
  assert.equal(out[0].updatedAt, 900, '新行时间戳换算进本机帧');
  assert.equal(out[0].title, '对端新行');
  assert.equal(incoming.updatedAt, 1100, '不修改入参');
});

test('P2-3 mergeTombstones + applyTombstones：快时钟对端墓碑不误删本机更晚的编辑', () => {
  // 本机卡 updatedAt=1000（删除后仍被编辑过 → 应复活）。对端墙钟快 200ms，
  // 其墓碑 raw deletedAt=1100（物理上=本地 900）。无补偿：liveness 1000 <= 1100 → 误删；
  // 补偿：墓碑换算到本地帧 = 900 < 1000 → 卡复活，墓碑标 stale（正确）。
  const rows = [{ id: 'c1', updatedAt: 1000, front: 'Q', back: 'A' }];
  const tomb = { id: 'c1', kind: 'card', deletedAt: 1100 };
  const badTs = mergeTombstones([], [tomb], {});
  const bad = applyTombstones(rows, badTs, 'card');
  assert.equal(bad.rows.length, 0, '无补偿时快时钟墓碑误删本机更晚编辑的卡（缺陷复现）');
  const goodTs = mergeTombstones([], [tomb], { clockSkew: 200 });
  assert.equal(goodTs[0].deletedAt, 900, '墓碑 deletedAt 换算到本机帧');
  const good = applyTombstones(rows, goodTs, 'card');
  assert.equal(good.rows.length, 1, '补偿后本机卡复活');
  assert.equal(good.stale.length, 1, '墓碑判 stale 待清除');
});
