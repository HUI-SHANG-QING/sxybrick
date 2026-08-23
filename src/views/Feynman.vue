<script setup>
// 费曼学习法：Agent 基于选中的卡片范围，出题考用户，让用户"以教代学"
import { ref, onMounted, nextTick } from 'vue';
import { toast } from '../utils/toast.js';
import { db } from '../db.js';
import { getSubjects, getTags, getStats, weakCards } from '../repo.js';
import { chatAI, hasAIKey } from '../ai.js';
import VoiceInput from '../components/VoiceInput.vue';

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

// 基于复习数据构建费曼上下文：优先把范围内薄弱/错题放在最前
async function buildFeynmanContext(cards) {
  const [stats, weak] = await Promise.all([getStats(), weakCards(40, 1)]);
  const rangeIds = new Set(cards.map(c => c.id));
  const weakInRange = weak.filter(c => rangeIds.has(c.id));
  const L = [];
  L.push(`【用户复习数据】卡片 ${stats.totalCards} 张，总复习 ${stats.totalReviews} 次，平均掌握度 ${stats.avgMastery}%；自评分布：没记住 ${stats.ratingDist[0]} 次 / 还模糊 ${stats.ratingDist[1]} 次 / 记住了 ${stats.ratingDist[2]} 次。`);
  if (weakInRange.length) {
    L.push(`【本范围内薄弱/错题卡片（务必优先针对这些提问）】`);
    L.push(cardsToText(weakInRange));
  } else {
    L.push(`【本范围内卡片】`);
    L.push(cardsToText(cards));
  }
  return L.join('\n');
}

async function start() {
  if (!hasAIKey()) { toast('请先在「AI 设置」里填入密钥', 'error'); return; }
  const cards = filterCards(await db.cards.toArray());
  if (!cards.length) { toast('该范围内没有卡片', 'error'); return; }
  started.value = true;
  messages.value = [];
  loading.value = true;
  try {
    const ctx = await buildFeynmanContext(cards);
    const reply = await chatAI([
      { role: 'system', content: FEYN_PROMPT + '\n\n' + ctx },
      { role: 'user', content: '开始吧，先看看我最薄弱的点，出第一道题。' },
    ]);
    messages.value.push({ role: 'assistant', content: reply });
  } catch (e) { toast(e.message, 'error'); }
  finally { loading.value = false; scroll(); }
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
    messages.value.push({ role: 'assistant', content: reply });
  } catch (e) {
    toast(e.message, 'error');
    messages.value.push({ role: 'assistant', content: '（出错了：' + e.message + '）' });
  } finally { loading.value = false; scroll(); }
}

function scroll() { nextTick(() => { box.value?.scrollTo({ top: box.value.scrollHeight }); }); }

onMounted(loadMeta);
</script>

<template>
  <div class="feynman-wrap">
    <h2 style="margin:0">费曼学习法</h2>
    <p class="hint" style="margin:4px 0 12px">以教代学：AI 出题考你，你用自己的话讲出来，讲不出的就是薄弱点。</p>

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