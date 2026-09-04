// 生成式测验（P2-1）：从卡片/知识点用 LLM 自动生成选择/填空/简答题
// 认知科学依据：测试效应（Testing Effect）—— 主动检索比被动复习强 2~3 倍；
//   生成效应（Generation Effect）—— 自己产出答案比再认更牢固。
// 与 Exam.vue 模考的差异：
//   - Exam.vue：从卡片原样抽 front/back 做简答题（再认级检索）
//   - genQuiz：用 LLM 重组出全新题目（选择/填空/简答），避免"背题而非学知识"
// 模式：LLM 优先（chatAI + 严格 JSON）→ 无 key/网络失败降级本地模板拼装
import { chatAI } from '../ai.js';
import { shouldFallback, isNetworkError } from './offlineAI.js';
import { parseLLMJsonArray } from './llm-json.js';

// 清洗 markdown，给 LLM 喂纯文本
function plain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [图片] ')
    .replace(/\$\$?([^$\n]+)\$\$?/g, ' $1 ')
    .replace(/[*_#>`~|-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 三种题型枚举（与 exams 表 questions[].type 兼容）
 * - choice     选择题（4 选 1，含 options + answer 索引）
 * - cloze      填空题（stem 含 ___，answer 为填空答案）
 * - shortAnswer 简答题（answer 为参考答案，用关键词覆盖度判分）
 */
export const QUIZ_TYPES = [
  { code: 'choice', label: '选择题', desc: '4 选 1，测试再认+排除能力' },
  { code: 'cloze', label: '填空题', desc: '主动回忆，测试精确提取' },
  { code: 'shortAnswer', label: '简答题', desc: '生成式输出，测试整合理解（最强）' },
];

/**
 * 本地离线模板拼装（无 LLM key 时回退）：从卡片 front/back 直接构造题目
 * - choice：用其他卡的 back 做干扰项
 * - cloze：从 back 挖空
 * - shortAnswer：原样以 front 提问
 * 质量远低于 LLM 生成，但保证无 key 也能用
 */
function offlineGenQuiz(cards, type, count) {
  const out = [];
  const pool = cards.filter(c => c.back && c.front);
  if (!pool.length) return out;
  for (let i = 0; i < count && pool.length; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    const c = pool[idx];
    // 避免重复抽同一张
    pool.splice(idx, 1);
    const stem = plain(c.front);
    const answer = plain(c.back);
    if (type === 'choice') {
      // 从其他卡取 3 个干扰项
      const distractors = cards
        .filter(x => x.id !== c.id && x.back && plain(x.back) !== answer)
        .map(x => plain(x.back))
        .filter(Boolean)
        .sort(() => Math.random() - 0.5)
        .slice(0, 3);
      while (distractors.length < 3) distractors.push('（无关选项）');
      const options = [answer, ...distractors].sort(() => Math.random() - 0.5);
      out.push({
        type: 'choice',
        stem,
        options,
        answer: options.indexOf(answer),
        explanation: answer,
        sourceCardId: c.id,
        subject: c.subject || '未分类',
      });
    } else if (type === 'cloze') {
      // 从 answer 中挖一个 2~4 字的关键片段
      const words = answer.split(/[\s，。、；：,.;:!?！？]+/).filter(w => w.length >= 2 && w.length <= 8);
      const blank = words[Math.floor(Math.random() * words.length)] || answer.slice(0, 3);
      const clozeStem = `${stem}\n填空：${answer.replace(blank, '____')}（请填写空白处）`;
      out.push({
        type: 'cloze',
        stem: clozeStem,
        answer: blank,
        explanation: answer,
        sourceCardId: c.id,
        subject: c.subject || '未分类',
      });
    } else {
      // shortAnswer
      out.push({
        type: 'shortAnswer',
        stem,
        answer,
        explanation: answer,
        sourceCardId: c.id,
        subject: c.subject || '未分类',
      });
    }
  }
  return out;
}

/**
 * 生成式测验核心：用 LLM 从卡片集生成题目
 * @param {Array} cards 卡片池 [{id, front, back, subject, tags}]
 * @param {object} opts { type:'choice|cloze|shortAnswer', count, mixTypes:boolean }
 *   - mixTypes=true 时 count 道题按 choice/cloze/shortAnswer 三等分混合
 * @returns {Promise<Array>} 题目数组 [{type, stem, options?, answer, explanation, sourceCardId, subject}]
 */
export async function genQuiz(cards, opts = {}) {
  const type = opts.mixTypes ? 'mixed' : (opts.type || 'choice');
  const count = Math.max(1, Math.min(20, opts.count || 5));
  if (!cards || !cards.length) throw new Error('卡片池为空，无法生成测验');

  // 离线回退
  if (shouldFallback()) {
    if (type === 'mixed') {
      const per = Math.ceil(count / 3);
      const r = [
        ...offlineGenQuiz(cards, 'choice', per),
        ...offlineGenQuiz(cards, 'cloze', per),
        ...offlineGenQuiz(cards, 'shortAnswer', count - 2 * per),
      ];
      if (!r.length) throw new Error('离线模式生成失败，请先配置 AI 密钥');
      return r;
    }
    const r = offlineGenQuiz(cards, type, count);
    if (!r.length) throw new Error('离线模式生成失败，请先配置 AI 密钥');
    return r;
  }

  // 准备知识点摘要（喂给 LLM，避免超长）
  const knowledge = cards.slice(0, 30).map((c, i) => ({
    id: c.id,
    q: plain(c.front).slice(0, 120),
    a: plain(c.back).slice(0, 150),
    subject: c.subject || '未分类',
  }));

  const typePrompt = type === 'mixed'
    ? `混合出题：约 1/3 选择题(choice)、1/3 填空题(cloze)、1/3 简答题(shortAnswer)`
    : `全部为 ${type} 题型`;

  const sys = `你是考研出题专家。基于给定的知识点，生成 ${count} 道高质量测验题，要求：
1. ${typePrompt}
2. 题目必须基于给定知识点，但换一种问法/情境，避免直接照抄原题
3. 选择题：4 个选项，只有 1 个正确，干扰项要有迷惑性（同科目易混概念）
4. 填空题：stem 中用 "____" 标出空白，answer 填空白处的答案
5. 简答题：answer 给出参考答案要点，explanation 给出详细解析
6. 每题关联 sourceCardId（从给定知识点里选最相关的一个）
输出严格 JSON 数组，每项格式：
[{"type":"choice","stem":"题干","options":["A","B","C","D"],"answer":0,"explanation":"解析","sourceCardId":"xxx","subject":"科目"}]
- choice 的 answer 是正确选项的索引(0-3)
- cloze 的 stem 含 "____"，answer 是空白处答案
- shortAnswer 无 options，answer 是参考答案
只输出 JSON，不要多余文字。`;

  let arr;
  try {
    const r = await chatAI([
      { role: 'system', content: sys },
      { role: 'user', content: `知识点：\n${JSON.stringify(knowledge, null, 2)}` },
    ], { maxTokens: Math.min(8000, Math.max(4000, count * 500)) }); // 出题含解析较长，防 max_tokens 截断 JSON
    arr = parseLLMJsonArray(r); // 空输出/非 JSON → 可读报错，而非 "Unexpected end of JSON input"
  } catch (e) {
    if (isNetworkError(e)) {
      // 网络失败降级本地模板
      if (type === 'mixed') {
        const per = Math.ceil(count / 3);
        return [
          ...offlineGenQuiz(cards, 'choice', per),
          ...offlineGenQuiz(cards, 'cloze', per),
          ...offlineGenQuiz(cards, 'shortAnswer', count - 2 * per),
        ];
      }
      return offlineGenQuiz(cards, type, count);
    }
    throw e;
  }

  // 校验 + 补全字段
  const validIds = new Set(cards.map(c => c.id));
  const result = [];
  for (const q of arr) {
    if (!q.stem || q.answer === undefined) continue;
    // sourceCardId 无效时回退第一张
    if (!q.sourceCardId || !validIds.has(q.sourceCardId)) {
      q.sourceCardId = cards[Math.floor(Math.random() * cards.length)].id;
    }
    if (q.type === 'choice' && (!Array.isArray(q.options) || q.options.length < 2)) continue;
    result.push({
      type: q.type || 'shortAnswer',
      stem: String(q.stem).slice(0, 2000),
      options: q.options ? q.options.map(o => String(o).slice(0, 200)) : undefined,
      answer: q.type === 'choice' ? Number(q.answer) : String(q.answer).slice(0, 2000),
      explanation: String(q.explanation || '').slice(0, 2000),
      sourceCardId: q.sourceCardId,
      subject: q.subject || '未分类',
    });
    if (result.length >= count) break;
  }
  if (!result.length) throw new Error('AI 未生成有效题目');
  return result;
}

/**
 * 批改：对比用户答案与正确答案
 * - choice：索引完全匹配
 * - cloze：去除标点后包含匹配（允许措辞差异）
 * - shortAnswer：关键词覆盖度 ≥60% 算对（复用 Exam.vue 的判分语义）
 */
export function gradeQuestion(q, userAnswer) {
  const u = String(userAnswer || '').trim();
  if (!u) return { correct: false, cov: 0, reason: '未作答' };
  if (q.type === 'choice') {
    const correct = Number(u) === Number(q.answer);
    return { correct, cov: correct ? 100 : 0, reason: correct ? '选择正确' : '选择错误' };
  }
  // cloze / shortAnswer：关键词覆盖度
  const norm = (s) => String(s || '').replace(/[，。、；：,.;:!?！？\s]/g, '').toLowerCase();
  const ans = norm(q.answer);
  const usr = norm(u);
  if (q.type === 'cloze') {
    // 填空题：答案应作为子串出现（允许用户写更多上下文）
    const correct = usr.includes(ans) || ans.includes(usr);
    return { correct, cov: correct ? 100 : 0, reason: correct ? '填空正确' : '填空不符' };
  }
  // shortAnswer：分词后关键词覆盖率
  const keywords = ans.split('').filter(Boolean);
  if (!keywords.length) return { correct: false, cov: 0, reason: '无参考答案' };
  // 用 2-gram 提升判分鲁棒性
  const grams = [];
  for (let i = 0; i < keywords.length - 1; i++) grams.push(keywords[i] + keywords[i + 1]);
  const sample = grams.length ? grams : keywords;
  const hit = sample.filter(g => usr.includes(g)).length;
  const cov = Math.round((hit / sample.length) * 100);
  return { correct: cov >= 60, cov, reason: cov >= 60 ? '覆盖达标' : '覆盖不足' };
}
