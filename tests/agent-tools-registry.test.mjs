// tests/agent-tools-registry.test.mjs —— 工具注册表完整性（防同名静默覆盖）
// 背景（2026-09-14 审计 P1）：内置工具 `list_docs` 被新加的「列资料库文件」工具同名覆盖，
// 「列出全部 AI 文档」这个能力对 Agent 静默消失——注册表是 Map，后注册者赢，不报错、不告警。
// 本测试用「源码注册次数 == 运行时唯一工具数」把这类事故钉死在提交前。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toolRegistry } from '../src/agent/registry.js';
import '../src/agent/tools/index.js'; // 触发内置工具注册
import { db } from '../src/db.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

const TOOLS_SRC = fileURLToPath(new URL('../src/agent/tools/index.js', import.meta.url));
const src = readFileSync(TOOLS_SRC, 'utf8');

test('内置工具：源码注册次数 == 运行时唯一工具数（任何同名覆盖都会失败）', () => {
  const calls = [...src.matchAll(/^toolRegistry\.register\(\{/gm)].length;
  const unique = toolRegistry.list().length;
  assert.ok(calls > 40, `源码里只找到 ${calls} 个注册调用，正则或文件结构可能变了`);
  assert.equal(
    calls, unique,
    `注册调用 ${calls} 次但注册表只有 ${unique} 个工具 → 有 ${calls - unique} 个同名工具被静默覆盖。`
    + '请给新工具换个名字（撞名不会报错，只会让旧功能凭空消失）',
  );
});

test('资料库工具与 AI 文档工具各归各位（list_docs 不得被顶掉）', () => {
  const listDocs = toolRegistry.get('list_docs');
  assert.ok(listDocs, 'list_docs（列 AI 文档）必须存在');
  assert.match(listDocs.description, /AI 文档/, 'list_docs 应仍是「列 AI 文档」');

  const listLib = toolRegistry.get('list_lib_docs');
  assert.ok(listLib, 'list_lib_docs（列资料库文件）必须存在');
  assert.match(listLib.description, /资料库/, 'list_lib_docs 应是「列资料库文件」');

  const readLib = toolRegistry.get('read_lib_doc');
  assert.ok(readLib, 'read_lib_doc（读资料内容，扫描件带视觉引用）必须存在');
  assert.match(readLib.description, /扫描件|视觉/, 'read_lib_doc 描述应说明扫描件可看图');
});

test('注册表：同名注册会告警（不静默）', () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    const ghost = `__dup_probe_${Date.now()}`;
    toolRegistry.register({ name: ghost, description: 'x', parameters: {}, async execute() { return { ok: true }; } });
    toolRegistry.register({ name: ghost, description: 'y', parameters: {}, async execute() { return { ok: true }; } });
  } finally {
    console.warn = orig;
  }
  assert.ok(warns.some((w) => /工具名重复/.test(w)), '第二次注册同名工具必须有告警');
});
