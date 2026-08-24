<script setup>
// 费曼学习法：Agent 基于选中的卡片范围，出题考用户，让用户"以教代学"
import { ref, onMounted, nextTick } from 'vue';
import { toast } from '../utils/toast.js';
import { db, uid } from '../db.js';
import { getSubjects, getTags, getStats, weakCards } from '../repo.js';
import { chatAI, hasAIKey, saveChat, listChats, deleteChat } from '../ai.js';
import { getCardAnalytics } from '../agent/analytics.js';
import VoiceInput from '../components/VoiceInput.vue';
import { speak } from '../utils/tts.js';

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
      if (logic.value === 'AND') r = r.filter(c => selTags.value.every(t => (c.tags || []).includes(t)));
      else if (logic.value === 'OR') r = r.filter(c => selTags.value.some(t => (c.tags || []).includes(t)));
      else r = r.filter(c => !selTags.value.some(t => (c.tags || []).includes(t)));
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

async function start() {
  if (!hasAIKey()) { toast('请先在「AI 设置」里填入密钥', 'error'); return; }
  const cards = filterCards(await db.cards.toArray());
  if (!cards.length) { toast('该范围内没有卡片', 'error'); return; }
  if (!currentId.value) currentId.value = uid();
  started.value = true;
  messages.value = [];
  loading.value = true;
  try {
    const ctx = await buildFeynmanContext(cards);
    const reply = await chatAI([
      { role: 'system', content: FEYN_PROMPT + '\n\n' + ctx },
      { role: 'user', content: '开始吧，先看看我最薄弱的点，出第一道题。' },
    ]);
    messages.value.push({ role: 'assistant', content: reply }); if (voiceOn.value) speak(reply);
  } catch (e) { toast(e.message, 'error'); }
  finally { loading.value = false; scroll(); await persistSession(); }
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
    const ctx = await buildFeynmanContext(cards);
    const reply = await chatAI([
      { role: 'system', content: FEYN_PROMPT + '\n\n' + ctx },
      ...messages.value,
    ]);
    messages.value.push({ role: 'assistant', content: reply }); if (voiceOn.value) speak(reply);
  } catch (e) {
    toast(e.message, 'error');
    messages.value.push({ role: 'assistant', content: '（出错了：' + e.message + '）' });
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
  localStorage.setItem('sxy_last_feynman', currentId.value);
}
function selectSession(id) {
  const s = sessions.value.find(x => x.id === id);
  if (!s) return;
  currentId.value = id;
  messages.value = s.messages || [];
  started.value = messages.value.length > 0;
  localStorage.setItem('sxy_last_feynman', id);
}
async function persistSession() {
  if (!currentId.value) return;
  await saveChat({ id: currentId.value, type: 'feynman', title: '费曼练习', messages: messages.value, createdAt: Date.now() });
  localStorage.setItem('sxy_last_feynman', currentId.value);
  await loadSessions();
}
async function removeSession(id) {
  if (!confirm('删除这个费曼会话？')) return;
  await deleteChat(id);
  if (currentId.value === id) newSession();
  await loadSessions();
}

onMounted(async () => {
  loadMeta(); await loadSessions();
  const last = localStorage.getItem('sxy_last_feynman');
  if (last && sessions.value.some(s => s.id === last)) selectSession(last);
});
</script>

<template>
  <div class="feynman-wrap">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">费曼学习法</h2>
      <button class="chip" :class="{ on: voiceOn }" @click="toggleVoice">语音播报</button>
    </div>
    <p class="hint" style="margin:4px 0 12px">以教代学：AI 出题考你，你用自己的话讲出来，讲不出的就是薄弱点。</p>

    <div v-if="sessions.length" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <span class="hint">历史：</span>
      <button class="btn small primary" @click="newSession">＋ 新练习</button>
      <button v-for="s in sessions" :key="s.id" class="chip" :class="{ on: s.id === currentId }" @click="selectSession(s.id)">
        {{ (s.messages?.length || 0) }} 轮
        <a style="color:var(--red);cursor:pointer;margin-left:4px" @click.stop="removeSession(s.id)">删</a>
      </button>
    </div>

    <div class="panel">
      <div class="row">
        <button class="chip" :class="{ on: allMode }" @click="allMode = true">全量</button>
        <button class="chip" :class="{ on: !allMode }" @click="allMode = false">自定义范围</button>
      </div>
      <template v-if="!allMode">
        <div class="field-label" style="margin-top:0">科目（多选 = 并集）</div>
        <div class="row">
          <button v-for="s in subjects" :key="s.name" class="chip" :class="{ on: selSubjects.includes(s.name) }" @click="toggleSubject(s.name)">{{ s.name }}</button>
        </div>
        <div class="field-label">标签</div>
        <div class="row">
          <button v-for="t in allTags.slice(0, 16)" :key="t.name" class="chip" :class="{ on: selTags.includes(t.name) }" @click="toggleTag(t.name)">{{ t.name }}</button>
          <select v-if="selTags.length" v-model="logic" class="input" style="width:auto">
            <option value="AND">交集（同时含）</option>
            <option value="OR">并集（含任一）</option>
            <option value="NOT">差集（排除）</option>
          </select>
        </div>
      </template>
      <div style="margin-top:12px">
        <button class="btn primary" @click="start">开始费曼练习</button>
      </div>
    </div>

    <div v-if="started" ref="box" class="chat-box">
      <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
        <div class="bubble">{{ m.content }}</div>
      </div>
      <div v-if="loading" class="msg assistant"><div class="bubble">思考中…</div></div>
    </div>

    <div v-if="started" class="input-row">
      <VoiceInput @result="(t) => input = input ? input + t : t" />
      <input v-model="input" class="input" placeholder="用你自己的话回答…" @keydown.enter="send" />
      <button class="btn primary" :disabled="loading" @click="send">回答</button>
    </div>
  </div>
</template>

<style scoped>
.feynman-wrap { max-width: 760px; margin: 0 auto; }
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
</style>