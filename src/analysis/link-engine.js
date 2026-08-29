// src/analysis/link-engine.js
// M2 联动分析统一入口：cards + 用户问题/预设指令 → 结构化结果。
// 模式策略：
//  - preset（快捷按钮）：默认本地模式（离线即时）；用户显式选 AI 时走 AI。
//  - question（自由问答）：有 AI 密钥 → AI 模式，失败（超时/网络/解析）自动降级本地（启发式路由问题→本地分析）；
//    无密钥 → 直接本地模式。
// 返回 { type, data, note?, engine: 'local'|'ai'|'fallback' }
// 本地降级路由：按问题关键词匹配最接近的预设分析（关系/依赖/顺序/共同点/对比/默认问答）。

import { runPreset } from './local-analyzer.js';
import { analyzeWithAI } from './ai-analyzer.js';

/** 问题 → 预设 的启发式路由（降级用） */
function routeQuestion(q) {
  const s = String(q || '');
  if (/对比|异同|区别|不同|比较/.test(s)) return 'compare';
  if (/图谱|关系图|关系|联系|关联|网络|graph/i.test(s)) return 'graph';
  if (/前置|依赖|拓扑|先学什么|先背|顺序排/.test(s)) return 'topo';
  if (/关键|核心|重点|最优先|必背/.test(s)) return 'critical';
  if (/共同|共点|交集|都涉及|共同知识/.test(s)) return 'common';
  if (/学习顺序|路径|计划|安排|复习顺序|怎么学|先复习|考试/.test(s)) return 'path';
  return 'path'; // 默认给一个可执行的学习顺序（比纯文本更有用）
}

/** 本地自由问答：先路由到预设分析，再补一段说明，保证「有结构化结果 + 可读解释」 */
function localAnswer(cards, question) {
  const preset = routeQuestion(question);
  const r = runPreset(preset, cards);
  const intro = `本地模式（离线启发式）已按「${presetLabel(preset)}」分析 ${cards.length} 张卡片。配置 AI 密钥后可获得更深入的语义分析。`;
  if (r.type === 'text') return { ...r, note: `${intro}\n${r.note || ''}`.trim() };
  return { ...r, note: `${intro}\n${r.note || ''}`.trim() };
}

function presetLabel(p) {
  return { graph: '关系图谱', topo: '前置依赖/拓扑', critical: '关键路径', common: '共同知识点', path: '学习顺序', compare: '卡片对比' }[p] || p;
}

/**
 * 统一分析入口。
 * @param {Array} cards 卡片行（含 front/back/subject/tags/ease/failCount/id）
 * @param {object} req { preset?: 'graph'|'topo'|'critical'|'common'|'path'|'compare',
 *                       question?: string, mode?: 'local'|'ai'（用户选择，缺省自动） }
 * @param {object} cfg AI 配置 { baseUrl, apiKey, model }（无密钥自动走本地）
 * @param {object} opts { timeoutMs, signal, history }
 * @returns {Promise<{type,data,note?,engine}>}
 */
export async function runAnalysis(cards, req = {}, cfg, opts = {}) {
  if (!cards || !cards.length) {
    return { type: 'text', data: { text: '请先选择至少一张卡片。' }, engine: 'local' };
  }
  const wantAI = req.mode === 'ai' || (req.mode !== 'local' && req.question && !!cfg?.apiKey);

  // 快捷预设：本地优先（即时、离线可用）；显式 AI 模式走 LLM
  if (req.preset) {
    if (wantAI) {
      try {
        const presetQ = {
          graph: '请生成这些卡片的关系图谱（节点=卡片，边=知识点关联，注明关系类型）。',
          topo: '请推断这些卡片的前置依赖关系，并按拓扑顺序输出学习链。',
          critical: '请找出这些卡片中的关键路径：哪些是必须优先掌握的核心卡片？说明理由。',
          common: '请找出这些卡片共同涉及的核心知识点，按重要性排序。',
          path: '请给出这些卡片的最短学习路径（学习顺序），并说明每一步的理由。',
          compare: '请对比前两张卡片的异同。',
        }[req.preset] || '请分析这些卡片。';
        const ai = await analyzeWithAI(cards, presetQ, cfg, { ...opts, history: req.history });
        return ai;
      } catch (e) {
        // AI 失败 → 降级本地，保住可用性
        const local = runPreset(req.preset, cards);
        return { ...local, engine: 'fallback', note: `AI 模式失败（${e.message || '未知错误'}），已降级本地模式。\n${local.note || ''}`.trim() };
      }
    }
    return runPreset(req.preset, cards);
  }

  // 自由问答
  if (wantAI) {
    try {
      return await analyzeWithAI(cards, req.question, cfg, opts);
    } catch (e) {
      const local = localAnswer(cards, req.question);
      return { ...local, engine: 'fallback', note: `AI 模式失败（${e.message || '未知错误'}），已降级本地模式。\n${local.note || ''}`.trim() };
    }
  }
  return localAnswer(cards, req.question || '请分析这些卡片。');
}
