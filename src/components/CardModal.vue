<script setup>
// 新建/编辑卡片弹窗：科目(含自定义)、标签自动完成、Markdown 实时预览、
// 图片插入(本地存储)、字数统计(CARD_WARN_CHARS 预警 / CARD_MAX_CHARS 上限)、实时校验
import { ref, computed, watch, shallowRef, onMounted, onBeforeUnmount } from 'vue';
import { confirmDialog } from '../utils/confirm.js';
import MarkdownRenderer from './MarkdownRenderer.vue';
import { toast } from '../utils/toast.js';
import { getSubjects, getTags, createCard, updateCard, WRONG_REASONS, wrongReasonToCode,
  listCardGroups, cardGroupsOfCard, setCardGroups, listCards,
  linkCardWord, unlinkCardWord, wordCardsOfCard,
  linkCards, unlinkCards, cardsOfCard } from '../repo.js';
import { listWordCards } from '../word-repo.js';
import { T } from '../utils/telemetry.js';
import { t } from '../i18n/index.js';
import { putImage } from '../images.js';
import { uid } from '../db.js';
import { CARD_MAX_CHARS, CARD_WARN_CHARS } from '../utils/card-limits.js';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  card: { type: Object, default: null },
});
const emit = defineEmits(['update:modelValue', 'saved']);

const MAX = CARD_MAX_CHARS, WARN = CARD_WARN_CHARS, MAX_TAGS = 16;

const subject = ref('');
const customSubject = ref('');
const useCustomSubject = ref(false);
const subjects = ref([]);
const allTags = ref([]);
const tags = ref([]);
const tagInput = ref('');
const source = ref('');
const type = ref('basic');
const marked = ref(false);
const mnemonic = ref('');
const wrongReason = ref('');
const customWrong = ref('');
const showTagSuggest = ref(false);
// M1 卡组：编辑时记录原分组，保存时按「新增/移除」差集同步
const allGroups = ref([]);
const groupFilter = ref('');
const cardGroupIds = ref([]);
const originalGroupIds = ref([]);

// v31：通用卡 ↔ 英语词卡链接；v34：扩展到「通用卡 ↔ 通用卡」——
// 此前关联对象只有英语词卡，纯记忆卡（线代/计网/政治…）之间无法互相关联，
// UI 上只看到一句「尚未关联任何英语词」。现改为双模式选择器（本库卡片 / 英语词卡）。
const cwLinks = ref([]);
const ccLinks = ref([]);
const relMode = ref('card'); // 'card' = 本库卡片（默认，覆盖大多数场景）| 'word' = 英语词卡
const cwPickOpen = ref(false);
const cwPickQ = ref('');
// 审计（2026-09-14）：候选缓存必须用 shallowRef 而不是普通 let——
// relHasCache/relPickList 是 computed，普通变量的赋值不会触发重算，
// 结果「＋ 关联」按钮的 disabled 状态永远停在初始的 true（缓存未加载时），
// 表现为按钮无法点击、候选列表永远打不开。改成 ref 后缓存赋值即刷新。
const cwWordCache = shallowRef([]);
const ccCardCache = shallowRef([]);
/** 卡片显示标题：取正文首个标题行（与卡片列表口径一致） */
function cardHead(c) {
  const lines = String(c?.front || '').split('\n').map(s => s.trim()).filter(Boolean);
  for (const l of lines) { const m = l.match(/^#{1,6}\s*(.+)$/); if (m) return m[1].slice(0, 48); }
  return (lines.find(l => !/^([-*+>|]|\d+\.)/.test(l)) || '').slice(0, 48);
}
const relPickList = computed(() => {
  const q = String(cwPickQ.value || '').trim().toLowerCase();
  if (relMode.value === 'word') {
    const linked = new Set(cwLinks.value.map(c => c.id));
    return cwWordCache.value
      .filter(c => !linked.has(c.id) && (!q || (c.word || '').toLowerCase().includes(q) || (c.meaning || '').toLowerCase().includes(q)))
      .slice(0, 8);
  }
  const linked = new Set(ccLinks.value.map(c => c.id));
  return ccCardCache.value
    .filter(c => c.id !== props.card?.id && !linked.has(c.id)
      && (!q || cardHead(c).toLowerCase().includes(q) || String(c.subject || '').toLowerCase().includes(q)))
    .slice(0, 8);
});
const relHasCache = computed(() => !!(cwWordCache.value.length || ccCardCache.value.length));
async function refreshCwLinks() {
  const [w, c] = await Promise.all([
    listWordCards().then(rows => rows.slice(0, 500)).catch(() => []),
    // listCards 返回的是 { items, total, dueCount }（不是数组）——必须取 .items，
    // 否则 slice 抛错被 catch 吞掉，卡片候选恒为空（静默失败）。
    listCards({ mode: 'all' }).then(r => (r?.items || []).slice(0, 500)).catch(() => []),
  ]);
  cwWordCache.value = w;
  ccCardCache.value = c;
  if (!props.card?.id) { cwLinks.value = []; ccLinks.value = []; return; }
  const [wl, cl] = await Promise.all([
    wordCardsOfCard(props.card.id).catch(() => []),
    cardsOfCard(props.card.id).catch(() => []),
  ]);
  cwLinks.value = wl;
  ccLinks.value = cl;
}
async function doCwLink(wordCard) {
  if (!props.card?.id) return;
  await linkCardWord(props.card.id, wordCard.id);
  await refreshCwLinks();
  cwPickOpen.value = false;
  cwPickQ.value = '';
}
async function doCwUnlink(wordCardId) {
  if (!props.card?.id) return;
  await unlinkCardWord(props.card.id, wordCardId);
  await refreshCwLinks();
}
async function doCcLink(card) {
  if (!props.card?.id || !card?.id) return;
  await linkCards(props.card.id, card.id);
  await refreshCwLinks();
  cwPickOpen.value = false;
  cwPickQ.value = '';
}
async function doCcUnlink(cardId) {
  if (!props.card?.id) return;
  await unlinkCards(props.card.id, cardId);
  await refreshCwLinks();
}
const filteredGroups = computed(() => {
  const kw = groupFilter.value.trim();
  return allGroups.value.filter(g => !kw || g.name.includes(kw));
});
function toggleGroup(id) {
  const i = cardGroupIds.value.indexOf(id);
  if (i >= 0) cardGroupIds.value.splice(i, 1);
  else cardGroupIds.value.push(id);
}
const front = ref('');
const back = ref('');
const preview = ref(true);
const errors = ref({});
const saving = ref(false);

const frontLen = computed(() => [...front.value].length);
const backLen = computed(() => [...back.value].length);

watch(() => props.modelValue, async (open) => {
  if (!open) return;
  errors.value = {};
  subjects.value = await getSubjects();
  allTags.value = await getTags();
  allGroups.value = await listCardGroups();
  groupFilter.value = '';
  cardGroupIds.value = [];
  originalGroupIds.value = [];
  cwLinks.value = [];
  ccLinks.value = [];
  cwPickOpen.value = false;
  cwPickQ.value = '';
  if (props.card) {
    front.value = props.card.front;
    back.value = props.card.back;
    tags.value = [...(props.card.tags || [])];
    source.value = props.card.source || '';
    type.value = props.card.type || 'basic';
    marked.value = !!props.card.marked;
    mnemonic.value = props.card.mnemonic || '';
    const wr = wrongReasonToCode(props.card.wrongReason || '');
    if (wr && !WRONG_REASONS.some(r => r.code === wr) && wr !== 'OTHER') { wrongReason.value = '__custom__'; customWrong.value = props.card.wrongReason || ''; }
    else { wrongReason.value = wr; customWrong.value = ''; }
    const known = subjects.value.some(s => s.name === props.card.subject);
    useCustomSubject.value = !!props.card.subject && !known;
    subject.value = known ? props.card.subject : '';
    customSubject.value = known ? '' : props.card.subject;
    const groups = await cardGroupsOfCard(props.card.id);
    cardGroupIds.value = groups.map(g => g.id);
    originalGroupIds.value = [...cardGroupIds.value];
    await refreshCwLinks();
  } else {
    front.value = ''; back.value = ''; tags.value = []; source.value = ''; type.value = 'basic'; marked.value = false; mnemonic.value = ''; wrongReason.value = ''; customWrong.value = '';
    subject.value = ''; customSubject.value = ''; useCustomSubject.value = false;
    tagInput.value = '';
  }
});

const tagSuggestions = computed(() => {
  const kw = tagInput.value.trim();
  return allTags.value
    .filter(t => !tags.value.includes(t.name) && (!kw || t.name.includes(kw)))
    .slice(0, 8);
});

function addTag(name) {
  const n = String(name).trim();
  if (!n) return;
  if (tags.value.length >= MAX_TAGS) return toast(`标签最多 ${MAX_TAGS} 个`, 'error');
  if (!tags.value.includes(n)) tags.value.push(n);
  tagInput.value = '';
}
function onTagBlur() {
  if (tagInput.value.trim()) addTag(tagInput.value);
  setTimeout(() => { showTagSuggest.value = false; }, 150);
}

function onTagKeydown(e) {
  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput.value); }
  else if (e.key === 'Backspace' && !tagInput.value && tags.value.length) tags.value.pop();
}

function limitField(v) {
  const chars = [...v];
  return chars.length > MAX ? chars.slice(0, MAX).join('') : v;
}

// 图片插入：存本地 IndexedDB，正文里插入 sxy-img:// 引用
async function insertImage(side, file) {
  if (!file || !file.type.startsWith('image/')) return toast('请选择图片文件', 'error');
  try {
    const id = uid();
    await putImage(id, file, file.type);
    const md = `\n![image](sxy-img://${id})\n`;
    if (side === 'front') front.value = limitField(front.value + md);
    else back.value = limitField(back.value + md);
    toast('图片已插入', 'success');
  } catch (e) { toast(e.message, 'error'); }
}
function onPaste(side, e) {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); insertImage(side, item.getAsFile()); }
}

const frontLabel = computed(() => type.value === 'cloze' ? '句子（用 {{答案}} 挖空）' : type.value === 'choice' ? '题干（问题）' : type.value === 'writing' ? '默写题目（提示）' : '正面（提示 / 问题）');
const backLabel = computed(() => type.value === 'choice' ? '选项 + 答案' : type.value === 'writing' ? '标准答案（逐字匹配判对）' : type.value === 'cloze' ? '解释 / 提示（可选）' : '背面（结论 / 答案）');
const frontPh = computed(() => type.value === 'cloze' ? '把要挖空的位置用 {{答案}} 包起来，例如：CPU 的中文是 {{中央处理器}}' : type.value === 'choice' ? '输入题干，例如：以下哪个不是操作系统？' : type.value === 'writing' ? '例如：TCP 三次握手分别是哪三步？' : '背诵时先看到的提示，支持 Markdown / 公式 / 代码块');
const backPh = computed(() => type.value === 'choice' ? '每行一个选项（A~D），最后一行写答案。例如：\nA. Linux\nB. Windows\nC. Chrome\nD. macOS\n答案：C' : type.value === 'writing' ? '默写题的判定答案：与作答逐字（忽略空格标点、大小写）比对' : type.value === 'cloze' ? '可选：补充解释或助记，帮助理解' : '翻开要记住的内容，支持 Markdown');

function validate() {
  const errs = {};
  const finalSubject = useCustomSubject.value ? customSubject.value.trim() : subject.value;
  if (useCustomSubject.value && !finalSubject) errs.subject = '请输入自定义科目名称';
  if (useCustomSubject.value && [...finalSubject].length > 30) errs.subject = '科目名称不超过 30 字';
  if (!front.value.trim()) errs.front = '正面内容不能为空';
  if (!back.value.trim()) errs.back = '背面内容不能为空';
  if (frontLen.value > MAX) errs.front = `正面不能超过 ${MAX} 字`;
  if (backLen.value > MAX) errs.back = `背面不能超过 ${MAX} 字`;
  if (tags.value.length > MAX_TAGS) errs.tags = `标签最多 ${MAX_TAGS} 个`;
  errors.value = errs;
  return Object.keys(errs).length === 0;
}

async function save() {
  if (tagInput.value.trim()) addTag(tagInput.value);
  if (!validate()) return;
  saving.value = true;
  try {
    const payload = {
      front: front.value.trim(),
      back: back.value.trim(),
      subject: useCustomSubject.value ? customSubject.value.trim() : subject.value,
      tags: tags.value,
      source: source.value,
      type: type.value,
      marked: marked.value,
      mnemonic: mnemonic.value,
      wrongReason: marked.value
        ? (wrongReason.value === '__custom__' ? customWrong.value.trim() : wrongReason.value)
        : '',
    };
    let cardId = props.card?.id;
    if (props.card) {
      await updateCard(cardId, payload);
      try { T.cardEdit(cardId); } catch {}
    } else {
      const r = await createCard(payload);
      cardId = r?.id || r;
      try { T.cardNew(cardId); } catch {}
    }
    // M1：卡组分组按差集更新（学习数据不随分组隔离，只动关联表）
    const add = cardGroupIds.value.filter(id => !originalGroupIds.value.includes(id));
    const remove = originalGroupIds.value.filter(id => !cardGroupIds.value.includes(id));
    if (cardId && (add.length || remove.length)) await setCardGroups([cardId], add, remove);
    emit('saved');
    emit('update:modelValue', false);
    toast(props.card ? '已保存修改' : '卡片已创建', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally { saving.value = false; }
}

// round54（P3 修复）：**未保存守卫**。此前保存只由「保存」按钮触发，一旦误点遮罩/✕、
// 或直接关页面，本地编辑（front/back/标记/助记）全部静默丢失且无提示。
// 脏值判定 = 「当前表单 vs 卡片原文」签名比对——只看用户真正会手改的字段，避免误报。
function formSig() {
  return JSON.stringify([front.value.trim(), back.value.trim(), marked.value, mnemonic.value]);
}
function cardSig() {
  const c = props.card || {};
  return JSON.stringify([String(c.front || '').trim(), String(c.back || '').trim(), !!c.marked, c.mnemonic || '']);
}
const dirty = computed(() => !!props.modelValue && formSig() !== cardSig());
function onBeforeUnload(e) {
  if (!dirty.value) return;
  e.preventDefault();
  e.returnValue = '';
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload));

async function close() {
  // 未保存就直接关 → 先二次确认（统一走 utils/confirm.js 的 confirmDialog）
  if (dirty.value && !(await confirmDialog('有未保存的修改，确定要丢弃吗？'))) return;
  emit('update:modelValue', false);
}
</script>

<template>
  <teleport to="body">
    <div v-if="modelValue" class="modal-mask" @click.self="close">
      <div class="modal">
        <h3>{{ card ? '编辑卡片' : '新建卡片' }}</h3>

        <div class="field-label" style="margin-top:4px">题型</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="chip" :class="{ on: type === 'basic' }" @click="type = 'basic'">正反面</button>
          <button class="chip" :class="{ on: type === 'cloze' }" @click="type = 'cloze'">填空</button>
          <button class="chip" :class="{ on: type === 'choice' }" @click="type = 'choice'">选择</button>
          <button class="chip" :class="{ on: type === 'writing' }" @click="type = 'writing'">默写</button>
        </div>

        <div class="field-label">科目</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <select v-model="subject" class="input" style="max-width:240px" :disabled="useCustomSubject"
                  @change="useCustomSubject = subject === '__custom__'">
            <option value="">不限科目</option>
            <option v-for="s in subjects" :key="s.name" :value="s.name">{{ s.name }}</option>
            <option value="__custom__">自定义…</option>
          </select>
          <input v-if="useCustomSubject" v-model="customSubject" class="input" style="max-width:240px"
                 placeholder="输入自定义科目" maxlength="30" />
        </div>
        <div v-if="errors.subject" class="hint error">{{ errors.subject }}</div>

        <div class="field-label">来源（可选）</div>
        <input v-model="source" class="input" placeholder="如：计算机网络 第3章 / 某教材 P123" maxlength="60" />

        <div class="field-label">所属卡组（可多选，学习数据全局共享）</div>
        <input v-model="groupFilter" class="input" style="max-width:240px" placeholder="搜索卡组…" />
        <div v-if="allGroups.length" class="group-picker">
          <button v-for="g in filteredGroups" :key="g.id" type="button" class="chip"
                  :class="{ on: cardGroupIds.includes(g.id) }"
                  :style="cardGroupIds.includes(g.id) && g.color ? `border-color:${g.color};color:${g.color}` : {}"
                  @click="toggleGroup(g.id)" :title="g.status === 'archived' ? '备用卡组（不进默认复习）' : '背诵中'">
            <span v-if="g.color" class="g-dot" :style="{ background: g.color }"></span>
            {{ g.name }}<span v-if="g.status === 'archived'" class="hint"> 备</span>
          </button>
          <div v-if="!filteredGroups.length" class="hint">无匹配卡组</div>
        </div>
        <div v-else class="hint">还没有卡组——到「卡组」页创建</div>

        <div class="field-label" style="display:flex;align-items:center;gap:8px;margin-top:12px">
          <input type="checkbox" v-model="marked" id="mk" />
          <label for="mk" style="margin:0;font-size:14px;color:var(--ink)">加入错题集（手动标记薄弱卡）</label>
        </div>
        <div v-if="marked">
          <div class="field-label">错因</div>
          <select v-model="wrongReason" class="input" style="max-width:240px">
            <option value="">选择错因（可选）</option>
            <option v-for="r in WRONG_REASONS" :key="r.code" :value="r.code">{{ r.label }}</option>
            <option value="__custom__">自定义…</option>
          </select>
          <input v-if="wrongReason === '__custom__'" v-model="customWrong" class="input"
                 style="max-width:240px;margin-top:8px" placeholder="输入自定义错因（20字内）" maxlength="20" />
        </div>

        <div class="field-label">标签（最多 {{ MAX_TAGS }} 个，回车添加）</div>
        <div class="tag-box input" style="position:relative">
          <span v-for="tag in tags" :key="tag" class="tag-pill" style="margin-right:6px">
            {{ tag }} <a style="cursor:pointer" @click="tags = tags.filter(x => x !== tag)">×</a>
          </span>
          <input v-model="tagInput" style="border:none;outline:none;flex:1;min-width:120px"
                 placeholder="输入标签，回车添加" @keydown="onTagKeydown"
                 @focus="showTagSuggest = true" @blur="onTagBlur" />
          <div v-if="showTagSuggest && tagSuggestions.length" class="suggest">
            <div v-for="s in tagSuggestions" :key="s.name" class="suggest-item" @mousedown.prevent="addTag(s.name)">
              {{ s.name }} <span class="hint">{{ s.count }}</span>
            </div>
          </div>
        </div>
        <div class="hint" style="margin-top:4px">已用过：
          <a v-for="s in allTags.slice(0, 10)" :key="s.name" class="chip" style="margin:2px" @click="addTag(s.name)">{{ s.name }}</a>
        </div>
        <div v-if="errors.tags" class="hint error">{{ errors.tags }}</div>

        <div class="field-label" style="display:flex;justify-content:space-between;align-items:center">
          <span>{{ frontLabel }}</span>
          <label class="btn small">插入图片<input type="file" accept="image/*" hidden
            @change="insertImage('front', $event.target.files[0]); $event.target.value = ''" /></label>
        </div>
        <textarea v-model="front" class="input" :class="{ invalid: errors.front }" rows="5"
                  :placeholder="frontPh"
                  @input="front = limitField(front)" @paste="onPaste('front', $event)"></textarea>
        <div class="hint" :class="{ warn: frontLen >= WARN, error: frontLen >= MAX }">
          {{ frontLen }} / {{ MAX }} 字<span v-if="frontLen >= WARN && frontLen < MAX"> · 接近上限，请注意精简</span>
        </div>
        <div v-if="errors.front" class="hint error">{{ errors.front }}</div>

        <div class="field-label" style="display:flex;justify-content:space-between;align-items:center">
          <span>{{ backLabel }}</span>
          <label class="btn small">插入图片<input type="file" accept="image/*" hidden
            @change="insertImage('back', $event.target.files[0]); $event.target.value = ''" /></label>
        </div>
        <textarea v-model="back" class="input" :class="{ invalid: errors.back }" rows="7"
                  :placeholder="backPh"
                  @input="back = limitField(back)" @paste="onPaste('back', $event)"></textarea>
        <div class="hint" :class="{ warn: backLen >= WARN, error: backLen >= MAX }">
          {{ backLen }} / {{ MAX }} 字<span v-if="backLen >= WARN && backLen < MAX"> · 接近上限，请注意精简</span>
        </div>
        <div v-if="errors.back" class="hint error">{{ errors.back }}</div>

        <div class="field-label">助记 / 词根（可选，语言学习用）</div>
        <input v-model="mnemonic" class="input" placeholder="如：quad- = 四（quadrant 四象限）" maxlength="200" />

        <!-- v31 + v34：关联（同一知识点，多对多；仅编辑已有卡时可用）
             对象支持两类：本库卡片（v34 新增）/ 英语词卡（v31） -->
        <div v-if="props.card" class="cw-sec">
          <div class="field-label" style="display:flex;justify-content:space-between;align-items:center">
            <span>关联（同一知识点，可多组）</span>
            <button class="btn small" :disabled="!relHasCache" @click="cwPickOpen = !cwPickOpen">
              {{ cwPickOpen ? '收起' : '＋ 关联' }}
            </button>
          </div>
          <div class="hint" style="margin:2px 0 0">只存「谁对应谁」，两侧内容与复习进度各自独立、互不干扰</div>

          <div class="rel-tabs">
            <button class="rel-tab" :class="{ on: relMode === 'card' }" @click="relMode = 'card'; cwPickQ = ''">
              本库卡片（已关联 {{ ccLinks.length }} · 可关联 {{ ccCardCache.length }}）
            </button>
            <button class="rel-tab" :class="{ on: relMode === 'word' }" @click="relMode = 'word'; cwPickQ = ''">
              英语词卡（已关联 {{ cwLinks.length }} · 可关联 {{ cwWordCache.length }}）
            </button>
          </div>

          <!-- 本库卡片：显示所属科目，便于同名卡区分 -->
          <template v-if="relMode === 'card'">
            <div v-if="ccLinks.length" class="cw-list">
              <span v-for="c in ccLinks" :key="c.id" class="cw-chip">
                {{ cardHead(c) || '（无标题）' }}<small v-if="c.subject"> · {{ c.subject }}</small>
                <button class="cw-x" @click="doCcUnlink(c.id)" title="解除关联">×</button>
              </span>
            </div>
            <div v-else class="hint" style="margin:2px 0 0">尚未关联任何卡片</div>
          </template>

          <!-- 英语词卡 -->
          <template v-else>
            <div v-if="cwLinks.length" class="cw-list">
              <span v-for="c in cwLinks" :key="c.id" class="cw-chip">
                {{ c.word }}<small v-if="c.meaning"> · {{ c.meaning }}</small>
                <button class="cw-x" @click="doCwUnlink(c.id)" title="解除关联">×</button>
              </span>
            </div>
            <div v-else class="hint" style="margin:2px 0 0">尚未关联任何英语词</div>
          </template>

          <div v-if="cwPickOpen" class="cw-pick">
            <input v-model="cwPickQ" class="input"
                   :placeholder="relMode === 'card' ? '搜索标题 / 科目…' : '搜索英语词 / 释义…'" style="margin-bottom:6px" />
            <div v-if="relPickList.length">
              <div v-for="c in relPickList" :key="c.id" class="cw-pick-item"
                   @click="relMode === 'card' ? doCcLink(c) : doCwLink(c)">
                <template v-if="relMode === 'card'">
                  {{ cardHead(c) || '（无标题）' }}<span class="hint"> {{ c.subject || '' }}</span>
                </template>
                <template v-else>
                  {{ c.word }}<small v-if="c.meaning"> · {{ c.meaning }}</small><span class="hint"> {{ c.kind === 'word' ? '单词' : c.kind === 'phrase' ? '词组' : c.kind === 'sentence' ? '短句' : '范文' }}</span>
                </template>
              </div>
            </div>
            <div v-else class="hint">
              {{ relMode === 'card' ? '无候选（本库暂无其它卡片或无匹配）' : '无候选（英语模块暂无词卡或无匹配）' }}
            </div>
          </div>
          <!-- 可关联总量提示：卡片数量 >0 但当前卡尚未关联任何对象时，明确告知不是「库是空的」 -->
          <div v-if="!cwPickOpen" class="hint" style="margin:6px 0 0">
            本库共 {{ ccCardCache.length }} 张卡 · 英语词库共 {{ cwWordCache.length }} 个可关联
          </div>
        </div>

        <div class="field-label" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" v-model="preview" id="pv" />
          <label for="pv" style="margin:0">实时预览</label>
        </div>
        <div class="hint" style="margin:-4px 0 6px">{{ t('components.cardModal.mdSyntax') }}</div>
        <div v-if="preview" class="preview-grid">
          <div class="preview-pane"><div class="hint">正面预览</div><MarkdownRenderer :content="front" /></div>
          <div class="preview-pane"><div class="hint">背面预览</div><MarkdownRenderer :content="back" /></div>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px">
          <button class="btn" @click="close">取消</button>
          <button class="btn primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.group-picker { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.g-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
.tag-box { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.suggest {
  position: absolute; top: 100%; left: 0; right: 0; background: var(--panel); z-index: 10;
  border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.12);
  max-height: 200px; overflow-y: auto;
}
.suggest-item { padding: 8px 12px; cursor: pointer; }
.suggest-item:hover { background: var(--code-inline); }
.preview-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.preview-pane { border: 1px dashed var(--line); border-radius: 8px; padding: 10px; max-height: 260px; overflow-y: auto; }
.cw-sec { margin-top: 12px; }
/* 关联对象切换（本库卡片 / 英语词卡） */
.rel-tabs { display: flex; gap: 6px; margin-top: 8px; }
.rel-tab {
  font-size: 12px; padding: 3px 12px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink-2);
}
.rel-tab.on { border-color: var(--accent); color: var(--accent); background: var(--code-inline); font-weight: 600; }
.cw-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.cw-chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; font-size: 12px; background: var(--code-inline); }
.cw-chip small { color: var(--ink-2); }
.cw-x { border: 0; background: none; cursor: pointer; color: var(--ink-2); font-size: 14px; line-height: 1; padding: 0 0 0 2px; }
.cw-x:hover { color: var(--red); }
.cw-pick { margin-top: 8px; border: 1px solid var(--line); border-radius: 8px; padding: 8px; background: var(--code-bg); max-height: 220px; overflow-y: auto; }
.cw-pick-item { padding: 7px 10px; cursor: pointer; border-radius: 6px; font-size: 13px; }
.cw-pick-item:hover { background: var(--code-inline); }
.cw-pick-item small { color: var(--ink-2); }
@media (max-width: 720px) { .preview-grid { grid-template-columns: 1fr; } }
</style>