// scripts/benchmark.mjs —— FSRS 调度器评测基准（跨版本对比）
// 运行：node scripts/benchmark.mjs
// 输出：指标 JSON（stdout），可重定向到文件做历史对比，也便于 CI 门槛采集。
// 三个种子取平均，消除单数据集的偶然性。
import { runBenchmark } from '../src/algorithms/fsrs-benchmark.js';

const SEEDS = [42, 7, 2024];
const runs = SEEDS.map(seed => runBenchmark({ nCards: 40, reviewsPerCard: 10, seed }));

const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
const round4 = v => Number(v.toFixed(4));

const summary = {
  generatedAt: new Date().toISOString(),
  // 汇总指标（三种子平均）
  avgEce: round4(avg(runs.map(r => r.calibration.ece))),                 // 校准误差，越低越好
  avgBrier: round4(avg(runs.map(r => r.calibration.brier))),             // Brier 分数，越低越好
  avgBias: round4(avg(runs.map(r => r.calibration.bias))),               // 校准偏差，越接近 0 越好
  avgTrainingImprovement: round4(avg(runs.map(r => r.training.improvement))), // 训练改善，越高越好
  // 明细
  runs: runs.map(r => ({
    seed: r.synthetic.seed,
    synthetic: r.synthetic,
    calibration: r.calibration,
    trainingImprovement: round4(r.training.improvement),
  })),
};

console.log(JSON.stringify(summary, null, 2));
