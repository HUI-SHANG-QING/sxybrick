// tests/fsrs-benchmark.test.mjs —— FSRS 调度器质量评测基准（回归门槛）
// 与「正确性单测」不同，这里测「质量」：校准自洽性 + 训练器收敛性 + 确定性。
// 阈值取当前实测值（ECE≈0.06、改善≈0.10）留足余量，只在真正回归时才失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runBenchmark, generateSyntheticReviews, lcg } from '../src/algorithms/fsrs-benchmark.js';

test('合成数据确定性：同种子两次生成完全一致（可复现）', () => {
  const a = generateSyntheticReviews({ seed: 42 });
  const b = generateSyntheticReviews({ seed: 42 });
  assert.deepEqual(a.reviews, b.reviews);
  assert.equal(a.cardsById.size, b.cardsById.size);
});

test('lcg：确定性 + 不同种子序列不同', () => {
  const a = lcg(1); const b = lcg(1); const c = lcg(2);
  assert.equal(a(), b());
  assert.notEqual(a(), c());
});

test('校准质量：自洽数据 ECE < 0.12、偏差 |bias| < 0.1', () => {
  const b = runBenchmark({ seed: 42 });
  assert.ok(b.calibration.n > 0, '应有可回测样本');
  assert.ok(b.calibration.ece < 0.12, `ECE 过高：${b.calibration.ece}`);
  assert.ok(Math.abs(b.calibration.bias) < 0.1, `校准偏差过大：${b.calibration.bias}`);
});

test('训练改善：扰动权重训练后 loss 显著下降（> 0.05）', () => {
  const b = runBenchmark({ seed: 42 });
  assert.ok(b.training.samples > 0, '应有训练样本');
  assert.ok(b.training.improvement > 0.05, `训练改善不足：${b.training.improvement}`);
  assert.ok(b.training.afterLoss < b.training.beforeLoss, '训练后 loss 应低于扰动初始 loss');
});

test('多种子稳健：不同数据下校准与改善均达标', () => {
  for (const seed of [7, 2024]) {
    const b = runBenchmark({ seed });
    assert.ok(b.calibration.ece < 0.12, `seed=${seed} ECE 过高：${b.calibration.ece}`);
    assert.ok(b.training.improvement > 0.05, `seed=${seed} 改善不足：${b.training.improvement}`);
  }
});
