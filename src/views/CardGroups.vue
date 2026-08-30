<script setup>
// M1 卡组管理：自定义分组（多对多）+ active/archived 状态
// 核心规则：卡片全局唯一，学习数据不随分组隔离；archived（备用）组内的卡不进默认复习队列
import { ref, computed, onMounted } from 'vue';
import { toast } from '../utils/toast.js';
import { confirmDialog } from '../utils/confirm.js';
import CardModal from '../components/CardModal.vue';
import {
  listCardGroups, createCardGroup, updateCardGroup, deleteCardGroup,
  cardGroupCardIds, setCardGroups,
} from '../repo.js';

const groups = ref([]);
const cardsCache = ref(new Map()); // groupId -> 组内卡片（懒加载）
const loading = ref(true);

// 新建/编辑表单
const editing = ref(null); // null=新建, 'id'=编辑
const form = ref({ name: '', description: '', color: '#4f7cff', status: 'active' });
const PALETTE = ['#4f7cff', '#2fbf71', '#e6a23c', '#f56c6c', '#9b59b6', '#16a085', '#e67e22', '#607d8b'];

async function reload() {
  loading.value = true;
  try {
    groups.value = await listCardGroups();
    // 默认展开第一个卡组，进入即看到组内卡片完整预览
    if (groups.value.length && !expanded.value) await toggleExpand(groups.value[0]);
  } finally {
    loading.value = false;
  }
}

function startCreate() {
  editing.value = null;
  form.value = { name: '', description: '', color: PALETTE[groups.value.length % PALETTE.length], status: 'active' };
}
function startEdit(g) {
  editing.value = g.id;
  form.value = { name: g.name, description: g.description || '', color: g.color || PALETTE[0], status: g.status };
}
function closeEdit() { editing.value = null; }

async function saveForm() {
  try {
    if (editing.value === null) {
      await createCardGroup(form.value);
      toast('卡组已创建', 'success');
    } else {
      await updateCardGroup(editing.value, form.value);
      toast('卡组已更新', 'success');
    }
    closeEdit();
    await reload();
  } catch (e) {
    toast(e.message || '保存失败', 'error');
  }
}

async function toggleStatus(g) {
  const next = g.status === 'active' ? 'archived' : 'active';
  await updateCardGroup(g.id, { status: next });
  toast(next === 'archived' ? `「${g.name}」已转备用（组内卡不进默认复习）` : `「${g.name}」已恢复背诵`, 'success');
  await reload();
}

async function remove(g) {
  if (!(await confirmDialog(`删除卡组「${g.name}」？组内卡片本身不会被删除，仅解除关联。`))) return;
  await deleteCardGroup(g.id);
  toast('卡组已删除', 'success');
  await reload();
}

// 查看组内卡片（懒加载 + 可移出 + 点击编辑）
const expanded = ref('');
const expandedCards = ref([]);
async function loadGroupCards(g) {
  const ids = await cardGroupCardIds(g.id);
  const { db } = await import('../db.js');
  expandedCards.value = (await db.cards.bulkGet(ids)).filter(Boolean);
}
async function toggleExpand(g) {
  if (expanded.value === g.id) { expanded.value = ''; expandedCards.value = []; return; }
  expanded.value = g.id;
  await loadGroupCards(g);
}
async function removeCard(g, card) {
  await setCardGroups([card.id], [], [g.id]);
  toast(`已从「${g.name}」移出`, 'success');
  await loadGroupCards(g);
}

// 点击卡片 → 打开编辑弹窗（CardModal），保存后刷新预览
const editCard = ref(null);
const cardModalOpen = ref(false);
function openCard(c) { editCard.value = c; cardModalOpen.value = true; }
async function onCardSaved() {
  const g = groups.value.find(x => x.id === expanded.value);
  if (g) await loadGroupCards(g);
}

onMounted(reload);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>卡组</h1>
        <div class="hint">把卡片分到不同卡组（可多组）；「备用」卡组暂停背诵，随时恢复。卡片学习数据全局共享，分组不影响复习进度。</div>
      </div>
      <button class="btn btn-primary" @click="startCreate">＋ 新建卡组</button>
    </div>

    <!-- 新建/编辑 -->
    <div v-if="editing !== null" class="group-form">
      <div class="field-label">名称 *</div>
      <input v-model="form.name" class="input" maxlength="30" placeholder="如：数二 · 高数" @keyup.enter="saveForm" />
      <div class="field-label">描述（可选）</div>
      <input v-model="form.description" class="input" maxlength="60" placeholder="如：2027 考研数二" />
      <div class="field-label">颜色</div>
      <div class="palette">
        <button v-for="c in PALETTE" :key="c" type="button" class="pal-dot"
                :class="{ on: form.color === c }" :style="{ background: c }" @click="form.color = c"></button>
      </div>
      <div class="field-label">状态</div>
      <div class="chip-row">
        <button class="chip" :class="{ on: form.status === 'active' }" @click="form.status = 'active'">背诵中</button>
        <button class="chip" :class="{ on: form.status === 'archived' }" @click="form.status = 'archived'">备用（暂停）</button>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" @click="saveForm">{{ editing === null ? '创建' : '保存' }}</button>
        <button class="btn" @click="closeEdit">取消</button>
      </div>
    </div>

    <div v-else-if="loading" class="hint">加载中…</div>
    <div v-else-if="!groups.length" class="empty">
      还没有卡组。创建一个卡组，把卡片按「科目/模块/考试」分组管理。
    </div>

    <div v-else class="group-list">
      <div v-for="g in groups" :key="g.id" class="group-item">
        <div class="group-main">
          <span class="g-dot" :style="{ background: g.color || '#4f7cff' }"></span>
          <div class="g-info">
            <div class="g-name">
              {{ g.name }}
              <span class="chip chip-sm" :class="g.status === 'active' ? 'on' : ''">{{ g.status === 'active' ? '背诵中' : '备用' }}</span>
            </div>
            <div v-if="g.description" class="hint">{{ g.description }}</div>
          </div>
          <button class="chip" @click="toggleExpand(g)">{{ expanded === g.id ? '收起 ▲' : '卡片 ▼' }}</button>
        </div>
        <div class="group-actions">
          <button class="btn" @click="startEdit(g)">编辑</button>
          <button class="btn" @click="toggleStatus(g)">{{ g.status === 'active' ? '转备用' : '恢复' }}</button>
          <button class="btn btn-danger" @click="remove(g)">删除</button>
        </div>

        <!-- 组内卡片 -->
        <div v-if="expanded === g.id" class="group-cards">
          <div v-if="!expandedCards.length" class="hint">组内还没有卡片——到「卡片」页多选后移入此组，或编辑卡片时添加。</div>
          <div v-for="c in expandedCards" :key="c.id" class="gc-row">
            <div class="gc-text" @click="openCard(c)" title="点击编辑">
              <div class="gc-front">{{ c.front }}</div>
              <div class="gc-back">{{ c.back }}</div>
              <div v-if="c.tags && c.tags.length" class="gc-tags">
                <span v-for="t in c.tags" :key="t" class="gc-tag">#{{ t }}</span>
              </div>
            </div>
            <button class="btn" @click="removeCard(g, c)">移出</button>
          </div>
        </div>
      </div>
    </div>
    <CardModal v-model="cardModalOpen" :card="editCard" @saved="onCardSaved" />
  </div>
</template>

<style scoped>
.group-form { border: 1px solid var(--line); border-radius: 12px; padding: 14px; margin-bottom: 16px; background: var(--panel); }
.palette { display: flex; gap: 8px; margin: 6px 0 12px; }
.pal-dot { width: 24px; height: 24px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; }
.pal-dot.on { border-color: var(--ink); transform: scale(1.15); }
.chip-row { display: flex; gap: 8px; margin-bottom: 12px; }
.form-actions { display: flex; gap: 8px; }
.group-list { display: flex; flex-direction: column; gap: 10px; }
.group-item { border: 1px solid var(--line); border-radius: 12px; padding: 12px; background: var(--panel); }
.group-main { display: flex; align-items: center; gap: 10px; }
.g-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
.g-info { flex: 1; min-width: 0; }
.g-name { font-weight: 600; display: flex; align-items: center; gap: 8px; }
.group-actions { display: flex; gap: 6px; flex-shrink: 0; }
.group-cards { margin-top: 10px; border-top: 1px dashed var(--line); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.gc-row { display: flex; align-items: flex-start; gap: 8px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
.gc-text { flex: 1; min-width: 0; cursor: pointer; line-height: 1.55; }
.gc-text:hover { background: var(--panel); }
.gc-front { font-weight: 600; color: var(--ink); white-space: pre-wrap; word-break: break-word; }
.gc-back { color: var(--ink-2); white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
.gc-tags { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
.gc-tag { font-size: 11px; color: var(--accent, #1677ff); background: color-mix(in srgb, var(--accent, #1677ff) 10%, transparent); border-radius: 6px; padding: 0 6px; }
.chip-sm { font-size: 11px; padding: 0 6px; }
.empty { padding: 40px 0; text-align: center; color: var(--ink-2); }
</style>
