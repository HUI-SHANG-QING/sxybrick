// src/services/word-meaning.js
// 考研大纲词的中文释义：存储层（db 优先）→ 内置种子（离线兜底）。
//
// 为什么单独建表而不改词表 JSON：
//   词表（src/data/kaoyan-vocab-2027.json）是**只读静态资产**，isInSyllabus/filterBySyllabus
//   依赖「字符串数组」语义，改成对象数组会牵动现有测试与 AI 过滤链路。
//   释义是**可增长产出**（AI 批量生成 / 用户手工编辑），因此落在 db.syllabusMeanings（v30）。
//
// 优先级：db（AI/用户产出） > 内置种子（离线兜底）。
// 同步语义（用户要求「两者同步更新」）：
//   · 词表新增词 → 释义表无对应行 → 计入 missing，由 AI 补齐通道批量生成；
//   · 词表删词   → 释义表对应行成孤儿 → syncWithSyllabus() 清理（避免统计分母与 UI 漂移）；
//   · 词表升级（meta.version 变化）→ 旧释义标 stale（syllabusVersion 不匹配），可复核。
import { db } from '../db.js';
import { listSyllabus, builtinMeaning, normalizeWordKey, getSyllabusMeta } from './word-syllabus.js';

/** 词表版本（释义与之绑定，用于升级后标记待复核） */
function syllabusVersion() {
  return String(getSyllabusMeta()?.version || 'v1.0');
}

/**
 * 取单个词的中文释义
 * @param {string} word
 * @returns {Promise<{word:string, meaning:string, source:'ai'|'manual'|'seed'|''}>}
 */
export async function getMeaning(word) {
  const key = normalizeWordKey(word);
  if (!key) return { word: '', meaning: '', source: '' };
  try {
    const row = await db.syllabusMeanings.get(key);
    if (row && String(row.meaning || '').trim()) {
      return { word: key, meaning: String(row.meaning).trim(), source: row.source || 'ai' };
    }
  } catch (e) {
    console.warn('[word-meaning] read failed:', e?.message || e);
  }
  const seed = builtinMeaning(key);
  return seed ? { word: key, meaning: seed, source: 'seed' } : { word: key, meaning: '', source: '' };
}

/**
 * 批量取释义（一次 bulkGet，避免 N 次往返）
 * @param {string[]} words
 * @returns {Promise<Map<string, {meaning:string, source:string}>>}
 */
export async function getMeanings(words) {
  const out = new Map();
  const list = (words || []).map(normalizeWordKey).filter(Boolean);
  if (!list.length) return out;
  try {
    const rows = await db.syllabusMeanings.bulkGet([...new Set(list)]);
    list.forEach((w, i) => {
      const r = rows[i];
      if (r && String(r.meaning || '').trim()) {
        out.set(w, { meaning: String(r.meaning).trim(), source: r.source || 'ai' });
        return;
      }
      const seed = builtinMeaning(w);
      if (seed) out.set(w, { meaning: seed, source: 'seed' });
    });
  } catch (e) {
    console.warn('[word-meaning] bulk read failed:', e?.message || e);
    for (const w of list) {
      const seed = builtinMeaning(w);
      if (seed) out.set(w, { meaning: seed, source: 'seed' });
    }
  }
  return out;
}

/**
 * 写入一条释义（幂等：主键 = 归一化词）
 * @param {string} word
 * @param {string} meaning
 * @param {{source?:'ai'|'manual'|'seed'}} [opts]
 */
export async function setMeaning(word, meaning, opts = {}) {
  const key = normalizeWordKey(word);
  const val = String(meaning || '').trim();
  if (!key || !val) return null;
  const now = Date.now();
  const row = {
    id: key, word: key, meaning: val,
    source: opts.source || 'ai',
    updatedAt: now,
    syllabusVersion: syllabusVersion(),
  };
  try {
    const old = await db.syllabusMeanings.get(key);
    if (old && String(old.meaning) === val) return old; // 同值不写，避免无谓 bump 同步水位
    await db.syllabusMeanings.put({ ...row, createdAt: old?.createdAt || now });
  } catch (e) {
    console.warn('[word-meaning] write failed:', e?.message || e);
    return null;
  }
  return row;
}

/** 批量写入（AI 生成批次落库；单批事务，失败不影响已写批次以外的流程） */
export async function setMeanings(entries, opts = {}) {
  const rows = [];
  const now = Date.now();
  for (const e of entries || []) {
    const key = normalizeWordKey(e?.word);
    const val = String(e?.meaning || '').trim();
    if (!key || !val) continue;
    rows.push({
      id: key, word: key, meaning: val,
      source: e.source || opts.source || 'ai',
      updatedAt: now, createdAt: now,
      syllabusVersion: syllabusVersion(),
    });
  }
  if (!rows.length) return 0;
  try {
    await db.syllabusMeanings.bulkPut(rows);
    return rows.length;
  } catch (e) {
    console.warn('[word-meaning] bulk write failed:', e?.message || e);
    return 0;
  }
}

/**
 * 与大纲词表双向同步：清理孤儿释义 + 回报待补清单
 * @param {{prune?:boolean}} [opts] prune=true 时物理删除孤儿（默认只报告不删）
 */
export async function syncWithSyllabus(opts = {}) {
  const words = listSyllabus().map(normalizeWordKey).filter(Boolean);
  const set = new Set(words);
  let rows = [];
  try {
    rows = await db.syllabusMeanings.toArray();
  } catch (e) {
    console.warn('[word-meaning] scan failed:', e?.message || e);
  }
  const version = syllabusVersion();
  const orphans = [];
  const stale = [];
  for (const r of rows) {
    const k = normalizeWordKey(r?.word || r?.id);
    if (!set.has(k)) { orphans.push(k); continue; }
    if (r.syllabusVersion && r.syllabusVersion !== version) stale.push(k);
  }
  let pruned = 0;
  if (opts.prune && orphans.length) {
    try {
      await db.syllabusMeanings.bulkDelete(orphans);
      pruned = orphans.length;
    } catch (e) {
      console.warn('[word-meaning] prune failed:', e?.message || e);
    }
  }
  // 待补：词表里有、但 db 与种子都没有释义的词
  const covered = new Map(await getMeanings(words));
  const missing = words.filter((w) => !covered.has(w));
  return {
    total: words.length,
    covered: words.length - missing.length,
    coverage: words.length ? +(((words.length - missing.length) / words.length) * 100).toFixed(2) : 0,
    missing,
    orphans,
    pruned,
    stale,
    syllabusVersion: version,
  };
}

/** 覆盖率概览（供 UI/统计展示） */
export async function meaningCoverage() {
  const s = await syncWithSyllabus();
  return { total: s.total, covered: s.covered, coverage: s.coverage, missingCount: s.missing.length };
}
