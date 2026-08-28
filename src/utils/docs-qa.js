// 文件问答（Phase 6.4）
// 纯函数：prompt 拼装 / 引用格式化 / 片段裁剪 —— Node 可测
// IO：askDoc —— 限定单文件检索（sourceId）→ 拼 prompt → chatAI（离线兜底）

import { db } from '../db.js';
import { hybridSearch } from '../agent/retrieval.js';
import { chatAI } from '../ai.js';

/** 检索结果 → 引用片段（裁剪到 limit 条、每条 maxChars） */
export function trimDocExcerpts(results, limit = 4, maxChars = 400) {
  return (results || [])
    .filter((r) => r?.row?.text)
    .slice(0, limit)
    .map((r, i) => ({
      idx: i + 1,
      text: String(r.row.text).slice(0, maxChars),
      score: Math.round((r.fused ?? 0) * 100),
    }));
}

/** 拼装问答 prompt：仅依据资料片段回答，禁止编造 */
export function buildDocQAPrompt({ docName, excerpts, question }) {
  const ctx = excerpts.map((e) => `[片段${e.idx}] ${e.text}`).join('\n');
  return [
    `你是《${docName}》的答疑助手。请仅依据下面给出的资料片段回答用户问题，不要编造资料外的内容；`,
    `若片段不足以回答，请明确说明「资料中未找到相关内容」。回答中引用某片段时标注 [片段N]。`,
    '',
    '【资料片段】',
    ctx,
    '',
    '【问题】',
    String(question || '').trim(),
  ].join('\n');
}

/** 引用列表 → 展示文本（问答面板附在回答下方） */
export function formatCitations(excerpts) {
  return (excerpts || []).map((e) => `[片段${e.idx}]（相似 ${e.score}%）${e.text}`).join('\n\n');
}

/**
 * 对单个资料提问。
 * @param {string} docId docFiles.id
 * @param {string} question
 * @param {object} opts { topK=6 }
 * @returns {Promise<{answer:string, citations:Array}>}
 */
export async function askDoc(docId, question, opts = {}) {
  const row = await db.docFiles.get(docId);
  if (!row) throw new Error('资料不存在');
  const textRow = await db.docTexts.get(docId);
  if (!textRow?.text?.trim()) throw new Error('该资料尚未解析完成，无法问答');
  const q = String(question || '').trim();
  if (!q) throw new Error('问题不能为空');

  // 限定单文件检索（loadEmbeddingRows 的 sourceId 分支）
  const results = await hybridSearch(q, { sourceId: docId, topK: opts.topK ?? 6 });
  const excerpts = trimDocExcerpts(results);
  if (!excerpts.length) {
    return {
      answer: '未在资料中找到与问题相关的片段。可换个问法，或确认资料已解析完成。',
      citations: [],
    };
  }

  const prompt = buildDocQAPrompt({ docName: row.name, excerpts, question: q });
  const answer = await chatAI([{ role: 'user', content: prompt }], {});
  return { answer: String(answer || '').trim(), citations: excerpts };
}
