// src/services/word-ai-modes.js
// 英语「AI 智能模块」：复用 AI 助手通道，为 13 种背诵模式逐题生成【问题/答案】。
//
// 设计约束（用户要求）：
//   1. 复用现有 AI 助手 API —— 一律走 services/word-llm.js 的 callLlmJson（agent 优先 →
//      用户 Key 兜底 → 用量记账），本模块不自己拼 provider/key/base/HTTP。
//   2. 生成结果结构必须与现有背诵模块一致 —— 字段名/语义严格对齐 WordReview.vue 的渲染口径：
//        · 题干取 card.word / card.meaning / card.defs / card.examples / card.collocations；
//        · 判断题面/答案方向时与 WordReview 的 pickMeaning 判定同侧（见 ANSWER_SIDE）。
//      生成物落在 wordCards.modeQuestions = { [modeId]: { q, a, options?, tip? } }，
//      与 EXT_FIELDS 一起受 WORD_EXT_FIELDS 并集保护，跨设备同步不丢。
//   3. 不信任 LLM —— 全部结果过 validateModeQuestion，不合规直接丢弃该模式（绝不写脏数据）。
import { callLlmJson, hasLlmChannel } from './word-llm.js';
import { normalizeWordKey } from './word-syllabus.js';

/**
 * 13 种复习模式契约表
 * answerSide: 'zh' → 答案应为中文释义；'en' → 答案应为英文词本身
 * 与 WordReview.vue 的 pickMeaning 语义一一对应（choice/listenChoice=zh，其余选项模式=en）。
 */
export const REVIEW_MODES = [
  { id: 'adaptive',       answerSide: 'zh', desc: '不背式：先看词自评，忘记则切选择题强化' },
  { id: 'choice',         answerSide: 'zh', desc: '看词选义：题干英文词，选项中文释义' },
  { id: 'listenChoice',   answerSide: 'zh', desc: '听音选义：只放发音，选项中文释义' },
  { id: 'spell',          answerSide: 'zh', desc: '看词写义：题干英文词，作答中文释义' },
  { id: 'listenSpell',    answerSide: 'en', desc: '听音写词：只放发音，作答英文词' },
  { id: 'reverseChoice',  answerSide: 'en', desc: '中文选词：题干中文释义，选项英文词' },
  { id: 'cloze',          answerSide: 'en', desc: '填空拼写：题干为挖空词形，作答完整英文词' },
  { id: 'sentenceCloze',  answerSide: 'en', desc: '例句挖空：题干为挖空例句，作答英文词' },
  { id: 'flashcard',      answerSide: 'zh', desc: '闪卡翻面：正面英文词，翻面中文释义' },
  { id: 'englishEnglish', answerSide: 'en', desc: '英英释义：题干英文释义/同义语境，选英文词' },
  { id: 'collocations',   answerSide: 'en', desc: '词组搭配：题干中文释义+搭配提示，选英文词' },
  { id: 'readAloud',      answerSide: 'zh', desc: '跟读朗读：听发音跟读后自评，答案为中文释义' },
  { id: 'quiz',           answerSide: 'mix', desc: '综合选择题：题干类型不限，含 4 个选项' },
];
export const MODE_IDS = REVIEW_MODES.map((m) => m.id);
const MODE_MAP = new Map(REVIEW_MODES.map((m) => [m.id, m]));

/** 选择题类模式（生成时应附带 3 个干扰项） */
const CHOICE_MODES = new Set(['choice', 'listenChoice', 'reverseChoice', 'englishEnglish', 'collocations', 'quiz']);

export function modeContract(id) { return MODE_MAP.get(id) || null; }
export function isChoiceMode(id) { return CHOICE_MODES.has(id); }

// v40：按词条 kind 分轨出题。
//   word / phrase：13 模式全开——短语与单词同构（题干/答案方向一致），
//     差异只在校验层（短语答案 = 整个短语，不允许单复数变形，见 validateModeQuestion）。
//   sentence：卡片的 word 字段是整句、meaning 是句译——「答案=英文本身」类模式
//     （listenSpell/reverseChoice/cloze/sentenceCloze/englishEnglish/collocations）
//     会让整句充当答案（超 MAX_A 且方向不合理），故只保留 6 种中文答案模式。
//   template：范文模板不参与 SRS 复习，无出题语义，显式拒绝。
export const MODES_BY_KIND = {
  word: MODE_IDS,
  phrase: MODE_IDS,
  sentence: ['adaptive', 'choice', 'spell', 'flashcard', 'readAloud', 'quiz'],
  template: [],
};
export const KIND_LABELS = { word: '单词', phrase: '短语', sentence: '句子', template: '范文模板' };
const TERM_LABELS = { word: '目标单词', phrase: '目标短语', sentence: '目标句子' };

export function kindOf(card) {
  const k = card?.kind || 'word';
  return KIND_LABELS[k] ? k : 'word';
}
export function modesForCard(card) {
  return (MODES_BY_KIND[kindOf(card)] || MODE_IDS).slice();
}

// ---------- 提示词 ----------
function cardContext(card) {
  const ex = Array.isArray(card?.examples) && card.examples[0]
    ? card.examples[0].sentence : (card?.example || '');
  return {
    word: String(card?.word || '').trim(),
    meaning: String(card?.meaning || '').trim(),
    pos: String(card?.pos || '').trim(),
    defs: Array.isArray(card?.defs) ? card.defs.slice(0, 3) : [],
    synonyms: Array.isArray(card?.synonyms) ? card.synonyms.slice(0, 3) : [],
    collocations: Array.isArray(card?.collocations) ? card.collocations.slice(0, 3) : [],
    example: String(ex || '').trim(),
  };
}

export function buildModesPrompt(card, modeIds) {
  const kind = kindOf(card);
  const termLabel = TERM_LABELS[kind];
  const ctx = cardContext(card);
  const ids = (modeIds && modeIds.length ? modeIds : modesForCard(card)).filter((id) => MODE_MAP.has(id));
  const lines = ids.map((id) => {
    const m = MODE_MAP.get(id);
    const side = m.answerSide === 'zh' ? '答案必须是【中文释义】'
      : m.answerSide === 'en' ? '答案必须是【英文原词/短语/句子本身】'
        : '答案可以是中文释义或英文原文（与 q 的类型相反即可）';
    const opt = CHOICE_MODES.has(id) ? '，并额外给 options（4 个选项字符串数组，含正确答案，顺序打乱）' : '';
    return `- ${id}（${m.desc}）：给出 q（题面）与 a（答案）。${side}${opt}`;
  }).join('\n');
  const posLine = kind === 'sentence'
    ? '（句子类，无词性）'
    : `词性：${ctx.pos || '（未知）'}`;
  const meaningLine = kind === 'sentence' ? '中文句译' : '中文释义';
  const meaningVal = kind === 'sentence' ? (ctx.meaning || '（待补充，请你给出准确的考研语境翻译）')
    : (ctx.meaning || '（待补充，请你给出准确的考研语境释义）');
  const defsLine = kind === 'word' ? `义项：${JSON.stringify(ctx.defs)}\n` : '';
  const hardRules = kind === 'sentence'
    ? '1. q 是展示给学生的题面，绝不能直接包含答案（「中文选词」的 q 只能是中文句译，不能出现该英文句子）。\n2. a 是标准答案，必须与题干方向匹配、简短准确（中文句译 ≤ 30 字）。\n3. 只输出 JSON，不要任何解释文字，格式：'
    : '1. q 是展示给学生的题面，绝不能直接包含答案（例如「看词写义」的 q 只能是英文词，不能带中文释义；「中文选词」的 q 只能是中文，不能出现该英文词）。\n2. a 是标准答案，必须与题干方向匹配、简短准确（中文释义 ≤ 30 字，英文答案 = 该单词/短语本身）。\n3. 挖空类（cloze）的 q 用下划线 _ 表示被挖去的字母；例句挖空（sentenceCloze）的 q 用 ____ 表示被挖去的单词。\n4. 英英释义（englishEnglish）的 q 必须是英文（同义短语或挖空例句），a 为该单词。\n5. 词组搭配（collocations）的 q 用「中文释义 + 一条把目标词挖空的搭配短语」组成，a 为该单词。\n6. 只输出 JSON，不要任何解释文字，格式：';
  return `你是一名考研英语出题老师。请基于下面这个${KIND_LABELS[kind]}，为指定的背诵模式各出一道题。

${termLabel}：${ctx.word}
${posLine}
${meaningLine}：${meaningVal}
${defsLine}同义词：${JSON.stringify(ctx.synonyms)}
搭配：${JSON.stringify(ctx.collocations)}
例句：${ctx.example || '（无）'}

需要出题的模式：
${lines}

硬性要求：
${hardRules}
{"modes":{"<模式id>":{"q":"...","a":"..."${ids.some((id) => CHOICE_MODES.has(id)) ? ',"options":["...","...","...","..."]' : ''}}}}`;
}

// ---------- 校验（与 WordReview 渲染口径一致） ----------
const MAX_Q = 300;
const MAX_A = 60;

/**
 * 校验单条模式题目
 * @returns {{ok:boolean, reason?:string, item?:{q:string,a:string,options?:string[],tip?:string}}}
 */
export function validateModeQuestion(modeId, item, card) {
  const m = MODE_MAP.get(modeId);
  if (!m) return { ok: false, reason: `未知模式 ${modeId}` };
  if (!item || typeof item !== 'object') return { ok: false, reason: '非对象' };
  const q = String(item.q || '').trim();
  let a = String(item.a || '').trim();
  if (!q) return { ok: false, reason: '题干为空' };
  if (!a) return { ok: false, reason: '答案为空' };
  if (q.length > MAX_Q) return { ok: false, reason: '题干过长' };
  if (a.length > MAX_A) return { ok: false, reason: '答案过长' };

  const word = String(card?.word || '').trim();
  const wordKey = normalizeWordKey(word);
  const qKey = normalizeWordKey(q);
  const aKey = normalizeWordKey(a);
  const hasCJK = (s) => /[一-龥]/.test(s);

  if (m.answerSide === 'zh') {
    if (!hasCJK(a)) return { ok: false, reason: '答案应为中文释义' };
  } else if (m.answerSide === 'en') {
    if (hasCJK(a)) return { ok: false, reason: '答案应为英文原词' };
    // 答案必须是词条本身（word 容忍大小写/单复数差异；phrase/sentence 是整条短语或句子，
    // 不允许单复数变形，必须整体一致——防模型自造词/偷换单词）
    if (wordKey && aKey !== wordKey) {
      const isPhrase = kindOf(card) !== 'word';
      const pluralOk = !isPhrase
        && (aKey === `${wordKey}s` || aKey === `${wordKey}es`
          || wordKey === `${aKey}s` || wordKey === `${aKey}es`);
      if (!pluralOk) return { ok: false, reason: `答案「${a}」与词条「${word}」不符` };
    }
    a = word; // 统一回填为标准词形，避免大小写漂移影响判分
  }

  // 题干泄露检测：答案不得原样出现在题干里
  if (m.answerSide === 'en' && wordKey && qKey.includes(wordKey)) {
    // cloze/sentenceCloze 的题干本就含部分字母或用 ____ 占位，属正常；
    // 但完整词出现即为泄露
    const masked = q.replace(/_+/g, '').replace(/\s+/g, '');
    if (masked.toLowerCase().includes(wordKey.replace(/\s+/g, ''))) {
      return { ok: false, reason: '题干泄露了答案（完整单词）' };
    }
  }
  if (m.answerSide === 'zh' && a && q.includes(a)) {
    return { ok: false, reason: '题干泄露了答案（中文释义）' };
  }

  // 选择题：选项必须包含答案且去重后 ≥2
  let options = null;
  if (CHOICE_MODES.has(modeId)) {
    const raw = Array.isArray(item.options) ? item.options : [];
    const clean = [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))];
    if (clean.length < 2) return { ok: false, reason: '选择题干扰项不足' };
    const side = m.answerSide === 'en'
      ? clean.some((x) => normalizeWordKey(x) === wordKey)
      : clean.some((x) => x === a);
    if (!side) return { ok: false, reason: '选项中不含正确答案' };
    options = clean.slice(0, 4);
  }

  const tip = typeof item.tip === 'string' ? item.tip.trim().slice(0, 120) : '';
  return { ok: true, item: { q, a, ...(options ? { options } : {}), ...(tip ? { tip } : {}) } };
}

/** 归一化整包结果：只保留通过校验的模式，返回被丢弃的模式及原因（供 UI 展示） */
export function normalizeModeQuestions(card, data, modeIds) {
  const raw = data?.modes && typeof data.modes === 'object' ? data.modes : (data || {});
  const ids = (modeIds || MODE_IDS).filter((id) => MODE_MAP.has(id));
  const out = {};
  const dropped = [];
  for (const id of ids) {
    const v = validateModeQuestion(id, raw?.[id], card);
    if (v.ok) out[id] = v.item;
    else dropped.push({ mode: id, reason: v.reason });
  }
  return { modes: out, dropped, count: Object.keys(out).length };
}

// ---------- 主入口 ----------
/**
 * 为一词生成 13 模式题目（不落库）
 * @returns {Promise<{ok:boolean, modes?:object, dropped?:Array, reason?:string, via?:string}>}
 */
export async function generateModeQuestions({ card, modes, settings, agentCtx }) {
  const word = String(card?.word || '').trim();
  if (!word) return { ok: false, reason: 'empty-word' };
  const kind = kindOf(card);
  // v40：默认模式按 kind 分轨（sentence 只出 6 种中文答案模式；template 无出题语义）
  const ids = (modes && modes.length ? modes : modesForCard(card)).filter((id) => MODE_MAP.has(id));
  if (!ids.length) return { ok: false, reason: `no-modes-for-${kind}` };
  const res = await callLlmJson({
    prompt: buildModesPrompt(card, ids),
    settings,
    agentCtx,
    agentInput: word,
    source: 'english-modes',
    task: 'word-mode-questions',
    system: '你是考研英语出题老师。严格输出 JSON，不要任何额外文字。',
  });
  if (!res.ok) return { ok: false, reason: res.reason };
  const norm = normalizeModeQuestions(card, res.data, ids);
  if (!norm.count) {
    return { ok: false, reason: `生成结果全部未通过校验：${norm.dropped.map((d) => d.mode + '(' + d.reason + ')').join('，')}` };
  }
  return { ok: true, modes: norm.modes, dropped: norm.dropped, via: res.via };
}

/** 合并到卡片行（不写库；返回新行对象，调用方负责落库） */
export function applyModeQuestions(card, modes) {
  if (!card || !modes || !Object.keys(modes).length) return card;
  const prev = (card.modeQuestions && typeof card.modeQuestions === 'object') ? card.modeQuestions : {};
  return {
    ...card,
    modeQuestions: { ...prev, ...modes },
    updatedAt: Date.now(),
  };
}

// ---------- 大纲中文释义批量补齐 ----------
// 4956 词不可能一次性生成：按批（默认 40 词/批）调用，逐批落库，
// 支持进度回调与中断（onBatch 返回 false 即停止），失败批次不影响已落库批次。
export async function batchGenerateMeanings({
  words, settings, agentCtx, batchSize = 40, onBatch,
}) {
  const list = (words || []).map((w) => String(w || '').trim()).filter(Boolean);
  if (!list.length) return { ok: false, reason: 'empty-words', generated: 0, failed: 0, batches: 0 };

  const batches = [];
  for (let i = 0; i < list.length; i += batchSize) batches.push(list.slice(i, i + batchSize));

  let generated = 0;
  let failed = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const prompt = `你是考研英语词汇专家。请为下列英文单词各给出**一个**最常用、最贴合考研语境的中文释义。

单词列表：
${batch.map((w, k) => `${k + 1}. ${w}`).join('\n')}

要求：
1. 只输出 JSON：{"meanings":{"<单词>":"<中文释义>"}}，key 必须与上面给出的单词完全一致（含大小写）。
2. 中文释义简洁（≤ 30 字），多义项用「；」分隔，最多 3 个义项。
3. 不要音标、不要例句、不要解释性文字；生僻义项不要。`;
    let entries = [];
    try {
      const res = await callLlmJson({
        prompt, settings, agentCtx,
        agentInput: batch.join(','),
        source: 'english-syllabus-meaning',
        task: 'word-syllabus-meanings',
        system: '你是考研英语词汇专家。严格输出 JSON，不要任何额外文字。',
      });
      if (res.ok) {
        const map = res.data?.meanings && typeof res.data.meanings === 'object' ? res.data.meanings : {};
        for (const w of batch) {
          const m = map[w] ?? map[String(w).toLowerCase()];
          const val = String(m || '').trim();
          // 校验：必须是中文、非空、长度合理、且不是把单词本身抄回来
          if (val && /[一-龥]/.test(val) && val.length <= 60 && normalizeWordKey(val) !== normalizeWordKey(w)) {
            entries.push({ word: w, meaning: val, source: 'ai' });
          }
        }
      }
    } catch (e) {
      console.warn('[word-ai-modes] meaning batch failed:', e?.message || e);
    }
    if (entries.length) {
      const { setMeanings } = await import('./word-meaning.js');
      const n = await setMeanings(entries, { source: 'ai' });
      generated += n;
      failed += batch.length - entries.length;
    } else {
      failed += batch.length;
    }
    if (onBatch) {
      const keepGoing = onBatch({ done: i + 1, total: batches.length, generated, failed });
      if (keepGoing === false) break;
    }
  }
  return { ok: generated > 0, generated, failed, batches: batches.length };
}

export { hasLlmChannel };
