// src/services/word-enrich.js
// 英语单词「本地补全」引擎：查内置词库 src/data/word-enrich.json（主文件为 meta + 分片索引），
// 词条按字母序存放在 src/data/word-enrich-shards/NN.json，**运行时按需加载**。
// 零依赖、零网络、零 AI 调用 —— 补全不再经过任何付费接口。
//
// 为什么分片：全量 4956 个大纲词约 11MB，单文件既进不了 PWA 预缓存（上限 600KB/文件），
// 也会拖垮首屏。分片后每片 ≈ 300~460KB：首屏不加载词库，查词时只加载目标词所在的那一片。
//
// 加载策略：
//   · 浏览器（Vite）：import.meta.glob 生成惰性 chunk 加载器，按需 import 对应分片；
//   · Node（node --test / 脚本）：顶层 await 全量预载，保持查询的**同步**语义不变。
//
// 输出契约与 services/word-llm.js 的 normalize() 一致
// （syllable/defs/synonyms/collocations/phrases/derived/rootAffix/examples/pos/mnemonic），
// 额外保留 examples[].analysis（长难句解析）——AI 路径没有该字段，本地词库独有。
//
// 未命中分两种，调用方据此决定是否先加载分片再重试：
//   { ok:false, reason:'shard-not-loaded', shard }  → 该词所在分片尚未加载，可 await ensureWord() 后重试
//   { ok:false, reason:'not-in-local-wordbank' }    → 分片已加载但确无此词，明确跳过、绝不臆造
import mainBank from '../data/word-enrich.json' with { type: 'json' };

const IS_VITE = typeof import.meta.glob === 'function';
/** Vite 编译期生成的「分片路径 → 惰性加载函数」映射 */
const shardLoaders = IS_VITE ? import.meta.glob('../data/word-enrich-shards/*.json') : {};

/** word(小写) → 词条，仅含**已加载**分片中的条目 */
const INDEX = new Map();
/** 已加载的分片号 */
const loadedShards = new Set();

const normKey = (w) => String(w || '').trim().toLowerCase();

/** 主文件仍内嵌 entries 时（尚未拆分）直接当作已加载数据使用 */
if (mainBank && mainBank.entries && typeof mainBank.entries === 'object') {
  for (const [k, v] of Object.entries(mainBank.entries)) INDEX.set(normKey(k), v);
  loadedShards.add('legacy');
}

/** 分片索引（来自主文件，很小）：[{ shard, from, to, count }] */
const SHARDS = Array.isArray(mainBank?.shards) ? mainBank.shards : [];
export const SHARD_COUNT = SHARDS.length;

/**
 * 注入一个分片的条目（同步）。供 **Node 侧**（测试环境 tests/_env.mjs、脚本）预载使用：
 * 前端不含任何 node: 依赖（Rollup 无法打包 node: 内置模块），因此 Node 侧的全量预载
 * 由外部读取分片文件后注入，从而保持查询的同步语义。
 * @param {{shard?:string, entries?:object}} payload
 */
export function ingestShardPayload(payload) {
  const shard = String(payload?.shard || '');
  for (const [k, v] of Object.entries(payload?.entries || {})) INDEX.set(normKey(k), v);
  if (shard) loadedShards.add(shard);
  return INDEX.size;
}

export function localWordKey(word) {
  return normKey(word);
}

/** 词条所属分片号（依据主文件索引，同步返回，无需加载分片） */
export function shardOf(word) {
  const k = normKey(word);
  for (const s of SHARDS) if (k >= s.from && k <= s.to) return s.shard;
  return null;
}

export function isShardLoaded(shard) {
  return loadedShards.has(String(shard));
}

/** 确保某分片已加载（幂等）。返回是否可用。 */
export async function ensureShard(shard) {
  const id = String(shard || '');
  if (!id) return false;
  if (loadedShards.has(id)) return true;
  const load = shardLoaders[`../data/word-enrich-shards/${id}.json`];
  if (!load) return false;
  const mod = await load();
  const payload = mod?.default || mod || {};
  for (const [k, v] of Object.entries(payload.entries || {})) INDEX.set(normKey(k), v);
  loadedShards.add(id);
  return true;
}

/** 确保某词所在分片已加载。返回该词现在是否可查。 */
export async function ensureWord(word) {
  if (INDEX.has(normKey(word))) return true;
  const s = shardOf(word);
  if (!s) return false;
  await ensureShard(s);
  return INDEX.has(normKey(word));
}

/** 强制加载全部分片（离线批量场景 / 测试用） */
export async function loadAllShards() {
  for (const s of SHARDS) await ensureShard(s.shard);
  return INDEX.size;
}

/** 已加载的词条数（供 UI 展示「本地词库已加载 N 词」） */
export function localEntryCount() {
  return INDEX.size;
}

export function hasLocalEntry(word) {
  return INDEX.has(normKey(word));
}

export function localEntry(word) {
  return INDEX.get(normKey(word)) || null;
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

const DEFAULT_LEVELS = ['simple', 'long'];

/**
 * 生成与 normalize() 同构的完整素材（含长难句解析）。
 * @param {{word:string, levels?:string[]}} req
 * @returns {{ok:boolean, data?:object, via?:string, reason?:string, skipped?:string, shard?:string}}
 */
export function enrichWordMaterials(req = {}) {
  const raw = String(req.word || '').trim();
  const entry = INDEX.get(normKey(raw));
  if (!entry) {
    // 分片未加载 → 告知调用方，可 await ensureWord() 后重试；否则确为未收录
    const s = shardOf(raw);
    if (s && !loadedShards.has(s)) return { ok: false, reason: 'shard-not-loaded', shard: s, skipped: raw };
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
