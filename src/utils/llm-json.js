// src/utils/llm-json.js
// 统一的「LLM 输出 → JSON 数组」解析器。
//
// 背景：ai 文档转卡片 / 生成式测验 / 智能组卡 / 情境变式等模块，此前都是
//   const m = String(r).match(/\[[\s\S]*\]/); JSON.parse(m ? m[0] : r)
// 当 LLM 返回空串（content === ''）或截断 / 带污染输出时，JSON.parse('')
// 抛出晦涩的 "Unexpected end of JSON input"，用户看到的报错不知所云。
// 本模块统一收口：空输出 / 非法格式 / 非 JSON 数组 → 抛出可读的 i18n 文案，
// 并做三级容错（代码块剥离 → 括号截取 → 尾逗号修复），尽最大可能解析成功。
import { t } from '../i18n/index.js';

/** 单次尝试：剥 ```json 代码块围栏后 JSON.parse */
function tryParse(s) {
  if (typeof s !== 'string') return null;
  const cand = s.trim();
  if (!cand) return null;
  const fence = cand.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fence ? fence[1] : cand).trim();
  try { return JSON.parse(body); } catch { /* fallthrough */ }
  // 常见 LLM 格式病：尾逗号（[1, 2,] / {"a":1,}）
  try { return JSON.parse(body.replace(/,\s*([\]}])/g, '$1')); } catch { /* fallthrough */ }
  return null;
}

/**
 * 从 LLM 原始输出中解析出 JSON 数组。
 * @param {any} raw LLM 返回（string，可能为 ''/null/undefined）
 * @returns {Array} 解析出的数组（可能为空数组，但一定是数组）
 * @throws {Error} 空输出 / 无法解析 / 不是数组时，抛出可读的 i18n 错误信息
 */
export function parseLLMJsonArray(raw) {
  const s = typeof raw === 'string' ? raw.trim() : (raw == null ? '' : String(raw));
  if (!s) throw new Error(t('utils.llmJson.emptyReply'));

  let v = tryParse(s);
  if (v == null) {
    // 输出前后可能带说明文字，截取第一个 [ 到最后一个 ]
    const m = s.match(/\[[\s\S]*\]/);
    if (m) v = tryParse(m[0]);
  }
  if (v == null) throw new Error(t('utils.llmJson.badFormat'));
  if (!Array.isArray(v)) throw new Error(t('utils.llmJson.notArray'));
  return v;
}
