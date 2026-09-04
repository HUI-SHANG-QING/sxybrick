// 回归测试：parseLLMJsonArray 统一解析 LLM 输出。
// 历史坑（经验：用户反馈 "Unexpected end of JSON input"）：各生成模块此前
//   JSON.parse(m ? m[0] : r) —— LLM 返回空串时 JSON.parse('') 抛晦涩异常；
//   本模块把「空输出 / 非 JSON / 非数组」转成可读 i18n 报错，并修复尾逗号/代码块/杂文。
// 仅依赖 i18n t()，Node 下可直接 import。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLLMJsonArray } from '../src/utils/llm-json.js';

const hasAIWord = (msg) => typeof msg === 'string' && /AI/.test(msg);

test('合法纯 JSON 数组 → 原样解析', () => {
  const arr = parseLLMJsonArray('[{"front":"a","back":"b"},{"front":"c","back":"d"}]');
  assert.equal(arr.length, 2);
  assert.equal(arr[0].front, 'a');
});

test('```json 代码块围栏 → 剥离后解析', () => {
  const arr = parseLLMJsonArray('```json\n[{"front":"x","back":"y"}]\n```');
  assert.equal(arr.length, 1);
  assert.equal(arr[0].back, 'y');
});

test('前后带说明文字的杂文 → 截取数组段解析', () => {
  const raw = '好的，为你生成以下卡片：\n[{"front":"q1","back":"a1"}] \n希望有帮助！';
  const arr = parseLLMJsonArray(raw);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].front, 'q1');
});

test('尾逗号格式病 → 修复后解析', () => {
  const arr = parseLLMJsonArray('[{"front":"a","back":"b",}, {"front":"c","back":"d"},]');
  assert.equal(arr.length, 2);
});

test('空字符串 / null / undefined → 抛可读报错（不再是 Unexpected end of JSON input）', () => {
  for (const bad of ['', '   ', null, undefined]) {
    assert.throws(() => parseLLMJsonArray(bad), (e) => hasAIWord(e.message), `输入 ${JSON.stringify(bad)} 应抛含 AI 提示的错误`);
  }
});

test('非 JSON 文本 → 抛可读报错', () => {
  assert.throws(() => parseLLMJsonArray('抱歉，我无法生成卡片。'), (e) => hasAIWord(e.message));
});

test('JSON 对象（非数组）→ 抛 notArray 报错', () => {
  assert.throws(() => parseLLMJsonArray('{"front":"a","back":"b"}'), (e) => hasAIWord(e.message));
});

test('数组内可含中文内容，原样保留', () => {
  const arr = parseLLMJsonArray('[{"front":"什么是进程？","back":"运行中的程序","tags":["操作系统"]}]');
  assert.equal(arr[0].front, '什么是进程？');
  assert.deepEqual(arr[0].tags, ['操作系统']);
});
