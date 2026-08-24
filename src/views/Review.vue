<script setup>
// 背诵页：到期队列 + 翻转卡 + 三档自评 + 自由组合筛选 + 每日目标(去重卡片数) + 完成弹窗 + 已背记录(默认全展开)
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import FlipCard from '../components/FlipCard.vue';
import CardModal from '../components/CardModal.vue';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import EmptyState from '../components/EmptyState.vue';
import { toast } from '../utils/toast.js';
import { reviewQueue, review, reviewHistory, getSubjects, getTags, WRONG_REASONS } from '../repo.js';
import { getGoal, getTodayCount, recordReview } from '../utils/streak.js';
import { startSpeech, isSpeechSupported } from '../utils/speech.js';
import { mdToSpeech } from '../utils/tts.js';
import { getConfusablePairs } from '../agent/analytics.js';

const router = useRouter();

const queue = ref([]);
const idx = ref(0);
const loading = ref(false);
const intensity = ref(1);
const interleave = ref(localStorage.getItem('sxy_interleave') !== '0');
const editOpen = ref(false);
const editing = ref(null);

// 每日目标（去重卡片数，跨会话持久化）
const goal = ref(getGoal());
const todayCount = ref(getTodayCount());

// 自由组合筛选
const filterOpen = ref(false);
const fSubjects = ref([]);
const fTags = ref([]);
const fLogic = ref('OR');
const fWrongReasons = ref([]);
const subjects = ref([]);
const allTags = ref([]);

// 完成弹窗
const showComplete = ref(false);
const completeType = ref('goal'); // goal 达成目标 | empty 卡片不足
let goalNotified = false;
let emptyNotified = false;
let repeatMode = false; // 重复复习（背全部而非仅到期）

const tab = ref('due'); // due | history
const history = ref([]);
const historyLoading = ref(false);
const collapsedIds = ref(new Set()); // 已背记录里被收起的卡 id（默认全展开）
const onlyToday = ref(false);

const confusablePairs = ref([]);
const confusableHint = ref('');
const voiceListening = ref(false);
const focusMode = ref(false);
const speechSupported = isSpeechSupported();

const current = () => queue.value[idx.value] || null;
const hasMore = computed(() => idx.value < queue.value.length);

const filterActive = computed(() =>
  fSubjects.value.length + fTags.value.length + fWrongReasons.value.length > 0,
);

function filterObj() {
  return {
    subjects: fSubjects.value,
    tags: fTags.value,
    logic: fLogic.value,
    wrongReasons: fWrongReasons.value,
    includeDueOnly: !repeatMode,
  };
}

async function loadQueue() {
  loading.value = true;
  try {
    queue.value = await reviewQueue(100, interleave.value, filterObj());
    idx.value = 0;
    goalNotified = false;
    emptyNotified = false;
    confusablePairs.value = await getConfusablePairs(40);
  } catch (e) { toast(e.message, 'error'); }
  finally { loading.value = false; }
}

async function rate(card, rating, guessed = false, meta = {}) {
  try {
    const res = await review(card.id, rating, intensity.value, guessed, meta);
    recordReview(card.id);            // 记录今日去重卡片
    todayCount.value = getTodayCount(); // 跨会话同步
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
    checkComplete();
  } catch (e) { toast(e.message, 'error'); }
}

function checkComplete() {
  // 队列空了：卡片不足（未达标）或已达标
  if (!hasMore.value && !emptyNotified) {
    emptyNotified = true;
    const reached = todayCount.value >= goal.value;
    completeType.value = reached ? 'goal' : 'empty';
    showComplete.value = true;
    return;
  }
  // 达成目标（还有剩余卡）
  if (!goalNotified && todayCount.value >= goal.value) {
    goalNotified = true;
    completeType.value = 'goal';
    showComplete.value = true;
  }
}

function nextRound() {
  showComplete.value = false;
  repeatMode = true; // 队列空后点"下一轮/重复复习"→ 背全部（含未到期）
  loadQueue();
}
function viewToday() {
  showComplete.value = false;
  onlyToday.value = true;
  switchTab('history');
}
function exitReview() {
  showComplete.value = false;
  router.push('/');
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

function toggleFSubject(name) {
  const i = fSubjects.value.indexOf(name);
  if (i >= 0) fSubjects.value.splice(i, 1); else fSubjects.value.push(name);
}
function toggleFTag(name) {
  const i = fTags.value.indexOf(name);
  if (i >= 0) fTags.value.splice(i, 1); else fTags.value.push(name);
}
function toggleFWrong(r) {
  const i = fWrongReasons.value.indexOf(r);
  if (i >= 0) fWrongReasons.value.splice(i, 1); else fWrongReasons.value.push(r);
}
function applyFilter() { filterOpen.value = false; repeatMode = false; loadQueue(); }
function clearFilter() { fSubjects.value = []; fTags.value = []; fWrongReasons.value = []; fLogic.value = 'OR'; repeatMode = false; loadQueue(); }

async function loadMeta() {
  subjects.value = await getSubjects();
  allTags.value = await getTags();
}

async function loadHistory() {
  historyLoading.value = true;
  try { history.value = await reviewHistory(300); }
  catch (e) { toast(e.message, 'error'); }
  finally { historyLoading.value = false; }
}

const shownHistory = computed(() => {
  if (!onlyToday.value) return history.value;
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  return history.value.filter(h => h.reviewedAt >= dayStart.getTime());
});

function switchTab(t) {
  tab.value = t;
  if (t === 'history' && !history.value.length) loadHistory();
}
function toggleCollapse(id) {
  const s = new Set(collapsedIds.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  collapsedIds.value = s;
}
function collapseAll() { collapsedIds.value = new Set(shownHistory.value.map(h => h.id)); }
function expandAll() { collapsedIds.value = new Set(); }

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
  loadMeta();
  focusTimer = setInterval(() => { focusSeconds.value++; }, 1000);
});
onBeforeUnmount(() => { clearInterval(focusTimer); document.body.classList.remove('review-focus'); });
</script>

<template>
  <div style="max-width:760px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">专注背诵</h2>
      <span class="hint">今日 {{ todayCount }} / {{ goal }} 张</span>
      <span class="hint">待背 {{ Math.max(0, queue.length - idx) }} 张</span>
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
        <button class="chip" :class="{ on: filterActive }" @click="filterOpen = !filterOpen">
          筛选背诵{{ filterActive ? '（已选）' : '' }}
        </button>
        <button v-if="speechSupported" class="chip" :class="{ on: voiceListening }" @click="voiceEval">{{ voiceListening ? '聆听中…' : '语音作答' }}</button>
        <button class="chip" :class="{ on: focusMode }" @click="toggleFocus">专注模式</button>
      </div>

      <!-- 自由组合筛选面板 -->
      <div v-if="filterOpen" class="panel no-print" style="margin-top:12px">
        <div class="field-label" style="margin-top:0">科目（多选，并集）</div>
        <div class="row">
          <button v-for="s in subjects" :key="s.name" class="chip" :class="{ on: fSubjects.includes(s.name) }" @click="toggleFSubject(s.name)">{{ s.name }}<span v-if="s.count" class="n">{{ s.count }}</span></button>
          <button v-if="fSubjects.length" class="chip" @click="fSubjects = []">清除</button>
        </div>
        <div class="field-label">标签（多选）</div>
        <div class="row">
          <button v-for="t in allTags" :key="t.name" class="chip" :class="{ on: fTags.includes(t.name) }" @click="toggleFTag(t.name)">{{ t.name }}<span class="n">{{ t.count }}</span></button>
          <select v-if="fTags.length" v-model="fLogic" class="input" style="width:auto">
            <option value="OR">并集 OR</option>
            <option value="AND">交集 AND</option>
            <option value="NOT">差集 NOT</option>
          </select>
        </div>
        <div class="field-label">错因（多选）</div>
        <div class="row">
          <button v-for="r in WRONG_REASONS" :key="r" class="chip" :class="{ on: fWrongReasons.includes(r) }" @click="toggleFWrong(r)">{{ r }}</button>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary" @click="applyFilter">应用筛选</button>
          <button class="btn" @click="clearFilter">清除全部</button>
        </div>
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
        <div v-if="todayCount > 0" class="celebrate">
          <div class="celebrate-ring">{{ todayCount }}</div>
          <h3>本轮复习完成</h3>
          <p class="hint">今日已复习 {{ todayCount }} 张（目标 {{ goal }} 张）</p>
          <button class="btn primary" @click="nextRound">继续复习</button>
        </div>
        <template v-else>
          <h3>当前没有到期的卡片</h3>
          <p class="hint">所有卡片都已安排到未来复习，去「我的卡片」新建或编辑卡片吧。</p>
        </template>
      </div>
    </template>

    <template v-else>
      <div v-if="historyLoading" class="hint" style="text-align:center;padding:40px">加载中…</div>

      <div v-else-if="shownHistory.length">
        <div style="display:flex;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap">
          <span class="hint">共 {{ shownHistory.length }} 条 · 默认全展开，点「收起」隐藏熟悉的卡</span>
          <span style="flex:1"></span>
          <button class="chip" :class="{ on: onlyToday }" @click="onlyToday = !onlyToday">只看今日</button>
          <button class="chip" @click="expandAll">全部展开</button>
          <button class="chip" @click="collapseAll">全部收起</button>
        </div>

        <div class="history-list">
          <div v-for="h in shownHistory" :key="h.id" class="card-item">
            <div class="tags">
              <span v-if="h.subject" class="tag-pill subj">{{ h.subject }}</span>
              <span v-for="t in h.tags" :key="t" class="tag-pill">{{ t }}</span>
            </div>
            <!-- 默认全展开；点「收起」才隐藏详情 -->
            <div v-if="!collapsedIds.has(h.id)" class="history-detail">
              <div class="hint" style="margin:6px 0 2px">正面</div>
              <MarkdownRenderer :content="h.front" />
              <div class="hint" style="margin:10px 0 2px">背面 / 答案</div>
              <MarkdownRenderer :content="h.back" />
            </div>
            <div v-else class="front-preview">{{ plain(h.front).slice(0, 120) || '（空）' }}</div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px">
              <span class="hint">{{ fmtTime(h.reviewedAt) }}</span>
              <div style="display:flex;gap:8px;align-items:center">
                <button class="btn small" @click="toggleCollapse(h.id)">{{ collapsedIds.has(h.id) ? '展开' : '收起' }}</button>
                <span class="rating-pill" :class="'r' + h.rating">{{ h.ratingText }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="empty">
        <EmptyState title="还没有背诵记录" message="完成第一张卡的背诵后，这里会显示你的历史记录" />
      </div>
    </template>

    <CardModal v-model="editOpen" :card="editing" @saved="onSaved" />

    <!-- 完成弹窗 -->
    <teleport to="body">
      <div v-if="showComplete" class="modal-mask" @click.self="showComplete = false">
        <div class="modal" style="max-width:420px;text-align:center">
          <div class="celebrate-ring" style="margin:0 auto 14px">{{ todayCount }}</div>
          <h3 style="margin-top:0">{{ completeType === 'goal' ? '今日复习已完成 🎉' : '卡片已全部复习完' }}</h3>
          <p class="hint" style="line-height:1.8">
            <template v-if="completeType === 'goal'">今日已复习 <b>{{ todayCount }}</b> 张，达成目标 <b>{{ goal }}</b> 张。</template>
            <template v-else>今日已复习 <b>{{ todayCount }}</b> 张，当前到期卡片已全部复习完（目标 {{ goal }} 张）。</template>
          </p>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:16px">
            <button class="btn primary" @click="nextRound">
              {{ completeType === 'goal' ? (hasMore ? '继续复习' : '开始下一轮复习') : '重复复习' }}
            </button>
            <button class="btn" @click="viewToday">查看今日复习</button>
            <button class="btn" @click="exitReview">退出</button>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
.empty { text-align: center; padding: 60px 0; }
.celebrate-ring {
  width: 84px; height: 84px; border-radius: 50%;
  background: var(--green); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 30px; font-weight: 700;
  animation: pop .45s ease;
}
@keyframes pop {
  0% { transform: scale(.4); opacity: 0; }
  70% { transform: scale(1.12); }
  100% { transform: scale(1); opacity: 1; }
}
.history-list { margin-top: 12px; }
.front-preview { color: var(--ink); }
.rating-pill { font-size: 12px; border-radius: 6px; padding: 2px 10px; font-weight: 600; }
.rating-pill.r0 { background: #fee2e2; color: var(--red); }
.rating-pill.r1 { background: #fef3c7; color: var(--amber); }
.rating-pill.r2 { background: #dcfce7; color: var(--green); }
.history-detail { border-top: 1px dashed var(--line); margin-top: 8px; padding-top: 4px; }
.confusable-hint { margin-top: 12px; padding: 10px 14px; border: 1px solid #fcd34d; background: #fef3c7; color: #92400e; border-radius: 8px; font-size: 13px; }
</style>
