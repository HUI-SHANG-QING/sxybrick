// tests/round117-node-preview.test.mjs —— round117：图谱 / 导图点节点改为**只读预览**
//
// 需求：这两个模块点击节点，原先一律 `router.push('/cards?id=…')` —— 那是卡片管理页的
//   **编辑态**，用户只想看一眼这张卡写了什么，却被带进编辑器。
//   现在改为弹出只读预览（呈现方式与「卡片分组」页展开后的预览一致）。
//
// .vue 无法在 node --test 里挂载，按本项目既有做法用**源码形态闸门**兜底，
// 防止后续改动把这两个入口悄悄改回"跳编辑页"、或给预览组件加进写入逻辑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const KG = read('../src/views/KnowledgeGraph.vue');
const MM = read('../src/views/Mindmap.vue');
const CP = read('../src/components/CardPreviewModal.vue');

test('图谱页：命中唯一卡片时弹只读预览，不再跳卡片编辑页', () => {
  assert.match(KG, /import CardPreviewModal from '\.\.\/components\/CardPreviewModal\.vue'/, '要引入预览组件');
  assert.match(KG, /previewCard\.value = loose\[0\][\s\S]{0,80}?previewOpen\.value = true/, '唯一命中 → 打开预览');
  assert.match(KG, /<CardPreviewModal v-model="previewOpen" :card="previewCard" \/>/, '模板里要挂上预览弹窗');
  assert.ok(!/router\.push\(`\/cards\?id=/.test(KG),
    '不应再直接跳 /cards?id=（那是编辑态）——多命中/找不到时才跳卡片页让用户挑');
});

test('导图页：同样改为只读预览', () => {
  assert.match(MM, /import CardPreviewModal from '\.\.\/components\/CardPreviewModal\.vue'/);
  assert.match(MM, /previewCard\.value = loose\[0\][\s\S]{0,80}?previewOpen\.value = true/);
  assert.match(MM, /<CardPreviewModal v-model="previewOpen" :card="previewCard" \/>/);
  assert.ok(!/router\.push\(`\/cards\?id=/.test(MM), '不应再直接跳编辑页');
});

test('预览弹窗必须是**只读**的：不得含任何写库/编辑入口', () => {
  assert.match(CP, /MarkdownRenderer/, '正面/背面用 Markdown 渲染（与卡片分组页预览一致）');
  assert.ok(!/createCard|updateCard|saveCard|deleteCard|db\.cards\.put/.test(CP),
    '预览组件里不得出现写入操作——"看内容"这件事不该有机会改到数据');
  assert.match(CP, /components\.cardPreview\./, '文案走 i18n 字典');
});

test('多命中 / 找不到时仍跳卡片页（保留让用户自己挑或新建的能力）', () => {
  assert.match(KG, /loose\.length > 1[\s\S]{0,160}?router\.push\(`\/cards\?\$\{params\.toString\(\)\}`\)/,
    '图谱页多命中要保留搜索跳转');
  assert.match(MM, /loose\.length > 1\) router\.push\(`\/cards\?q=/, '导图页多命中要保留搜索跳转');
});
