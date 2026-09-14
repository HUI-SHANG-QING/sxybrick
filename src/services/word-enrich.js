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

/**
 * 分片加载器映射。
 *
 * ⚠️ 这里**不能**用「typeof 检查 import.meta.glob 是否存在」的方式判定环境 ——
 * Vite 只把 `import.meta.glob(...)` 这个**调用**替换成对象字面量，**不替换 `typeof` 引用**，
 * 于是产物里该判定恒为 `undefined === 'function'` = false，整个加载器表被丢弃成 {}，
 * 浏览器端**任何单词都查不到**（表现为「该词暂无完整词条 / 该单词暂无释义」）。
 * 2026-09-14 实测：dist 里 52 个分片 chunk 都构建出来了，但映射表是空的。
 * 而 node --test 走 tests/_env.mjs 的 ingestShardPayload 注入，恰好绕开了这条路径 → 测试全绿却线上全崩。
 *
 * 正确做法：直接调用 import.meta.glob，用 try/catch 吃掉「Node 下不是函数」的 TypeError。
 * Vite（dev/build）替换成 { 路径: () => import(分片 chunk) }；Node 返回 {} 由外部注入分片。
 */
function loadShardLoaders() {
  try {
    return import.meta.glob('../data/word-enrich-shards/*.json');
  } catch {
    return {}; // Node（node --test / 脚本）：无 glob，分片由 ingestShardPayload 注入
  }
}
const shardLoaders = loadShardLoaders();

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
/** 词→分片精确映射（全量 4956 词，避免 from/to 范围重叠导致选错分片） */
const WORD_SHARD = mainBank?.wordShard && typeof mainBank.wordShard === 'object' ? mainBank.wordShard : {};
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

/** 词条所属分片号（优先用词→分片精确映射；未命中时回退 from/to 范围扫描） */
export function shardOf(word) {
  const k = normKey(word);
  if (WORD_SHARD[k]) return WORD_SHARD[k];
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
 * 用本地词库「回填」一张词卡缺失的字段（纯函数，不写库）。
 *
 * 背景：大纲词卡是「只有单词、没有释义」的裸卡（用户不需要额外生成，数据应由产品内置）。
 * 而背诵页/13 种模式**只读 card.meaning**，因此裸卡在背诵页一律显示「该单词暂无释义」、
 * 选项空白、判分缺答案。展示前必须用本地词库补齐，且**必须补 meaning**
 * （它是出题与判分的唯一字段，defs 只用于详情展示）。
 *
 * 语义（刻意保守，绝不臆造）：
 *   · 只填空字段，已有值一律保留（用户手改/导入的数据优先）；
 *   · 命中完整词条 → _localSource = 'full'；
 *   · 只命中内置种子释义（约 450 词）→ 'seed'；
 *   · 都没有 → 'none'，由 UI 明确提示「未收录」；
 *   · 分片尚未加载（reason='shard-not-loaded'）→ 'pending'，调用方 await ensureWord() 后重试。
 *
 * @param {object} card 词卡行（含 word 等字段）
 * @param {{ levels?: string[], seedMeaning?: (w:string)=>string }} [opts]
 *   seedMeaning 为种子释义注入点（默认用 word-syllabus 的 builtinMeaning，便于测试打桩）
 * @returns {object} 新对象（不修改入参）
 */
export function fillCardFromLocalBank(card, opts = {}) {
  const c = card || {};
  const word = String(c.word || '').trim();
  const out = { ...c };
  const blank = (k) => {
    const v = out[k];
    if (Array.isArray(v)) return v.length === 0;
    return !String(v ?? '').trim();
  };
  const take = (key, val) => {
    if (val == null) return;
    if (Array.isArray(val)) {
      if (blank(key) && val.length) out[key] = val;
    } else if (blank(key) && String(val).trim()) out[key] = val;
  };

  const seedOf = typeof opts.seedMeaning === 'function' ? opts.seedMeaning : null;
  const applySeed = () => {
    const m = seedOf ? seedOf(word) : '';
    if (m) {
      take('meaning', m);
      if (!(out.defs || []).length) out.defs = [{ pos: out.pos || '', meaning: m }];
      out._localSource = 'seed';
      return true;
    }
    out._localSource = 'none';
    return false;
  };

  if (!word) { out._localSource = 'none'; return out; }

  const r = enrichWordMaterials({ word, levels: opts.levels });
  if (r.ok && r.data) {
    const d = r.data;
    // meaning 优先取首个义项的中文（WordReview 等出题路径只认这个字段）
    const firstMeaning = Array.isArray(d.defs) && d.defs.length ? d.defs[0].meaning : '';
    take('meaning', firstMeaning);
    take('defs', d.defs); take('pos', d.pos); take('examples', d.examples);
    take('collocations', d.collocations); take('phrases', d.phrases);
    take('derived', d.derived); take('synonyms', d.synonyms);
    take('rootAffix', d.rootAffix); take('syllable', d.syllable);
    take('phonetic', d.phonetic);
    if (d.mnemonic) take('mnemonics', [d.mnemonic]);
    out._localSource = 'full';
    return out;
  }
  if (r.reason === 'shard-not-loaded') { out._localSource = 'pending'; return out; }
  applySeed();
  return out;
}

/**
 * 把一批词卡按本地词库回填（先即时用已加载分片填一遍，再按需加载分片后补全）。
 * 供背诵页/单词本共用：既保证首屏立刻有内容，又保证分片到位后数据完整。
 * @param {object[]} cards
 * @param {{ levels?: string[], seedMeaning?: Function, ensureFn?: (w:string)=>Promise<boolean>, onReady?: (filled:object[])=>void }} [opts]
 * @returns {Promise<object[]>} 回填后的卡数组（顺序不变）
 */
export async function fillCardsFromLocalBank(cards, opts = {}) {
  const list = Array.isArray(cards) ? cards : [];
  const first = list.map((c) => fillCardFromLocalBank(c, opts));
  const pending = [...new Set(first.filter((c) => c._localSource === 'pending').map((c) => String(c.word || '').trim()).filter(Boolean))];
  if (!pending.length) return first;

  const ensure = typeof opts.ensureFn === 'function' ? opts.ensureFn : ensureWord;
  await Promise.all(pending.map((w) => ensure(w).catch(() => false)));
  const filled = list.map((c) => fillCardFromLocalBank(c, opts));
  if (typeof opts.onReady === 'function') { try { opts.onReady(filled); } catch { /* 回调失败不影响返回 */ } }
  return filled;
}


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
