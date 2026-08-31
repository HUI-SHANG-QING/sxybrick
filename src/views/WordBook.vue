<script setup>
// 英语单词本首页（独立模块，复用 FSRS 调度）
// 默认全部展开；支持分类筛选 / 已背查看 / 搜索 / 添加编辑 / 熟词 / 加词组 / 批注 / 朗读。
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { t } from '../i18n/index.js';
import { toast } from '../utils/toast.js';
import { confirmDialog } from '../utils/confirm.js';
import { speak, speechSupported } from '../utils/speak.js';
import {
  listWordCards, wordStats, createWordCard, updateWordCard, deleteWordCard,
  markFamiliar, setWordNote, listWordGroups, createWordGroup, setWordGroups,
  wordGroupsOfCard,
} from '../word-repo.js';

const router = useRouter();
const loading = ref(true);
const cards = ref([]);
const stats = ref({ total: 0, due: 0, mastered: 0, newToday: 0, familiar: 0, templates: 0, schedulable: 0 });

// 筛选
const activeKind = ref(''); // ''=全部
const reviewedFilter = ref('all'); // all | reviewed | unreviewed
const q = ref('');

// 类型 / 类别 选项
const KIND_TABS = [
  { value: '', key: 'filterAll' },
  { value: 'word', key: 'filterWord' },
  { value: 'phrase', key: 'filterPhrase' },
  { value: 'sentence', key: 'filterSentence' },
  { value: 'template', key: 'filterTemplate' },
];
const SUBJECTS = [
  { value: '考研', key: 'subjectKaoyan' },
  { value: '四六级', key: 'subjectCet' },
  { value: '雅思', key: 'subjectIelts' },
  { value: '托福', key: 'subjectToefl' },
  { value: '专四专八', key: 'subjectTem' },
  { value: '其他', key: 'subjectOther' },
];
const KIND_LABELS = { word: 'kindWord', phrase: 'kindPhrase', sentence: 'kindSentence', template: 'kindTemplate' };

async function reload() {
  loading.value = true;
  try {
    const [list, st] = await Promise.all([
      listWordCards({
        kind: activeKind.value || undefined,
        reviewedOnly: reviewedFilter.value === 'reviewed' ? true : reviewedFilter.value === 'unreviewed' ? false : undefined,
        q: q.value || undefined,
      }),
      wordStats(),
    ]);
    cards.value = list;
    stats.value = st;
  } finally {
    loading.value = false;
  }
}
onMounted(reload);

function kindLabel(k) { return t('views.wordBook.' + (KIND_LABELS[k] || 'kindWord')); }
function subjectLabel(v) { return t('views.wordBook.' + (SUBJECTS.find(s => s.value === v)?.key || 'subjectOther')); }

// ---------- 添加 / 编辑 ----------
const editOpen = ref(false);
const editingId = ref(null);
const form = ref({ kind: 'word', word: '', phonetic: '', meaning: '', example: '', exampleTrans: '', note: '', source: '', subject: '', tags: '' });
const PALETTE = ['#4f7cff', '#2fbf71', '#e6a23c', '#f56c6c', '#9b59b6', '#16a085', '#e67e22', '#607d8b'];

function openAdd() {
  editingId.value = null;
  form.value = { kind: 'word', word: '', phonetic: '', meaning: '', example: '', exampleTrans: '', note: '', source: '', subject: '', tags: '' };
  editOpen.value = true;
}
function openEdit(c) {
  editingId.value = c.id;
  form.value = {
    kind: c.kind, word: c.word, phonetic: c.phonetic || '', meaning: c.meaning,
    example: c.example || '', exampleTrans: c.exampleTrans || '', note: c.note || '',
    source: c.source || '', subject: c.subject || '', tags: (c.tags || []).join(', '),
  };
  editOpen.value = true;
}
async function saveForm() {
  const payload = {
    ...form.value,
    tags: form.value.tags.split(',').map(s => s.trim()).filter(Boolean),
  };
  try {
    if (editingId.value === null) {
      await createWordCard(payload);
      toast(t('views.wordBook.created'), 'success');
    } else {
      await updateWordCard(editingId.value, payload);
      toast(t('views.wordBook.updated'), 'success');
    }
    editOpen.value = false;
    await reload();
  } catch (e) {
    toast(e.message || t('views.wordBook.saveFailed'), 'error');
  }
}

// ---------- 删除 ----------
async function remove(c) {
  if (!(await confirmDialog(t('views.wordBook.confirmDelete', undefined, { word: c.word })))) return;
  await deleteWordCard(c.id);
  toast(t('views.wordBook.deleted'), 'success');
  await reload();
}

// ---------- 熟词 ----------
async function toggleFamiliar(c) {
  await markFamiliar(c.id, c.familiar ? 0 : 1);
  toast(c.familiar ? t('views.wordBook.unmarkFamiliarToast') : t('views.wordBook.markFamiliarToast'), 'success');
  await reload();
}

// ---------- 批注 ----------
const noteOpen = ref(false);
const noteCard = ref(null);
const noteText = ref('');
function openNote(c) { noteCard.value = c; noteText.value = c.note || ''; noteOpen.value = true; }
async function saveNote() {
  await setWordNote(noteCard.value.id, noteText.value);
  toast(t('views.wordBook.updated'), 'success');
  noteOpen.value = false;
  await reload();
}

// ---------- 加入词组 ----------
const groupOpen = ref(false);
const groupCard = ref(null);
const groupList = ref([]);
const groupChecks = ref({});
const groupOwned = ref([]);
const newGroupName = ref('');
async function openGroup(c) {
  groupCard.value = c;
  groupList.value = await listWordGroups();
  const owned = await wordGroupsOfCard(c.id);
  groupOwned.value = owned.map(g => g.id);
  const ownedIds = new Set(groupOwned.value);
  groupChecks.value = Object.fromEntries(groupList.value.map(g => [g.id, ownedIds.has(g.id)]));
  newGroupName.value = '';
  groupOpen.value = true;
}
async function saveGroup() {
  const add = [], remove = [];
  for (const g of groupList.value) {
    const checked = !!groupChecks.value[g.id];
    const wasOwned = groupOwned.value.includes(g.id);
    if (checked && !wasOwned) add.push(g.id);
    if (!checked && wasOwned) remove.push(g.id);
  }
  // 新建并加入
  if (newGroupName.value.trim()) {
    const g = await createWordGroup({ name: newGroupName.value.trim() });
    add.push(g.id);
  }
  await setWordGroups([groupCard.value.id], add, remove);
  toast(t('views.wordBook.updated'), 'success');
  groupOpen.value = false;
  await reload();
}

function speakWord(c) { speak(c.word || c.example || ''); }

const canSpeak = speechSupported();
</script>

<template>
  <div class="wb">
    <header class="wb-head">
      <div>
        <h1>{{ t('views.wordBook.title') }}</h1>
        <p class="sub">{{ t('views.wordBook.subtitle') }}</p>
      </div>
      <div class="head-actions">
        <el-button type="primary" @click="openAdd">{{ t('views.wordBook.addBtn') }}</el-button>
        <el-button @click="router.push('/words/review')">{{ t('views.wordBook.startReview') }}</el-button>
        <el-button @click="router.push('/words/groups')">{{ t('views.wordBook.groups') }}</el-button>
        <el-button @click="router.push('/words/export')">{{ t('views.wordBook.export') }}</el-button>
      </div>
    </header>

    <!-- 统计卡 -->
    <section class="stats">
      <div class="stat"><b>{{ stats.due }}</b><span>{{ t('views.wordBook.statDue') }}</span></div>
      <div class="stat"><b>{{ stats.mastered }}</b><span>{{ t('views.wordBook.statMastered') }}</span></div>
      <div class="stat"><b>{{ stats.newToday }}</b><span>{{ t('views.wordBook.statNewToday') }}</span></div>
      <div class="stat"><b>{{ stats.familiar }}</b><span>{{ t('views.wordBook.statFamiliar') }}</span></div>
      <div class="stat"><b>{{ stats.templates }}</b><span>{{ t('views.wordBook.statTemplate') }}</span></div>
      <div class="stat"><b>{{ stats.total }}</b><span>{{ t('views.wordBook.statTotal') }}</span></div>
    </section>

    <!-- 工具栏 -->
    <section class="toolbar">
      <div class="tabs">
        <button v-for="tab in KIND_TABS" :key="tab.value" :class="{ on: activeKind === tab.value }" @click="activeKind = tab.value; reload()">
          {{ t('views.wordBook.' + tab.key) }}
        </button>
      </div>
      <div class="seg">
        <button :class="{ on: reviewedFilter === 'all' }" @click="reviewedFilter = 'all'; reload()">{{ t('views.wordBook.showAll') }}</button>
        <button :class="{ on: reviewedFilter === 'reviewed' }" @click="reviewedFilter = 'reviewed'; reload()">{{ t('views.wordBook.showReviewed') }}</button>
        <button :class="{ on: reviewedFilter === 'unreviewed' }" @click="reviewedFilter = 'unreviewed'; reload()">{{ t('views.wordBook.showUnreviewed') }}</button>
      </div>
      <el-input v-model="q" :placeholder="t('views.wordBook.searchPlaceholder')" clearable class="search" @input="reload" />
    </section>

    <!-- 列表（默认全部展开） -->
    <section v-if="loading" class="empty">{{ t('views.wordBook.loading') }}</section>
    <section v-else-if="!cards.length" class="empty">
      <p>{{ t('views.wordBook.empty') }}</p>
      <p class="hint">{{ t('views.wordBook.emptyHint') }}</p>
    </section>
    <section v-else class="list">
      <article v-for="c in cards" :key="c.id" class="card" :class="{ fam: c.familiar, tpl: c.kind === 'template' }">
        <div class="card-top">
          <div class="word">
            <span class="wtext">{{ c.word }}</span>
            <span v-if="c.phonetic" class="ph">/{{ c.phonetic }}/</span>
            <span class="tag kind">{{ kindLabel(c.kind) }}</span>
            <span v-if="c.familiar" class="tag fam">{{ t('views.wordBook.familiarBadge') }}</span>
            <span v-if="c.kind === 'template'" class="tag tpl">{{ t('views.wordBook.templateBadge') }}</span>
            <span v-if="c.subject" class="tag subj">{{ subjectLabel(c.subject) }}</span>
          </div>
          <div class="acts">
            <button v-if="canSpeak" class="ico" :title="t('views.wordBook.speak')" @click="speakWord(c)">🔊</button>
            <button class="ico" :title="t('views.wordBook.editNote')" @click="openNote(c)">📝</button>
            <button class="ico" :title="t('views.wordBook.addToGroup')" @click="openGroup(c)">📚</button>
            <button class="ico" :title="t('views.wordBook.markFamiliar')" @click="toggleFamiliar(c)">{{ c.familiar ? '⭐' : '☆' }}</button>
            <button class="txt" @click="openEdit(c)">{{ t('views.wordBook.edit') }}</button>
            <button class="txt danger" @click="remove(c)">{{ t('views.wordBook.delete') }}</button>
          </div>
        </div>
        <div class="card-body">
          <div class="row"><span class="k">{{ t('views.wordBook.formMeaning') }}</span><span class="v">{{ c.meaning }}</span></div>
          <div v-if="c.example" class="row"><span class="k">{{ t('views.wordBook.formExample') }}</span><span class="v ex">{{ c.example }}<template v-if="c.exampleTrans"> —— {{ c.exampleTrans }}</template></span></div>
          <div v-if="c.note" class="row"><span class="k">{{ t('views.wordBook.noteLabel') }}</span><span class="v note">{{ c.note }}</span></div>
          <div v-if="c.source" class="row"><span class="k">{{ t('views.wordBook.sourceLabel') }}</span><span class="v">{{ c.source }}</span></div>
          <div v-if="c.tags && c.tags.length" class="row"><span class="k">{{ t('views.wordBook.formTags') }}</span><span class="v">
            <span v-for="tg in c.tags" :key="tg" class="tag mini">{{ tg }}</span>
          </span></div>
        </div>
      </article>
    </section>

    <!-- 添加 / 编辑 -->
    <el-dialog v-model="editOpen" :title="editingId === null ? t('views.wordBook.addTitle') : t('views.wordBook.editTitle')" width="560px">
      <div class="form">
        <label>{{ t('views.wordBook.formKind') }}
          <el-select v-model="form.kind" style="width:100%">
            <el-option v-for="k in ['word','phrase','sentence','template']" :key="k" :value="k" :label="kindLabel(k)" />
          </el-select>
        </label>
        <label>{{ t('views.wordBook.formWord') }}
          <el-input v-model="form.word" :placeholder="t('views.wordBook.formWordPlaceholder')" />
        </label>
        <label>{{ t('views.wordBook.formPhonetic') }}
          <el-input v-model="form.phonetic" :placeholder="t('views.wordBook.formPhoneticPlaceholder')" />
        </label>
        <label>{{ t('views.wordBook.formMeaning') }}
          <el-input v-model="form.meaning" type="textarea" :rows="2" :placeholder="t('views.wordBook.formMeaningPlaceholder')" />
        </label>
        <label>{{ t('views.wordBook.formExample') }}
          <el-input v-model="form.example" :placeholder="t('views.wordBook.formExamplePlaceholder')" />
        </label>
        <label>{{ t('views.wordBook.formExampleTrans') }}
          <el-input v-model="form.exampleTrans" :placeholder="t('views.wordBook.formExampleTransPlaceholder')" />
        </label>
        <label>{{ t('views.wordBook.formNote') }}
          <el-input v-model="form.note" type="textarea" :rows="2" :placeholder="t('views.wordBook.formNotePlaceholder')" />
        </label>
        <label>{{ t('views.wordBook.formSource') }}
          <el-input v-model="form.source" :placeholder="t('views.wordBook.formSourcePlaceholder')" />
        </label>
        <label>{{ t('views.wordBook.formSubject') }}
          <el-select v-model="form.subject" clearable style="width:100%">
            <el-option v-for="s in SUBJECTS" :key="s.value" :value="s.value" :label="subjectLabel(s.value)" />
          </el-select>
        </label>
        <label>{{ t('views.wordBook.formTags') }}
          <el-input v-model="form.tags" :placeholder="t('views.wordBook.formTags')" />
        </label>
      </div>
      <template #footer>
        <el-button @click="editOpen = false">{{ t('views.wordBook.cancel') }}</el-button>
        <el-button type="primary" @click="saveForm">{{ t('views.wordBook.save') }}</el-button>
      </template>
    </el-dialog>

    <!-- 批注 -->
    <el-dialog v-model="noteOpen" :title="t('views.wordBook.editNote') + '：' + (noteCard?.word || '')" width="520px">
      <el-input v-model="noteText" type="textarea" :rows="4" :placeholder="t('views.wordBook.formNotePlaceholder')" />
      <template #footer>
        <el-button @click="noteOpen = false">{{ t('views.wordBook.cancel') }}</el-button>
        <el-button type="primary" @click="saveNote">{{ t('views.wordBook.save') }}</el-button>
      </template>
    </el-dialog>

    <!-- 加入词组 -->
    <el-dialog v-model="groupOpen" :title="t('views.wordBook.addToGroup') + '：' + (groupCard?.word || '')" width="520px">
      <div v-if="groupList.length" class="glist">
        <label v-for="g in groupList" :key="g.id" class="grow">
          <input type="checkbox" v-model="groupChecks[g.id]" />
          <span class="dot" :style="{ background: g.color }"></span>{{ g.name }}
        </label>
      </div>
      <p v-else class="hint">{{ t('views.wordBook.empty') }}</p>
      <label class="newg">{{ t('views.wordBook.createBtn') }}
        <el-input v-model="newGroupName" :placeholder="t('views.wordBook.namePlaceholder')" />
      </label>
      <template #footer>
        <el-button @click="groupOpen = false">{{ t('views.wordBook.cancel') }}</el-button>
        <el-button type="primary" @click="saveGroup">{{ t('views.wordBook.save') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.wb { max-width: 980px; margin: 0 auto; padding: 18px 16px 60px; color: var(--el-text-color-primary); }
.wb-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.wb-head h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--el-text-color-secondary); font-size: 13px; margin: 0; max-width: 620px; }
.head-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.stats { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin: 16px 0; }
.stat { background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: var(--radius); padding: 12px 8px; text-align: center; }
.stat b { display: block; font-size: 20px; color: var(--accent); }
.stat span { font-size: 12px; color: var(--el-text-color-secondary); }

.toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
.tabs, .seg { display: flex; gap: 4px; background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: var(--radius); padding: 3px; }
.tabs button, .seg button { border: 0; background: transparent; color: var(--el-text-color-regular); padding: 6px 12px; border-radius: calc(var(--radius) - 3px); cursor: pointer; font-size: 13px; }
.tabs button.on, .seg button.on { background: var(--accent); color: #fff; }
.search { max-width: 260px; flex: 1; }

.list { display: flex; flex-direction: column; gap: 10px; }
.card { background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: var(--radius); padding: 12px 14px; }
.card.fam { border-left: 3px solid var(--el-color-success); }
.card.tpl { border-left: 3px solid var(--el-color-warning); }
.card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.word { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wtext { font-size: 17px; font-weight: 700; }
.ph { color: var(--el-text-color-secondary); font-size: 13px; }
.acts { display: flex; gap: 6px; align-items: center; }
.ico { border: 1px solid var(--el-border-color-lighter); background: var(--el-bg-color-page); border-radius: 8px; width: 30px; height: 30px; cursor: pointer; font-size: 14px; }
.txt { border: 1px solid var(--el-border-color-lighter); background: transparent; color: var(--el-text-color-regular); border-radius: 8px; padding: 4px 10px; cursor: pointer; font-size: 13px; }
.txt.danger { color: var(--el-color-danger); }
.card-body { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.row { display: flex; gap: 10px; font-size: 14px; }
.row .k { color: var(--el-text-color-secondary); min-width: 56px; flex-shrink: 0; }
.row .v { color: var(--el-text-color-primary); }
.row .v.ex { font-style: italic; }
.row .v.note { color: var(--accent); }

.tag { font-size: 11px; padding: 1px 7px; border-radius: 10px; background: var(--el-color-primary-light-9); color: var(--el-color-primary); }
.tag.fam { background: var(--el-color-success-light-9); color: var(--el-color-success); }
.tag.tpl { background: var(--el-color-warning-light-9); color: var(--el-color-warning); }
.tag.subj { background: var(--el-bg-color-page); color: var(--el-text-color-secondary); }
.tag.mini { margin-right: 4px; }

.empty { text-align: center; color: var(--el-text-color-secondary); padding: 50px 0; }
.empty .hint, .hint { font-size: 12px; color: var(--el-text-color-secondary); }

.form { display: flex; flex-direction: column; gap: 12px; }
.form label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--el-text-color-regular); }
.glist { display: flex; flex-direction: column; gap: 8px; max-height: 220px; overflow: auto; margin-bottom: 10px; }
.grow { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.newg { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--el-text-color-regular); }
</style>
