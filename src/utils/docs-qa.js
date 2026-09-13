// 文件问答（Phase 6.4）
// 纯函数：prompt 拼装 / 引用格式化 / 片段裁剪 / 视觉 prompt —— Node 可测
// IO：askDoc —— 有文本走「限定单文件检索（sourceId）」；无文本/疑似扫描件走视觉兜底

import { db } from '../db.js';
import { hybridSearch } from '../agent/retrieval.js';
import { chatAI } from '../ai.js';
import { docContentProfile, docVisionContent, DOC_VISION_LIMIT } from '../services/doc-vision.js';

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

/**
 * 拼装「视觉问答」prompt：资料以图片/扫描页形式随消息送入多模态模型。
 * 与 buildDocQAPrompt 的区别：没有可检索文本，模型必须看图回答，
 * 因此要求它同时转述关键内容（避免用户只拿到一句「看到了」）。
 * @param {{docName:string, question:string, pageCount:number, kind:string}} o
 */
export function buildDocVisionPrompt({ docName, question, pageCount = 0, kind = 'pdf' }) {
  const what = kind === 'image' ? '这张图片' : `这份资料的图片页（共 ${pageCount} 页）`;
  return [
    `你是《${docName}》的答疑助手。${what}已作为图片随本条消息提供（原文档没有可提取的文字层，`,
    `属于扫描件或图表型资料），请直接用视觉能力阅读图片内容后回答。`,
    '',
    '要求：',
    '1. 先简要转述与问题相关的关键内容（公式、图表数值、版式结构等），再给出结论；',
    '2. 只依据图片中能看到的内容回答，看不清或图片未覆盖的部分明确说明「图片中无法确认」；',
    '3. 若图片是图表，请读出坐标轴/图例/趋势，而不是只描述「有一张图」。',
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
  const q = String(question || '').trim();
  if (!q) throw new Error('问题不能为空');

  const textRow = await db.docTexts.get(docId);
  const text = String(textRow?.text || '').trim();
  const profile = await docContentProfile(docId);

  // ① 文本层可用且不像扫描件 → 原「限定单文件检索」路径（最准、最省）
  //    suspectedScan 时文本往往只有零散标题，检索片段答不出实质内容，直接走视觉更诚实。
  if (text && !profile.suspectedScan) {
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
    return { answer: String(answer || '').trim(), citations: excerpts, via: 'text' };
  }

  // ② 无文本 / 疑似扫描件 → 视觉路径（这正是「上传了资料却问不出内容」的修复点）
  if (profile.canVision) {
    const vision = await docVisionContent(docId, {
      maxPages: Math.min(Number(opts.maxPages) || DOC_VISION_LIMIT, DOC_VISION_LIMIT),
      renderPdfPagesFn: opts.renderPdfPagesFn, // 测试注入点
    });
    if (vision.length) {
      const prompt = buildDocVisionPrompt({
        docName: row.name, question: q, pageCount: profile.pageCount, kind: profile.kind,
      });
      const answer = await chatAI([{ role: 'user', content: [{ type: 'text', text: prompt }, ...vision] }], {});
      return {
        answer: String(answer || '').trim(),
        citations: [],
        via: 'vision',
        visionPages: vision.length,
        note: profile.suspectedScan
          ? '该资料疑似扫描件（文本层几乎为空），已改用图片视觉分析回答'
          : '该资料无可提取文字层，已改用图片视觉分析回答',
      };
    }
  }

  // ③ 视觉也不可用 → 区分两种情况，绝不静默给一句「没找到」
  //   · 文本型资料（txt/docx/xlsx…）没有文本 = 尚未解析完成 → 保持既有契约直接报错，
  //     UI 对该错误有专门提示（改成引导文案反而丢失「去解析」这个动作指引）；
  //   · 视觉型资料（pdf/图片）没有文本但也不可送图 → 给出可执行的下一步引导。
  if (!text && profile.kind === 'text') {
    throw new Error('该资料尚未解析完成，无法问答');
  }
  const reason = !profile.hasBlob
    ? '原始文件不在本机（未找到文件数据），无法做视觉分析'
    : (profile.kind === 'pdf' || profile.kind === 'image'
      ? '这份资料需要视觉分析，但当前环境无法渲染图片（或渲染失败）'
      : '这份资料没有可提取的文字内容');
  return {
    answer: [
      `${reason}。`,
      profile.kind === 'pdf' || profile.kind === 'image'
        ? '下一步：在「英语中心 → 设置 → 图片分析策略」里选择「先多模态」（需 AI 接口支持视觉模型），或对该资料先执行一次 OCR 生成文字层，然后再来提问。'
        : '下一步：确认文件已解析完成，或换一份可解析的资料。',
    ].join('\n\n'),
    citations: [],
    via: 'blocked',
    profile,
  };
}
