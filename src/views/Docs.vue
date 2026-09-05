<script setup>
// AI 文档：保存 AI 生成的总结/讲义/计划等长文，可增删改，数据落 IndexedDB 并随数据包同步
import { confirmDialog } from '../utils/confirm.js';
import { ref, onMounted, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { listDocs, createDoc, updateDoc, deleteDoc, createCard } from '../repo.js';
import { chatAI, hasAIKey } from '../ai.js';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import EmptyState from '../components/EmptyState.vue';
import FullscreenButton from '../components/FullscreenButton.vue';
import { useFullscreen } from '../composables/useFullscreen.js';
import { toast } from '../utils/toast.js';
import { t } from '../i18n/index.js';
import { parseLLMJsonArray } from '../utils/llm-json.js';

// 全屏/非全屏：文档正文是长阅读场景（AI 总结/讲义），沉浸式专心阅读
const docFsEl = ref(null);
const { isFullscreen: docFs, toggle: toggleDocFs } = useFullscreen(docFsEl);

const route = useRoute();
const docs = ref([]);
const showForm = ref(false);
const editing = ref(null);
const title = ref('');
const content = ref('');
const type = ref('note');
const tags = ref('');
const activeId = ref('');

const genOpen = ref(false);
const genLoading = ref(false);
const genCards = ref([]);
const genFrom = ref(null);

const typeMeta = { summary: t('views.docs.typeSummary'), note: t('views.docs.typeNote'), plan: t('views.docs.typePlan'), other: t('views.docs.typeOther') };

async function load() { docs.value = await listDocs(); }

function openNew() {
  editing.value = null; title.value = ''; content.value = ''; type.value = 'note'; tags.value = ''; showForm.value = true;
}
function openEdit(d) {
  editing.value = d; title.value = d.title; content.value = d.content; type.value = d.type || 'note'; tags.value = (d.tags || []).join(', '); showForm.value = true;
}
async function save() {
  if (!title.value.trim() && !content.value.trim()) { toast(t('views.docs.emptyBoth'), 'error'); return; }
  const tagArr = tags.value.split(/[,，]/).map(t => t.trim()).filter(Boolean);
  try {
  if (editing.value) {
    await updateDoc(editing.value.id, { title: title.value, content: content.value, type: type.value, tags: tagArr });
    toast(t('views.docs.updated'), 'success');
  } else {
    await createDoc({ title: title.value, content: content.value, type: type.value, tags: tagArr });
    toast(t('views.docs.created'), 'success');
  }
  showForm.value = false; await load();
  } catch (e) { toast(t('views.docs.saveFail', '保存失败：{msg}', { msg: e.message }), 'error'); }
}
async function remove(d) { if (!(await confirmDialog(t('views.docs.confirmDelete')))) return; await deleteDoc(d.id); if (activeId.value === d.id) activeId.value = ''; await load(); }

// 一键转卡片：把文档内容拆成记忆卡片（AI）
async function toCards(d) {
  if (!hasAIKey()) { toast(t('views.docs.noAIKey'), 'error'); return; }
  if (!d.content || !d.content.trim()) { toast(t('views.docs.contentEmpty'), 'error'); return; }
  genFrom.value = d; genCards.value = []; genOpen.value = true; genLoading.value = true;
  try {
    const sys = '你是学习内容拆解助手。把下面内容拆成记忆卡片，输出严格 JSON 数组，每项 {"front":"问题/提示","back":"答案","subject":"科目","tags":["标签"]}。只输出 JSON 数组。';
    const r = await chatAI([{ role: 'system', content: sys }, { role: 'user', content: d.content }], { maxTokens: 4000 });
    const arr = parseLLMJsonArray(r); // 空输出/非 JSON → 可读报错，而非 "Unexpected end of JSON input"
    genCards.value = Array.isArray(arr) ? arr.filter(c => c && c.front && c.back) : [];
    if (!genCards.value.length) toast(t('views.docs.noCards'), 'error');
  } catch (e) { toast(t('views.docs.convertFail', '转换失败：{msg}', { msg: e.message }), 'error'); }
  finally { genLoading.value = false; }
}
async function importCards() {
  if (!genCards.value.length) return;
  for (const c of genCards.value) {
    await createCard({ front: String(c.front), back: String(c.back), subject: c.subject || (genFrom.value?.tags?.[0] || ''), tags: c.tags || [], type: 'basic' });
  }
  toast(t('views.docs.importedN', '已导入 {n} 张卡片', { n: genCards.value.length }), 'success');
  genOpen.value = false; genCards.value = [];
}

// 从 URL ?id=xxx 定位具体文档（搜索结果跳转）
async function applyRouteId() {
  const id = route.query?.id ? String(route.query.id) : '';
  if (!id) return;
  await load();
  await nextTick();
  const hit = docs.value.find(d => d.id === id);
  if (hit) activeId.value = hit.id;
}
onMounted(applyRouteId);
</script>

<template>
  <div class="docs-wrap">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">{{ t('views.docs.title') }}</h2>
      <span style="flex:1"></span>
      <button class="btn primary small" @click="openNew">{{ t('views.docs.newDoc') }}</button>
    </div>

    <div class="docs-body">
      <aside class="docs-list no-print">
        <EmptyState v-if="!docs.length" icon="📄" :title="t('views.docs.emptyListTitle')" :message="t('views.docs.emptyListMsg')" />
        <div v-for="d in docs" :key="d.id" class="doc-item" :class="{ active: activeId === d.id }" @click="activeId = d.id">
          <div class="doc-title">{{ d.title }}</div>
          <div class="doc-meta">
            <span class="doc-type">{{ typeMeta[d.type] || t('views.docs.typeOther') }}</span>
            <span class="doc-date">{{ new Date(d.updatedAt).toLocaleDateString() }}</span>
          </div>
        </div>
      </aside>

      <section class="docs-detail">
        <EmptyState v-if="!activeId && !showForm" icon="📄" :title="t('views.docs.noSelTitle')" :message="t('views.docs.noSelMsg')" />
        <template v-for="d in docs" :key="'d' + d.id">
          <div v-if="activeId === d.id" class="detail-card">
            <div class="detail-head">
              <h3 style="margin:0">{{ d.title }}</h3>
              <div style="display:flex;gap:8px">
                <button class="btn small primary" @click="toCards(d)">{{ t('views.docs.toCards') }}</button>
                <button class="btn small" @click="openEdit(d)">{{ t('views.docs.edit') }}</button>
                <button class="btn small" style="color:var(--red)" @click="remove(d)">{{ t('views.docs.del') }}</button>
              </div>
            </div>
            <div v-if="d.tags && d.tags.length" style="margin-bottom:8px">
              <span v-for="t in d.tags" :key="t" class="tag">{{ t }}</span>
            </div>
            <div style="display:flex;justify-content:flex-end;margin-bottom:6px">
              <FullscreenButton :active="docFs" @toggle="toggleDocFs" />
            </div>
            <div ref="docFsEl">
              <MarkdownRenderer :content="d.content || t('views.docs.noContent')" />
            </div>
          </div>
        </template>
      </section>
    </div>

    <teleport to="body">
      <div v-if="showForm" class="modal-mask" @click.self="showForm = false">
        <div class="modal">
          <h3>{{ editing ? t('views.docs.editDoc') : t('views.docs.newDocTitle') }}</h3>
          <div class="field-label">{{ t('views.docs.fieldTitle') }}</div>
          <input v-model="title" class="input" :placeholder="t('views.docs.titlePlaceholder')" />
          <div class="field-label">{{ t('views.docs.fieldType') }}</div>
          <select v-model="type" class="input">
            <option value="note">{{ t('views.docs.typeNote') }}</option>
            <option value="summary">{{ t('views.docs.typeSummary') }}</option>
            <option value="plan">{{ t('views.docs.typePlan') }}</option>
            <option value="other">{{ t('views.docs.typeOther') }}</option>
          </select>
          <div class="field-label">{{ t('views.docs.fieldTags') }}</div>
          <input v-model="tags" class="input" :placeholder="t('views.docs.tagsPlaceholder')" />
          <div class="field-label">{{ t('views.docs.fieldContent') }}</div>
          <textarea v-model="content" class="input" rows="10" :placeholder="t('views.docs.contentPlaceholder')"></textarea>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
            <button class="btn" @click="showForm = false">{{ t('views.docs.cancel') }}</button>
            <button class="btn primary" @click="save">{{ t('views.docs.save') }}</button>
          </div>
        </div>
      </div>
    </teleport>
    <!-- 转卡片预览弹窗 -->
    <teleport to="body">
      <div v-if="genOpen" class="modal-mask" @click.self="genOpen = false">
        <div class="modal">
          <h3 style="margin-top:0">{{ t('views.docs.genTitle') }}</h3>
          <p class="hint" style="margin-top:0">{{ t('views.docs.genHint', 'AI 已把「{title}」拆成 {n} 张卡片，确认后导入。', { title: genFrom?.title, n: genCards.length }) }}</p>
          <div v-if="genLoading" class="hint" style="text-align:center;padding:24px">{{ t('views.docs.generating') }}</div>
          <div v-else class="gen-list">
            <div v-for="(c, i) in genCards" :key="i" class="gen-item">
              <div class="gen-q">{{ c.front }}</div>
              <div class="gen-a">{{ c.back }}</div>
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
            <button class="btn" @click="genOpen = false">{{ t('views.docs.cancel') }}</button>
            <button class="btn primary" :disabled="!genCards.length" @click="importCards">{{ t('views.docs.importN', '导入这 {n} 张', { n: genCards.length }) }}</button>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.docs-wrap { max-width: 1000px; margin: 0 auto; }
.docs-body { display: grid; grid-template-columns: 240px 1fr; gap: 12px; margin-top: 14px; }
.docs-list { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 10px; overflow-y: auto; max-height: calc(100vh - 200px); }
.doc-item { padding: 10px; border-radius: 8px; cursor: pointer; margin-bottom: 6px; border: 1px solid transparent; }
.doc-item:hover { background: var(--code-inline); }
.doc-item.active { background: var(--code-bg); border-color: var(--accent); }
.doc-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.doc-meta { display: flex; gap: 8px; margin-top: 4px; align-items: center; }
.doc-type { font-size: 11px; border-radius: 4px; padding: 1px 6px; background: var(--code-inline); color: var(--ink-2); }
.doc-date { font-size: 11px; color: var(--ink-2); }
.docs-detail { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 20px; overflow-y: auto; }
.detail-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.tag { font-size: 11px; background: var(--code-inline); border-radius: 4px; padding: 1px 6px; margin-right: 4px; color: var(--ink-2); }
.gen-list { max-height: 320px; overflow-y: auto; border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; }
.gen-item { padding: 8px 0; border-bottom: 1px dashed var(--line); }
.gen-item:last-child { border-bottom: none; }
.gen-q { font-weight: 600; }
.gen-a { color: var(--ink-2); font-size: 13px; margin-top: 2px; }
@media (max-width: 720px) { .docs-body { grid-template-columns: 1fr; } }
</style>
