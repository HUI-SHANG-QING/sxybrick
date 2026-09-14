// round48 回归测试：
//   P1-1 AI 错误分类（401/429/取消 不得被当成"网络不可达"）
//   P3-6 合并入口时间戳净化（字符串/NaN 不得污染 updatedAt）
//   P3-5 墓碑时钟上界（未来时间戳不得"一刀切"删本地数据）
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isNetworkError } from '../src/utils/offlineAI.js';
import { numTs, applyTombstones, mergeCardPair } from '../src/sync-manifest.js';

// ---------- P1-1 ----------
test('isNetworkError：带 HTTP 状态码的错误一律不算网络错误（真因必须照实透出）', () => {
  const mk = (status, msg) => Object.assign(new Error(msg), { status });
  // 历史缺陷原始形态：llm.js 抛的就是这句话，旧正则含 "AI 请求失败" → 被误判成断网，
  // 界面统一显示「网络连接失败」，把"密钥无效/限流"的真因掩盖。
  assert.equal(isNetworkError(mk(401, 'AI 请求失败(401：API 密钥无效或已过期)：{"error":"invalid api key"}')), false);
  assert.equal(isNetworkError(mk(429, 'AI 请求失败(429：请求过于频繁，稍后重试)：…')), false);
  assert.equal(isNetworkError(mk(403, 'AI 请求失败(403：无权限访问该模型)：…')), false);
  assert.equal(isNetworkError(mk(500, 'AI 请求失败(500：服务暂时不可用（稍后重试）)')), false);
  // 用户取消 / 超时中断
  const ab = new Error('AI 请求已取消'); ab.name = 'AbortError';
  assert.equal(isNetworkError(ab), false);
  const to = new Error('AI 请求超时（>60s 未响应）'); to.aborted = true;
  assert.equal(isNetworkError(to), false);
});

test('isNetworkError：只有真·连不上/断网才降级', () => {
  assert.equal(isNetworkError(new TypeError('Failed to fetch')), true);
  assert.equal(isNetworkError(new Error('getaddrinfo ENOTFOUND api.deepseek.com')), true);
  assert.equal(isNetworkError(new Error('fetch failed')), true);
  assert.equal(isNetworkError(null), false);
  assert.equal(isNetworkError(new Error('随便一个业务错误')), false);
});

// ---------- P3-6 ----------
test('numTs：只认有限数值（含可解析字符串），其余归 0', () => {
  assert.equal(numTs(1234), 1234);
  assert.equal(numTs('1700000000000'), 1700000000000);
  assert.equal(numTs('2026-09-14'), 0, 'ISO 串不可解析为数值 → 0（不得变成 NaN）');
  assert.equal(numTs(NaN), 0);
  assert.equal(numTs(undefined), 0);
  assert.equal(numTs(null), 0);
  assert.equal(numTs(Infinity), 0);
});

test('mergeCardPair：updatedAt 为字符串时结果仍是有限数值（否则该行永不重传）', () => {
  const m = mergeCardPair(
    { id: 'c1', front: 'A', updatedAt: '1700000000000' },
    { id: 'c1', front: 'B', updatedAt: '1700000000001' },
  );
  assert.ok(Number.isFinite(m.updatedAt), 'updatedAt 必须是有限数值（NaN 会让增量导出恒假）');
  assert.equal(m.updatedAt, 1700000000001);
});

// ---------- P3-5 ----------
test('applyTombstones：墓碑时间戳远超本机时钟 → 忽略（保守不删本地数据）', () => {
  const now = 1_700_000_000_000;
  const rows = [{ id: 'c1', updatedAt: now - 1000, front: 'Q', back: 'A' }];
  const future = [{ id: 'c1', kind: 'card', deletedAt: now + 365 * 86400000 }];
  const r = applyTombstones(rows, future, 'card', now);
  assert.equal(r.rows.length, 1, '未来墓碑被忽略，本地行保留');
  assert.equal(r.removed.length, 0);

  const normal = [{ id: 'c1', kind: 'card', deletedAt: now - 1 }];
  const r2 = applyTombstones(rows, normal, 'card', now);
  assert.equal(r2.rows.length, 0, '正常墓碑照常删除');
  assert.equal(r2.removed.length, 1);
});
