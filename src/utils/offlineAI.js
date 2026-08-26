// 离线 AI 兜底（P3-D）
// 目标：当未配置 API Key 或网络请求失败时，让依赖 AI 的功能（智能卡组 / 情境变式 / 费曼 / AI 对话）
//       不直接报错崩溃，而是降级为"本地规则化"产物或明确的离线引导，保证应用可用性。
// 设计原则：
//  1) 结构化输出（卡组/变式）走本地启发式，产出真实可用卡片——离线也有学习价值；
//  2) 自然语言对话（费曼/AI 问答）不"伪装 AI"，而是给出诚实引导，避免误导用户；
//  3) 所有兜底函数为纯函数、无副作用、无网络，便于测试与复用。

import { decideType, scoreCard } from './genDeck.js';

// ---------- 意图识别：从 messages 推断当前调用属于哪类功能 ----------
export function detectIntent(messages = []) {
  const text = messages.map(m => String(m?.content || '')).join('\n').slice(0, 4000);
  if (/拆解|记忆卡片|JSON 数组|卡组生成|冷启动/.test(text)) return 'deck';
  if (/情境变式|变式题|出题老师/.test(text)) return 'variant';
  if (/费曼|FEYNMAN|Feynman/.test(text)) return 'feynman';
  if (/记忆抽取|提取记忆|长期记忆/.test(text)) return 'memory';
  return 'chat';
}

function toPlain(t) {
  return String(t || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\$\$?[^$\n]+\$\$?/g, ' $1 ')
    .replace(/[*_#>~`|\[\](){}=]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 从一句话生成一个"问题"front
function questionFromSentence(s) {
  s = String(s).trim();
  if (!s) return null;
  let m = s.match(/^(.{2,24}?)\s*(?:是(?:指|一种|一类)?|指的是?|是指的?|表示|代表|含义是)\s*(.+)$/);
  if (m) {
    const subj = m[1].trim();
    return { front: `什么是「${subj}」？`, back: s, type: 'basic' };
  }
  m = s.match(/^(.{2,20}?)[:：]\s*(.+)$/);
  if (m) {
    const subj = m[1].trim();
    return { front: `请简述：${subj}`, back: m[2].trim(), type: 'basic' };
  }
  if (/(?:包括|包含|主要(?:有|分|包括)|分(?:为|成))/.test(s)) {
    m = s.match(/^(.{2,20}?)(?:主要)?(?:包括|包含|有|分为|分成)/);
    if (m) {
      const subj = m[1].trim() || '下列内容';
      return { front: `${subj}主要包括哪些？`, back: s, type: 'choice' };
    }
  }
  if (s.length >= 10 && s.length <= 160 && /[。.]$/.test(s)) {
    const kw = s.match(/[\u4e00-\u9fa5]{2,4}/g);
    if (kw && kw.length) {
      const target = kw[Math.floor(kw.length / 2)];
      const idx = s.indexOf(target);
      if (idx >= 0) {
        const front = s.slice(0, idx) + '___' + s.slice(idx + target.length);
        return { front, back: target, type: 'cloze' };
      }
    }
    return { front: `判断正误并简述：${s.slice(0, 30)}…`, back: s, type: 'basic' };
  }
  return null;
}

/**
 * 本地卡组生成：把文本切成多张记忆卡
 * @param {string} text
 * @param {object} opts { subject }
 * @returns {Array<{front,back,subject,tags,type,score,dupScore}>}
 */
export function offlineGenDeck(text, opts = {}) {
  const subject = String(opts.subject || '').slice(0, 30) || '';
  const plain = toPlain(text);
  if (!plain) return [];
  const sentences = plain
    .split(/(?<=[。！？；.!?])\s*/)
    .map(s => s.trim())
    .filter(s => s.length >= 6 && s.length <= 300);
  const out = [];
  const seenFront = new Set();
  for (const s of sentences) {
    const card = questionFromSentence(s);
    if (!card) continue;
    const front = String(card.front).slice(0, 8000);
    if (seenFront.has(front)) continue;
    seenFront.add(front);
    const c = {
      front,
      back: String(card.back).slice(0, 8000),
      subject,
      tags: subject ? [subject] : [],
      type: card.type,
    };
    out.push({ ...c, type: c.type === 'basic' ? decideType(c) : c.type, score: scoreCard(c), dupScore: 0 });
    if (out.length >= 30) break;
  }
  return out;
}

const VARIANT_TEMPLATES = [
  {
    name: '定义反问', difficulty: 'basic',
    make: (c) => {
      const subj = (c.front.match(/[\u4e00-\u9fa5A-Za-z]{2,12}/) || ['该概念'])[0];
      return { front: `请用自己的话解释「${subj}」，并举例说明。`, back: c.back };
    },
  },
  {
    name: '填空变式', difficulty: 'basic',
    make: (c) => {
      const back = String(c.back);
      const kw = back.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
      if (!kw.length) return null;
      const target = kw[Math.floor(kw.length / 2)];
      const idx = back.indexOf(target);
      if (idx < 0) return null;
      return { front: `填空：${back.slice(0, idx)}___${back.slice(idx + target.length)}`, back: target };
    },
  },
  {
    name: '判断变式', difficulty: 'applied',
    make: (c) => {
      const back = String(c.back).slice(0, 60);
      return { front: `下列说法是否正确？为什么？\n「${back}」`, back: `正确（原卡答案）。理由：${back}` };
    },
  },
  {
    name: '情境应用', difficulty: 'applied',
    make: (c) => {
      const kw = (c.front + c.back).match(/[\u4e00-\u9fa5]{2,4}/g) || [];
      const k = kw[0] || '该知识点';
      return { front: `在实际场景中如何运用「${k}」？请结合一个例子说明。`, back: c.back };
    },
  },
  {
    name: '对比辨析', difficulty: 'challenge',
    make: (c) => {
      const subj = (c.front.match(/[\u4e00-\u9fa5A-Za-z]{2,12}/) || ['该概念'])[0];
      return { front: `「${subj}」与容易混淆的概念有何区别？请对比分析。`, back: c.back };
    },
  },
];

/**
 * 本地变式生成：对一张卡产出 count 张模板变式（含难度梯度）
 * @param {object} card { front, back, subject, tags }
 * @param {number} count
 * @returns {Array<{front,back,subject,tags,type,difficulty}>}
 */
export function offlineGenVariants(card, count = 3) {
  const out = [];
  const tags = ['情境变式', ...(card.tags || []).slice(0, 3)];
  // 按 difficulty 排序：basic → applied → challenge，保证梯度递进
  const order = { basic: 0, applied: 1, challenge: 2 };
  const sorted = [...VARIANT_TEMPLATES].sort((a, b) => (order[a.difficulty] ?? 1) - (order[b.difficulty] ?? 1));
  for (const t of sorted) {
    if (out.length >= count) break;
    try {
      const v = t.make(card);
      if (!v || !v.front || !v.back) continue;
      out.push({
        front: String(v.front).slice(0, 8000),
        back: String(v.back).slice(0, 8000),
        subject: card.subject || '',
        tags,
        type: 'basic',
        difficulty: t.difficulty,
      });
    } catch { /* 跳过失败的模板 */ }
  }
  return out;
}

/**
 * 对话兜底：返回一段引导文字，告知用户当前离线/未配置，并给出下一步建议。
 * @param {Array} messages
 * @returns {string}
 */
export function offlineChat(messages = []) {
  const intent = detectIntent(messages);
  const hasKey = (() => { try { return !!JSON.parse(localStorage.getItem('sxy_ai_config') || 'null')?.apiKey; } catch { return false; } })();
  const reason = hasKey ? '网络连接失败或 AI 服务不可达' : '尚未配置 AI 密钥';
  const setup = hasKey
    ? '请检查网络后重试；若持续失败，可前往「同步 → 错误日志」查看详情。'
    : '前往「AI 问答」页右上角设置，填入 OpenAI 兼容的 API Key（如 DeepSeek）即可启用。';
  if (intent === 'feynman') {
    return `【离线模式】${reason}。\n费曼练习需要 AI 出题与点评，当前无法进行。\n${setup}\n\n提示：在「错题本」选中错卡可加入今日复习，待联网后再来费曼讲解。`;
  }
  if (intent === 'memory') {
    return '【离线模式】记忆抽取需要 AI，当前已跳过，不影响你的对话历史。';
  }
  return `【离线模式】${reason}。\n${setup}`;
}

/** 是否应走兜底：无 key */
export function shouldFallback() {
  try {
    const cfg = JSON.parse(localStorage.getItem('sxy_ai_config') || 'null');
    return !cfg || !cfg.apiKey;
  } catch { return true; }
}

/** 判断一个错误是否是网络/请求失败（可兜底） */
export function isNetworkError(err) {
  const m = String(err?.message || err || '');
  return /fetch|network|Failed to fetch|网络|请求失败|AI 请求失败|timeout|aborted/i.test(m);
}
