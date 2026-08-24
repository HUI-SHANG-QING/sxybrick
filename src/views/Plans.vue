<script setup>
// 学习计划：可增删改、标状态（进行中/已完成/已归档），数据落 IndexedDB 并随数据包同步
import { ref, onMounted } from 'vue';
import { listPlans, createPlan, updatePlan, deletePlan } from '../repo.js';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import { toast } from '../utils/toast.js';

const plans = ref([]);
const showForm = ref(false);
const editing = ref(null);
const title = ref('');
const content = ref('');
const status = ref('active');
const activeId = ref('');

const statusMeta = {
  active: { label: '进行中', cls: 'st-active' },
  done: { label: '已完成', cls: 'st-done' },
  archived: { label: '已归档', cls: 'st-archived' },
};

async function load() { plans.value = await listPlans(); }

function openNew() {
  editing.value = null; title.value = ''; content.value = ''; status.value = 'active'; showForm.value = true;
}
function openEdit(p) {
  editing.value = p; title.value = p.title; content.value = p.content; status.value = p.status || 'active'; showForm.value = true;
}
async function save() {
  if (!title.value.trim() && !content.value.trim()) { toast('标题或内容不能都为空', 'error'); return; }
  if (editing.value) {
    await updatePlan(editing.value.id, { title: title.value, content: content.value, status: status.value });
    toast('计划已更新', 'success');
  } else {
    await createPlan({ title: title.value, content: content.value, status: status.value });
    toast('计划已创建', 'success');
  }
  showForm.value = false; await load();
}
async function setStatus(p, s) { await updatePlan(p.id, { status: s }); await load(); }
async function remove(p) { if (!confirm('删除这个计划？')) return; await deletePlan(p.id); if (activeId.value === p.id) activeId.value = ''; await load(); }

onMounted(load);
</script>

<template>
  <div class="plans-wrap">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">学习计划</h2>
      <span style="flex:1"></span>
      <button class="btn primary small" @click="openNew">＋ 新建计划</button>
    </div>

    <div class="plans-body">
      <aside class="plans-list no-print">
        <div v-if="!plans.length" class="hint" style="padding:12px">还没有计划。可在此手动创建，或在「Agent 工作台」让「复习计划编排师」帮你生成并保存。</div>
        <div v-for="p in plans" :key="p.id" class="plan-item" :class="{ active: activeId === p.id }" @click="activeId = p.id">
          <div class="plan-title">{{ p.title }}</div>
          <div class="plan-meta">
            <span class="plan-status" :class="(statusMeta[p.status] || statusMeta.active).cls">{{ (statusMeta[p.status] || statusMeta.active).label }}</span>
            <span class="plan-date">{{ new Date(p.updatedAt).toLocaleDateString() }}</span>
          </div>
        </div>
      </aside>

      <section class="plans-detail">
        <div v-if="!activeId && !showForm" class="hint" style="text-align:center;padding:60px">选择左侧计划查看详情</div>
        <template v-for="p in plans" :key="'d' + p.id">
          <div v-if="activeId === p.id" class="detail-card">
            <div class="detail-head">
              <h3 style="margin:0">{{ p.title }}</h3>
              <div style="display:flex;gap:8px">
                <button class="chip" @click="setStatus(p, 'active')">进行中</button>
                <button class="chip" @click="setStatus(p, 'done')">完成</button>
                <button class="chip" @click="setStatus(p, 'archived')">归档</button>
                <button class="btn small" @click="openEdit(p)">编辑</button>
                <button class="btn small" style="color:var(--red)" @click="remove(p)">删除</button>
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
</style>
