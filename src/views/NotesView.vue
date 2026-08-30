<script setup>
// 笔记视图（D3.2）：双栏布局，左列表 + 右详情/编辑，支持双向链接 [[id]] 自动跳转 + ExportButton
import { t } from '../i18n/index.js';
import { confirmDialog } from '../utils/confirm.js';
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import EmptyState from '../components/EmptyState.vue';
import ExportButton from '../components/ExportButton.vue';
import { toast } from '../utils/toast.js';
import {
  listNotes, createNote, updateNote, deleteNote,
  getNoteCategories, getNoteTags, findNotesLinkingTo,
} from '../repo.js';
import {
  exportNotesToJSON, exportNotesToMarkdown,
} from '../utils/exporters.js';
import {
  recognizeWikiLinks, renderWikiLinks, countChars,
} from '../utils/note-parser.js';
import { fmtLocaleDate } from '../utils/locale-date.js';

const router = useRouter();
const route = useRoute();
const notes = ref([]);
const loading = ref(true); // P2-30 初始加载态
const categories = ref([]);
const tags = ref([]);
const filter = ref({ q: '', category: '', tags: [] });
const editingId = ref(null);          // 当前编辑的笔记 id（null 表示新建）
const draft = ref(null);                // 编辑中的草稿（null 表示查看模式）
const isDirty = ref(false);
const backlinks = ref([]);              // 反向链接列表

async function load() {
  notes.value = await listNotes(filter.value);
  categories.value = await getNoteCategories();
  tags.value = await getNoteTags();
}
async function reload() { await load(); }

onMounted(async () => {
  loading.value = true;
  try {
    await load();
    // URL ?id=xxx 自动打开
    const id = route.query.id;
    if (id) {
      const n = notes.value.find(x => x.id === id);
      if (n) openNote(n);
    }
  } finally { loading.value = false; }
});
watch(filter, () => load(), { deep: true });

function openNote(n) {
  editingId.value = n.id;
  draft.value = JSON.parse(JSON.stringify(n));
  isDirty.value = false;
  loadBacklinks(n.id);
}
function startCreate() {
  editingId.value = null;
  draft.value = { title: '', content: '', category: '', tags: [], linkedCardIds: [] };
  isDirty.value = true; // 新建模式直接可保存
  nextTick(() => titleInput.value?.focus());
}
async function loadBacklinks(targetId) {
  const list = await findNotesLinkingTo(targetId);
  backlinks.value = list.map(n => ({ id: n.id, title: n.title }));
}
async function save() {
  if (!draft.value) return;
    if (!draft.value.title?.trim()) { toast(t('views.notesView.titleEmpty'), 'error'); return; }
  try {
    let saved;
    if (editingId.value) {
      saved = await updateNote(editingId.value, draft.value);
      toast(t('views.notesView.toastSaved'), 'success');
    } else {
      saved = await createNote(draft.value);
      editingId.value = saved.id;
      toast(t('views.notesView.toastCreated'), 'success');
    }
    isDirty.value = false;
    await reload();
    // 选中新建/更新后的笔记
    const cur = notes.value.find(n => n.id === saved.id);
    if (cur) await loadBacklinks(cur.id);
    // 保持选中
    selectedId.value = saved.id;
  } catch (e) {
    toast(t('views.notesView.saveFailed', { msg: e?.message || e }), 'error');
  }
}
async function remove() {
  if (!editingId.value) {
    // 新建但未保存 → 退出即可
    draft.value = null; editingId.value = null; selectedId.value = null;
    return;
  }
  if (!(await confirmDialog(t('views.notesView.confirmDelete')))) return;
  await deleteNote(editingId.value);
  toast(t('views.notesView.toastDeleted'), 'success');
  editingId.value = null; draft.value = null; selectedId.value = null;
  await reload();
}

const selectedId = ref(null);
watch(selectedId, async (id) => {
  if (!id) return;
  const n = notes.value.find(x => x.id === id);
  if (n && (!draft.value || draft.value.id !== id)) openNote(n);
});

function onWikiLinkClick(e) {
  // 拦截渲染产物里的 a.wiki-link 跳转
  const a = e.target.closest('a.wiki-link');
  if (!a) return;
  e.preventDefault();
  const id = a.dataset.id;
  const type = a.dataset.type;
  if (type === 'card') router.push({ path: '/cards', query: { id } });
  else if (type === 'doc') router.push({ path: '/library', query: { id } });
  else if (type === 'note') {
    const n = notes.value.find(x => x.id === id);
    if (n) openNote(n);
  }
}

const draftLinks = computed(() => draft.value ? recognizeWikiLinks(draft.value.content || '') : []);
const draftStats = computed(() => {
  if (!draft.value) return { chars: 0, links: 0 };
  return { chars: countChars(draft.value.content), links: draftLinks.value.length };
});

function addTag(tagName) {
  const v = String(tagName || '').toLowerCase().trim();
  if (!v || draft.value.tags.includes(v)) return;
  draft.value.tags.push(v);
}
function removeTag(tagName) { draft.value.tags = draft.value.tags.filter(x => x !== tagName); }

const titleInput = ref(null);

const noteExportFormats = computed(() => [
  { key: 'md', label: t('views.notesView.fmtMarkdown'), hint: t('views.notesView.fmtMarkdownHint'), mime: 'text/markdown', ext: 'md', build: rows => exportNotesToMarkdown(rows) },
  { key: 'json', label: t('views.notesView.fmtJson'), hint: t('views.notesView.fmtJsonHint'), mime: 'application/json', ext: 'json', build: rows => exportNotesToJSON(rows) },
]);

// 渲染产物：把双向链接 [[id]] 转成 <a class="wiki-link">，再喂给 MarkdownRenderer
const renderedContent = computed(() => {
  if (!draft.value?.content) return '';
  return renderWikiLinks(draft.value.content, (id, type) => {
    if (type === 'card') return `#/cards?id=${encodeURIComponent(id)}`;
    if (type === 'doc') return `#/library?id=${encodeURIComponent(id)}`;
    if (type === 'note') return `#/notes?id=${encodeURIComponent(id)}`;
    return '#';
  });
});

const filteredNotes = computed(() => notes.value);
</script>

<template>
  <div class="notes-page" v-loading="loading" :element-loading-text="t('views.notesView.loading')">
    <!-- 左栏：列表 -->
    <div class="notes-list">
      <div class="notes-toolbar">
        <input v-model="filter.q" class="input" :placeholder="t('views.notesView.searchPlaceholder')" />
        <select v-model="filter.category" class="input">
          <option value="">{{ t('views.notesView.allCategories') }}</option>
          <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
        </select>
        <button class="btn primary" @click="startCreate">{{ t('views.notesView.newNote') }}</button>
      </div>
      <div v-if="tags.length" class="notes-tagbar">
        <button
          v-for="tag in tags" :key="tag"
          class="chip" :class="{ on: filter.tags.includes(tag) }"
          @click="filter.tags.includes(tag) ? filter.tags = filter.tags.filter(x => x !== tag) : filter.tags.push(tag)"
        >{{ tag }}</button>
      </div>
      <div class="notes-list-items">
        <EmptyState v-if="!notes.length" icon="📝" :title="t('views.notesView.emptyTitle')" :message="t('views.notesView.emptyMessage')" />
        <div
          v-for="n in notes"
          :key="n.id"
          class="notes-item"
          :class="{ active: selectedId === n.id }"
          @click="selectedId = n.id"
        >
          <div class="notes-item-title">{{ n.title || t('views.notesView.untitled') }}</div>
          <div class="notes-item-meta">
            <span class="notes-cat" v-if="n.category">📁 {{ n.category }}</span>
            <span class="notes-tag" v-for="tag in (n.tags || []).slice(0, 3)" :key="tag">#{{ tag }}</span>
            <span class="notes-time">{{ fmtLocaleDate(n.updatedAt) }}</span>
          </div>
          <div class="notes-item-excerpt">{{ (n.content || '').replace(/\s+/g, ' ').slice(0, 60) }}{{ (n.content || '').length > 60 ? '…' : '' }}</div>
        </div>
      </div>
      <div v-if="notes.length" class="notes-export">
        <ExportButton
          :data="notes"
          :count="notes.length"
          filename-prefix="notes"
          :label="t('views.notesView.exportAll')"
          :formats="noteExportFormats"
        />
      </div>
    </div>

    <!-- 右栏：详情 / 编辑 -->
    <div class="notes-detail" @click="onWikiLinkClick">
      <EmptyState
        v-if="!draft"
        icon="📓"
        :title="t('views.notesView.selectTitle')"
        :message="t('views.notesView.selectMessage')"
      />
      <div v-else class="notes-edit">
        <div class="notes-edit-head">
          <input
            ref="titleInput"
            v-model="draft.title"
            class="input title-input"
            :placeholder="t('views.notesView.titlePlaceholder')"
            @input="isDirty = true"
          />
          <div class="notes-edit-actions">
            <button class="btn primary" @click="save">{{ t('views.notesView.save') }}</button>
            <button v-if="editingId" class="btn" @click="remove">{{ t('views.notesView.delete') }}</button>
          </div>
        </div>

        <div class="notes-edit-meta">
          <input
            v-model="draft.category"
            class="input"
            :placeholder="t('views.notesView.categoryPlaceholder')"
            list="note-cat-list"
            @input="isDirty = true"
          />
          <datalist id="note-cat-list">
            <option v-for="c in categories" :key="c" :value="c" />
          </datalist>

          <div class="tag-input-wrap">
            <div class="tag-list">
              <span v-for="tag in draft.tags" :key="tag" class="tag-pill" @click="removeTag(tag)">#{{ tag }} ×</span>
            </div>
            <input
              class="input"
              :placeholder="t('views.notesView.tagPlaceholder')"
              @keydown.enter.prevent="(e) => { addTag(e.target.value); e.target.value=''; }"
            />
          </div>
        </div>

        <div class="notes-split">
          <textarea
            v-model="draft.content"
            class="input notes-content"
            :placeholder="t('views.notesView.contentPlaceholder')"
            rows="16"
            @input="isDirty = true"
          />
          <div class="notes-preview">
            <div class="hint notes-preview-head">{{ t('views.notesView.preview') }}</div>
            <MarkdownRenderer :content="renderedContent" v-if="draft.content" />
            <div v-else class="hint">{{ t('views.notesView.noContent') }}</div>
          </div>
        </div>

        <div class="notes-footer">
          <span class="hint">{{ t('views.notesView.charCount', { n: draftStats.chars }) }} · {{ t('views.notesView.linkCount', { n: draftStats.links }) }} · {{ isDirty ? t('views.notesView.unsaved') : t('views.notesView.synced') }}</span>
          <span v-if="backlinks.length" class="hint">
            {{ t('views.notesView.referenced') }}
            <a v-for="b in backlinks" :key="b.id" class="wiki-link" @click="openNote(notes.find(n => n.id === b.id))">{{ b.title }}</a>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notes-page { display: grid; grid-template-columns: 360px 1fr; gap: 16px; max-width: 1200px; margin: 0 auto; }
.notes-list { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; }
.notes-toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.notes-toolbar .input { flex: 1; min-width: 140px; }
.notes-tagbar { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.notes-tagbar .chip { font-size: 12px; padding: 4px 10px; }

.notes-list-items { display: flex; flex-direction: column; gap: 4px; max-height: calc(100vh - 280px); overflow-y: auto; }
.notes-item { padding: 10px 12px; border-radius: 8px; cursor: pointer; transition: background .15s; border: 1px solid transparent; }
.notes-item:hover { background: var(--panel-2, #f7f7f9); }
.notes-item.active { background: color-mix(in srgb, var(--accent) 8%, transparent); border-color: var(--accent); }
.notes-item-title { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
.notes-item-meta { display: flex; gap: 6px; flex-wrap: wrap; font-size: 11px; color: var(--ink-2); margin-bottom: 4px; }
.notes-cat { background: rgba(217, 119, 6, 0.12); color: #b45309; padding: 2px 6px; border-radius: 4px; }
.notes-tag { background: var(--tag-bg, #eef2ff); color: var(--tag-ink, #4338ca); padding: 2px 6px; border-radius: 4px; }
.notes-time { margin-left: auto; color: var(--ink-2); opacity: 0.7; }
.notes-item-excerpt { font-size: 12px; color: var(--ink-2); line-height: 1.5; opacity: 0.8; }
.notes-export { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }

.notes-detail { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px; min-height: 600px; }
.notes-edit { display: flex; flex-direction: column; gap: 12px; }
.notes-edit-head { display: flex; gap: 8px; align-items: center; }
.title-input { font-size: 18px; font-weight: 700; flex: 1; }
.notes-edit-actions { display: flex; gap: 6px; }

.notes-edit-meta { display: flex; gap: 8px; flex-wrap: wrap; }
.notes-edit-meta .input { flex: 1; min-width: 160px; }
.tag-input-wrap { flex: 1; min-width: 200px; }
.tag-list { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 4px; }
.tag-pill { background: var(--tag-bg, #eef2ff); color: var(--tag-ink, #4338ca); padding: 2px 8px; border-radius: 12px; font-size: 12px; cursor: pointer; }

.notes-split { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; min-height: 320px; }
.notes-content { min-height: 320px; resize: vertical; font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 13.5px; line-height: 1.65; }
.notes-preview { padding: 12px; background: var(--bg, #fafafb); border: 1px solid var(--line); border-radius: 8px; min-height: 320px; max-height: 600px; overflow-y: auto; }
.notes-preview-head { margin-bottom: 8px; font-weight: 600; }

.notes-footer { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding-top: 8px; border-top: 1px dashed var(--line); }

/* 双向链接样式 */
:deep(.wiki-link) {
  display: inline-flex; align-items: center; gap: 2px;
  padding: 1px 6px; border-radius: 4px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent); text-decoration: none;
  font-size: 0.95em;
  cursor: pointer; transition: background .15s;
}
:deep(.wiki-link):hover {
  background: color-mix(in srgb, var(--accent) 20%, transparent);
  text-decoration: underline;
}
:deep(.wiki-link[data-type="doc"]) { background: color-mix(in srgb, #7ba87b 14%, transparent); color: #4c8352; }
:deep(.wiki-link[data-type="note"]) { background: color-mix(in srgb, #d4a853 14%, transparent); color: #a0801e; }
:deep(.wiki-link[data-type="unknown"]) { background: rgba(220, 38, 38, 0.1); color: #dc2626; } /* 未识别红色警示 */

@media (max-width: 880px) {
  .notes-page { grid-template-columns: 1fr; }
  .notes-split { grid-template-columns: 1fr; }
}
</style>
