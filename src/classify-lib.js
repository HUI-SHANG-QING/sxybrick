/**
 * 自动分类服务层（D4.2）
 *
 * 基于 classifier.js 纯函数，跨「卡片 / 资料 / 笔记」三类实体：
 *   1) 读已有 subject/category 作为 seed（训练样本）
 *   2) 对「未分类」的实体做预测
 *   3) 写回 subject（卡片/资料）或 category（笔记）
 *
 * 策略：
 *   - 训练样本 >= 1 个类别才建模型（否则无可分类依据）
 *   - 只自动写「未分类」的实体，绝不覆盖用户手动设的 subject/category
 *   - 幂等：重复调用不会重复写（预测结果相同）
 *   - 可 dry-run（只预览不写库）
 *   - 全程返回可诊断统计（seedCount / lowConfidence / emptyText），
 *     避免 UI 只显示「可自动分类 0 条」却说不清为什么
 *
 * 「未分类」哨兵值：
 *   空字符串、空白、以及字面量 '未分类' 都视为「尚未分类」，
 *   既不会被当成训练样本（否则会把这个伪类目教给模型），也允许被重新归类。
 */

import { db } from './db.js';
import { trainClassifier, classify, toTrainSample } from './utils/classifier.js';

/** 视为「尚未分类」的值 */
const UNCLASSIFIED_VALUES = new Set(['', '未分类', 'uncategorized', 'none', 'null']);
export function isUnclassified(v) {
  return UNCLASSIFIED_VALUES.has(String(v ?? '').trim().toLowerCase());
}

// ──────────────── 工具：从 db 读训练样本 ────────────────

/** 从 cards 表读「已有 subject」的卡片作为训练样本 */
async function cardSeeds() {
  const cards = await db.cards.toArray();
  const seeds = [];
  for (const c of cards) {
    if (!c?.subject || isUnclassified(c.subject)) continue;
    seeds.push(toTrainSample({ front: c.front, back: c.back, subject: c.subject }, { labelField: 'subject' }));
  }
  return seeds;
}

/** 从 docFiles 表读「已有 subject」的资料作为训练样本 */
async function docSeeds() {
  const files = await db.docFiles.toArray();
  const seeds = [];
  for (const f of files) {
    if (!f?.subject || isUnclassified(f.subject)) continue;
    seeds.push(toTrainSample({ text: f.name || '', subject: f.subject }, { labelField: 'subject', textField: 'text' }));
  }
  return seeds;
}

/** 从 notes 表读「已有 category」的笔记作为训练样本 */
async function noteSeeds() {
  const notes = await db.notes.toArray();
  const seeds = [];
  for (const n of notes) {
    if (!n?.category || isUnclassified(n.category)) continue;
    seeds.push(toTrainSample({ content: n.content || '', title: n.title || '', category: n.category }, { labelField: 'category', textField: 'content' }));
  }
  return seeds;
}

/**
 * 统一的分类主流程（三类实体共用，避免三份逻辑各自漂移）。
 * @param {object} cfg
 *   seeds()   读训练样本
 *   rows()    读待分类全量
 *   textOf(row)  取待预测文本
 *   hasLabel(row) 是否已有分类（已有则跳过）
 *   write(row,label) 写回
 *   nothingReason 无训练样本时的原因文案
 */
async function runClassify(cfg, { dryRun = false, threshold = 0.12 } = {}) {
  const seeds = await cfg.seeds();
  const model = trainClassifier(seeds);
  const labels = model.labels.length;
  const empty = { trained: false, total: 0, classified: 0, skipped: 0, results: [],
    seedCount: 0, labelCount: 0, lowConfidence: 0, emptyText: 0, already: 0,
    reason: cfg.nothingReason };
  if (!labels) return empty;

  const rows = await cfg.rows();
  const results = [];
  let classified = 0, skipped = 0, lowConfidence = 0, emptyText = 0, already = 0;
  for (const row of rows) {
    if (cfg.hasLabel(row)) { skipped++; already++; continue; }
    const text = cfg.textOf(row) || '';
    if (!text.trim()) { skipped++; emptyText++; continue; }
    const pred = classify(text, model, { threshold });
    // 以 ok 判定，不能用 label === '未分类'（真实科目可能就叫「未分类」）
    if (!pred.ok) { skipped++; lowConfidence++; continue; }
    results.push({ id: row.id, ...cfg.preview(row), label: pred.label, confidence: pred.confidence });
    if (!dryRun) await cfg.write(row, pred.label);
    classified++;
  }
  return {
    trained: true,
    total: rows.length,
    classified,
    skipped,
    results,
    labelCount: labels,
    seedCount: seeds.length,
    lowConfidence,
    emptyText,
    already,
  };
}

// ──────────────── 分类执行 ────────────────

/**
 * 对「未分类」的卡片自动归类。
 * @param {object} opts { dryRun=false, threshold=0.12 }
 */
export async function classifyAllCards({ dryRun = false, threshold = 0.12 } = {}) {
  return runClassify({
    seeds: cardSeeds,
    rows: () => db.cards.toArray(),
    textOf: c => `${c.front || ''} ${c.back || ''}`,
    hasLabel: c => !!c.subject && !isUnclassified(c.subject),
    preview: c => ({ front: String(c.front || '').slice(0, 30) }),
    write: (c, label) => db.cards.update(c.id, { subject: label }),
    nothingReason: '没有带科目的卡片可作训练样本——先手动给几张卡设定科目，模型才有依据',
  }, { dryRun, threshold });
}

/**
 * 对「未分类」的资料自动归类（写 subject）。
 */
export async function classifyAllDocs({ dryRun = false, threshold = 0.12 } = {}) {
  return runClassify({
    seeds: docSeeds,
    rows: () => db.docFiles.toArray(),
    textOf: f => f.name || '',
    hasLabel: f => !!f.subject && !isUnclassified(f.subject),
    preview: f => ({ name: String(f.name || '').slice(0, 40) }),
    write: (f, label) => db.docFiles.update(f.id, { subject: label }),
    nothingReason: '没有带科目的资料可作训练样本',
  }, { dryRun, threshold });
}

/**
 * 对「未分类」的笔记自动归类（写 category）。
 */
export async function classifyAllNotes({ dryRun = false, threshold = 0.12 } = {}) {
  return runClassify({
    seeds: noteSeeds,
    rows: () => db.notes.toArray(),
    textOf: n => `${n.title || ''} ${n.content || ''}`,
    hasLabel: n => !!n.category && !isUnclassified(n.category),
    preview: n => ({ title: String(n.title || '').slice(0, 30) }),
    write: (n, label) => db.notes.update(n.id, { category: label }),
    nothingReason: '没有带分类的笔记可作训练样本',
  }, { dryRun, threshold });
}

/**
 * 一键分类全部三类实体（dry-run 预览或真正写回）。
 */
export async function classifyEverything({ dryRun = false, threshold = 0.12 } = {}) {
  const [cards, docs, notes] = await Promise.all([
    classifyAllCards({ dryRun, threshold }),
    classifyAllDocs({ dryRun, threshold }),
    classifyAllNotes({ dryRun, threshold }),
  ]);
  return { cards, docs, notes };
}

// ──────────────── 统计 / 训练样本数 ────────────────

/**
 * 分类总览统计：三类实体各自「已分类 / 未分类」数量 + 训练样本数。
 * 注：「未分类」包含空值与字面量 '未分类'（后者是历史导入留下的伪类目，同样需要归类）。
 */
export async function getClassifyStats() {
  const [cards, files, notes] = await Promise.all([
    db.cards.toArray(),
    db.docFiles.toArray(),
    db.notes.toArray(),
  ]);
  const count = (arr, key) => arr.filter(x => x?.[key] && !isUnclassified(x[key])).length;
  return {
    cards: { total: cards.length, classified: count(cards, 'subject') },
    docs: { total: files.length, classified: count(files, 'subject') },
    notes: { total: notes.length, classified: count(notes, 'category') },
  };
}

/**
 * 模型体检：训练样本数、类别数、留一法准确率。
 * 供 UI 解释「为什么可自动分类 0 条」。
 */
export async function evaluateClassification() {
  const seeds = await cardSeeds();
  if (!seeds.length) return { available: false, accuracy: 0, seedCount: 0, labelCount: 0 };
  const { evaluateClassifier } = await import('./utils/classifier.js');
  const r = evaluateClassifier(seeds);
  const labelCount = new Set(seeds.map(s => s.label)).size;
  return { available: true, seedCount: seeds.length, labelCount, ...r };
}
