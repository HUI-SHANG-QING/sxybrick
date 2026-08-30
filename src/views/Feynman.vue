<script setup>
// 费曼学习法：Agent 基于选中的卡片范围，出题考用户，让用户"以教代学"
import { confirmDialog } from '../utils/confirm.js';
import { t } from '../i18n/index.js';
import { ref, onMounted, nextTick } from 'vue';
import { toast } from '../utils/toast.js';
import { db, uid } from '../db.js';
import { getSubjects, getTags, getStats, weakCards, applyCardFeedback } from '../repo.js';
import { chatAI, hasAIKey, saveChat, listChats, deleteChat, getChat } from '../ai.js';
import { getCardAnalytics } from '../agent/analytics.js';
import VoiceInput from '../components/VoiceInput.vue';
import { speak } from '../utils/tts.js';
import { T } from '../utils/telemetry.js';

const subjects = ref([]);
const allTags = ref([]);
const selSubjects = ref([]);
const selTags = ref([]);
const logic = ref('AND');
const allMode = ref(true);

const messages = ref([]);
const input = ref('');
const loading = ref(false);
const box = ref(null);
const started = ref(false);

const FEYN_PROMPT = '你是「费曼学习法」教练，用中文自然交互。用"以教代学"帮用户巩固复习：1) 优先针对下面数据里"没记住/薄弱/错题"的知识点提问，帮用户突破盲区；2) 每次只出一道题，让用户用自己的话解释、推导或举例子，而不是简单背答案；3) 用户回答后，先点评对错、指出遗漏，再自然追问深入一层，或过渡到下一个知识点；4) 语气像耐心的老师，多鼓励；一次只解决一个点，不要一次抛一大堆。';

async function loadMeta() {
  subjects.value = await getSubjects();
  allTags.value = await getTags();
}

function toggleSubject(name) {
  const i = selSubjects.value.indexOf(name);
  if (i >= 0) selSubjects.value.splice(i, 1); else selSubjects.value.push(name);
}
function toggleTag(name) {
  const i = selTags.value.indexOf(name);
  if (i >= 0) selTags.value.splice(i, 1); else selTags.value.push(name);
}

function filterCards(cards) {
  let r = cards;
  if (!allMode.value) {
    if (selSubjects.value.length) r = r.filter(c => selSubjects.value.includes(c.subject || '未分类'));
    if (selTags.value.length) {
      if (logic.value === 'AND') r = r.filter(c => selTags.value.every(tag => (c.tags || []).includes(tag)));
      else if (logic.value === 'OR') r = r.filter(c => selTags.value.some(tag => (c.tags || []).includes(tag)));
      else r = r.filter(c => !selTags.value.some(tag => (c.tags || []).includes(tag)));
    }
  }
  return r;
}

function cardsToText(cards) {
  const sample = cards.slice(0, 60);
  return sample.map((c, i) => `${i + 1}. [${c.subject || '未分类'}] 问题：${String(c.front).replace(/\s+/g, ' ').slice(0, 120)} → 答案：${String(c.back).replace(/\s+/g, ' ').slice(0, 160)}${c.mnemonic ? '（助记：' + c.mnemonic + '）' : ''}`).join('\n');
}

// 为卡片补上复习画像（复习次数/错次数/频率/标签/是否高频错频），实现跨模块协同
async function enrichCards(cards, limit = 15) {
  const out = [];
  for (const c of cards.slice(0, limit)) {
    try {
      const a = await getCardAnalytics(c.id);
      out.push({ ...c, stats: a });
    } catch { out.push(c); }
  }
  return out;
}
function enrichedToText(items) {
  return items.map((c, i) => {
    const s = c.stats;
    const flags = [s?.isHighFreq ? '高频' : '', s?.isWrongFreq ? '错频' : ''].filter(Boolean).join('/');
    const statStr = s
      ? `（复习${s.total}次·错${s.wrong}次·正确率${s.correctRate ?? '—'}%${flags ? '·' + flags : ''}·标签[${(c.tags || []).join(',') || '无'}]）`
      : '';
    return `${i + 1}. [${c.subject || '未分类'}] 问题：${String(c.front).replace(/\s+/g, ' ').slice(0, 100)} → 答案：${String(c.back).replace(/\s+/g, ' ').slice(0, 140)}${c.mnemonic ? '（助记：' + c.mnemonic + '）' : ''}${statStr}`;
  }).join('\n');
}

// 基于复习数据构建费曼上下文：优先把范围内薄弱/错题放在最前，并附复习画像
async function buildFeynmanContext(cards) {
  const [stats, weak] = await Promise.all([getStats(), weakCards(40, 1)]);
  const rangeIds = new Set(cards.map(c => c.id));
  const weakInRange = weak.filter(c => rangeIds.has(c.id));
  const L = [];
  L.push(`【用户复习数据】卡片 ${stats.totalCards} 张，总复习 ${stats.totalReviews} 次，平均掌握度 ${stats.avgMastery}%；自评分布：没记住 ${stats.ratingDist[0]} 次 / 还模糊 ${stats.ratingDist[1]} 次 / 记住了 ${stats.ratingDist[2]} 次。`);
  if (weakInRange.length) {
    const enriched = await enrichCards(weakInRange, 15);
    L.push(`【本范围内薄弱/错题卡片（务必优先针对这些提问；每张卡已附复习次数/错次数/正确率/频率/标签）】`);
    L.push(enrichedToText(enriched));
  } else {
    const enriched = await enrichCards(cards, 10);
    L.push(`【本范围内卡片（含复习统计）】`);
    L.push(enrichedToText(enriched));
  }
  return L.join('\n');
}

async function start(initialUserMsg) {
  if (!hasAIKey()) { toast(t('views.feynman.needKey'), 'error'); return; }
  const cards = filterCards(await db.cards.toArray());
  if (!cards.length) { toast(t('views.feynman.noCardsInScope'), 'error'); return; }
  if (!currentId.value) currentId.value = uid();
  started.value = true;
  messages.value = [];
  loading.value = true;
  try {
    const ctx = await getContext(cards); // 上下文构建一次并缓存，后续每轮对话复用（弱设备不卡顿）
    const reply = await chatAI([
      { role: 'system', content: FEYN_PROMPT + '\n\n' + ctx },
      { role: 'user', content: initialUserMsg || '开始吧，先看看我最薄弱的点，出第一道题。' },
    ]);
    messages.value.push({ role: 'assistant', content: reply }); if (voiceOn.value) speak(reply);
    // 行为回写 SRS：完成一次费曼练习，给范围内最薄弱的 5 张卡小幅 ease 加成（每次会话一次）
    if (!fedBoosted) {
      fedBoosted = true;
      const weak = await weakCards(40, 1);
      const rangeIds = new Set(cards.map(c => c.id));
      for (const w of weak.filter(c => rangeIds.has(c.id)).slice(0, 5)) {
        await applyCardFeedback(w.id, { feynman: true });
      }
    }
  } catch (e) { toast(e.message, 'error'); }
  finally { loading.value = false; scroll(); await persistSession(); }
}
let fedBoosted = false; // 每次费曼会话只加成一次

// 上下文缓存：仅在「开始练习」或筛选条件变化时重建（与会话绑定）
let ctxCache = '';
let ctxKey = '';
function ctxSignature(cards) {
  return `${allMode.value}|${[...selSubjects.value].sort().join(',')}|${[...selTags.value].sort().join(',')}|${logic.value}|${cards.length}`;
}
async function getContext(cards) {
  const key = ctxSignature(cards);
  if (ctxCache && key === ctxKey) return ctxCache;
  ctxKey = key;
  ctxCache = await buildFeynmanContext(cards);
  return ctxCache;
}

async function send() {
  const text = input.value.trim();
  if (!text || loading.value || !started.value) return;
  input.value = '';
  messages.value.push({ role: 'user', content: text });
  loading.value = true;
  scroll();
  try {
    const cards = filterCards(await db.cards.toArray());
    const ctx = await getContext(cards);
    const reply = await chatAI([
      { role: 'system', content: FEYN_PROMPT + '\n\n' + ctx },
      ...messages.value,
    ]);
    messages.value.push({ role: 'assistant', content: reply }); if (voiceOn.value) speak(reply);
    try { T.feynmanRound(currentId.value); } catch {}
  } catch (e) {
    toast(e.message, 'error');
    messages.value.push({ role: 'assistant', content: t('views.feynman.errorBubble', '（出错了：{msg}）', { msg: e.message }) });
  } finally { loading.value = false; scroll(); await persistSession(); }
}

function scroll() { nextTick(() => { box.value?.scrollTo({ top: box.value.scrollHeight }); }); }

const voiceOn = ref(localStorage.getItem('sxy_voice') !== '0');
function toggleVoice() {
  voiceOn.value = !voiceOn.value;
  localStorage.setItem('sxy_voice', voiceOn.value ? '1' : '0');
  if (!voiceOn.value && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

const sessions = ref([]);
const currentId = ref('');
async function loadSessions() {
  const all = await listChats();
  sessions.value = all.filter(c => c.type === 'feynman');
}
function newSession() {
  currentId.value = uid();
  messages.value = [];
  started.value = false;
  fedBoosted = false;
  ctxCache = '';
  ctxKey = '';
  localStorage.setItem('sxy_last_feynman', currentId.value);
}
function selectSession(id) {
  const s = sessions.value.find(x => x.id === id);
  if (!s) return;
  currentId.value = id;
  messages.value = s.messages || [];
  started.value = messages.value.length > 0;
  // 恢复会话的筛选范围（便于继续练习使用同样卡片范围）
  if (s.scope) {
    allMode.value = !!s.scope.allMode;
    selSubjects.value = Array.isArray(s.scope.selSubjects) ? [...s.scope.selSubjects] : [];
    selTags.value = Array.isArray(s.scope.selTags) ? [...s.scope.selTags] : [];
    logic.value = s.scope.logic || 'AND';
  }
  localStorage.setItem('sxy_last_feynman', id);
}
async function persistSession() {
  if (!currentId.value) return;
  try {
    const old = await getChat(currentId.value);
    // 最后一条助手消息作为卡片列表的摘要预览
    const lastAssistant = [...messages.value].reverse().find(m => m.role === 'assistant');
    const preview = lastAssistant?.content?.slice(0, 60) || '';
    const scope = {
      allMode: !!allMode.value,
      selSubjects: [...selSubjects.value],
      selTags: [...selTags.value],
      logic: logic.value,
    };
    await saveChat({
      id: currentId.value, type: 'feynman',
      title: '费曼练习',
      messages: messages.value,
      createdAt: old?.createdAt || Date.now(),
      scope, preview,
      rounds: messages.value.filter(m => m.role === 'assistant').length,
    });
    localStorage.setItem('sxy_last_feynman', currentId.value);
    await loadSessions();
  } catch (e) { toast(t('views.feynman.saveSessionFail', '会话保存失败：{msg}', { msg: e.message }), 'error'); }
}
// 构建会话卡片的「范围摘要」文字
function scopeSummary(s) {
  if (!s?.scope || s.scope.allMode) return t('views.feynman.scopeAllCards');
  const parts = [];
  if (s.scope.selSubjects?.length) {
    parts.push(t('views.feynman.scopeSubjects', '科目[{list}]', {
      list: s.scope.selSubjects.slice(0,3).join('/') + (s.scope.selSubjects.length>3 ? '…' : ''),
    }));
  }
  if (s.scope.selTags?.length) {
    const log = s.scope.logic === 'AND' ? t('views.feynman.logicAnd')
      : s.scope.logic === 'NOT' ? t('views.feynman.logicNot') : t('views.feynman.logicOr');
    parts.push(t('views.feynman.scopeTags', '{logic}标签[{list}]', {
      logic: log,
      list: s.scope.selTags.slice(0,3).join('/') + (s.scope.selTags.length>3 ? '…' : ''),
    }));
  }
  return parts.length ? t('views.feynman.scopePrefix') + parts.join(' · ') : t('views.feynman.scopeCustomEmpty');
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  const now = new Date();
  const sameDay = d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth() && d.getDate()===now.getDate();
  if (sameDay) return t('views.feynman.todayAt', '今天 {time}', { time: `${p(d.getHours())}:${p(d.getMinutes())}` });
  return `${d.getMonth()+1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function removeSession(id) {
  if (!(await confirmDialog(t('views.feynman.confirmDeleteSession')))) return;
  await deleteChat(id);
  if (currentId.value === id) newSession();
  await loadSessions();
}

onMounted(async () => {
  loadMeta(); await loadSessions();
  // P2-C 协同：错题集「去费曼练习 →」跳转过来时，预填费曼主题并自动开一轮会话
  const topic = sessionStorage.getItem('sxy_feynman_topic');
  if (topic) {
    const prompt = sessionStorage.getItem('sxy_feynman_prompt')
      || t('views.feynman.topicPrefill', '请用费曼学习法讲解：「{topic}」', { topic });
    sessionStorage.removeItem('sxy_feynman_topic');
    sessionStorage.removeItem('sxy_feynman_prompt');
    newSession();
    input.value = prompt;
    toast(t('views.feynman.topicLoaded', '已载入错题补救的费曼建议：{topic}', { topic }), 'info');
    // 已配 AI Key 则自动开练；否则把 prompt 留在输入框，引导用户先配置
    if (hasAIKey()) {
      await start(prompt);
    } else {
      toast(t('views.feynman.needKeyThenStart'), 'info');
    }
    return;
  }
  const last = localStorage.getItem('sxy_last_feynman');
  if (last && sessions.value.some(s => s.id === last)) selectSession(last);
});
</script>

<template>
  <div class="feynman-wrap">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">{{ t('views.feynman.title') }}</h2>
      <button class="chip" :class="{ on: voiceOn }" @click="toggleVoice">{{ t('views.feynman.voiceBtn') }}</button>
    </div>
    <p class="hint" style="margin:4px 0 12px">{{ t('views.feynman.hint') }}</p>

    <div v-if="sessions.length" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <span class="field-label" style="margin:0">{{ t('views.feynman.historyLabel', '历史练习（{n} 条）', { n: sessions.length }) }}</span>
        <span class="hint">{{ t('views.feynman.historyHint') }}</span>
        <span style="flex:1"></span>
        <button class="btn small primary" @click="newSession">{{ t('views.feynman.newPractice') }}</button>
      </div>
      <div class="feyn-history">
        <div v-for="s in sessions" :key="s.id" class="feyn-card" :class="{ active: s.id === currentId }">
          <div class="feyn-card-head">
            <span class="feyn-ts">🕒 {{ fmtTime(s.updatedAt || s.createdAt) }}</span>
            <span class="feyn-rounds pill">{{ t('views.feynman.rounds', '{n} 轮', { n: (s.rounds ?? (s.messages?.filter(m=>m.role==='assistant').length) ?? 0) }) }}</span>
            <span v-if="s.id === currentId" class="pill on">{{ t('views.feynman.currentSession') }}</span>
            <span style="flex:1"></span>
          </div>
          <div class="feyn-scope">{{ scopeSummary(s) }}</div>
          <div v-if="s.preview || (s.messages?.length)" class="feyn-preview">
            💬 {{ (s.preview || s.messages?.[s.messages.length-1]?.content || t('views.feynman.noConversationYet')).replace(/\s+/g,' ').slice(0, 80) }}
          </div>
          <div class="feyn-actions">
            <button class="btn small primary" @click="selectSession(s.id)">
              {{ s.id === currentId ? t('views.feynman.loaded') : t('views.feynman.continueSession') }}
            </button>
            <button class="btn small" :disabled="s.id === currentId" @click="removeSession(s.id)">{{ t('views.feynman.deleteBtn') }}</button>
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="row">
        <button class="chip" :class="{ on: allMode }" @click="allMode = true">{{ t('views.feynman.scopeAll') }}</button>
        <button class="chip" :class="{ on: !allMode }" @click="allMode = false">{{ t('views.feynman.scopeCustom') }}</button>
      </div>
      <template v-if="!allMode">
        <div class="field-label" style="margin-top:0">{{ t('views.feynman.subjectsLabel') }}</div>
        <div class="row">
          <button v-for="s in subjects" :key="s.name" class="chip" :class="{ on: selSubjects.includes(s.name) }" @click="toggleSubject(s.name)">{{ s.name }}</button>
        </div>
        <div class="field-label">{{ t('views.feynman.tagsLabel') }}</div>
        <div class="row">
          <button v-for="tag in allTags" :key="tag.name" class="chip" :class="{ on: selTags.includes(tag.name) }" @click="toggleTag(tag.name)">{{ tag.name }}</button>
          <select v-if="selTags.length" v-model="logic" class="input" style="width:auto">
            <option value="AND">{{ t('views.feynman.optAnd') }}</option>
            <option value="OR">{{ t('views.feynman.optOr') }}</option>
            <option value="NOT">{{ t('views.feynman.optNot') }}</option>
          </select>
        </div>
      </template>
      <div style="margin-top:12px">
        <button class="btn primary" @click="start">{{ t('views.feynman.startBtn') }}</button>
      </div>
    </div>

    <div v-if="started" ref="box" class="chat-box">
      <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
        <div class="bubble">{{ m.content }}</div>
      </div>
      <div v-if="loading" class="msg assistant"><div class="bubble">{{ t('views.feynman.thinking') }}</div></div>
    </div>

    <div v-if="started" class="input-row">
      <VoiceInput @result="(txt) => input = input ? input + txt : txt" />
      <input v-model="input" class="input" :placeholder="t('views.feynman.answerPlaceholder')" @keydown.enter="send" />
      <button class="btn primary" :disabled="loading" @click="send">{{ t('views.feynman.answerBtn') }}</button>
    </div>
  </div>
</template>

<style scoped>
.feynman-wrap { max-width: 900px; margin: 0 auto; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px; margin-bottom: 16px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.field-label { font-size: 13px; font-weight: 600; color: var(--ink-2); margin: 10px 0 6px; }
.chat-box { height: 320px; overflow-y: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 16px; margin-bottom: 12px; }
.msg { display: flex; margin-bottom: 12px; }
.msg.user { justify-content: flex-end; }
.bubble { max-width: 78%; padding: 10px 14px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; line-height: 1.6; }
.msg.user .bubble { background: var(--accent); color: #fff; }
.msg.assistant .bubble { background: var(--code-bg); color: var(--ink); }
.input-row { display: flex; gap: 8px; }
.input-row .input { flex: 1; }

/* —— 费曼历史卡片列表 —— */
.feyn-history {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
.feyn-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: all .15s ease;
}
.feyn-card:hover { border-color: var(--accent); }
.feyn-card.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  background: color-mix(in srgb, var(--accent) 6%, var(--panel));
}
.feyn-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.feyn-ts { font-size: 12px; color: var(--ink-2); }
.pill {
  display: inline-flex; align-items: center;
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  background: var(--code-inline); color: var(--ink-2); font-weight: 600;
}
.pill.on { background: var(--accent); color: #fff; }
.feyn-rounds { color: var(--blue); background: #dbeafe; }
.feyn-scope { font-size: 13px; color: var(--ink); font-weight: 500; }
.feyn-preview {
  font-size: 12px; color: var(--ink-2);
  padding: 6px 8px; background: var(--code-bg); border-radius: 8px;
  line-height: 1.5; min-height: 20px;
}
.feyn-actions {
  display: flex; gap: 8px; margin-top: 4px;
}
.feyn-actions .btn.small { flex: 1; }
</style>