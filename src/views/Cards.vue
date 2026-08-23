<script setup>
// 卡片管理页：视图切换、科目/标签筛选、基础+高级搜索、虚拟列表（本地数据）
import { ref, reactive, computed, watch, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import VirtualList from '../components/VirtualList.vue';
import CardModal from '../components/CardModal.vue';
import { toast } from '../utils/toast.js';
import { listCards, getSubjects, getTags, deleteCard } from '../repo.js';

const router = useRouter();

const viewMode = ref(localStorage.getItem('sxy_view') || 'scroll');
const filters = reactive({ q: '', subject: '', tags: [], logic: 'AND' });

const subjects = ref([]);
const allTags = ref([]);
const items = ref([]);
const total = ref(0);
const dueCount = ref(0);
const loading = ref(false);

const modalOpen = ref(false);
const editing = ref(null);

watch(viewMode, v => localStorage.setItem('sxy_view', v));

function plain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [图片] ')
    .replace(/\$\$?([^$\n]+)\$\$?/g, ' $1 ')
    .replace(/[*_#>`~|-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadMeta() {
  subjects.value = await getSubjects();
  allTags.value = await getTags(filters.subject);
}

async function loadCards() {
  loading.value = true;
  try {
    const data = await listCards({
      q: filters.q, subject: filters.subject,
      tags: filters.tags, logic: filters.logic,
    });
    items.value = data.items;
    total.value = data.total;
    dueCount.value = data.dueCount;
  } catch (e) { toast(e.message, 'error'); }
  finally { loading.value = false; }
}

watch(() => [filters.q, filters.subject, filters.logic], loadCards);
watch(() => filters.tags, loadCards, { deep: true });
watch(() => filters.subject, loadMeta);

function toggleTag(name) {
  const i = filters.tags.indexOf(name);
  if (i >= 0) filters.tags.splice(i, 1);
  else filters.tags.push(name);
}

function openCreate() { editing.value = null; modalOpen.value = true; }
function openEdit(card) { editing.value = card; modalOpen.value = true; }

async function remove(card) {
  if (!confirm(`确定删除这张卡片？\n${plain(card.front).slice(0, 40)}`)) return;
  try {
    await deleteCard(card.id);
    await loadCards();
    await loadMeta();
    toast('已删除', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function onSaved() {
  await loadCards();
  await loadMeta();
}

let searchTimer = null;
const searchInput = ref('');
watch(searchInput, v => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { filters.q = v.trim(); }, 300);
});

onMounted(() => { loadMeta(); loadCards(); });
</script>

<template>
  <div>
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">我的卡片</h2>
      <span class="hint">共 {{ total }} 张 · 今日待背 {{ dueCount }}</span>
      <span style="flex:1"></span>
      <button v-if="dueCount > 0" class="btn primary" @click="router.push('/review')">专注背诵（{{ dueCount }}）→</button>
      <button class="btn primary" @click="openCreate">＋ 新建卡</button>
    </div>

    <div class="filter-bar">
      <div class="row">
        <span class="hint" style="width:56px">视图</span>
        <button class="chip" :class="{ on: viewMode === 'scroll' }" @click="viewMode = 'scroll'">滚轮模式</button>
        <button class="chip" :class="{ on: viewMode === 'page' }" @click="viewMode = 'page'">分页模式</button>
        <span style="flex:1"></span>
        <input v-model="searchInput" class="input" style="max-width:280px" placeholder="搜正面 / 背面内容…" />
      </div>
      <div class="row">
        <span class="hint" style="width:56px">科目</span>
        <button class="chip" :class="{ on: !filters.subject }" @click="filters.subject = ''">全部科目</button>
        <button v-for="s in subjects" :key="s.name" class="chip" :class="{ on: filters.subject === s.name }"
                @click="filters.subject = filters.subject === s.name ? '' : s.name">
          {{ s.name }}<span class="n">{{ s.count }}</span>
        </button>
      </div>
      <div class="row">
        <span class="hint" style="width:56px">标签</span>
        <button class="chip" :class="{ on: !filters.tags.length }" @click="filters.tags = []">全部</button>
        <button v-for="t in allTags.slice(0, 20)" :key="t.name" class="chip" :class="{ on: filters.tags.includes(t.name) }"
                @click="toggleTag(t.name)">{{ t.name }}<span class="n">{{ t.count }}</span></button>
        <select v-if="filters.tags.length" v-model="filters.logic" class="input" style="width:auto;margin-left:8px">
          <option value="AND">交集 AND（同时含所选）</option>
          <option value="OR">并集 OR（含任一）</option>
          <option value="NOT">差集 NOT（排除所选）</option>
        </select>
      </div>
    </div>

    <VirtualList v-if="viewMode === 'scroll'" :items="items">
      <template #default="{ item }">
        <div class="card-item">
          <div class="tags">
            <span v-if="item.subject" class="tag-pill subj">{{ item.subject }}</span>
            <span v-for="t in item.tags" :key="t" class="tag-pill">{{ t }}</span>
          </div>
          <div class="front-preview">{{ plain(item.front).slice(0, 120) || '（空）' }}</div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
            <button class="btn small" @click="openEdit(item)">编辑</button>
            <button class="btn small danger" @click="remove(item)">删除</button>
          </div>
        </div>
      </template>
    </VirtualList>

    <template v-else>
      <div v-for="item in items" :key="item.id" class="card-item">
        <div class="tags">
          <span v-if="item.subject" class="tag-pill subj">{{ item.subject }}</span>
          <span v-for="t in item.tags" :key="t" class="tag-pill">{{ t }}</span>
        </div>
        <div class="front-preview">{{ plain(item.front).slice(0, 120) || '（空）' }}</div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
          <button class="btn small" @click="openEdit(item)">编辑</button>
          <button class="btn small danger" @click="remove(item)">删除</button>
        </div>
      </div>
    </template>

    <div v-if="!loading && !items.length" class="hint" style="text-align:center;padding:40px">
      暂无卡片，点击「＋ 新建卡」创建第一张记忆卡片
    </div>

    <CardModal v-model="modalOpen" :card="editing" @saved="onSaved" />
  </div>
</template>

<style scoped>
.filter-bar { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 16px; margin: 16px 0; }
.filter-bar .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.filter-bar .row:last-child { margin-bottom: 0; }
.front-preview { color: var(--ink); }
</style>