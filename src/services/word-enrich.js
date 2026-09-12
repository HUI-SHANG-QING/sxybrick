// src/services/word-enrich.js
// 英语单词「本地补全」引擎：查内置词库 src/data/word-enrich.json，
// 零依赖、零网络、零 AI 调用 —— 补全不再经过任何付费接口。
//
// 设计要点：
//  1. 输出契约与 services/word-llm.js 的 normalize() 完全一致
//     （syllable/defs/synonyms/collocations/phrases/derived/rootAffix/examples/pos/mnemonic），
//     上层（WordBook 自动补全 / OCR 建卡 / 释义补齐）可无感替换 AI 结果。
//     额外保留 examples[].analysis（长难句解析）——AI 路径没有该字段，本地词库独有。
//  2. 未收录 → 明确返回 { ok:false, reason:'not-in-local-wordbank' }，
//     由调用方提示「暂未收录」并跳过，**绝不臆造**内容（与 normalize() 的占位模板不同）。
//  3. JSON 导入必须带 `with { type: 'json' }`：Node ESM 缺属性会抛
//     ERR_IMPORT_ATTRIBUTE_MISSING，加上后本模块才能被 node --test 直接覆盖。
import enrichData from '../data/word-enrich.json' with { type: 'json' };

const RAW = (enrichData && enrichData.entries) || {};
/** 小写索引：查找大小写不敏感、首尾空白容错（与 word-syllabus.js 同口径） */
const INDEX = new Map();
for (const [k, v] of Object.entries(RAW)) {
  if (v && typeof v === 'object') INDEX.set(String(k).trim().toLowerCase(), v);
}

const DEFAULT_LEVELS = ['simple', 'long'];

export function localWordKey(word) {
  return String(word || '').trim().toLowerCase();
}

export function hasLocalEntry(word) {
  return INDEX.has(localWordKey(word));
}

export function localEntry(word) {
  return INDEX.get(localWordKey(word)) || null;
}

/** 词库已收录词条数（供 UI 展示「本地词库已收录 N 词」） */
export function localEntryCount() {
  return INDEX.size;
}

export function localWords() {
  return [...INDEX.keys()];
}

/** 主释义（首义项）；未收录返回空串 */
export function localMeaning(word) {
  const e = localEntry(word);
  if (!e) return '';
  if (Array.isArray(e.defs) && e.defs.length) return String(e.defs[0].meaning || '').trim();
  return String(e.meaning || '').trim();
}

/**
 * 生成与 normalize() 同构的完整素材（含长难句解析）。
 * @param {{word:string, levels?:string[]}} req
 * @returns {{ok:boolean, data?:object, via?:string, reason?:string, skipped?:string}}
 */
export function enrichWordMaterials(req = {}) {
  const raw = String(req.word || '').trim();
  const entry = INDEX.get(localWordKey(raw));
  if (!entry) {
    return { ok: false, reason: 'not-in-local-wordbank', skipped: raw };
  }
  const want = Array.isArray(req.levels) && req.levels.length
    ? req.levels.map((l) => String(l).toLowerCase())
    : DEFAULT_LEVELS;

  const defs = (Array.isArray(entry.defs) ? entry.defs : [])
    .filter((d) => d && (d.pos || d.meaning))
    .slice(0, 6)
    .map((d) => ({ pos: String(d.pos || '').trim(), meaning: String(d.meaning || '').trim() }));

  // 只取真实例句：缺档不补占位模板（不臆造），由 UI 自然留空
  const examples = [];
  for (const ex of Array.isArray(entry.examples) ? entry.examples : []) {
    if (!ex) continue;
    const lv = String(ex.level || '').toLowerCase();
    if (!want.includes(lv)) continue;
    if (typeof ex.sentence !== 'string' || typeof ex.translation !== 'string') continue;
    const item = { level: lv, sentence: ex.sentence, translation: ex.translation };
    if (typeof ex.analysis === 'string' && ex.analysis.trim()) item.analysis = ex.analysis.trim();
    examples.push(item);
  }

  return {
    ok: true,
    via: 'local-wordbank',
    data: {
      syllable: String(entry.syllable || '').trim(),
      defs,
      synonyms: (Array.isArray(entry.synonyms) ? entry.synonyms : []).slice(0, 6).map(String),
      collocations: (Array.isArray(entry.collocations) ? entry.collocations : []).slice(0, 6).map(String),
      phrases: (Array.isArray(entry.phrases) ? entry.phrases : []).slice(0, 4).map(String),
      derived: (Array.isArray(entry.derived) ? entry.derived : [])
        .filter((d) => d && d.word)
        .slice(0, 5)
        .map((d) => ({ word: String(d.word).trim(), meaning: String(d.meaning || '').trim() })),
      rootAffix: String(entry.rootAffix || '').trim(),
      examples,
      pos: String(entry.pos || '').trim(),
      mnemonic: String(entry.mnemonic || '').trim(),
    },
  };
}
