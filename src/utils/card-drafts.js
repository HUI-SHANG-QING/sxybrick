// 资料 → 卡片草稿生成（纯函数，Node 可测）
// ⚠️ 用户选择制：默认绝不自动建卡；用户主动点「生成卡片」才生成草稿；
//    草稿必须先预览，用户确认后才入库——可逐卡编辑 / 删除 / 整体取消。

/**
 * 真题 QA 分卡：题号开头（1. 1、 1） (1) 等）→ 题干；「答案/解析」标记 → 背面。
 * 题干多行/选项行并入正面；答案标记后的内容并入背面。
 * @param {string} text
 * @returns {Array<{front:string, back:string, note:string}>}
 */
export function splitQA(text) {
  const lines = String(text ?? '').split('\n');
  const cards = [];
  let cur = null; // { front: string[], back: string[] }
  let inBack = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // 题号开头：1. 1、 1） (1) 一、 等
    const qm = line.match(/^\s*(?:[（(]?(\d{1,3})[)）.、．]|([一二三四五六七八九十]{1,3})[、．.])\s*(.+)$/);
    // 答案/解析标记（行首）
    const am = line.match(/^[【\[]?(?:参考答案?|答案解析?|解析|解答|详解|答)[】\]]?[:：]?\s*(.*)$/);
    if (qm && !inBack) {
      if (cur) cards.push(finishQACard(cur));
      cur = { front: [line], back: [] };
      inBack = false;
    } else if (qm && inBack && cur) {
      // 背面的题干后紧跟下一题：结算当前卡，开新卡
      cards.push(finishQACard(cur));
      cur = { front: [line], back: [] };
      inBack = false;
    } else if (am && cur) {
      inBack = true;
      if (am[1]) cur.back.push(line); // 答案/解析标记自带内容
    } else if (cur) {
      if (inBack) cur.back.push(line);
      else cur.front.push(line);
    }
    // 无当前卡且非题号：跳过（前言/页眉等噪声）
  }
  if (cur) cards.push(finishQACard(cur));
  return cards.filter((c) => c.front && c.back);
}

function finishQACard(cur) {
  return {
    front: cur.front.join('\n').trim(),
    back: cur.back.join('\n').trim(),
    note: '真题/题目',
  };
}

/**
 * 段落要点分卡：讲义/教材（无题号）按空行分段，每段一张卡。
 * front = 段首句截断，back = 整段。
 * @param {string} text
 * @param {object} opts { minLen=24, maxLen=900 }
 */
export function paragraphCards(text, opts = {}) {
  const minLen = opts.minLen ?? 24;
  const maxLen = opts.maxLen ?? 900;
  const paras = String(text ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length >= minLen && p.length <= maxLen);
  return paras.map((p) => {
    const firstLine = p.split('\n')[0].trim();
    const front = firstLine.length > 64 ? firstLine.slice(0, 61) + '…' : firstLine;
    return { front, back: p, note: '讲义段落' };
  });
}

/**
 * 主入口：真题 QA 命中 ≥ minQA 用 QA 分卡，否则回退段落要点。
 * @param {string} text
 * @param {object} opts { minQA=2, ...paragraphCards opts }
 */
export function textToCardDrafts(text, opts = {}) {
  const qa = splitQA(text);
  if (qa.length >= (opts.minQA ?? 2)) return qa;
  return paragraphCards(text, opts);
}

/** 草稿 → createCard payload（补 subject/source 血缘；note 仅 UI 展示不入卡） */
export function draftToCardPayload(draft, opts = {}) {
  return {
    front: String(draft?.front || '').trim(),
    back: String(draft?.back || '').trim(),
    subject: String(opts.subject || '未分类').trim(),
    source: String(opts.source || '').trim(), // 血缘：docFiles.id（资料 → 卡片可反查）
    type: 'basic',
    marked: 0,
    mnemonic: '',
  };
}

/** 校验草稿是否可入库（front/back 非空） */
export function validateDraft(draft) {
  if (!draft || !String(draft.front || '').trim()) return '正面不能为空';
  if (!draft || !String(draft.back || '').trim()) return '背面不能为空';
  return null;
}
