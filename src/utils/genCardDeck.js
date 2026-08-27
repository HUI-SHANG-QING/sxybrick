// P2-3 AI 智能卡组生成：从纯文本/笔记/文档用 LLM 批量拆分成 front/back 卡片
// 与 Cards.vue 批量建卡的差异：
//   - 批量建卡：用户手动用 | → 分隔正反面（机械拆分）
//   - genCardDeck：用户粘贴纯笔记，AI 自动识别知识点并提问化生成 front/back（智能拆分）
// 认知科学：优质提问=优质检索线索，AI 把陈述句转成问句，复习时检索强度更高
// 模式：LLM 优先（chatAI + 严格 JSON）→ 无 key/网络失败降级按段落简单拆分
import { chatAI } from '../ai.js';
import { shouldFallback, isNetworkError } from './offlineAI.js';

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
 * 离线回退：按段落/句子简单拆分（无提问化，质量低但保证可用）
 * 规则：按空行分段，每段一张卡；front=段首句，back=段剩余
 */
function offlineGenDeck(text, count, subject) {
  const paragraphs = String(text || '')
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!paragraphs.length) return [];
  const out = [];
  for (const p of paragraphs.slice(0, count)) {
    // 尝试用首句作 front，剩余作 back
    const firstSentence = p.split(/[。！？.!?\n]/)[0]?.trim() || p.slice(0, 40);
    const rest = p.slice(firstSentence.length).trim();
    out.push({
      front: firstSentence.slice(0, 200),
      back: (rest || p).slice(0, 2000),
      subject: subject || '未分类',
      difficulty: 'basic',
    });
    if (out.length >= count) break;
  }
  return out;
}

/**
 * AI 智能卡组生成核心
 * @param {string} text 纯文本/笔记/文档
 * @param {object} opts { count, subject, tags?, difficultyHint? }
 *   - count 目标卡片数（默认 8，上限 30）
 *   - subject 科目
 *   - tags 额外标签
 *   - difficultyHint basic/applied/challenge 出题难度倾向
 * @returns {Promise<Array>} [{front, back, subject, tags, difficulty}]
 */
export async function genCardDeck(text, opts = {}) {
  const count = Math.max(1, Math.min(30, opts.count || 8));
  const subject = opts.subject || '未分类';
  const tags = Array.isArray(opts.tags) ? opts.tags : [];
  const text_ = String(text || '').trim();
  if (!text_) throw new Error('文本为空');
  if (text_.length < 20) throw new Error('文本太短，至少 20 字');

  // 离线回退
  if (shouldFallback()) {
    const r = offlineGenDeck(text_, count, subject);
    if (!r.length) throw new Error('离线模式无法拆分，请先配置 AI 密钥');
    return r.map(c => ({ ...c, tags }));
  }

  const difficultyHint = opts.difficultyHint || 'mixed';
  const sys = `你是考研复习卡片设计专家。把用户给的笔记/文档拆成 ${count} 张高质量的「问答题」卡片，要求：
1. 每张卡 front 必须是**问句**（把陈述句改写成提问，如"X是?"→"什么是X?请简述其定义与特征"），不要照抄原句
2. back 是简明完整的答案（可含要点列表，用换行分隔），覆盖该知识点的核心内容
3. 难度梯度 ${difficultyHint === 'mixed' ? '混排 basic/applied/challenge' : `全部 ${difficultyHint}`}
   - basic：基础识记（定义/概念）
   - applied：情境应用（举例/计算）
   - challenge：综合辨析（对比/评价）
4. 覆盖文本的不同知识点，不要重复
5. front 控制在 100 字内，back 控制在 500 字内
输出严格 JSON 数组：[{"front":"问句","back":"答案","difficulty":"basic|applied|challenge"}]
只输出 JSON，不要多余文字。`;

  let arr;
  try {
    const r = await chatAI([
      { role: 'system', content: sys },
      { role: 'user', content: `科目：${subject}\n笔记内容：\n${plain(text_).slice(0, 4000)}` },
    ]);
    const m = String(r).match(/\[[\s\S]*\]/);
    arr = JSON.parse(m ? m[0] : r);
    if (!Array.isArray(arr)) throw new Error('AI 返回格式异常');
  } catch (e) {
    if (isNetworkError(e)) {
      // 网络失败降级段落拆分
      const r = offlineGenDeck(text_, count, subject);
      if (!r.length) throw new Error('网络失败且离线拆分失败，请稍后重试');
      return r.map(c => ({ ...c, tags }));
    }
    throw e;
  }

  const result = [];
  for (const c of arr) {
    if (!c.front || !c.back) continue;
    const diff = ['basic', 'applied', 'challenge'].includes(c.difficulty) ? c.difficulty : 'basic';
    result.push({
      front: String(c.front).slice(0, 2000),
      back: String(c.back).slice(0, 8000),
      subject,
      tags,
      difficulty: diff,
    });
    if (result.length >= count) break;
  }
  if (!result.length) throw new Error('AI 未生成有效卡片');
  return result;
}
