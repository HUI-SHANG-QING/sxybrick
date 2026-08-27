// src/agent/analytics.worker.js
// P0-3：重计算 worker —— 把 O(n²)/全表扫描移出主线程，千卡级不卡 UI
//
// 协议：主线程 postMessage({ id, fn, args }) → worker 回 { id, result } 或 { id, error }
// worker 内 _analyticsWorker 为 null（isMainThread=false），故调用 analytics.js 的 public 函数
// 会直接走 inline `_xxx` 实现，无循环递归、无二次跨线程往返。
import {
  getConfusablePairs,
  getCrossModuleInsight,
  getSubjectDiagnosis,
  getGraphDrivenReviewPlan,
  generateAutoPlan,
  prepareFsrsTrainingData,
} from './analytics.js';
import { trainWeights } from '../fsrs.js';

const handlers = {
  getConfusablePairs,
  getCrossModuleInsight,
  getSubjectDiagnosis,
  getGraphDrivenReviewPlan,
  generateAutoPlan,
  // P1-1：FSRS 权重训练（在 worker 内读训练数据 + 拟合，主线程零阻塞）
  async trainFsrs() {
    const { reviews, cardsById } = await prepareFsrsTrainingData();
    return trainWeights(reviews, cardsById);
  },
};

self.onmessage = async (ev) => {
  const { id, fn, args } = ev.data || {};
  const h = handlers[fn];
  if (!h) {
    self.postMessage({ id, error: `analytics.worker: unknown fn "${fn}"` });
    return;
  }
  try {
    const result = await h(...(Array.isArray(args) ? args : []));
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
