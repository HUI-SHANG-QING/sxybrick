<script setup>
// 背诵页：到期队列 + 翻转卡 + 三档自评 + 强度系数 + 已背记录（本地）
import { ref, onMounted, onBeforeUnmount } from 'vue';
import FlipCard from '../components/FlipCard.vue';
import CardModal from '../components/CardModal.vue';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import EmptyState from '../components/EmptyState.vue';
import { toast } from '../utils/toast.js';
import { reviewQueue, review, reviewHistory } from '../repo.js';
import { recordReview } from '../utils/streak.js';
import { startSpeech, isSpeechSupported } from '../utils/speech.js';
import { mdToSpeech } from '../utils/tts.js';
import { getConfusablePairs } from '../agent/analytics.js';

const queue = ref([]);
const idx = ref(0);
const loading = ref(false);
const intensity = ref(1);
const interleave = ref(localStorage.getItem('sxy_interleave') !== '0'); // 默认开交错混科
const editOpen = ref(false);
const editing = ref(null);
const doneCount = ref(0);

const tab = ref('due'); // due | history
const history = ref([]);
const historyLoading = ref(false);
const expandId = ref(null);
const confusablePairs = ref([]);
const confusableHint = ref('');
const voiceListening = ref(false);
const focusMode = ref(false);
const speechSupported = isSpeechSupported();

const current = () => queue.value[idx.value] || null;

async function loadQueue() {
  loading.value = true;
  try {
    queue.value = await reviewQueue(100, interleave.value);
    idx.value = 0;
    confusablePairs.value = await getConfusablePairs(40);
  } catch (e) { toast(e.message, 'error'); }
  finally { loading.value = false; }
}

async function rate(card, rating, guessed = false, meta = {}) {
  try {
    const res = await review(card.id, rating, intensity.value, guessed, meta);
    doneCount.value += 1;
    recordReview();
    let msg = `下次复习：${res.dueText}`;
    if (rating === 0) {
      const pair = confusablePairs.value.find(p => p.a.id === card.id || p.b.id === card.id);
      if (pair) {
        const other = pair.a.id === card.id ? pair.b : pair.a;
        confusableHint.value = `⚠ 易混提醒：这张卡常与「${other.front}」一起出错，建议紧接着复习对比。`;
        msg += '；已标记易混对';
      } else confusableHint.value = '';
    } else confusableHint.value = '';
    toast(msg, 'success');
    if (rating === 0) queue.value.push({ ...card, ...res });
    idx.value += 1;
  } catch (e) { toast(e.message, 'error'); }
}

function voiceEval() {
  const card = current();
  if (!card) return;
  voiceListening.value = true;
  const rec = startSpeech((text) => {
    voiceListening.value = false;
    const backText = mdToSpeech(card.back);
    const keywords = backText.split(/[\s，。、；：,.;:!?！？]+/).filter(w => w.length >= 2);
    const hit = keywords.filter(k => text.includes(k)).length;
    const cov = keywords.length ? Math.round((hit / keywords.length) * 100) : 0;
    toast(`语音作答覆盖 ${cov}%（命中 ${hit}/${keywords.length} 个要点）`, cov >= 60 ? 'success' : 'info');
  }, () => { voiceListening.value = false; });
  if (!rec) { voiceListening.value = false; toast('当前浏览器不支持语音识别', 'error'); }
}

function toggleFocus() {
  focusMode.value = !focusMode.value;
  document.body.classList.toggle('review-focus', focusMode.value);
}

function toggleInterleave() {
  interleave.value = !interleave.value;
  localStorage.setItem('sxy_interleave', interleave.value ? '1' : '0');
  loadQueue();
}

function openEdit(card) { editing.value = card; editOpen.value = true; }
function onSaved() { loadQueue(); }

async function loadHistory() {
  historyLoading.value = true;
  try { history.value = await reviewHistory(200); }
  catch (e) { toast(e.message, 'error'); }
  finally { historyLoading.value = false; }
}

function switchTab(t) {
  tab.value = t;
  if (t === 'history' && !history.value.length) loadHistory();
}
function toggleExpand(id) { expandId.value = expandId.value === id ? null : id; }

function plain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [图片] ')
    .replace(/\$\$?([^$\n]+)\$\$?/g, ' $1 ')
    .replace(/[*_#>`~|-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const focusSeconds = ref(0);
let focusTimer = null;
function fmtFocus(s) {
  const m = Math.floor(s / 60), sec = s % 60;
  return m > 0 ? `${m} 分 ${sec} 秒` : `${sec} 秒`;
}

onMounted(() => {
  loadQueue();
  focusTimer = setInterval(() => { focusSeconds.value++; }, 1000);
});
onBeforeUnmount(() => { clearInterval(focusTimer); document.body.classList.remove('review-focus'); });
</script>

<template>
  <div style="max-width:760px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">专注背诵</h2>
      <span class="hint">待背 {{ Math.max(0, queue.length - idx) }} 张 · 已完成 {{ doneCount }}</span>
      <span class="hint" style="color:var(--green)">已专注 {{ fmtFocus(focusSeconds) }}</span>
      <span style="flex:1"></span>
      <button class="chip" :class="{ on: tab === 'due' }" @click="switchTab('due')">待背</button>
      <button class="chip" :class="{ on: tab === 'history' }" @click="switchTab('history')">已背记录</button>
    </div>

    <template v-if="tab === 'due'">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px">
        <label class="hint">复习强度</label>
        <select v-model.number="intensity" class="input" style="width:auto">
          <option :value="1">正常</option>
          <option :value="1.5">考试临近（更频繁）</option>
          <option :value="2">考前冲刺（最高频）</option>
        </select>
        <button class="chip" :class="{ on: interleave }" @click="toggleInterleave">交错混科</button>
        <button v-if="speechSupported" class="chip" :class="{ on: voiceListening }" @click="voiceEval">{{ voiceListening ? '聆听中…' : '语音作答' }}</button>
        <button class="chip" :class="{ on: focusMode }" @click="toggleFocus">专注模式</button>
      </div>

      <div v-if="loading" class="hint" style="text-align:center;padding:60px">加载中…</div>

      <template v-else-if="current()">
        <FlipCard :card="current()" @rate="rate" @edit="openEdit" />
        <div v-if="confusableHint" class="confusable-hint">{{ confusableHint }}</div>
        <div class="hint" style="text-align:center;margin-top:12px">
          第 {{ idx + 1 }} / {{ queue.length }} 张 · 翻到背面后选择自评结果
        </div>
      </template>

      <div v-else class="empty">
        <div v-if="doneCount > 0" class="celebrate">
          <div class="celebrate-ring">{{ doneCount }}</div>
          <h3>本轮复习完成</h3>
          <p class="hint">共完成 {{ doneCount }} 张，继续保持！</p>
          <button class="btn primary" @click="loadQueue()">继续复习</button>
        </div>
        <template v-else>
          <h3>当前没有到期的卡片</h3>
          <p class="hint">所有卡片都已安排到未来复习，去「我的卡片」新建或编辑卡片吧。</p>
        </template>
      </div>
    </template>

    <template v-else>
      <div v-if="historyLoading" class="hint" style="text-align:center;padding:40px">加载中…</div>

      <div v-else-if="history.length" class="history-list">
        <div v-for="h in history" :key="h.id" class="card-item">
          <div class="tags">
            <span v-if="h.subject" class="tag-pill subj">{{ h.subject }}</span>
            <span v-for="t in h.tags" :key="t" class="tag-pill">{{ t }}</span>
          </div>
          <div class="front-preview">{{ plain(h.front).slice(0, 120) || '（空）' }}</div>
          <div v-if="expandId === h.id" class="history-detail">
            <div class="hint" style="margin:6px 0 2px">正面</div>
            <MarkdownRenderer :content="h.front" />
            <div class="hint" style="margin:10px 0 2px">背面 / 答案</div>
            <MarkdownRenderer :content="h.back" />
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px">
            <span class="hint">{{ fmtTime(h.reviewedAt) }}</span>
            <div style="display:flex;gap:8px;align-items:center">
              <button class="btn small" @click="toggleExpand(h.id)">{{ expandId === h.id ? '收起' : '查看完整' }}</button>
              <span class="rating-pill" :class="'r' + h.rating">{{ h.ratingText }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="empty">
        <EmptyState title="还没有背诵记录" message="完成第一张卡的背诵后，这里会显示你的历史记录" />
      </div>
    </template>

    <CardModal v-model="editOpen" :card="editing" @saved="onSaved" />
  </div>
</template>

<style scoped>
.empty { text-align: center; padding: 60px 0; }
.celebrate-ring {
  width: 84px; height: 84px; border-radius: 50%;
  background: var(--green); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 30px; font-weight: 700;
  margin: 0 auto 14px;
  animation: pop .45s ease;
}
@keyframes pop {
  0% { transform: scale(.4); opacity: 0; }
  70% { transform: scale(1.12); }
  100% { transform: scale(1); opacity: 1; }
}
.history-list { margin-top: 16px; }
.front-preview { color: var(--ink); }
.rating-pill { font-size: 12px; border-radius: 6px; padding: 2px 10px; font-weight: 600; }
.rating-pill.r0 { background: #fee2e2; color: var(--red); }
.rating-pill.r1 { background: #fef3c7; color: var(--amber); }
.rating-pill.r2 { background: #dcfce7; color: var(--green); }
.history-detail { border-top: 1px dashed var(--line); margin-top: 8px; padding-top: 4px; }
.confusable-hint { margin-top: 12px; padding: 10px 14px; border: 1px solid #fcd34d; background: #fef3c7; color: #92400e; border-radius: 8px; font-size: 13px; }
</style>