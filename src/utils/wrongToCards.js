// P2-2 模考/生成式测验 - 错题-AI补卡闭环：把错题统一生成为卡片入复习队列
// 认知科学闭环：测试（检索）→ 发现缺口 → 补卡（重新编码）→ 间隔复习（巩固）
// 兼容两种错题结构：
//   - Exam.vue 模考错题：{cardId, front, back, user, cov, correct, explain?}
//   - GenQuiz.vue 生成式错题：{type, stem, options, answer, explanation, sourceCardId, subject, user, cov, correct}
// 生成的卡片：front=题干, back=参考答案+解析, 关联 sourceCardId, 标签"错题补卡"
import { createCard } from '../repo.js';

/**
 * 把错题列表统一生成为卡片入复习队列
 * @param {Array} wrongList 错题数组（兼容两种结构）
 * @param {object} opts { tag: 自定义标签, source: 来源标记 }
 * @returns {Promise<{created:number, failed:number}>}
 */
export async function wrongQuestionsToCards(wrongList, opts = {}) {
  if (!Array.isArray(wrongList) || !wrongList.length) return { created: 0, failed: 0 };
  const tag = opts.tag || '错题补卡';
  const source = opts.source || '错题补卡';
  let created = 0, failed = 0;
  for (const w of wrongList) {
    try {
      // 判定结构：生成式测验（有 type+stem）vs 模考（有 front+back）
      const isGenQuiz = w.type && w.stem !== undefined;
      let front, back, sourceCardId, subject, difficulty;
      if (isGenQuiz) {
        // 生成式测验错题
        const typeLabel = w.type === 'choice' ? '选择' : w.type === 'cloze' ? '填空' : '简答';
        front = `【${typeLabel}题】${w.stem}`;
        if (w.options) front += `\n选项：${w.options.map((o, i) => `${'ABCD'[i]}.${o}`).join('  ')}`;
        const ansText = w.type === 'choice'
          ? (w.options && w.options[w.answer] ? `${'ABCD'[w.answer]}. ${w.options[w.answer]}` : String(w.answer))
          : String(w.answer);
        back = `参考答案：${ansText}\n\n解析：${w.explanation || '（无）'}\n\n你的答案：${w.user ?? '（未作答）'}`;
        sourceCardId = w.sourceCardId;
        subject = w.subject || '未分类';
        difficulty = 'applied';
      } else {
        // 模考错题
        front = String(w.front || '');
        back = `参考答案：${w.back || ''}\n\n你的答案：${w.user || '（未作答）'}\n\n覆盖度：${w.cov ?? 0}%`;
        if (w.explain) back += `\n\nAI讲解：${w.explain}`;
        sourceCardId = w.cardId;
        subject = w.subject || '未分类';
        difficulty = 'applied';
      }
      if (!front) { failed++; continue; }
      await createCard({
        front: front.slice(0, 8000),
        back: back.slice(0, 8000),
        subject,
        tags: [tag],
        type: 'basic',
        source,
        sourceCardId: sourceCardId || '',
        difficulty,
      });
      created++;
    } catch { failed++; }
  }
  return { created, failed };
}
