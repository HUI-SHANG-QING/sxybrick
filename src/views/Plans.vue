<script setup>
// 学习计划：可增删改、标状态（进行中/已完成/已归档），数据落 IndexedDB 并随数据包同步
// 含"一键自动编排"：基于真实复习数据生成阶段化计划草稿（数据驱动，零 LLM 也能用）
import { t } from '../i18n/index.js';
import { confirmDialog } from '../utils/confirm.js';
import { ref, onMounted, computed, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { listPlans, createPlan, updatePlan, deletePlan, getSubjects, listCards } from '../repo.js';
import { generateAutoPlan } from '../agent/analytics.js';
import { linkPlanToPomodoro, linkCardsToPlan, refreshPlanProgress, refreshAllPlanProgress } from '../intelligence.js';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import { toast } from '../utils/toast.js';
import EmptyState from '../components/EmptyState.vue';

const route = useRoute();
const plans = ref([]);
const loading = ref(true); // P2-30 初始加载态
const showForm = ref(false);
const editing = ref(null);
const title = ref('');
const content = ref('');
const status = ref('active');
const activeId = ref('');
const autoDays = ref(7);
const autoLoading = ref(false);
const autoMeta = ref(null);

// P2·#12 计划↔复习↔番茄联动
const linkOpen = ref(false); // 关联面板是否打开
const linkTarget = ref(null); // 当前要关联的计划
const linkSubject = ref(''); // 按科目关联
const subjects = ref([]);
const linkBusy = ref(false);

const statusMeta = {
  active: { key: 'statusActive', cls: 'st-active' },
  done: { key: 'statusDone', cls: 'st-done' },
  archived: { key: 'statusArchived', cls: 'st-archived' },
};

async function load() {
  plans.value = await listPlans();
  // 批量刷新所有开启联动的计划进度（单次 db 查询，O(N) 内存循环，避免 N 次全表扫描）
  try { await refreshAllPlanProgress(); } catch {}
  plans.value = await listPlans();
  // 联动面板仍打开时，把 linkTarget 重定向到刷新后的最新对象（防止引用旧 plan）
  if (linkTarget.value) {
    linkTarget.value = plans.value.find(p => p.id === linkTarget.value.id) || null;
  }
}

// 当前选中计划的进度（带响应式）
const activePlan = computed(() => plans.value.find(p => p.id === activeId.value) || null);

async function openLinkPanel(p) {
  linkTarget.value = p;
  linkOpen.value = true;
  if (!subjects.value.length) subjects.value = await getSubjects();
}

async function linkBySubject() {
  if (!linkTarget.value || !linkSubject.value) { toast(t('views.plans.pleaseSelectSubject'), 'error'); return; }
  if (linkBusy.value) return;
  linkBusy.value = true;
  try {
    const all = await listCards({ subject: linkSubject.value });
    const ids = all.items.map(c => c.id);
    if (!ids.length) { toast(t('views.plans.noCardsInSubject'), 'error'); return; }
    const n = await linkCardsToPlan(linkTarget.value.id, ids);
    toast(t('views.plans.linkedCards', undefined, { n, subject: linkSubject.value }), 'success');
    await load();
  } catch (e) { toast(t('views.plans.linkFail', undefined, { msg: e.message }), 'error'); }
  finally { linkBusy.value = false; }
}

async function linkDueCards() {
  if (!linkTarget.value) return;
  if (linkBusy.value) return;
  linkBusy.value = true;
  try {
    const all = await listCards({ mode: 'due' });
    const ids = all.items.map(c => c.id);
    if (!ids.length) { toast(t('views.plans.noDueCards'), 'error'); return; }
    const n = await linkCardsToPlan(linkTarget.value.id, ids);
    toast(t('views.plans.linkedDueCards', undefined, { n }), 'success');
    await load();
  } catch (e) { toast(t('views.plans.linkFail', undefined, { msg: e.message }), 'error'); }
  finally { linkBusy.value = false; }
}

async function enablePomoLink() {
  if (!linkTarget.value) return;
  const tag = await linkPlanToPomodoro(linkTarget.value.id);
  toast(t('views.plans.pomoLinkOn', undefined, { tag }), 'success');
  await load();
}

async function refreshProgress() {
  if (!linkTarget.value) return;
  const p = await refreshPlanProgress(linkTarget.value.id);
  if (p) {
    const pomo = p.pomoMinutes ? t('views.plans.pomoMinutes', undefined, { n: p.pomoMinutes }) : '';
    toast(t('views.plans.refreshProgress', undefined, { reviewed: p.reviewed, total: p.total, pomo }), 'info');
  }
  await load();
}

function openNew() {
  editing.value = null; title.value = ''; content.value = ''; status.value = 'active'; showForm.value = true;
}
function openEdit(p) {
  editing.value = p; title.value = p.title; content.value = p.content; status.value = p.status || 'active'; showForm.value = true;
}
async function save() {
  if (!title.value.trim() && !content.value.trim()) { toast(t('views.plans.titleOrContentEmpty'), 'error'); return; }
  try {
  if (editing.value) {
    await updatePlan(editing.value.id, { title: title.value, content: content.value, status: status.value });
    toast(t('views.plans.planUpdated'), 'success');
  } else {
    await createPlan({ title: title.value, content: content.value, status: status.value });
    toast(t('views.plans.planCreated'), 'success');
  }
  showForm.value = false; await load();
  } catch (e) { toast(t('views.plans.saveFail', undefined, { msg: e.message }), 'error'); }
}
async function setStatus(p, s) { await updatePlan(p.id, { status: s }); await load(); }
async function remove(p) { if (!(await confirmDialog(t('views.plans.confirmDelete')))) return; await deletePlan(p.id); if (activeId.value === p.id) activeId.value = ''; await load(); }

// 一键自动编排：拉取跨模块数据，生成阶段化计划草稿，直接落库
async function runAutoPlan() {
  autoLoading.value = true;
  autoMeta.value = null;
  try {
    const r = await generateAutoPlan(autoDays.value);
    const p = await createPlan({ title: r.title, content: r.content, status: 'active' });
    autoMeta.value = r.meta;
    activeId.value = p.id;
    toast(t('views.plans.autoPlanSaved', undefined, { title: r.title }), 'success');
    await load();
  } catch (e) { toast(t('views.plans.genFail', undefined, { msg: e.message }), 'error'); }
  finally { autoLoading.value = false; }
}

// 搜索结果跳转：URL ?id=xxx 自动选中对应计划并展开详情
async function applyRouteId() {
  await load();
  const id = route.query?.id ? String(route.query.id) : '';
  if (!id) return;
  await nextTick();
  const hit = plans.value.find(p => p.id === id);
  if (hit) activeId.value = hit.id;
}
onMounted(async () => { loading.value = true; try { await applyRouteId(); } finally { loading.value = false; } });
</script>

<template>
  <div class="plans-wrap" v-loading="loading" :element-loading-text="t('views.plans.loading')">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">{{ t('views.plans.title') }}</h2>
      <span style="flex:1"></span>
      <div style="display:flex;align-items:center;gap:6px">
        <select v-model.number="autoDays" class="input" style="width:auto">
          <option :value="3">{{ t('views.plans.optDays', undefined, { n: 3 }) }}</option>
          <option :value="7">{{ t('views.plans.optDays', undefined, { n: 7 }) }}</option>
          <option :value="14">{{ t('views.plans.optDays', undefined, { n: 14 }) }}</option>
          <option :value="30">{{ t('views.plans.optDays', undefined, { n: 30 }) }}</option>
        </select>
        <button class="btn small" :disabled="autoLoading" @click="runAutoPlan" :title="t('views.plans.autoGenTitle')">{{ autoLoading ? t('views.plans.genLoading') : t('views.plans.autoGenerate') }}</button>
      </div>
      <button class="btn primary small" @click="openNew">{{ t('views.plans.newPlanBtn') }}</button>
    </div>
    <div v-if="autoMeta" class="auto-meta">
      <span>{{ t('views.plans.focusPrefix') }}<b>{{ autoMeta.focusSubject || t('views.plans.focusAll') }}</b></span>
      <span>{{ t('views.plans.dailyLoad', undefined, { n: autoMeta.dailyDue }) }}</span>
      <span>{{ t('views.plans.riskCount', undefined, { n: autoMeta.riskCount }) }}</span>
      <span>{{ t('views.plans.weakCount', undefined, { n: autoMeta.weakCount }) }}</span>
      <span v-if="autoMeta.graphUsed">{{ t('views.plans.graphEdges', undefined, { n: autoMeta.graphEdgesUsed }) }}</span>
    </div>

    <div class="plans-body">
      <aside class="plans-list no-print">
        <EmptyState v-if="!plans.length" icon="🎯" :title="t('views.plans.emptyTitle')" :message="t('views.plans.emptyMsg')" />
        <div v-for="p in plans" :key="p.id" class="plan-item" :class="{ active: activeId === p.id }" @click="activeId = p.id">
          <div class="plan-title">{{ p.title }}</div>
          <div class="plan-meta">
            <span class="plan-status" :class="(statusMeta[p.status] || statusMeta.active).cls">{{ t('views.plans.' + (statusMeta[p.status] || statusMeta.active).key) }}</span>
            <span class="plan-date">{{ new Date(p.updatedAt).toLocaleDateString() }}</span>
          </div>
        </div>
      </aside>

      <section class="plans-detail">
        <EmptyState v-if="!activeId && !showForm" icon="🎯" :title="t('views.plans.selectPlanTitle')" :message="t('views.plans.selectPlanMsg')" />
        <template v-for="p in plans" :key="'d' + p.id">
          <div v-if="activeId === p.id" class="detail-card">
            <div class="detail-head">
              <h3 style="margin:0">{{ p.title }}</h3>
              <div style="display:flex;gap:8px">
                <button class="chip" @click="setStatus(p, 'active')">{{ t('views.plans.statusActive') }}</button>
                <button class="chip" @click="setStatus(p, 'done')">{{ t('views.plans.chipDone') }}</button>
                <button class="chip" @click="setStatus(p, 'archived')">{{ t('views.plans.chipArchived') }}</button>
                <button class="btn small" @click="openLinkPanel(p)" :title="t('views.plans.linkBtnTitle')">{{ t('views.plans.linkBtn') }}</button>
                <button class="btn small" @click="openEdit(p)">{{ t('views.plans.editBtn') }}</button>
                <button class="btn small" style="color:var(--red)" @click="remove(p)">{{ t('views.plans.deleteBtn') }}</button>
              </div>
            </div>
            <div v-if="p.autoProgress && p.progress" class="plan-progress-box">
              <div class="plan-progress-head">
                <span class="hint">{{ t('views.plans.reviewProgress') }}</span>
                <span style="flex:1"></span>
                <span class="hint">{{ t('views.plans.progressCount', undefined, { reviewed: p.progress.reviewed, total: p.progress.total, pct: p.progress.pct }) }}</span>
                <span v-if="p.progress.pomoMinutes" class="hint" style="margin-left:8px">{{ t('views.plans.pomoMinutes', undefined, { n: p.progress.pomoMinutes }) }}</span>
              </div>
              <div class="plan-progress-bar">
                <div class="plan-progress-fill" :style="{ width: p.progress.pct + '%' }"></div>
              </div>
            </div>
            <MarkdownRenderer :content="p.content || t('views.plans.noContent')" />
          </div>
        </template>
      </section>
    </div>

    <teleport to="body">
      <div v-if="showForm" class="modal-mask" @click.self="showForm = false">
        <div class="modal">
          <h3>{{ editing ? t('views.plans.modalEditTitle') : t('views.plans.modalNewTitle') }}</h3>
          <div class="field-label">{{ t('views.plans.fieldTitle') }}</div>
          <input v-model="title" class="input" :placeholder="t('views.plans.titlePlaceholder')" />
          <div class="field-label">{{ t('views.plans.fieldContent') }}</div>
          <textarea v-model="content" class="input" rows="8" :placeholder="t('views.plans.contentPlaceholder')"></textarea>
          <div class="field-label">{{ t('views.plans.fieldStatus') }}</div>
          <select v-model="status" class="input">
            <option value="active">{{ t('views.plans.statusActive') }}</option>
            <option value="done">{{ t('views.plans.statusDone') }}</option>
            <option value="archived">{{ t('views.plans.statusArchived') }}</option>
          </select>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
            <button class="btn" @click="showForm = false">{{ t('views.plans.cancelBtn') }}</button>
            <button class="btn primary" @click="save">{{ t('views.plans.saveBtn') }}</button>
          </div>
        </div>
      </div>
      <!-- P2·#12 联动面板 -->
      <div v-if="linkOpen && linkTarget" class="modal-mask" @click.self="linkOpen = false">
        <div class="modal">
          <h3>{{ t('views.plans.linkTitle') }}</h3>
          <p class="hint" style="margin:4px 0 12px">{{ t('views.plans.linkHint') }}</p>
          <div v-if="linkTarget.autoProgress" class="link-on-box">
            <span>{{ t('views.plans.linkOn') }}</span>
            <span v-if="linkTarget.progress" class="hint">
              {{ t('views.plans.linkOnProgress', undefined, { reviewed: linkTarget.progress.reviewed, total: linkTarget.progress.total, pomo: linkTarget.progress.pomoMinutes || 0 }) }}
            </span>
            <span style="flex:1"></span>
            <button class="btn small" @click="refreshProgress">🔄 {{ t('views.plans.refreshBtn') }}</button>
          </div>
          <div class="field-label">{{ t('views.plans.linkSubjectLabel') }}</div>
          <div style="display:flex;gap:8px;align-items:center">
            <select v-model="linkSubject" class="input" style="width:auto;flex:1">
              <option value="">{{ t('views.plans.selectSubject') }}</option>
              <option v-for="s in subjects" :key="s.name" :value="s.name">{{ t('views.plans.subjectCount', undefined, { name: s.name, count: s.count }) }}</option>
            </select>
            <button class="btn small primary" :disabled="linkBusy || !linkSubject" @click="linkBySubject">{{ t('views.plans.linkBtn2') }}</button>
          </div>
          <div class="field-label" style="margin-top:12px">{{ t('views.plans.quickLinkLabel') }}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn small" :disabled="linkBusy" @click="linkDueCards" :title="t('views.plans.linkDueTitle')">{{ t('views.plans.linkDueBtn') }}</button>
            <button class="btn small" :disabled="linkBusy" @click="enablePomoLink" :title="t('views.plans.pomoLinkTitle')">{{ t('views.plans.pomoLinkBtn') }}</button>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
            <button class="btn" @click="linkOpen = false">{{ t('views.plans.closeBtn') }}</button>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.plans-wrap { max-width: 1000px; margin: 0 auto; }
.plans-body { display: grid; grid-template-columns: 240px 1fr; gap: 12px; margin-top: 14px; }
.plans-list { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 10px; overflow-y: auto; max-height: calc(100vh - 200px); }
.plan-item { padding: 10px; border-radius: 8px; cursor: pointer; margin-bottom: 6px; border: 1px solid transparent; }
.plan-item:hover { background: var(--code-inline); }
.plan-item.active { background: var(--code-bg); border-color: var(--accent); }
.plan-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.plan-meta { display: flex; gap: 8px; margin-top: 4px; align-items: center; }
.plan-status { font-size: 11px; border-radius: 4px; padding: 1px 6px; }
.st-active { background: #e0f2fe; color: #0369a1; }
.st-done { background: #dcfce7; color: #16a34a; }
.st-archived { background: #f1f5f9; color: #64748b; }
.plan-date { font-size: 11px; color: var(--ink-2); }
.plans-detail { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 20px; overflow-y: auto; }
.detail-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.chip { font-size: 12px; border: 1px solid var(--line); background: var(--panel); border-radius: 999px; padding: 3px 10px; cursor: pointer; }
@media (max-width: 720px) { .plans-body { grid-template-columns: 1fr; } }
/* P2·#12 计划联动进度条 + 联动面板 */
.plan-progress-box { margin: 12px 0; padding: 10px 12px; background: var(--code-bg); border-radius: 8px; }
.plan-progress-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.plan-progress-bar { height: 8px; background: var(--line); border-radius: 4px; margin-top: 8px; overflow: hidden; }
.plan-progress-fill { height: 100%; background: var(--accent); transition: width 0.3s ease; }
.link-on-box { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px; background: var(--code-inline); border-radius: 6px; margin-bottom: 12px; font-size: 13px; }
.auto-meta { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--ink-2); margin: 8px 0 0; padding: 8px 12px; background: var(--code-bg); border-radius: 8px; }
.detail-card { padding: 4px 0; }
</style>
