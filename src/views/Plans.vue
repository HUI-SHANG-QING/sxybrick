<script setup>
// 学习计划：可增删改、标状态（进行中/已完成/已归档），数据落 IndexedDB 并随数据包同步
// 含"一键自动编排"：基于真实复习数据生成阶段化计划草稿（数据驱动，零 LLM 也能用）
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
  active: { label: '进行中', cls: 'st-active' },
  done: { label: '已完成', cls: 'st-done' },
  archived: { label: '已归档', cls: 'st-archived' },
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
  if (!linkTarget.value || !linkSubject.value) { toast('请选择科目', 'error'); return; }
  if (linkBusy.value) return;
  linkBusy.value = true;
  try {
    const all = await listCards({ subject: linkSubject.value });
    const ids = all.items.map(c => c.id);
    if (!ids.length) { toast('该科目下没有卡片', 'error'); return; }
    const n = await linkCardsToPlan(linkTarget.value.id, ids);
    toast(`已关联 ${n} 张卡片（${linkSubject.value}）`, 'success');
    await load();
  } catch (e) { toast('关联失败：' + e.message, 'error'); }
  finally { linkBusy.value = false; }
}

async function linkDueCards() {
  if (!linkTarget.value) return;
  if (linkBusy.value) return;
  linkBusy.value = true;
  try {
    const all = await listCards({ mode: 'due' });
    const ids = all.items.map(c => c.id);
    if (!ids.length) { toast('当前没有到期卡片', 'error'); return; }
    const n = await linkCardsToPlan(linkTarget.value.id, ids);
    toast(`已关联 ${n} 张到期卡片（复习联动已开启）`, 'success');
    await load();
  } catch (e) { toast('关联失败：' + e.message, 'error'); }
  finally { linkBusy.value = false; }
}

async function enablePomoLink() {
  if (!linkTarget.value) return;
  const tag = await linkPlanToPomodoro(linkTarget.value.id);
  toast(`已开启番茄联动，tag: ${tag}（在番茄页选此 tag 即可联动）`, 'success');
  await load();
}

async function refreshProgress() {
  if (!linkTarget.value) return;
  const p = await refreshPlanProgress(linkTarget.value.id);
  if (p) toast(`进度刷新：复习 ${p.reviewed}/${p.total} 张${p.pomoMinutes ? `·专注 ${p.pomoMinutes} 分钟` : ''}`, 'info');
  await load();
}

function openNew() {
  editing.value = null; title.value = ''; content.value = ''; status.value = 'active'; showForm.value = true;
}
function openEdit(p) {
  editing.value = p; title.value = p.title; content.value = p.content; status.value = p.status || 'active'; showForm.value = true;
}
async function save() {
  if (!title.value.trim() && !content.value.trim()) { toast('标题或内容不能都为空', 'error'); return; }
  try {
  if (editing.value) {
    await updatePlan(editing.value.id, { title: title.value, content: content.value, status: status.value });
    toast('计划已更新', 'success');
  } else {
    await createPlan({ title: title.value, content: content.value, status: status.value });
    toast('计划已创建', 'success');
  }
  showForm.value = false; await load();
  } catch (e) { toast('保存失败：' + e.message, 'error'); }
}
async function setStatus(p, s) { await updatePlan(p.id, { status: s }); await load(); }
async function remove(p) { if (!(await confirmDialog('删除这个计划？'))) return; await deletePlan(p.id); if (activeId.value === p.id) activeId.value = ''; await load(); }

// 一键自动编排：拉取跨模块数据，生成阶段化计划草稿，直接落库
async function runAutoPlan() {
  autoLoading.value = true;
  autoMeta.value = null;
  try {
    const r = await generateAutoPlan(autoDays.value);
    const p = await createPlan({ title: r.title, content: r.content, status: 'active' });
    autoMeta.value = r.meta;
    activeId.value = p.id;
    toast(`已生成并保存「${r.title}」`, 'success');
    await load();
  } catch (e) { toast('生成失败：' + e.message, 'error'); }
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
  <div class="plans-wrap" v-loading="loading" element-loading-text="加载中…">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">学习计划</h2>
      <span style="flex:1"></span>
      <div style="display:flex;align-items:center;gap:6px">
        <select v-model.number="autoDays" class="input" style="width:auto">
          <option :value="3">3 天</option>
          <option :value="7">7 天</option>
          <option :value="14">14 天</option>
          <option :value="30">30 天</option>
        </select>
        <button class="btn small" :disabled="autoLoading" @click="runAutoPlan" title="基于你的复习数据自动生成阶段化计划草稿">{{ autoLoading ? '生成中…' : '一键自动编排' }}</button>
      </div>
      <button class="btn primary small" @click="openNew">＋ 新建计划</button>
    </div>
    <div v-if="autoMeta" class="auto-meta">
      <span>重点：<b>{{ autoMeta.focusSubject || '综合' }}</b></span>
      <span>每日负载：约 {{ autoMeta.dailyDue }} 张</span>
      <span>遗忘风险：{{ autoMeta.riskCount }} 张</span>
      <span>高频错题：{{ autoMeta.weakCount }} 张</span>
      <span v-if="autoMeta.graphUsed">图驱动：用 {{ autoMeta.graphEdgesUsed }} 条边</span>
    </div>

    <div class="plans-body">
      <aside class="plans-list no-print">
        <EmptyState v-if="!plans.length" icon="🎯" title="还没有计划" message="可在此手动创建，或在「Agent 工作台」让「复习计划编排师」帮你生成并保存" />
        <div v-for="p in plans" :key="p.id" class="plan-item" :class="{ active: activeId === p.id }" @click="activeId = p.id">
          <div class="plan-title">{{ p.title }}</div>
          <div class="plan-meta">
            <span class="plan-status" :class="(statusMeta[p.status] || statusMeta.active).cls">{{ (statusMeta[p.status] || statusMeta.active).label }}</span>
            <span class="plan-date">{{ new Date(p.updatedAt).toLocaleDateString() }}</span>
          </div>
        </div>
      </aside>

      <section class="plans-detail">
        <EmptyState v-if="!activeId && !showForm" icon="🎯" title="选择左侧计划" message="查看详情，或点「＋ 新建计划」开始制定" />
        <template v-for="p in plans" :key="'d' + p.id">
          <div v-if="activeId === p.id" class="detail-card">
            <div class="detail-head">
              <h3 style="margin:0">{{ p.title }}</h3>
              <div style="display:flex;gap:8px">
                <button class="chip" @click="setStatus(p, 'active')">进行中</button>
                <button class="chip" @click="setStatus(p, 'done')">完成</button>
                <button class="chip" @click="setStatus(p, 'archived')">归档</button>
                <button class="btn small" @click="openLinkPanel(p)" title="关联卡片/番茄，开启自动进度">🔗 联动</button>
                <button class="btn small" @click="openEdit(p)">编辑</button>
                <button class="btn small" style="color:var(--red)" @click="remove(p)">删除</button>
              </div>
            </div>
            <div v-if="p.autoProgress && p.progress" class="plan-progress-box">
              <div class="plan-progress-head">
                <span class="hint">复习进度</span>
                <span style="flex:1"></span>
                <span class="hint">{{ p.progress.reviewed }} / {{ p.progress.total }} 张 · {{ p.progress.pct }}%</span>
                <span v-if="p.progress.pomoMinutes" class="hint" style="margin-left:8px">· 番茄 {{ p.progress.pomoMinutes }} 分钟</span>
              </div>
              <div class="plan-progress-bar">
                <div class="plan-progress-fill" :style="{ width: p.progress.pct + '%' }"></div>
              </div>
            </div>
            <MarkdownRenderer :content="p.content || '（无内容）'" />
          </div>
        </template>
      </section>
    </div>

    <teleport to="body">
      <div v-if="showForm" class="modal-mask" @click.self="showForm = false">
        <div class="modal">
          <h3>{{ editing ? '编辑计划' : '新建计划' }}</h3>
          <div class="field-label">标题</div>
          <input v-model="title" class="input" placeholder="如：408 冲刺复习计划" />
          <div class="field-label">内容（支持 Markdown）</div>
          <textarea v-model="content" class="input" rows="8" placeholder="分阶段目标 / 每日任务 / 里程碑…"></textarea>
          <div class="field-label">状态</div>
          <select v-model="status" class="input">
            <option value="active">进行中</option>
            <option value="done">已完成</option>
            <option value="archived">已归档</option>
          </select>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
            <button class="btn" @click="showForm = false">取消</button>
            <button class="btn primary" @click="save">保存</button>
          </div>
        </div>
      </div>
      <!-- P2·#12 联动面板 -->
      <div v-if="linkOpen && linkTarget" class="modal-mask" @click.self="linkOpen = false">
        <div class="modal">
          <h3>🔗 计划联动设置</h3>
          <p class="hint" style="margin:4px 0 12px">关联卡片后，复习该卡片时自动更新计划进度；关联番茄后，番茄会话也计入计划。</p>
          <div v-if="linkTarget.autoProgress" class="link-on-box">
            <span>联动已开启</span>
            <span v-if="linkTarget.progress" class="hint">
              · 复习 {{ linkTarget.progress.reviewed }}/{{ linkTarget.progress.total }} 张 · 番茄 {{ linkTarget.progress.pomoMinutes || 0 }} 分钟
            </span>
            <span style="flex:1"></span>
            <button class="btn small" @click="refreshProgress">🔄 刷新进度</button>
          </div>
          <div class="field-label">按科目关联卡片</div>
          <div style="display:flex;gap:8px;align-items:center">
            <select v-model="linkSubject" class="input" style="width:auto;flex:1">
              <option value="">选择科目</option>
              <option v-for="s in subjects" :key="s.name" :value="s.name">{{ s.name }}（{{ s.count }} 张）</option>
            </select>
            <button class="btn small primary" :disabled="linkBusy || !linkSubject" @click="linkBySubject">关联</button>
          </div>
          <div class="field-label" style="margin-top:12px">快捷关联</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn small" :disabled="linkBusy" @click="linkDueCards" title="把当前所有到期卡片关联到这个计划">关联今日到期卡</button>
            <button class="btn small" :disabled="linkBusy" @click="enablePomoLink" title="开启番茄联动，在番茄页选此 tag 即可">🔗 番茄联动</button>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
            <button class="btn" @click="linkOpen = false">关闭</button>
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
