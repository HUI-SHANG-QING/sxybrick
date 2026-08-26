<script setup>
// 卡片管理页：视图切换、科目/标签筛选、基础+高级搜索、虚拟列表（本地数据）
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import VirtualList from '../components/VirtualList.vue';
import CardModal from '../components/CardModal.vue';
import EmptyState from '../components/EmptyState.vue';
import { db, uid } from '../db.js';
import { toast } from '../utils/toast.js';
import { listCards, getSubjects, getTags, deleteCard, weakCards, setMarked, getReviewSuggestion, getCardHistory, gradeCard, createCard } from '../repo.js';
import { getGoal, setGoal, getTodayCount, getStreak } from '../utils/streak.js';
import { chatAI } from '../ai.js';
import { genVariants } from '../utils/genVariants.js';
import { getForgetRisk } from '../agent/analytics.js';

const router = useRouter();
const route = useRoute();

const viewMode = ref(localStorage.getItem('sxy_view') || 'scroll');
const sortBy = ref(localStorage.getItem('sxy_card_sort') || 'updated');
const filters = reactive(JSON.parse(localStorage.getItem('sxy_card_filters') || '{"q":"","subject":"","tags":[],"logic":"AND"}'));

const subjects = ref([]);
const allTags = ref([]);
const items = ref([]);
const total = ref(0);
const dueCount = ref(0);
const loading = ref(false);

const modalOpen = ref(false);
const editing = ref(null);
const weakMode = ref(localStorage.getItem('sxy_card_weak') === '1');
const suggestion = ref(null);
const goal = ref(20);
const todayCount = ref(0);
const streak = ref(0);

async function loadStreak() {
  goal.value = await getGoal();
  todayCount.value = await getTodayCount();
  streak.value = await getStreak();
}
async function onGoalChange() { await setGoal(goal.value); await loadStreak(); }

watch(viewMode, v => localStorage.setItem('sxy_view', v));
watch(sortBy, v => localStorage.setItem('sxy_card_sort', v));
function saveCardFilters() { localStorage.setItem('sxy_card_filters', JSON.stringify({ q: filters.q, subject: filters.subject, tags: filters.tags, logic: filters.logic })); }
watch(() => [filters.subject, filters.logic], saveCardFilters);
watch(() => filters.tags, saveCardFilters, { deep: true });

function plain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [图片] ')
    .replace(/\$\$?([^$\n]+)\$\$?/g, ' $1 ')
    .replace(/[*_#>`~|-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function typeName(t) { return t === 'cloze' ? '填空' : t === 'choice' ? '选择' : t === 'writing' ? '默写' : ''; }

async function loadMeta() {
  subjects.value = await getSubjects();
  allTags.value = await getTags(filters.subject);
}

async function loadCards() {
  loading.value = true;
  try {
    if (weakMode.value) {
      items.value = await weakCards(100);
      total.value = items.value.length;
      dueCount.value = 0;
      return;
    }
    const data = await listCards({
      q: filters.q, subject: filters.subject,
      tags: filters.tags, logic: filters.logic,
      sortBy: sortBy.value,
    });
    // ?untagged=1：在 listCards 返回结果之上再做一层过滤，保留完全无标签的卡
    let list = data.items;
    if (filters._untagged) list = list.filter(c => !c.tags || !c.tags.length);
    items.value = list;
    total.value = filters._untagged ? list.length : data.total;
    dueCount.value = data.dueCount;
  } catch (e) { toast(e.message, 'error'); }
  finally { loading.value = false; }
}

watch(() => [filters.q, filters.subject, filters.logic], loadCards);
watch(() => filters.tags, loadCards, { deep: true });
watch(() => filters.subject, loadMeta);
watch(sortBy, loadCards);

function toggleTag(name) {
  const i = filters.tags.indexOf(name);
  if (i >= 0) filters.tags.splice(i, 1);
  else filters.tags.push(name);
}

function openCreate() { editing.value = null; modalOpen.value = true; }
function openEdit(card) { editing.value = card; modalOpen.value = true; }
function toggleWeak() { weakMode.value = !weakMode.value; localStorage.setItem('sxy_card_weak', weakMode.value ? '1' : '0'); loadCards(); }
async function toggleMarked(card) {
  try {
    await setMarked(card.id, !card.marked);
    await loadCards();
    toast(card.marked ? '已移出错题集' : '已加入错题集', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// 情境变式生成：AI 为同一知识点生成不同问法/场景的变式卡
const variantBusy = ref(new Set());
async function genVariantsFor(card) {
  if (variantBusy.value.has(card.id)) return;
  variantBusy.value.add(card.id);
  try {
    const created = await genVariants(card, 3);
    toast(`已生成 ${created.length} 张情境变式卡`, 'success');
    await loadCards();
  } catch (e) { toast('变式生成失败：' + e.message, 'error'); }
  finally { variantBusy.value.delete(card.id); }
}

async function remove(card) {
  if (!confirm(`确定删除这张卡片？\n${plain(card.front).slice(0, 40)}`)) return;
  try {
    await deleteCard(card.id);
    await loadCards();
    await loadMeta();
    toast('已删除', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function loadSuggestion() { suggestion.value = await getReviewSuggestion(); }

const historyOpen = ref(false);
const historyData = ref(null);
async function openHistory(card) {
  try { historyData.value = await getCardHistory(card.id); historyOpen.value = true; }
  catch (e) { toast(e.message, 'error'); }
}
function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const diagOpen = ref(false);
const diagCard = ref(null);
const diagText = ref('');
const diagLoading = ref(false);
async function openDiagnose(card) {
  diagCard.value = card; diagOpen.value = true; diagText.value = ''; diagLoading.value = true;
  try {
    const r = await chatAI([
      { role: 'system', content: '你是记忆卡质量诊断专家。点评这张卡：内容是否清晰、正面是否容易触发回忆、答案是否精炼、能否拆成更小知识点、怎么改更好记。用中文简洁回答。' },
      { role: 'user', content: `正面：${card.front}\n背面：${card.back}\n科目：${card.subject || '无'}\n题型：${card.type || 'basic'}` },
    ]);
    diagText.value = r;
  } catch (e) { toast(e.message, 'error'); diagText.value = '（诊断失败：' + e.message + '）'; }
  finally { diagLoading.value = false; }
}

async function onSaved() {
  await loadCards();
  await loadMeta();
  await loadSuggestion();
}

let searchTimer = null;
const searchInput = ref(localStorage.getItem('sxy_card_search') || '');
watch(searchInput, v => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { filters.q = v.trim(); }, 300);
  localStorage.setItem('sxy_card_search', v);
});

const highlightId = ref('');

/**
 * 读取 URL 查询参数（搜索结果跳转 / 命令面板跳转 / 科目和标签直链）：
 *   ?id=xxx      → 自动打开该卡编辑弹窗，并滚动/高亮
 *   ?subject=xxx → 自动筛选该科目
 *   ?tag=xxx     → 自动筛选该标签（可重复出现多个）
 *   ?untagged=1  → 仅显示无标签卡（"无标签卡 N 种"快捷跳转）
 *   ?q=xxx       → 自动填充关键词搜索
 */
async function applyQueryParams() {
  const id = route.query?.id ? String(route.query.id) : '';
  const subj = route.query?.subject ? String(route.query.subject) : '';
  const tags = Array.isArray(route.query?.tag)
    ? route.query.tag.map(t => String(t).trim()).filter(Boolean)
    : (route.query?.tag ? [String(route.query.tag).trim()] : []);
  const untagged = route.query?.untagged === '1' || route.query?.untagged === true;
  const qp = route.query?.q ? String(route.query.q).trim() : '';
  let changed = false;
  if (subj && filters.subject !== subj) { filters.subject = subj; changed = true; }
  if (tags.length) {
    const merged = [...new Set([...filters.tags, ...tags])];
    if (merged.length !== filters.tags.length || merged.some((t, i) => t !== filters.tags[i])) {
      filters.tags = merged; changed = true;
    }
  }
  if (untagged) {
    // 仅显示无标签卡：筛掉 tags 非空的卡，走 q 里注入 "无标签" 语义并在后处理补
    // 这里直接在过滤器里追加 notag 专用逻辑，改 filters.q 会影响用户体验
    filters.logic = 'NOT';
    // 用一个特殊 tag 占位：虚拟列表里 tag 过滤逻辑会正常工作，
    // 我们把 untagged 过滤在 listCards 外面的 postFilter 里处理更简单；
    // 为此把 untagged 写入 filters，让 listCards 识别。
    filters._untagged = true;
    changed = true;
  } else if (filters._untagged) {
    delete filters._untagged;
  }
  if (qp && filters.q !== qp) { filters.q = qp; searchInput.value = qp; changed = true; }
  if (changed) {
    saveCardFilters();
    await loadCards();
  }
  // 如果指定了 id，在加载完卡列表后自动打开该卡
  if (id) {
    await nextTick();
    let target = items.value.find(c => c.id === id);
    if (!target) {
      // 不在当前筛选结果中：尝试直接从 IndexedDB 查找该卡
      target = await db.cards.get(id);
    }
    if (target) {
      highlightId.value = id;
      editing.value = target;
      modalOpen.value = true;
      setTimeout(() => { highlightId.value = ''; }, 2500);
    }
  }
}

onMounted(async () => {
  await loadMeta();
  await loadCards();
  await Promise.all([loadSuggestion(), loadStreak(), loadSmart(), loadRisk()]);
  await applyQueryParams();
});
// 清理搜索防抖定时器，避免卸载后触发游离 searchTimer
onBeforeUnmount(() => { clearTimeout(searchTimer); });

// ---- 批量建卡（P0 效率包）：粘贴文本按行拆成卡片 ----
const batchOpen = ref(false);
const batchText = ref('');
const batchSubject = ref('');
const batchBusy = ref(false);
const batchParsed = computed(() => {
  return batchText.value.split('\n').map(line => {
    let front = line.trim();
    let back = '';
    if (!front) return null;
    const m = front.match(/^(.+?)\s*(?:\||→|->|：答[:：]?)\s*(.+)$/);
    if (m && m[2]) { front = m[1].trim(); back = m[2].trim(); }
    return { front, back };
  }).filter(Boolean).slice(0, 200);
});
function openBatch() {
  batchText.value = '';
  batchSubject.value = filters.subject || '';
  batchOpen.value = true;
}
async function importBatch() {
  const cards = batchParsed.value;
  if (!cards.length) { toast('请先粘贴内容（每行一张卡）', 'error'); return; }
  batchBusy.value = true;
  try {
    let n = 0;
    for (const c of cards) {
      await createCard({ front: c.front, back: c.back, subject: batchSubject.value || '', tags: [], type: 'basic' });
      n++;
    }
    batchOpen.value = false;
    toast(`已批量创建 ${n} 张卡片`, 'success');
    loadCards();
  } catch (e) { toast(e.message, 'error'); }
  finally { batchBusy.value = false; }
}

// ---- 智能卡组（P0 效率包）：把当前筛选组合存成快捷入口 ----
const smartFilters = ref([]);
async function loadSmart() {
  const row = await db.meta.get('smartFilters');
  smartFilters.value = row?.value || [];
}
async function persistSmart() {
  // smartFilters.value 是 Vue 响应式代理数组，直接 put 会触发 IndexedDB 结构化克隆失败
  const plainFilters = JSON.parse(JSON.stringify(smartFilters.value));
  await db.meta.put({ key: 'smartFilters', value: plainFilters, updatedAt: Date.now() });
}
async function saveSmart() {
  const name = prompt('给这个筛选组合起个名字：', filters.subject || '智能卡组');
  if (!name) return;
  smartFilters.value.push({
    id: uid(), name: String(name).slice(0, 12),
    q: filters.q, subject: filters.subject, tags: [...filters.tags], logic: filters.logic,
  });
  await persistSmart();
  toast('已保存为智能卡组（本机偏好）', 'success');
}
function applySmart(f) {
  filters.q = f.q || ''; filters.subject = f.subject || '';
  filters.tags = [...(f.tags || [])]; filters.logic = f.logic || 'AND';
  searchInput.value = f.q || '';
}
async function removeSmart(f) {
  smartFilters.value = smartFilters.value.filter(x => x.id !== f.id);
  await persistSmart();
}

// ---- D1 遗忘预警：3 天内将到期且历史不稳的卡，可一键提前巩固 ----
const riskCards = ref([]);
async function loadRisk() { riskCards.value = await getForgetRisk(5); }
async function rescueCard(r) {
  const card = await db.cards.get(r.id);
  if (!card) return;
  await db.cards.put({ ...card, dueAt: Date.now() }); // 提前到今天（内容未变，不动 updatedAt）
  toast(`已把「${r.front.slice(0, 16)}…」加入今日复习`, 'success');
  await loadRisk();
  loadCards();
}
async function rescueAll() {
  let n = 0;
  for (const r of riskCards.value) {
    const card = await db.cards.get(r.id);
    if (!card) continue;
    await db.cards.put({ ...card, dueAt: Date.now() });
    n++;
  }
  toast(`已把 ${n} 张高危卡加入今日复习，去「背诵」页巩固`, 'success');
  await loadRisk();
  loadCards();
}
</script>

<template>
  <div>
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">我的卡片</h2>
      <span class="hint">共 {{ total }} 张 · 今日待背 {{ dueCount }}</span>
      <span style="flex:1"></span>
      <button v-if="dueCount > 0" class="btn primary" @click="router.push('/review')">专注背诵（{{ dueCount }}）→</button>
      <button class="chip" :class="{ on: weakMode }" @click="toggleWeak">错题集</button>
      <button class="btn" @click="openBatch">批量建卡</button>
      <button class="btn primary" @click="openCreate">＋ 新建卡</button>
    </div>

    <div class="streak-bar">
      <span class="hint">今日复习 <b>{{ todayCount }}</b> / <b>{{ goal }}</b> 张</span>
      <input type="number" v-model.number="goal" class="input" style="width:80px" min="1" @change="onGoalChange" title="每日目标（复习卡片数）" />
      <span class="streak-badge" :class="{ lit: streak >= 3, hot: streak >= 7 }">连续打卡 {{ streak }} 天</span>
    </div>

    <div v-if="riskCards.length" class="suggest-bar" style="border-color:var(--amber)">
      <div class="hint" style="font-weight:600;color:var(--amber)">⚠ 遗忘预警：这几张 3 天内将到期且历史表现不稳，趁没忘先巩固</div>
      <div v-for="r in riskCards" :key="r.id" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="hint" style="flex:1">[{{ r.subject }}] {{ r.front }}（错误率 {{ r.failRate }}% · 风险 {{ r.risk }}%）</span>
        <button class="btn small" @click="rescueCard(r)">加入今日复习</button>
      </div>
      <div><button class="btn small primary" @click="rescueAll">全部加入今日复习</button></div>
    </div>

    <div v-if="suggestion && suggestion.dueCount > 0" class="suggest-bar">
      <div class="hint" style="font-weight:600;color:var(--ink)">今日复习提醒</div>
      <div class="hint">待背 {{ suggestion.dueCount }} 张<span v-if="suggestion.markedCount"> · 错题 {{ suggestion.markedCount }} 张</span></div>
      <div v-if="suggestion.dueBySubject.length" class="hint">
        到期最多：<span v-for="(s, i) in suggestion.dueBySubject" :key="s.name">{{ i ? '、' : '' }}{{ s.name }}({{ s.count }})</span>
      </div>
      <div v-if="suggestion.staleSubjects.length" class="hint" style="color:var(--amber)">
        很久没复习：<span v-for="(s, i) in suggestion.staleSubjects" :key="s.name">{{ i ? '、' : '' }}{{ s.name }}({{ s.days }}天)</span>
      </div>
    </div>

    <div class="filter-bar">
      <div class="row">
        <span class="hint" style="width:56px">视图</span>
        <button class="chip" :class="{ on: viewMode === 'scroll' }" @click="viewMode = 'scroll'">滚轮模式</button>
        <button class="chip" :class="{ on: viewMode === 'page' }" @click="viewMode = 'page'">分页模式</button>
        <select v-model="sortBy" class="input" style="width:auto">
          <option value="updated">按更新时间</option>
          <option value="created">按创建时间</option>
          <option value="due">按到期时间</option>
          <option value="subject">按科目</option>
        </select>
        <span style="flex:1"></span>
        <input v-model="searchInput" class="input" style="max-width:280px" placeholder="搜正面 / 背面内容…" />
        <button class="btn small" @click="saveSmart">保存当前组合</button>
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
      <div v-if="smartFilters.length" class="row" style="margin-top:2px">
        <span class="hint" style="width:56px">智能卡组</span>
        <span v-for="f in smartFilters" :key="f.id" class="chip" style="cursor:pointer" @click="applySmart(f)">
          ⭐ {{ f.name }}<a @click.stop="removeSmart(f)" style="color:var(--red);margin-left:6px;cursor:pointer">✕</a>
        </span>
      </div>
    </div>

    <!-- 批量建卡弹窗 -->
    <teleport to="body">
      <div v-if="batchOpen" class="modal-mask" @click.self="batchOpen = false">
        <div class="modal">
          <h3 style="margin-top:0">批量建卡</h3>
          <p class="hint" style="margin-top:0">
            每行一张卡；用 <code>|</code>、<code>→</code> 或 <code>-&gt;</code> 分隔正面与背面。<br>
            例：<code>TCP 三次握手的过程？| 共 SYN / SYN-ACK / ACK 三步</code>
          </p>
          <div class="field-label" style="margin-top:12px">科目（可留空）</div>
          <select v-model="batchSubject" class="input">
            <option value="">不指定</option>
            <option v-for="s in subjects" :key="s.name" :value="s.name">{{ s.name }}</option>
          </select>
          <div class="field-label">内容（已解析 {{ batchParsed.length }} 张）</div>
          <textarea v-model="batchText" class="input" rows="10" placeholder="粘贴知识点清单…"></textarea>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
            <button class="btn" @click="batchOpen = false">取消</button>
            <button class="btn primary" :disabled="batchBusy || !batchParsed.length" @click="importBatch">
              {{ batchBusy ? '导入中…' : `导入 ${batchParsed.length} 张` }}
            </button>
          </div>
        </div>
      </div>
    </teleport>

    <VirtualList v-if="viewMode === 'scroll'" :items="items">
      <template #default="{ item }">
        <div class="card-item">
          <div class="tags">
            <span class="grade-pill" :class="gradeCard(item).cls">{{ gradeCard(item).label }}</span> <span v-if="item.type && item.type !== 'basic'" class="tag-pill" style="background:var(--blue);color:#fff">{{ typeName(item.type) }}</span> <span v-if="item.subject" class="tag-pill subj">{{ item.subject }}</span>
            <span v-for="t in item.tags" :key="t" class="tag-pill">{{ t }}</span>
            <span v-if="weakMode && item.failCount" class="tag-pill" style="background:var(--red);color:#fff">遗忘{{ item.failCount }}次</span>
          </div>
          <div v-if="item.source" class="hint" style="margin-bottom:4px">来源：{{ item.source }}</div>
          <div class="front-preview">{{ plain(item.front).slice(0, 120) || '（空）' }}</div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
            <button class="btn small" :class="{ danger: item.marked }" @click="toggleMarked(item)">{{ item.marked ? '取消错题' : '标错题' }}</button> <button class="btn small" @click="openEdit(item)">编辑</button>
            <button class="btn small" @click="genVariantsFor(item)" :disabled="variantBusy.has(item.id)">{{ variantBusy.has(item.id) ? '生成中…' : '变式' }}</button> <button class="btn small" @click="openDiagnose(item)">诊断</button> <button class="btn small" @click="openHistory(item)">历史</button> <button class="btn small danger" @click="remove(item)">删除</button>
          </div>
        </div>
      </template>
    </VirtualList>

    <template v-else>
      <div v-for="item in items" :key="item.id" class="card-item">
        <div class="tags">
          <span class="grade-pill" :class="gradeCard(item).cls">{{ gradeCard(item).label }}</span> <span v-if="item.type && item.type !== 'basic'" class="tag-pill" style="background:var(--blue);color:#fff">{{ typeName(item.type) }}</span> <span v-if="item.subject" class="tag-pill subj">{{ item.subject }}</span>
          <span v-for="t in item.tags" :key="t" class="tag-pill">{{ t }}</span>
          <span v-if="weakMode && item.failCount" class="tag-pill" style="background:var(--red);color:#fff">遗忘{{ item.failCount }}次</span>
        </div>
        <div v-if="item.source" class="hint" style="margin-bottom:4px">来源：{{ item.source }}</div>
        <div class="front-preview">{{ plain(item.front).slice(0, 120) || '（空）' }}</div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
          <button class="btn small" :class="{ danger: item.marked }" @click="toggleMarked(item)">{{ item.marked ? '取消错题' : '标错题' }}</button> <button class="btn small" @click="openEdit(item)">编辑</button>
          <button class="btn small" @click="genVariantsFor(item)" :disabled="variantBusy.has(item.id)">{{ variantBusy.has(item.id) ? '生成中…' : '变式' }}</button> <button class="btn small" @click="openDiagnose(item)">诊断</button> <button class="btn small" @click="openHistory(item)">历史</button> <button class="btn small danger" @click="remove(item)">删除</button>
        </div>
      </div>
    </template>

    <EmptyState v-if="!loading && !items.length" title="还没有卡片" message="创建第一张记忆卡片，开始高效复习">
      <button class="btn primary" @click="openCreate">＋ 新建第一张卡</button>
    </EmptyState>

    <CardModal v-model="modalOpen" :card="editing" @saved="onSaved" />

    <teleport to="body">
      <div v-if="historyOpen" class="modal-mask" @click.self="historyOpen = false">
        <div class="modal">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <h3 style="margin:0">该卡复习历史</h3>
            <button class="btn small" @click="historyOpen = false">关闭</button>
          </div>
          <div v-if="historyData && historyData.card" class="card-item" style="margin:8px 0">
            <div class="tags">
              <span v-if="historyData.card.subject" class="tag-pill subj">{{ historyData.card.subject }}</span>
              <span v-for="t in historyData.card.tags" :key="t" class="tag-pill">{{ t }}</span>
            </div>
            <div class="front-preview">{{ plain(historyData.card.front).slice(0, 80) || '（空）' }}</div>
          </div>
          <div v-if="historyData && !historyData.history.length" class="hint" style="text-align:center;padding:20px">还没有复习记录</div>
          <div v-else>
            <div v-for="(h, i) in historyData.history" :key="i" style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px dashed var(--line)">
              <span class="hint">{{ fmtTime(h.reviewedAt) }}</span>
              <span class="hint" :class="'rt-' + h.rating">{{ h.ratingText }}</span>
            </div>
          </div>
        </div>
      </div>
    </teleport>
  <teleport to="body">
      <div v-if="diagOpen" class="modal-mask" @click.self="diagOpen = false">
        <div class="modal">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <h3 style="margin:0">AI 卡片诊断</h3>
            <button class="btn small" @click="diagOpen = false">关闭</button>
          </div>
          <div v-if="diagLoading" class="hint" style="text-align:center;padding:30px">AI 分析中…</div>
          <div v-else class="diag-text">{{ diagText }}</div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.filter-bar { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 16px; margin: 16px 0; }
.filter-bar .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.filter-bar .row:last-child { margin-bottom: 0; }
.front-preview { color: var(--ink); }
.suggest-bar { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--blue); border-radius: var(--radius); padding: 12px 16px; margin: 12px 0; display: flex; flex-direction: column; gap: 2px; }
.streak-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 12px; }
.streak-badge {
  display: inline-flex; align-items: center;
  background: var(--code-inline); color: var(--ink-2);
  border-radius: 999px; padding: 2px 12px; font-size: 12px; font-weight: 600;
  transition: all .2s ease;
}
.streak-badge.lit { background: #dcfce7; color: var(--green); }
.streak-badge.hot { background: #fef3c7; color: var(--amber); animation: pulse 1.6s ease infinite; }
@keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.06); } }
.rt-0 { color: var(--red); }
.rt-1 { color: var(--amber); }
.rt-2 { color: var(--green); }
.grade-pill { font-size: 11px; border-radius: 6px; padding: 2px 8px; font-weight: 600; }
.g-new { background: #f1f5f9; color: #64748b; }
.g-learning { background: #eef2ff; color: #4338ca; }
.g-good { background: #dcfce7; color: #16a34a; }
.g-master { background: #dbeafe; color: #2563eb; }
.g-weak { background: #fee2e2; color: #dc2626; }
.diag-text { white-space: pre-wrap; line-height: 1.7; color: var(--ink); }
</style>