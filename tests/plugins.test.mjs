// tests/plugins.test.mjs —— 插件系统纯函数层测试
// 覆盖：manifest 校验、模块导出校验、Agent 桥接（schema→参数/工具描述/
// Agent 归一/钩子映射/冲突检测）、插件包序列化与解析。
// 注：installPlugin 的 Blob URL 动态 import 依赖浏览器 API（Node 不支持
// URL.createObjectURL 的动态 import），因此 IO 编排不在本文件测试。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { db } from '../src/db.js';
after(async () => { try { await db.close(); } catch {} });

import { validateManifest, validateModuleExports } from '../src/plugins/manifest.js';
import {
  inputSchemaToParams, describePluginTool, buildToolSpec,
  parseAgentDefs, collectHookHandlers, findConflicts, pluginActivationSummary,
} from '../src/plugins/agent-bridge.js';
import {
  serializePluginPackage, parsePluginPackage,
  PLUGIN_PACKAGE_FORMAT, PLUGIN_PACKAGE_VERSION,
} from '../src/plugins/package.js';

const validManifest = () => ({
  name: 'word-count',
  version: '1.0.0',
  description: '统计字数',
  author: 'sxybrick',
  tools: [
    { name: 'count', description: '统计字数', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  ],
  hooks: { onCardSaved: 'onCardSaved' },
});

// ---------- validateManifest ----------
test('validateManifest：合法 manifest 通过', () => {
  const r = validateManifest(validManifest());
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('validateManifest：缺失/非法字段被拒绝', () => {
  const cases = [
    [null, /manifest 必须是对象/],
    [{}, /name 必须/],
    [{ name: 'Bad_Name!', version: '1.0.0' }, /name 必须/],
    [{ name: 'ok', version: 123 }, /version 必须/],
    [{ name: 'ok', version: '1.0.0', description: 'x'.repeat(201) }, /description 必须/],
    [{ name: 'ok', version: '1.0.0', tools: 'nope' }, /tools 必须为数组/],
    [{ name: 'ok', version: '1.0.0', tools: [{}] }, /tools\[0\].name/],
    [{ name: 'ok', version: '1.0.0', tools: [{ name: 'a' }, { name: 'a' }] }, /tools\[1\].name 重复/],
    [{ name: 'ok', version: '1.0.0', tools: [{ name: 'a', inputSchema: 'x' }] }, /inputSchema 必须为对象/],
    [{ name: 'ok', version: '1.0.0', hooks: 'x' }, /hooks 必须为对象/],
  ];
  for (const [m, re] of cases) {
    const r = validateManifest(m);
    assert.equal(r.ok, false, `应拒绝：${JSON.stringify(m)}`);
    assert.ok(re.test(r.errors.join('；')), `错误信息应匹配 ${re}：${r.errors.join('；')}`);
  }
});

// ---------- validateModuleExports ----------
test('validateModuleExports：缺 manifest / 缺工具函数 / hooks 指向未导出', () => {
  const m = validManifest();
  assert.equal(validateModuleExports({}, m).ok, false, '无 manifest 应失败');
  assert.equal(validateModuleExports({ manifest: m }, m).ok, false, '缺工具函数应失败');
  assert.equal(
    validateModuleExports({ manifest: m, count: async () => {} }, m).ok,
    false,
    'hooks 指向未导出函数应失败',
  );
  assert.equal(
    validateModuleExports({ manifest: m, count: async () => {}, onCardSaved: () => {} }, m).ok,
    true,
    '全部导出齐全应通过',
  );
});

// ---------- inputSchemaToParams ----------
test('inputSchemaToParams：JSON Schema → 人类可读参数', () => {
  const params = inputSchemaToParams({
    type: 'object',
    properties: {
      text: { type: 'string', description: '要统计的文本' },
      n: { type: 'number' },
      opt: { type: 'boolean' },
    },
    required: ['text'],
  });
  assert.equal(params.text, 'string（必填）: 要统计的文本');
  assert.equal(params.n, 'number');
  assert.equal(params.opt, 'boolean');
  assert.deepEqual(inputSchemaToParams(undefined), {});
  assert.deepEqual(inputSchemaToParams({}), {});
});

// ---------- describePluginTool / buildToolSpec ----------
test('describePluginTool：生成带来源标记的工具描述', () => {
  const tool = describePluginTool('word-count', validManifest().tools[0]);
  assert.equal(tool.name, 'count');
  assert.ok(tool.description.includes('[插件 word-count]'));
  assert.deepEqual(tool.parameters, { text: 'string（必填）' });
  assert.equal(tool.plugin, 'word-count');
  assert.equal(tool.writesData, true, '插件工具按最保守口径标记可写');
});

test('buildToolSpec：execute 桥接到注入的调用函数', async () => {
  const calls = [];
  const spec = buildToolSpec('p1', { name: 'f', description: 'd' }, async (args) => {
    calls.push(args);
    return { ok: true };
  });
  const r = await spec.execute({ x: 1 });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls, [{ x: 1 }]);
});

// ---------- parseAgentDefs ----------
test('parseAgentDefs：支持数组/单对象/agentManifest 三种形态', () => {
  const arr = [{ id: 'a1', name: 'A1', systemPrompt: 'p', tools: ['t1'] }];
  assert.equal(parseAgentDefs({ agents: arr }).length, 1);
  assert.equal(parseAgentDefs({ agentManifest: arr[0] }).length, 1);
  assert.equal(parseAgentDefs({ agents: arr[0] }).length, 1);
  assert.deepEqual(parseAgentDefs({}), []);
  assert.deepEqual(parseAgentDefs(null), []);
});

test('parseAgentDefs：过滤非法项并保留 plugin 来源', () => {
  const out = parseAgentDefs({
    agents: [
      { id: 'ok', name: 'OK', useReAct: false },
      { id: 'bad-no-name' },
      null,
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'ok');
  assert.equal(out[0].useReAct, false);
  assert.equal(out[0].plugin, null);
});

// ---------- collectHookHandlers ----------
test('collectHookHandlers：只收集声明了该事件的插件', () => {
  const rows = [
    { id: 'a', hooks: { onCardSaved: 'onCardSaved' } },
    { id: 'b', hooks: { onReviewRated: 'h' } },
    { id: 'c', hooks: {} },
  ];
  const hit = collectHookHandlers(rows, 'onCardSaved');
  assert.equal(hit.length, 1);
  assert.deepEqual(hit[0], { pluginId: 'a', fnName: 'onCardSaved' });
  assert.deepEqual(collectHookHandlers(rows, 'onSyncCompleted'), []);
  assert.deepEqual(collectHookHandlers([], 'onCardSaved'), []);
});

// ---------- findConflicts ----------
test('findConflicts：检测工具/Agent 与现有注册表重名', () => {
  const current = { toolNames: new Set(['count', 'inner']), agentIds: new Set(['a1']) };
  const tools = [{ name: 'count' }, { name: 'new' }];
  const agents = [{ id: 'a1' }, { id: 'b2' }];
  const c = findConflicts(tools, agents, current);
  assert.deepEqual(c.tools, ['count']);
  assert.deepEqual(c.agents, ['a1']);
  assert.deepEqual(findConflicts([], [], current), { tools: [], agents: [] });
});

// ---------- pluginActivationSummary ----------
test('pluginActivationSummary：汇总注册清单', () => {
  const row = { id: 'p1', tools: [{ name: 't1' }, { name: 't2' }] };
  const mod = { agents: [{ id: 'p1-agent', name: 'P1 Agent' }] };
  const s = pluginActivationSummary(row, mod);
  assert.deepEqual(s.tools, ['t1', 't2']);
  assert.deepEqual(s.agents, ['p1-agent']);
  assert.deepEqual(pluginActivationSummary(row, null).agents, []);
});

// ---------- 插件包 ----------
test('serializePluginPackage：db 行 → 包对象', () => {
  const row = {
    id: 'p1', version: '2.0.0', description: 'd', author: 'a',
    tools: [{ name: 't' }], hooks: { onCardSaved: 'h' }, code: 'export const manifest={};',
  };
  const pkg = serializePluginPackage(row);
  assert.equal(pkg.format, PLUGIN_PACKAGE_FORMAT);
  assert.equal(pkg.version, PLUGIN_PACKAGE_VERSION);
  assert.equal(pkg.manifest.name, 'p1');
  assert.equal(pkg.manifest.author, 'a');
  assert.equal(pkg.code, row.code);
});

test('parsePluginPackage：合法包解析通过（往返一致）', () => {
  const row = {
    id: 'word-count', version: '1.0.0', description: 'd', author: 'sxybrick',
    tools: [{ name: 'count' }], hooks: {}, code: 'export const manifest={};',
  };
  const pkg = serializePluginPackage(row);
  const r = parsePluginPackage(JSON.stringify(pkg));
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(r.pkg.manifest.name, 'word-count');
  assert.equal(r.pkg.code, pkg.code);
});

test('parsePluginPackage：非法输入被拒绝', () => {
  const row = {
    id: 'p1', version: '1.0.0', description: '', author: '',
    tools: [], hooks: {}, code: 'x',
  };
  const good = JSON.stringify(serializePluginPackage(row));
  const cases = [
    ['not json', /不是合法 JSON/],
    [JSON.stringify({ ...serializePluginPackage(row), format: 'other' }), /不支持的包格式/],
    [JSON.stringify({ ...serializePluginPackage(row), version: 99 }), /不支持的包版本/],
    [JSON.stringify({ ...serializePluginPackage(row), code: '' }), /缺少插件代码/],
    [JSON.stringify({ ...serializePluginPackage(row), manifest: { ...serializePluginPackage(row).manifest, name: 'BAD!' } }), /name 必须/],
    ['{}', /不支持的包格式/],
  ];
  for (const [text, re] of cases) {
    const r = parsePluginPackage(text);
    assert.equal(r.ok, false, `应拒绝：${text.slice(0, 60)}`);
    assert.ok(re.test(r.errors.join('；')), `错误应匹配 ${re}：${r.errors.join('；')}`);
  }
  const goodR = parsePluginPackage(good);
  assert.equal(goodR.ok, true);
});
