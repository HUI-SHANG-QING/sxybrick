/**
 * 自动分类服务层（D4.2）
 *
 * 基于 classifier.js 纯函数，跨「卡片 / 资料 / 笔记」三类实体：
 *   1) 读已有 subject/category 作为 seed（训练样本）
 *   2) 对「未分类」的实体做预测
 *   3) 写回 subject（卡片/资料）或 category（笔记）
 *
 * 策略：
 *   - 训练样本 >= 2 个类别 且 每类 >= 1 样本才建模型（否则无可分类依据）
 *   - 只自动写「未分类」的实体，绝不覆盖用户手动设的 subject/category
 *   - 幂等：重复调用不会重复写（预测结果相同）
 *   - 可 dry-run（只预览不写库）
 */

import { db } from './db.js';
import { trainClassifier, classify, toTrainSample } from './utils/classifier.js';

// ──────────────── 工具：从 db 读训练样本 ────────────────

/** 从 cards 表读「已有 subject」的卡片作为训练样本 */
async function cardSeeds() {
  const cards = await db.cards.toArray();
  const seeds = [];
  for (const c of cards) {
    if (!c?.subject) continue;
    seeds.push(toTrainSample({ front: c.front, back: c.back, subject: c.subject }, { labelField: 'subject' }));
  }
  return seeds;
}

/** 从 docFiles 表读「已有 subject」的资料作为训练样本 */
async function docSeeds() {
  const files = await db.docFiles.toArray();
  const seeds = [];
  for (const f of files) {
    if (!f?.subject) continue;
    seeds.push(toTrainSample({ text: f.name || '', subject: f.subject }, { labelField: 'subject', textField: 'text' }));
  }
  return seeds;
}

/** 从 notes 表读「已有 category」的笔记作为训练样本 */
async function noteSeeds() {
  const notes = await db.notes.toArray();
  const seeds = [];
  for (const n of notes) {
    if (!n?.category) continue;
    seeds.push(toTrainSample({ content: n.content || '', title: n.title || '', category: n.category }, { labelField: 'category', textField: 'content' }));
  }
  return seeds;
}

// ──────────────── 分类执行 ────────────────

/**
 * 对「未分类」的卡片自动归类。
 * @param {object} opts { dryRun=false, threshold=0.12 }
 * @returns {{ trained:boolean, total:number, classified:number, skipped:number, results:Array }}
 */
export async function classifyAllCards({ dryRun = false, threshold = 0.12 } = {}) {
  const seeds = await cardSeeds();
  const model = trainClassifier(seeds);
  const labels = model.labels.length;
  if (!labels) return { trained: false, total: 0, classified: 0, skipped: 0, results: [], reason: '无带 subject 的卡片可作训练样本' };

  const cards = await db.cards.toArray();
  const results = [];
  let classified = 0, skipped = 0;
  for (const c of cards) {
    if (c?.subject) { skipped++; continue; } // 已有分类的不动
    const pred = classify((c.front || '') + ' ' + (c.back || ''), model, { threshold });
    if (pred.label === '未分类') { skipped++; continue; }
    results.push({ id: c.id, front: (c.front || '').slice(0, 30), label: pred.label, confidence: pred.confidence });
    if (!dryRun) await db.cards.update(c.id, { subject: pred.label });
    classified++;
  }
  return { trained: true, total: cards.length, classified, skipped, results, labelCount: labels };
}

/**
 * 对「未分类」的资料自动归类（写 subject）。
 */
export async function classifyAllDocs({ dryRun = false, threshold = 0.12 } = {}) {
  const seeds = await docSeeds();
  const model = trainClassifier(seeds);
  if (!model.labels.length) return { trained: false, total: 0, classified: 0, skipped: 0, results: [], reason: '无带 subject 的资料可作训练样本' };

  const files = await db.docFiles.toArray();
  const results = [];
  let classified = 0, skipped = 0;
  for (const f of files) {
    if (f?.subject) { skipped++; continue; }
    const pred = classify(f.name || '', model, { threshold });
    if (pred.label === '未分类') { skipped++; continue; }
    results.push({ id: f.id, name: (f.name || '').slice(0, 40), label: pred.label, confidence: pred.confidence });
    if (!dryRun) await db.docFiles.update(f.id, { subject: pred.label });
    classified++;
  }
  return { trained: true, total: files.length, classified, skipped, results, labelCount: model.labels.length };
}

/**
 * 对「未分类」的笔记自动归类（写 category）。
 */
export async function classifyAllNotes({ dryRun = false, threshold = 0.12 } = {}) {
  const seeds = await noteSeeds();
  const model = trainClassifier(seeds);
  if (!model.labels.length) return { trained: false, total: 0, classified: 0, skipped: 0, results: [], reason: '无带 category 的笔记可作训练样本' };

  const notes = await db.notes.toArray();
  const results = [];
  let classified = 0, skipped = 0;
  for (const n of notes) {
    if (n?.category) { skipped++; continue; }
    const pred = classify((n.title || '') + ' ' + (n.content || ''), model, { threshold });
    if (pred.label === '未分类') { skipped++; continue; }
    results.push({ id: n.id, title: (n.title || '').slice(0, 30), label: pred.label, confidence: pred.confidence });
    if (!dryRun) await db.notes.update(n.id, { category: pred.label });
    classified++;
  }
  return { trained: true, total: notes.length, classified, skipped, results, labelCount: model.labels.length };
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
 */
export async function getClassifyStats() {
  const [cards, files, notes] = await Promise.all([
    db.cards.toArray(),
    db.docFiles.toArray(),
    db.notes.toArray(),
  ]);
  const count = (arr, key) => arr.filter(x => x?.[key]).length;
  return {
    cards: { total: cards.length, classified: count(cards, 'subject'), unclassified: cards.length - count(cards, 'subject') },
    docs: { total: files.length, classified: count(files, 'subject'), unclassified: files.length - count(files, 'subject') },
    notes: { total: notes.length, classified: count(notes, 'category'), unclassified: notes.length - count(notes, 'category') },
  };
}

/**
 * 评估当前模型质量：返回留一法准确率（供 UI 展示「可信度」）。
 */
export async function evaluateClassification() {
  const seeds = await cardSeeds();
  if (!seeds.length) return { available: false, accuracy: 0 };
  // 简单评估：用 cards 的 seeds 做留一法（跨实体同样适用）
  const { evaluateClassifier } = await import('./utils/classifier.js');
  const r = evaluateClassifier(seeds);
  return { available: true, ...r };
}
