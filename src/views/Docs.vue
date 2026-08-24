<script setup>
// AI 文档：保存 AI 生成的总结/讲义/计划等长文，可增删改，数据落 IndexedDB 并随数据包同步
import { ref, onMounted } from 'vue';
import { listDocs, createDoc, updateDoc, deleteDoc, createCard } from '../repo.js';
import { chatAI, hasAIKey } from '../ai.js';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import { toast } from '../utils/toast.js';

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

const typeMeta = { summary: '总结', note: '笔记', plan: '计划', other: '其他' };

async function load() { docs.value = await listDocs(); }

function openNew() {
  editing.value = null; title.value = ''; content.value = ''; type.value = 'note'; tags.value = ''; showForm.value = true;
}
function openEdit(d) {
  editing.value = d; title.value = d.title; content.value = d.content; type.value = d.type || 'note'; tags.value = (d.tags || []).join(', '); showForm.value = true;
}
async function save() {
  if (!title.value.trim() && !content.value.trim()) { toast('标题或内容不能都为空', 'error'); return; }
  const tagArr = tags.value.split(/[,，]/).map(t => t.trim()).filter(Boolean);
  if (editing.value) {
    await updateDoc(editing.value.id, { title: title.value, content: content.value, type: type.value, tags: tagArr });
    toast('文档已更新', 'success');
  } else {
    await createDoc({ title: title.value, content: content.value, type: type.value, tags: tagArr });
    toast('文档已创建', 'success');
  }
  showForm.value = false; await load();
}
async function remove(d) { if (!confirm('删除这个文档？')) return; await deleteDoc(d.id); if (activeId.value === d.id) activeId.value = ''; await load(); }

// 一键转卡片：把文档内容拆成记忆卡片（AI）
async function toCards(d) {
  if (!hasAIKey()) { toast('请先配置 AI 密钥', 'error'); return; }
  if (!d.content || !d.content.trim()) { toast('文档内容为空', 'error'); return; }
  genFrom.value = d; genCards.value = []; genOpen.value = true; genLoading.value = true;
  try {
    const sys = '你是学习内容拆解助手。把下面内容拆成记忆卡片，输出严格 JSON 数组，每项 {"front":"问题/提示","back":"答案","subject":"科目","tags":["标签"]}。只输出 JSON 数组。';
    const r = await chatAI([{ role: 'system', content: sys }, { role: 'user', content: d.content }]);
    const m = String(r).match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : r);
    genCards.value = Array.isArray(arr) ? arr.filter(c => c && c.front && c.back) : [];
    if (!genCards.value.length) toast('没解析出卡片', 'error');
  } catch (e) { toast('转换失败：' + e.message, 'error'); }
  finally { genLoading.value = false; }
}
async function importCards() {
  if (!genCards.value.length) return;
  for (const c of genCards.value) {
    await createCard({ front: String(c.front), back: String(c.back), subject: c.subject || (genFrom.value?.tags?.[0] || ''), tags: c.tags || [], type: 'basic' });
  }
  toast(`已导入 ${genCards.value.length} 张卡片`, 'success');
  genOpen.value = false; genCards.value = [];
}

onMounted(load);
</script>

<template>
  <div class="docs-wrap">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">AI 文档</h2>
      <span style="flex:1"></span>
      <button class="btn primary small" @click="openNew">＋ 新建文档</button>
    </div>

    <div class="docs-body">
      <aside class="docs-list no-print">
        <div v-if="!docs.length" class="hint" style="padding:12px">还没有文档。可手动创建，或在「Agent 工作台」让 Agent 生成总结/讲义后保存到这里。</div>
        <div v-for="d in docs" :key="d.id" class="doc-item" :class="{ active: activeId === d.id }" @click="activeId = d.id">
          <div class="doc-title">{{ d.title }}</div>
          <div class="doc-meta">
            <span class="doc-type">{{ typeMeta[d.type] || '其他' }}</span>
            <span class="doc-date">{{ new Date(d.updatedAt).toLocaleDateString() }}</span>
          </div>
        </div>
      </aside>

      <section class="docs-detail">
        <div v-if="!activeId && !showForm" class="hint" style="text-align:center;padding:60px">选择左侧文档查看内容</div>
        <template v-for="d in docs" :key="'d' + d.id">
          <div v-if="activeId === d.id" class="detail-card">
            <div class="detail-head">
              <h3 style="margin:0">{{ d.title }}</h3>
              <div style="display:flex;gap:8px">
                <button class="btn small primary" @click="toCards(d)">转卡片</button>
                <button class="btn small" @click="openEdit(d)">编辑</button>
                <button class="btn small" style="color:var(--red)" @click="remove(d)">删除</button>
              </div>
            </div>
            <div v-if="d.tags && d.tags.length" style="margin-bottom:8px">
              <span v-for="t in d.tags" :key="t" class="tag">{{ t }}</span>
            </div>
            <MarkdownRenderer :content="d.content || '（无内容）'" />
          </div>
        </template>
      </section>
    </div>

    <teleport to="body">
      <div v-if="showForm" class="modal-mask" @click.self="showForm = false">
        <div class="modal">
          <h3>{{ editing ? '编辑文档' : '新建文档' }}</h3>
          <div class="field-label">标题</div>
          <input v-model="title" class="input" placeholder="如：操作系统·文件系统总结" />
          <div class="field-label">类型</div>
          <select v-model="type" class="input">
            <option value="note">笔记</option>
            <option value="summary">总结</option>
            <option value="plan">计划</option>
            <option value="other">其他</option>
          </select>
          <div class="field-label">标签（逗号分隔）</div>
          <input v-model="tags" class="input" placeholder="如：操作系统, 文件系统" />
          <div class="field-label">内容（支持 Markdown）</div>
          <textarea v-model="content" class="input" rows="10" placeholder="正文…"></textarea>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
            <button class="btn" @click="showForm = false">取消</button>
            <button class="btn primary" @click="save">保存</button>
          </div>
        </div>
      </div>
    </teleport>
    <!-- 转卡片预览弹窗 -->
    <teleport to="body">
      <div v-if="genOpen" class="modal-mask" @click.self="genOpen = false">
        <div class="modal">
          <h3 style="margin-top:0">文档转卡片</h3>
          <p class="hint" style="margin-top:0">AI 已把「{{ genFrom?.title }}」拆成 {{ genCards.length }} 张卡片，确认后导入。</p>
          <div v-if="genLoading" class="hint" style="text-align:center;padding:24px">生成中…</div>
          <div v-else class="gen-list">
            <div v-for="(c, i) in genCards" :key="i" class="gen-item">
              <div class="gen-q">{{ c.front }}</div>
              <div class="gen-a">{{ c.back }}</div>
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
            <button class="btn" @click="genOpen = false">取消</button>
            <button class="btn primary" :disabled="!genCards.length" @click="importCards">导入这 {{ genCards.length }} 张</button>
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
