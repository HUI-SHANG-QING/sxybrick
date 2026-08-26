// 智能卡组生成引擎（Phase 2 杀手锏）
// 把"贴一段笔记 → 拆成高质量记忆卡组"做成完整流水线：
//   1) 内容解析与分块（按段落/标题切分，避免单次 LLM 上下文过长）
//   2) 多题型自动决策（basic / cloze / choice，依据知识点形态）
//   3) 质量评分（atomicity / answerability / clarity / length）—— 0-100 本地启发式
//   4) 去重检测（与已有卡片库做关键词 Jaccard 相似度，标记疑似重复）
//   5) 源文档溯源（把原文存为 AI 文档，生成的卡片通过 source 字段回链）
//   6) 冷启动模板（针对 0 卡新用户的预设学科包，解决"空库没人想用"的冷启动问题）
// 设计原则：纯前端、模块化、无额外 LLM 调用做评分（省 token、可离线）
import { chatAI, hasAIKey } from '../ai.js';
import { listCards, createCard, createDoc } from '../repo.js';
import { offlineGenDeck, shouldFallback, isNetworkError } from './offlineAI.js';

// ---------- 文本预处理 ----------
const MAX_CHUNK_CHARS = 2000; // 单次 LLM 拆卡输入上限，超长则分块

/** 把 markdown / 杂乱文本规整成"段落块"列表，每块独立送 LLM 拆卡 */
export function splitIntoChunks(text, maxChars = MAX_CHUNK_CHARS) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  const paras = raw.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > maxChars) {
      if (cur) chunks.push(cur);
      if (p.length > maxChars) {
        const sents = p.split(/(?<=[。！？.!?])\s*/);
        let buf = '';
        for (const s of sents) {
          if ((buf + s).length > maxChars) { if (buf) chunks.push(buf); buf = s; }
          else buf += s;
        }
        if (buf) chunks.push(buf);
        cur = '';
      } else {
        cur = p;
      }
    } else {
      cur = cur ? cur + '\n\n' + p : p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** 提取关键词集合（中文按字 bigram、英文按词，用于去重 Jaccard） */
export function keywords(text) {
  const s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\$\$?([^$\n]+)\$\$?/g, ' $1 ')
    .replace(/[`*_#>~|\-\[\](){}=]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const set = new Set();
  const en = s.match(/[A-Za-z]{2,}/g) || [];
  for (const w of en) set.add(w.toLowerCase());
  const cn = s.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const seg of cn) {
    for (let i = 0; i < seg.length - 1; i++) set.add(seg.slice(i, i + 2));
  }
  const nums = s.match(/\d{2,}/g) || [];
  for (const n of nums) set.add(n);
  return set;
}

/** Jaccard 相似度（0-1） */
export function jaccard(aSet, bSet) {
  if (!aSet?.size || !bSet?.size) return 0;
  let inter = 0;
  const [small, large] = aSet.size <= bSet.size ? [aSet, bSet] : [bSet, aSet];
  for (const k of small) if (large.has(k)) inter++;
  return inter / (aSet.size + bSet.size - inter);
}

// ---------- 质量评分（0-100，本地启发式，无 LLM 调用） ----------
/**
 * 单卡质量评分维度：
 *  - atomicity（原子性）：单卡只考一个概念，front/back 不宜过长
 *  - answerability（可答性）：front 应是问题/填空，而非陈述句
 *  - clarity（清晰度）：无明显指代歧义（这/那/如下）
 *  - length（长度合理性）：过长难记，过短信息量不足
 */
export function scoreCard(card) {
  const front = String(card?.front || '');
  const back = String(card?.back || '');
  const fLen = [...front].length;
  const bLen = [...back].length;

  let atomicity = 100;
  if (fLen > 40) atomicity -= Math.min(40, (fLen - 40) * 0.5);
  if (bLen > 200) atomicity -= Math.min(30, (bLen - 200) * 0.15);
  if (fLen < 4) atomicity -= 30;
  atomicity = Math.max(0, Math.round(atomicity));

  const qWords = /[?？]|什么是|解释|定义|列举|比较|区别|原理|计算|求|为何|为什么|如何|哪些|哪一|填空|___|\(\s*\)/;
  let answerability = qWords.test(front) ? 90 : 60;
  if (/^[^?？]*[。.]$/.test(front) && !qWords.test(front)) answerability -= 20;
  answerability = Math.max(0, Math.min(100, answerability));

  const vague = /(这|那|如下|上述|该|此|其)[一者项]/;
  let clarity = vague.test(front) ? 60 : 85;
  if (vague.test(back) && bLen < 30) clarity -= 10;
  clarity = Math.max(0, Math.min(100, clarity));

  let lengthScore = 80;
  if (fLen >= 8 && fLen <= 35 && bLen >= 5 && bLen <= 150) lengthScore = 100;
  else if (fLen < 6 || bLen < 3) lengthScore = 50;
  lengthScore = Math.max(0, Math.min(100, lengthScore));

  const overall = Math.round(
    atomicity * 0.3 + answerability * 0.3 + clarity * 0.2 + lengthScore * 0.2,
  );
  return { atomicity, answerability, clarity, length: lengthScore, overall };
}

// ---------- 多题型自动决策 ----------
export function decideType(card) {
  if (!card) return 'basic';
  const front = String(card.front || '');
  const back = String(card.back || '');
  if (/___|_{3,}|\(\s*[A-Da-d]\s*\)|\[填空\]|【填空】/.test(front)) return 'cloze';
  if (/\n\s*[A-D][.、)]/.test(back) || /^[A-D][.、)]/m.test(back)) return 'choice';
  return 'basic';
}

// ---------- 源文档持久化 ----------
export async function persistSourceDoc(text, meta = {}) {
  const title = String(meta?.title || '').trim()
    || (String(text).trim().slice(0, 24).replace(/\n/g, ' ') + '…');
  const doc = await createDoc({
    title,
    content: String(text).slice(0, 20000),
    type: 'note',
    tags: ['智能卡组源'],
    source: '智能卡组生成',
  });
  return doc.id;
}

// ---------- 去重：与已有卡片库对比 ----------
export async function dedupAgainstLibrary(candidates, threshold = 0.35) {
  const existing = await listCards({ mode: 'all' });
  const existKw = existing.items.map(c => ({
    id: c.id, front: c.front, kw: keywords(c.front + ' ' + c.back),
  }));
  const result = [];
  for (const cand of candidates) {
    const candKw = keywords(cand.front + ' ' + cand.back);
    let best = { score: 0, with: null };
    for (const e of existKw) {
      const s = jaccard(candKw, e.kw);
      if (s > best.score) best = { score: s, with: e };
    }
    result.push({
      ...cand,
      dupScore: Number(best.score.toFixed(3)),
      dupWith: best.with ? { id: best.with.id, front: String(best.with.front).slice(0, 50) } : null,
    });
  }
  const deduped = result.filter(c => c.dupScore < threshold);
  return { candidates: result, deduped };
}

// ---------- 单次 LLM 拆卡（增强 prompt） ----------
const GEN_SYS_PROMPT = `你是学习内容拆解助手，专精把笔记/讲义拆成"高质量记忆卡片"。
拆解原则：
1) 原子化：一卡一概念，front 是一个明确问题或填空，back 是简短完整答案（建议 5-150 字）
2) 可答性：front 必须能独立作答，不含"这个/上述"等指代
3) 多题型：定义类用 basic；含填空标记用 cloze（front 留 ___）；列举类可写 choice（back 用 A. B. C. D. 形式）
4) 覆盖：尽量覆盖输入中的关键知识点，但宁缺毋滥
5) 科目：从内容自动判断（如"考研408/高数/英语/政治/数据结构"等）
输出严格 JSON 数组，每项：
{"front":"问题/填空","back":"答案","subject":"科目","tags":["标签"],"type":"basic|cloze|choice"}
只输出 JSON 数组，不要 markdown 代码块，不要多余文字。`;

export async function generateChunk(chunk, subjectHint = '') {
  const user = subjectHint
    ? `科目提示：${subjectHint}\n\n内容：\n${chunk}`
    : `内容：\n${chunk}`;
  const r = await chatAI([
    { role: 'system', content: GEN_SYS_PROMPT },
    { role: 'user', content: user },
  ]);
  return parseCards(r);
}

// 把本地兜底卡片包装成与 AI 路径一致的返回结构
function formatOfflineResult(cards, sourceDocId, opts) {
  return {
    sourceDocId,
    candidates: cards.map(enrichCard),
    deduped: cards.map(enrichCard),
    chunks: 1,
    meta: { subject: opts.subject || '', title: opts.title || '' },
    count: cards.length,
    offline: true, // 标记：本次为离线降级产物
  };
}

export function parseCards(text) {
  try {
    const m = String(text).match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : text);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(c => c && c.front && c.back)
      .map(c => ({
        front: String(c.front).slice(0, 8000),
        back: String(c.back).slice(0, 8000),
        subject: String(c.subject || '').slice(0, 30),
        tags: Array.isArray(c.tags) ? c.tags.slice(0, 8) : [],
        type: ['basic', 'cloze', 'choice'].includes(c.type) ? c.type : decideType(c),
      }));
  } catch { return []; }
}

// ---------- 冷启动模板 ----------
export const COLD_START_TEMPLATES = [
  {
    id: 'cs-ds',
    name: '数据结构入门',
    subject: '数据结构',
    description: '数组/链表/栈/队列/树/图的基础概念，适合零基础起步',
    prompt: '生成 10 张数据结构入门记忆卡片，覆盖：数组与链表区别、栈与队列、二叉树遍历、图的 BFS/DFS、时间复杂度。每张一问一答，原子化。',
  },
  {
    id: 'cs-net',
    name: '计算机网络必背',
    subject: '计算机网络',
    description: 'OSI/TCP-IP、三次握手、HTTP/HTTPS 基础',
    prompt: '生成 10 张计算机网络必背记忆卡片，覆盖：OSI 七层、TCP/IP 四层、三次握手四次挥手、HTTP 与 HTTPS、DNS 解析流程。',
  },
  {
    id: 'cs-os',
    name: '操作系统核心',
    subject: '操作系统',
    description: '进程/线程、调度、内存管理、死锁',
    prompt: '生成 10 张操作系统核心记忆卡片，覆盖：进程与线程、调度算法、内存分页分段、死锁四条件、PV 操作。',
  },
  {
    id: 'math-gaoshu',
    name: '高等数学基础',
    subject: '高等数学',
    description: '极限/导数/积分的核心公式与概念',
    prompt: '生成 10 张高等数学基础记忆卡片，覆盖：极限定义、导数几何意义、牛顿-莱布尼茨公式、中值定理、定积分应用。',
  },
  {
    id: 'en-vocab',
    name: '英语高频词根',
    subject: '英语',
    description: '高频词根词缀与易混词辨析',
    prompt: '生成 10 张英语词汇记忆卡片，覆盖：spect/dict/duc 等高频词根、affect/effect 等易混词辨析，每张含例句。',
  },
];

export async function generateColdStartDeck(templateId) {
  const tpl = COLD_START_TEMPLATES.find(t => t.id === templateId);
  if (!tpl) throw new Error('未知冷启动模板');
  // 离线兜底：无 key 时用模板内置文本本地切卡
  if (shouldFallback()) {
    const cards = offlineGenDeck(tpl.prompt, { subject: tpl.subject })
      .map(c => ({ ...c, subject: c.subject || tpl.subject, tags: [tpl.subject] }));
    return { template: tpl, candidates: cards, deduped: cards, count: cards.length, offline: true };
  }
  try {
    const r = await chatAI([
      { role: 'system', content: GEN_SYS_PROMPT },
      { role: 'user', content: tpl.prompt },
    ]);
    const raw = parseCards(r).map(c => ({ ...c, subject: c.subject || tpl.subject }));
    const { candidates, deduped } = await dedupAgainstLibrary(raw);
    return {
      template: tpl,
      candidates: candidates.map(enrichCard),
      deduped: deduped.map(enrichCard),
      count: candidates.length,
    };
  } catch (e) {
    if (isNetworkError(e)) {
      // 网络失败：降级本地切卡，保证冷启动可用
      const cards = offlineGenDeck(tpl.prompt, { subject: tpl.subject })
        .map(c => ({ ...c, subject: c.subject || tpl.subject, tags: [tpl.subject] }));
      return { template: tpl, candidates: cards, deduped: cards, count: cards.length, offline: true };
    }
    throw e;
  }
}

// ---------- 主入口：从一段文本生成完整卡组 ----------
/**
 * @param {string} text
 * @param {object} opts { subject?, title?, saveSource? }
 */
export async function generateDeck(text, opts = {}) {
  const src = String(text || '').trim();
  if (!src) throw new Error('内容为空');
  const chunks = splitIntoChunks(src);
  if (!chunks.length) throw new Error('内容解析失败');

  let sourceDocId = null;
  if (opts.saveSource !== false) {
    try { sourceDocId = await persistSourceDoc(src, { title: opts.title }); }
    catch { /* 失败不阻塞生成 */ }
  }

  // 离线兜底：无 key 或网络失败时，走本地规则切卡
  if (shouldFallback()) {
    const cards = offlineGenDeck(src, { subject: opts.subject });
    const { candidates, deduped } = await dedupAgainstLibrary(cards);
    return {
      sourceDocId,
      candidates: candidates.map(enrichCard),
      deduped: deduped.map(enrichCard),
      chunks: chunks.length,
      meta: { subject: opts.subject || '', title: opts.title || '' },
      count: candidates.length,
      offline: true,
    };
  }

  let raw;
  try {
    const results = [];
    const CONCURRENCY = 3;
    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const batch = chunks.slice(i, i + CONCURRENCY);
      const out = await Promise.all(batch.map(c => generateChunk(c, opts.subject)));
      results.push(...out);
    }
    raw = results.flat();
  } catch (e) {
    if (isNetworkError(e)) {
      // 网络失败：降级本地切卡
      const cards = offlineGenDeck(src, { subject: opts.subject });
      const { candidates, deduped } = await dedupAgainstLibrary(cards);
      return {
        sourceDocId,
        candidates: candidates.map(enrichCard),
        deduped: deduped.map(enrichCard),
        chunks: chunks.length,
        meta: { subject: opts.subject || '', title: opts.title || '' },
        count: candidates.length,
        offline: true,
      };
    }
    throw e;
  }
  const { candidates, deduped } = await dedupAgainstLibrary(raw);

  return {
    sourceDocId,
    candidates: candidates.map(enrichCard),
    deduped: deduped.map(enrichCard),
    chunks: chunks.length,
    meta: { subject: opts.subject || '', title: opts.title || '' },
    count: candidates.length,
  };
}

function enrichCard(c) {
  return { ...c, score: scoreCard(c), type: c.type || decideType(c) };
}

// ---------- 批量入库 ----------
export async function bulkCreateCards(cards, opts = {}) {
  const created = [];
  const failed = [];
  for (const c of cards) {
    try {
      const card = await createCard({
        front: String(c.front),
        back: String(c.back),
        subject: c.subject || opts.subject || '',
        tags: Array.isArray(c.tags) ? c.tags : [],
        type: c.type || 'basic',
        source: opts.sourceDocId ? `智能卡组·${opts.sourceDocId}` : (opts.source || '智能卡组生成'),
      });
      created.push(card);
    } catch (e) {
      failed.push({ front: c.front, error: e.message });
    }
  }
  return { created: created.length, failed, ids: created.map(c => c.id) };
}
