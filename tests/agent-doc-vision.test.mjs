// tests/agent-doc-vision.test.mjs —— Agent 读取资料库文件（含扫描件/图表）并真正"看图"
// 背景（2026-09-13 用户核心诉求续）：Agent 的工具调用走「文本协议」（tool 消息是字符串），
// 无法直接把图片塞进返回值，所以此前 Agent 面对「我上传的扫描 PDF 讲了什么」只能答「查不到」。
// 本测试锁定新链路：
//   read_doc 工具 → 文本里留 sxy-doc://<docId>[#pages] 引用
//     → image-analysis.enrichForLlm（chat() 唯一出口）渲染页面图
//       → 作为多模态附图随消息发送（复用同一套策略与费用护栏）
// 必须最先 import fake-indexeddb/auto，再 import 依赖 db.js 的模块。
import 'fake-indexeddb/auto';
import './_env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { toolRegistry } from '../src/agent/registry.js';
import '../src/agent/tools/index.js'; // 触发内置工具注册
import { extractDocRefs, parsePageSpec, enrichForLlm } from '../src/services/image-analysis.js';

after(async () => { try { await db.close(); } catch { /* ignore */ } });

async function mkDoc({ name, text = '', pageCount = 0, blob = true, type = 'application/pdf' }) {
  const id = `d${Math.random().toString(36).slice(2, 10)}-aaaa-4bbb-8ccc-${Math.random().toString(36).slice(2, 14)}`;
  const now = Date.now();
  await db.docFiles.put({
    id, name, status: 'ready', subject: '测试',
    ...(pageCount ? { pageCount } : {}), createdAt: now, updatedAt: now,
  });
  if (text) await db.docTexts.put({ id, text, textLen: text.length, updatedAt: now });
  if (blob) await db.docBlobs.put({ id, blob: new Blob([new Uint8Array([1, 2, 3])], { type }), size: 3, updatedAt: now });
  return id;
}
async function rmDoc(id) {
  await db.docFiles.delete(id); await db.docTexts.delete(id); await db.docBlobs.delete(id);
}
const stubPages = (n = 3) => async (blob, opts) => Array.from(
  { length: Math.min(opts.maxPages ?? n, n) },
  (_, i) => ({ page: i + 1, dataUrl: `data:image/jpeg;base64,PG${i + 1}` }),
);
const run = (name, args) => toolRegistry.get(name).execute(args, {});

// ---------- 1) 引用协议解析 ----------

test('parsePageSpec / extractDocRefs：解析 "1,3-5" 与 "#2"', () => {
  assert.deepEqual(parsePageSpec('1,3-5'), [1, 3, 4, 5]);
  assert.deepEqual(parsePageSpec(' 2 '), [2]);
  assert.deepEqual(parsePageSpec('abc'), [], '非法输入不产出页码');
  const refs = extractDocRefs('看 sxy-doc://abcdefghij#1,2 和 sxy-doc://klmnopqrst');
  assert.equal(refs.size, 2);
  assert.deepEqual(refs.get('abcdefghij'), [1, 2]);
  assert.deepEqual(refs.get('klmnopqrst'), [], '未指定页码 → 空数组（调用方取默认前 N 页）');
});

// ---------- 2) list_docs 工具 ----------

test('list_docs：列出资料并标注类型/页数/有无文字层', async () => {
  const scanId = await mkDoc({ name: '扫描讲义.pdf', pageCount: 12 });
  const textId = await mkDoc({ name: '笔记.md', text: 'a'.repeat(500) });
  const r = await run('list_docs');
  assert.equal(r.ok, true);
  const scan = r.data.items.find((x) => x.docId === scanId);
  const note = r.data.items.find((x) => x.docId === textId);
  assert.equal(scan.kind, 'pdf');
  assert.equal(scan.pageCount, 12);
  assert.equal(scan.hasTextLayer, false, '扫描件没有文字层');
  assert.equal(note.hasTextLayer, true);
  await rmDoc(scanId); await rmDoc(textId);
});

// ---------- 3) read_doc 工具 ----------

test('read_doc：有文字层 → 直接返回文字摘录（不需要视觉）', async () => {
  const id = await mkDoc({ name: '考点.txt', text: '死锁的四个必要条件：互斥、请求与保持、不可剥夺、循环等待。' });
  const r = await run('read_doc', { docId: id });
  assert.equal(r.ok, true);
  assert.equal(r.data.source, 'text');
  assert.match(r.data.excerpt, /死锁/);
  assert.equal(r.data.visionRef, undefined, '有文字层时不应触发视觉');
  await rmDoc(id);
});

test('read_doc：扫描件（无文字层）→ 返回 sxy-doc 视觉引用', async () => {
  const id = await mkDoc({ name: '高数扫描.pdf', pageCount: 20 });
  const r = await run('read_doc', { docId: id, pages: '3-5' });
  assert.equal(r.ok, true);
  assert.equal(r.data.source, 'vision');
  assert.equal(r.data.visionRef, `sxy-doc://${id}#3-5`);
  assert.match(r.data.note, /多模态|看图/);
  await rmDoc(id);
});

test('read_doc：支持按名称模糊匹配；找不到时列出可用资料', async () => {
  const id = await mkDoc({ name: '线性代数第三章.pdf', pageCount: 8 });
  const hit = await run('read_doc', { name: '线性代数' });
  assert.equal(hit.ok, true);
  assert.equal(hit.data.docId, id);
  const miss = await run('read_doc', { name: '不存在的资料名' });
  assert.equal(miss.ok, false);
  assert.match(miss.error, /线性代数第三章\.pdf/, '失败时要告诉模型有哪些资料可用');
  await rmDoc(id);
});

// ---------- 4) 富集层：sxy-doc 引用 → 真正送图 ----------

test('enrichForLlm：visionFirst 下把资料页面图送进多模态（端到端）', async () => {
  const id = await mkDoc({ name: '扫描实验报告.pdf', pageCount: 10 });
  const res = await run('read_doc', { docId: id });
  // 模拟 ReAct 循环里 tool 消息的真实形态：工具结果被 JSON.stringify 进文本
  const toolMsg = { role: 'tool', content: `工具 read_doc 返回：\n${JSON.stringify(res.data)}` };
  const messages = [{ role: 'user', content: '这份实验报告的数据说明了什么？' }, toolMsg];
  const out = await enrichForLlm(messages, {
    settings: { imageAnalysis: { mode: 'visionFirst' } },
    renderDocPagesFn: stubPages(3),
  });
  assert.equal(out.vision, 3, '应渲染并发送 3 页（护栏）');
  // 附图按 OpenAI 规范挂在 user 消息上（ReAct 循环里最后一条通常是 tool 消息，
  // attachVisionToLastUser 会回溯到最后一条 user）——所以要找「被改造为数组」的那条。
  const withVision = out.messages.find((m) => Array.isArray(m.content));
  assert.ok(withVision, '应有一条消息被改造为多模态数组');
  assert.equal(withVision.role, 'user');
  assert.equal(withVision.content.filter((p) => p.type === 'image_url').length, 3);
  const allText = out.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  assert.ok(!allText.includes('sxy-doc://'), '占位符必须被替换掉，不能原样留给模型');
  assert.match(allText, /已作为附图发送|看图/, '要明确告诉模型图已发送');
  await rmDoc(id);
});

test('enrichForLlm：auto 模式无文字层资料 → 视觉兜底 1 页', async () => {
  const id = await mkDoc({ name: '图表.pdf', pageCount: 6 });
  const messages = [{ role: 'user', content: `看下 sxy-doc://${id}` }];
  const out = await enrichForLlm(messages, {
    settings: { imageAnalysis: { mode: 'auto' } },
    renderDocPagesFn: stubPages(6),
  });
  assert.equal(out.vision, 1, 'auto 的视觉兜底额度是 1 张');
  assert.ok(Array.isArray(out.messages[0].content));
  await rmDoc(id);
});

test('enrichForLlm：ocrFirst 不送图，但要如实说明原因与下一步', async () => {
  const id = await mkDoc({ name: '扫描件.pdf', pageCount: 5 });
  const messages = [{ role: 'user', content: `看下 sxy-doc://${id}` }];
  const out = await enrichForLlm(messages, {
    settings: { imageAnalysis: { mode: 'ocrFirst' } },
    renderDocPagesFn: stubPages(5),
  });
  assert.equal(out.vision, 0, 'ocrFirst 永不主动调视觉');
  const text = out.messages[0].content;
  assert.equal(typeof text, 'string');
  assert.ok(!text.includes('sxy-doc://'), '占位符仍要被替换');
  assert.match(text, /先 OCR/, '要说明是策略限制');
  assert.match(text, /先多模态/, '要给出可执行的下一步');
  await rmDoc(id);
});

test('enrichForLlm：有文字层的资料走文字，不送图（省钱）', async () => {
  const id = await mkDoc({ name: '讲义.pdf', text: 'P'.repeat(2000), pageCount: 4 });
  const messages = [{ role: 'user', content: `看下 sxy-doc://${id}` }];
  const out = await enrichForLlm(messages, {
    settings: { imageAnalysis: { mode: 'visionFirst' } },
    renderDocPagesFn: stubPages(4),
  });
  assert.equal(out.vision, 0, '有文字层就不该花视觉的钱');
  assert.match(out.messages[0].content, /文字摘录/);
  await rmDoc(id);
});

test('enrichForLlm：引用不存在的资料 → 安全降级，不崩不漏占位符', async () => {
  const out = await enrichForLlm(
    [{ role: 'user', content: '看 sxy-doc://nonexistentdoc123#1' }],
    { settings: { imageAnalysis: { mode: 'visionFirst' } }, renderDocPagesFn: stubPages(1) },
  );
  assert.equal(out.vision, 0);
  const text = out.messages[0].content;
  assert.ok(!text.includes('sxy-doc://'));
  assert.match(text, /引用失效|找不到/);
});

test('enrichForLlm：渲染失败 → 明确告知未纳入分析（不静默丢弃）', async () => {
  const id = await mkDoc({ name: '坏文件.pdf', pageCount: 3 });
  const out = await enrichForLlm(
    [{ role: 'user', content: `看 sxy-doc://${id}` }],
    {
      settings: { imageAnalysis: { mode: 'visionFirst' } },
      renderDocPagesFn: async () => { throw new Error('render boom'); },
    },
  );
  assert.equal(out.vision, 0);
  assert.match(out.messages[0].content, /无文字层/);
  await rmDoc(id);
});

// ---------- 5) 视觉降级：模型不支持视觉时不报错，剥离附图重试一次 ----------
// 现实坑：用户可能一直用纯文本模型（默认配置就是），此时我们发了图 → 服务端 400/422。
// 若直接抛错，用户只看到「AI 请求失败」；正确做法是剥离附图重试，并把「为什么没分析图片」
// 通过给模型的系统提示转述给用户。
test('llm.chat：模型不支持视觉（400）→ 剥离附图重试一次并说明原因', async () => {
  const { chat } = await import('../src/agent/llm.js');
  const { saveWordSettings } = await import('../src/word-repo.js');
  const imgId = crypto.randomUUID();
  await db.images.put({ id: imgId, blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), size: 3, updatedAt: Date.now() });
  await saveWordSettings({ imageAnalysis: { mode: 'visionFirst' } });

  const bodies = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (bodies.length === 1) {
      return { ok: false, status: 400, text: async () => 'image_url is not supported by this model' };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: '已省略图片' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  };
  try {
    const out = await chat(
      [{ role: 'user', content: `看图 ![x](sxy-img://${imgId})` }],
      { apiKey: 'sk-test', baseUrl: 'https://example.invalid', model: 'text-only' },
    );
    assert.equal(out, '已省略图片', '应返回重试后的正常回答，而不是抛错');
    assert.equal(bodies.length, 2, '应发生一次重试');
    // 首次带图
    const first = bodies[0].messages[bodies[0].messages.length - 1];
    assert.ok(Array.isArray(first.content), '首次请求应带视觉内容');
    assert.ok(first.content.some((p) => p.type === 'image_url'));
    // 重试不带图，但把「为什么」写进文本
    const second = bodies[1].messages[bodies[1].messages.length - 1];
    assert.equal(typeof second.content, 'string', '重试必须是纯文本');
    assert.ok(!second.content.includes('image_url'));
    assert.match(second.content, /不支持视觉/, '要说明图片未分析的原因');
    assert.match(second.content, /图片分析策略/, '要给出可执行的下一步');
  } finally {
    globalThis.fetch = origFetch;
    await saveWordSettings({ imageAnalysis: { mode: 'auto' } });
    await db.images.delete(imgId);
    await db.aiUsage.clear();
  }
});
