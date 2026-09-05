<script setup>
// 词组管理（仿卡组）：多对多分组，active/archived 状态，成员增删。
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { t } from '../i18n/index.js';
import { toast } from '../utils/toast.js';
import { confirmDialog } from '../utils/confirm.js';
import {
  listWordGroups, createWordGroup, updateWordGroup, deleteWordGroup,
  wordGroupCardIds, setWordGroups, listWordCards,
} from '../word-repo.js';

const router = useRouter();
const groups = ref([]);
const loading = ref(true);
const expanded = ref('');
// 成员编辑：跳单词本并带 ?edit=<id>，WordBook onMounted 接住后自动打开该词编辑弹窗
// （与卡组页「点成员 → CardModal 编辑」对等）
function editMember(w) {
  router.push(`/english/book?edit=${w.id}`);
}

const editing = ref(null);
const editOpen = ref(false);
const form = ref({ name: '', description: '', color: '#4f7cff', status: 'active' });
const PALETTE = ['#4f7cff', '#2fbf71', '#e6a23c', '#f56c6c', '#9b59b6', '#16a085', '#e67e22', '#607d8b'];

const members = ref({}); // groupId -> words[]

async function reload() {
  loading.value = true;
  try {
    groups.value = await listWordGroups();
    if (groups.value.length && !expanded.value) expanded.value = groups.value[0].id;
    await refreshMembers();
  } finally {
    loading.value = false;
  }
}
async function refreshMembers() {
  members.value = {};
  for (const g of groups.value) {
    const ids = await wordGroupCardIds(g.id);
    const ws = ids.length ? await listWordCards({}) : [];
    const byId = new Map(ws.map(w => [w.id, w]));
    members.value[g.id] = ids.map(id => byId.get(id)).filter(Boolean);
  }
}

function startCreate() {
  editing.value = null;
  editOpen.value = true;
  form.value = { name: '', description: '', color: PALETTE[groups.value.length % PALETTE.length], status: 'active' };
}
function startEdit(g) {
  editing.value = g.id;
  editOpen.value = true;
  form.value = { name: g.name, description: g.description || '', color: g.color || PALETTE[0], status: g.status };
}
async function saveForm() {
  try {
    if (editing.value === null) { await createWordGroup(form.value); toast(t('views.wordGroups.created'), 'success'); }
    else { await updateWordGroup(editing.value, form.value); toast(t('views.wordGroups.updated'), 'success'); }
    editing.value = null;
    editOpen.value = false;
    await reload();
  } catch (e) { toast(e.message || t('views.wordGroups.saveFailed'), 'error'); }
}
async function toggleStatus(g) {
  const next = g.status === 'active' ? 'archived' : 'active';
  await updateWordGroup(g.id, { status: next });
  toast(next === 'archived' ? t('views.wordGroups.toArchived') : t('views.wordGroups.restore'), 'success');
  await reload();
}
async function remove(g) {
  if (!(await confirmDialog(t('views.wordGroups.deleteConfirm', undefined, { name: g.name })))) return;
  await deleteWordGroup(g.id);
  toast(t('views.wordGroups.deleted'), 'success');
  await reload();
}
async function toggleExpand(g) { expanded.value = expanded.value === g.id ? '' : g.id; await refreshMembers(); }

// 添加成员
const addOpen = ref(false);
const addGroup = ref(null);
const allWords = ref([]);
const addChecks = ref({});
async function openAdd(g) {
  addGroup.value = g;
  allWords.value = await listWordCards({});
  const ids = new Set(await wordGroupCardIds(g.id));
  addChecks.value = Object.fromEntries(allWords.value.map(w => [w.id, ids.has(w.id)]));
  addOpen.value = true;
}
async function saveAdd() {
  const ids = allWords.value.filter(w => addChecks.value[w.id]).map(w => w.id);
  await setWordGroups(ids, [addGroup.value.id], []);
  toast(t('views.wordGroups.updated'), 'success');
  addOpen.value = false;
  await reload();
}
async function removeMember(g, w) {
  if (!(await confirmDialog(t('views.wordGroups.removeMemberConfirm', undefined, { name: g.name })))) return;
  await setWordGroups([w.id], [], [g.id]);
  toast(t('views.wordGroups.removed'), 'success');
  await reload();
}

onMounted(reload);
</script>

<template>
  <div class="gp">
    <header class="gp-head">
      <div>
        <h1>{{ t('views.wordGroups.title') }}</h1>
        <p class="sub">{{ t('views.wordGroups.subtitle') }}</p>
      </div>
      <el-button type="primary" @click="startCreate">{{ t('views.wordGroups.createBtn') }}</el-button>
    </header>

    <section v-if="loading" class="empty">{{ t('views.wordGroups.loading') }}</section>
    <section v-else-if="!groups.length" class="empty">
      <p>{{ t('views.wordGroups.empty') }}</p>
    </section>
    <section v-else class="list">
      <article v-for="g in groups" :key="g.id" class="g">
        <div class="grow" @click="toggleExpand(g)">
          <span class="dot" :style="{ background: g.color }"></span>
          <b class="name">{{ g.name }}</b>
          <span v-if="g.status === 'archived'" class="chip">{{ t('views.wordGroups.archivedChip') }}</span>
          <span class="cnt">{{ t('views.wordGroups.members', undefined, { n: (members[g.id] || []).length }) }}</span>
          <!-- 与卡组页对齐：列表展示描述（此前描述只在编辑表单里，列表看不见） -->
          <span v-if="g.description" class="gdesc">{{ g.description }}</span>
          <span class="ca">{{ expanded === g.id ? t('views.wordGroups.collapse') : t('views.wordGroups.expand') }}</span>
        </div>
        <div class="gacts">
          <el-button size="small" @click.stop="startEdit(g)">{{ t('views.wordGroups.edit') }}</el-button>
          <el-button size="small" @click.stop="toggleStatus(g)">{{ g.status === 'active' ? t('views.wordGroups.statusArchived') : t('views.wordGroups.statusActive') }}</el-button>
          <el-button size="small" type="danger" plain @click.stop="remove(g)">{{ t('views.wordGroups.delete') }}</el-button>
        </div>

        <div v-if="expanded === g.id" class="mem">
          <el-button size="small" @click="openAdd(g)">{{ t('views.wordGroups.addMember') }}</el-button>
          <p v-if="!members[g.id] || !members[g.id].length" class="hint">{{ t('views.wordGroups.noMembers') }}</p>
          <div v-for="w in members[g.id]" :key="w.id" class="mw">
            <span class="w">{{ w.word }}</span>
            <span class="m">{{ w.meaning }}</span>
            <!-- 与卡组页对齐：成员可直接点开编辑（跳转单词本编辑弹窗） -->
            <button class="ed" @click.stop="editMember(w)">{{ t('views.wordGroups.editMember') }}</button>
            <button class="rm" @click="removeMember(g, w)">{{ t('views.wordGroups.remove') }}</button>
          </div>
        </div>
      </article>
    </section>

    <!-- 新建 / 编辑 -->
    <el-dialog v-model="editOpen" :title="editing === null ? t('views.wordGroups.createTitle') : t('views.wordGroups.editTitle')" width="520px">
      <div class="form">
        <label>{{ t('views.wordGroups.nameLabel') }}<el-input v-model="form.name" :placeholder="t('views.wordGroups.namePlaceholder')" /></label>
        <label>{{ t('views.wordGroups.descLabel') }}<el-input v-model="form.description" :placeholder="t('views.wordGroups.descPlaceholder')" /></label>
        <label>{{ t('views.wordGroups.colorLabel') }}
          <div class="palette">
            <button v-for="c in PALETTE" :key="c" class="sw" :style="{ background: c }" :class="{ on: form.color === c }" @click="form.color = c"></button>
          </div>
        </label>
        <label>{{ t('views.wordGroups.statusLabel') }}
          <el-select v-model="form.status" style="width:100%">
            <el-option value="active" :label="t('views.wordGroups.statusActive')" />
            <el-option value="archived" :label="t('views.wordGroups.statusArchived')" />
          </el-select>
        </label>
      </div>
      <template #footer>
        <el-button @click="editing = null">{{ t('views.wordGroups.cancel') }}</el-button>
        <el-button type="primary" @click="saveForm">{{ t('views.wordGroups.save') }}</el-button>
      </template>
    </el-dialog>

    <!-- 添加成员 -->
    <el-dialog v-model="addOpen" :title="t('views.wordGroups.addMember')" width="560px">
      <div class="mlist">
        <label v-for="w in allWords" :key="w.id" class="mrow"><input type="checkbox" v-model="addChecks[w.id]" /><b>{{ w.word }}</b><span class="mm">{{ w.meaning }}</span></label>
      </div>
      <template #footer>
        <el-button @click="addOpen = false">{{ t('views.wordGroups.cancel') }}</el-button>
        <el-button type="primary" @click="saveAdd">{{ t('views.wordGroups.save') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.gp { max-width: 900px; margin: 0 auto; padding: 18px 16px 60px; color: var(--el-text-color-primary); }
.gp-head { display: flex; justify-content: space-between; align-items: flex-start; }
.gp-head h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--el-text-color-secondary); font-size: 13px; margin: 0; }
.empty { text-align: center; color: var(--el-text-color-secondary); padding: 50px 0; }
.list { display: flex; flex-direction: column; gap: 10px; }
.g { background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: var(--radius); padding: 12px 14px; }
.grow { display: flex; align-items: center; gap: 10px; cursor: pointer; }
.dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
.name { font-size: 16px; }
.chip { font-size: 11px; padding: 1px 7px; border-radius: 10px; background: var(--el-color-info-light-9); color: var(--el-color-info); }
.cnt { font-size: 13px; color: var(--el-text-color-secondary); }
.ca { margin-left: auto; font-size: 12px; color: var(--el-text-color-secondary); }
.gacts { display: inline-flex; gap: 6px; margin-left: 10px; }
.mem { margin-top: 10px; border-top: 1px dashed var(--el-border-color-lighter); padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.mw { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.mw .w { font-weight: 600; min-width: 120px; }
.mw .m { color: var(--el-text-color-secondary); flex: 1; }
.mw .rm { border: 0; background: transparent; color: var(--el-color-danger); cursor: pointer; }
.mw .ed { border: 0; background: transparent; color: var(--el-color-primary); cursor: pointer; }
.hint { font-size: 12px; color: var(--el-text-color-secondary); }
.gdesc { font-size: 12px; color: var(--el-text-color-secondary); flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.form { display: flex; flex-direction: column; gap: 12px; }
.form label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--el-text-color-regular); }
.palette { display: flex; gap: 6px; }
.sw { width: 22px; height: 22px; border-radius: 6px; border: 2px solid transparent; cursor: pointer; }
.sw.on { border-color: var(--el-text-color-primary); }

.mlist { display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow: auto; }
.mrow { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
.mrow .mm { color: var(--el-text-color-secondary); margin-left: 4px; }
</style>
