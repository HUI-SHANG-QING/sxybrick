<script setup>
// 背诵页：到期队列 + 翻转卡 + 三档自评 + 自由组合筛选 + 每日目标(去重卡片数) + 完成弹窗 + 已背记录(默认全展开)
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRouter } from 'vue-router';
import FlipCard from '../components/FlipCard.vue';
import CardModal from '../components/CardModal.vue';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import EmptyState from '../components/EmptyState.vue';
import { toast } from '../utils/toast.js';
import { db } from '../db.js';
import { reviewQueue, review, reviewHistory, getSubjects, getTags, WRONG_REASONS, applyCardFeedback, RETRIEVAL_STRENGTH_OPTIONS } from '../repo.js';
import { getGoal, getTodayCount } from '../utils/streak.js';
import { startSpeech, isSpeechSupported } from '../utils/speech.js';
import { mdToSpeech, speak } from '../utils/tts.js';
import { getConfusablePairs, getGraphDrivenReviewPlan } from '../agent/analytics.js';
import { getQuickCheckDue, recordQuickCheck } from '../utils/quickCheck.js';
import { recommendTodaySequence, syncReviewToPlan } from '../intelligence.js';
import { T } from '../utils/telemetry.js';

const router = useRouter();

const queue = ref([]);
const idx = ref(0);
const loading = ref(false);
const intensity = ref(Number(localStorage.getItem('sxy_rv_intensity')) || 1);
// P1-3 检索强度分级（再认/回忆/生成/讲解）：映射不同间隔乘子，与 intensity（时间压力）正交
const retrievalStrength = ref(localStorage.getItem('sxy_rv_retrieval') || 'recall');
const interleave = ref(localStorage.getItem('sxy_interleave') !== '0');
const editOpen = ref(false);
const editing = ref(null);

// 每日目标（去重卡片数，存 db.meta 随同步跨设备）
const goal = ref(20);
const todayCount = ref(0);

// 自由组合筛选（持久化：切走后回来保留筛选条件）
const filterOpen = ref(false);
const fSubjects = ref(JSON.parse(localStorage.getItem('sxy_rv_fsubs') || '[]'));
const fTags = ref(JSON.parse(localStorage.getItem('sxy_rv_ftags') || '[]'));
const fLogic = ref(localStorage.getItem('sxy_rv_flogic') || 'OR');
const fWrongReasons = ref(JSON.parse(localStorage.getItem('sxy_rv_fwrong') || '[]'));
const subjects = ref([]);
const allTags = ref([]);

// 完成弹窗
const showComplete = ref(false);
const completeType = ref('goal'); // goal 达成目标 | empty 卡片不足
let goalNotified = false;
let emptyNotified = false;
let repeatMode = false; // 重复复习（背全部而非仅到期）

const tab = ref(localStorage.getItem('sxy_rv_tab') || 'due'); // due | history
const history = ref([]);
const historyLoading = ref(false);
const collapsedIds = ref(new Set(JSON.parse(localStorage.getItem('sxy_rv_collapsed') || '[]'))); // 已背记录里被收起的卡 id（默认全展开）
const onlyToday = ref(false);

const confusablePairs = ref([]);
const confusableHint = ref('');
const voiceListening = ref(false);
const focusMode = ref(false);
const speechSupported = isSpeechSupported();
// P3-C 语音复习：TTS 朗读题面/答案 + 自动朗读模式
const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;
const autoRead = ref(localStorage.getItem('sxy_rv_autoread') === '1');
const reading = ref(''); // '' | 'front' | 'back'，标识当前正在朗读哪一面
const graphMode = ref(localStorage.getItem('sxy_rv_graph') === '1');
const graphMeta = ref(null);
// P2·#14 今日最优序列：综合到期+薄弱+精力曲线+交错混科+变式分散的智能排程
const smartMode = ref(localStorage.getItem('sxy_rv_smart') === '1');
const smartMeta = ref(null); // { segments, summary, phase }

// 短期提取巩固（C6）：新卡 10min~1h 内快速校验，不计 SRS
const quickMode = ref(false);
const quickQueue = ref([]);
const quickIdx = ref(0);
const quickFlipped = ref(false);
let quickCheckTimer = null;
const quickCurrent = computed(() => quickQueue.value[quickIdx.value] || null);

const current = () => queue.value[idx.value] || null;
const hasMore = computed(() => idx.value < queue.value.length);

// 卡片导航：上一张/下一张（不重置翻转状态，FlipCard 会 watch card.id 自动重置）
function prevCard() {
  if (idx.value > 0) idx.value -= 1;
}
function nextCard() {
  if (idx.value < queue.value.length - 1) idx.value += 1;
}

// 短期提取巩固提示：当前卡处于阶段1（当日巩固）/ 阶段2（隔日巩固）时给出认知科学说明
const consolidationHint = computed(() => {
  const c = current();
  if (!c) return '';
  if (c.consolidation === 1) return '🧠 当日巩固 · 6 小时内首次主动提取，强化工作记忆→长期记忆转化';
  if (c.consolidation === 2) return '😴 隔日巩固 · 跨越睡眠周期，固化长期记忆';
  return '';
});
// 队列中短期巩固卡数量（让用户知道有几张在巩固阶段）
const consolidationCount = computed(() =>
  queue.value.filter(c => c.consolidation === 1 || c.consolidation === 2).length
);

// 图驱动复习：当前卡为何被排在这里（前置知识/易混配对）
const graphHint = computed(() => {
  if (!graphMode.value) return '';
  const c = current();
  if (!c) return '';
  if (c.graphReason === '前置知识') return '🧠 图驱动 · 前置知识：先把这块基础过一遍，再复习依赖它的卡';
  if (c.graphReason === '易混配对') return '🔀 图驱动 · 易混配对：与上一张挨着复习，强化辨析';
  if (c.graphReason === '到期/薄弱') return '📌 图驱动 · 当前到期/薄弱卡';
  return '';
});

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
    if (smartMode.value) {
      // 今日最优序列：智能排程（含交错混科+难度梯度+变式分散），优先级最高
      const opt = { limit: 100, includeNew: false };
      if (fSubjects.value.length === 1) opt.focusSubject = fSubjects.value[0];
      const r = await recommendTodaySequence(opt);
      queue.value = r.sequence || [];
      smartMeta.value = r;
      graphMeta.value = null;
    } else if (graphMode.value) {
      const plan = await getGraphDrivenReviewPlan({ limit: 100, includeDueOnly: !repeatMode });
      queue.value = plan.path;
      graphMeta.value = plan;
      smartMeta.value = null;
    } else {
      queue.value = await reviewQueue(100, interleave.value, filterObj());
      graphMeta.value = null;
      smartMeta.value = null;
    }
    idx.value = 0;
    goalNotified = false;
    emptyNotified = false;
    confusablePairs.value = await getConfusablePairs(40);
  } catch (e) { toast(e.message, 'error'); }
  finally { loading.value = false; }
}

function toggleSmart() {
  smartMode.value = !smartMode.value;
  localStorage.setItem('sxy_rv_smart', smartMode.value ? '1' : '0');
  if (smartMode.value) {
    interleave.value = false; // 智能序列已含交错
    graphMode.value = false;
    localStorage.setItem('sxy_rv_graph', '0');
  }
  loadQueue();
}

// 智能序列段落提示（热身/主攻/收尾）
const smartHint = computed(() => {
  if (!smartMode.value || !smartMeta.value?.segments) return '';
  const i = idx.value;
  const segs = smartMeta.value.segments;
  for (const s of segs) {
    const [start, end] = s.range.split('-').map(Number);
    if (i + 1 >= start && i + 1 <= end) return `🎯 ${s.name}：${s.desc}`;
  }
  return '';
});

function toggleGraph() {
  graphMode.value = !graphMode.value;
  localStorage.setItem('sxy_rv_graph', graphMode.value ? '1' : '0');
  if (graphMode.value) interleave.value = false; // 图驱动已自带排序，关交错混科
  loadQueue();
}

async function rate(card, rating, guessed = false, meta = {}) {
  try {
    const res = await review(card.id, rating, intensity.value, guessed, { ...meta, adaptive: adaptiveOn.value, retrievalStrength: retrievalStrength.value });
    todayCount.value = await getTodayCount(); // 从 db.reviews 推导（跨会话/跨设备同步）
    // P2·#12 计划↔复习联动：复习后刷新引用此卡的计划的进度
    syncReviewToPlan(card.id).catch(() => {});
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
    try { T.reviewRate(rating, card.id, card.front); } catch { /* 埋点失败不阻塞业务 */ }
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
    // 行为回写 SRS：复述覆盖率影响这张卡的 ease 与下次复习时间（数据一致性闭环）
    applyCardFeedback(card.id, { score: cov });
    const low = cov < 40 ? '；已安排 30 分钟内趁热重练' : cov >= 85 ? '；记忆较稳，间隔微调放宽' : '';
    toast(`语音作答覆盖 ${cov}%（命中 ${hit}/${keywords.length} 个要点）${low}`, cov >= 60 ? 'success' : 'info');
  }, () => { voiceListening.value = false; });
  if (!rec) { voiceListening.value = false; toast('当前浏览器不支持语音识别', 'error'); }
}

// P3-C TTS 朗读：part = 'front' | 'back'
function readAloud(part = 'front') {
  if (!ttsSupported) { toast('当前浏览器不支持语音朗读', 'error'); return; }
  const card = current();
  if (!card) return;
  const text = part === 'back' ? card.back : card.front;
  const ok = speak(text);
  if (!ok) { toast('该卡无可朗读内容', 'info'); return; }
  reading.value = part;
  // 朗读结束后清除状态（SpeechSynthesis 无精确 end 事件可靠，用定时兜底）
  const dur = Math.max(1500, mdToSpeech(text).length * 180);
  setTimeout(() => { if (reading.value === part) reading.value = ''; }, dur);
}
function stopRead() {
  if (ttsSupported) window.speechSynthesis?.cancel();
  reading.value = '';
}
function toggleAutoRead() {
  autoRead.value = !autoRead.value;
  localStorage.setItem('sxy_rv_autoread', autoRead.value ? '1' : '0');
  if (!autoRead.value) stopRead();
  else readAloud('front');
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
function saveFilter() {
  localStorage.setItem('sxy_rv_fsubs', JSON.stringify(fSubjects.value));
  localStorage.setItem('sxy_rv_ftags', JSON.stringify(fTags.value));
  localStorage.setItem('sxy_rv_flogic', fLogic.value);
  localStorage.setItem('sxy_rv_fwrong', JSON.stringify(fWrongReasons.value));
}
function applyFilter() { filterOpen.value = false; repeatMode = false; saveFilter(); loadQueue(); }
function clearFilter() { fSubjects.value = []; fTags.value = []; fWrongReasons.value = []; fLogic.value = 'OR'; repeatMode = false; saveFilter(); loadQueue(); }

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
  tab.value = t; localStorage.setItem('sxy_rv_tab', t);
  if (t === 'history' && !history.value.length) loadHistory();
}
function saveCollapsed() { localStorage.setItem('sxy_rv_collapsed', JSON.stringify([...collapsedIds.value])); }
function toggleCollapse(id) {
  const s = new Set(collapsedIds.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  collapsedIds.value = s; saveCollapsed();
}
function collapseAll() { collapsedIds.value = new Set(shownHistory.value.map(h => h.id)); saveCollapsed(); }
function expandAll() { collapsedIds.value = new Set(); saveCollapsed(); }

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

onMounted(async () => {
  goal.value = await getGoal();
  todayCount.value = await getTodayCount();
  focusSeconds.value = Number(localStorage.getItem('sxy_rv_focus')) || 0;
  // 恢复未完成的 25 分钟会话（基于 endTs 校准剩余时间）
  const savedEnd = Number(localStorage.getItem('sxy_rv_session_end'));
  if (savedEnd && savedEnd > Date.now()) {
    sessionOn.value = true;
    sessionLeft.value = Math.round((savedEnd - Date.now()) / 1000);
    sessionEndTs = savedEnd;
    startSessionTimer();
  } else if (savedEnd) {
    localStorage.removeItem('sxy_rv_session_end');
  }
  loadQueue();
  loadMeta();
  focusTimer = setInterval(() => { focusSeconds.value++; }, 1000);
  document.addEventListener('keydown', onKey);
  // 短期提取巩固：检查刚学的新卡是否需要快速校验
  const quickDue = await getQuickCheckDue();
  if (quickDue.length) {
    quickQueue.value = quickDue;
    quickMode.value = true;
  }
  // 每分钟检查一次是否有新卡进入快速校验窗口
  quickCheckTimer = setInterval(async () => {
    if (quickMode.value || showComplete.value || loading.value) return;
    const due = await getQuickCheckDue();
    if (due.length) {
      quickQueue.value = due;
      quickIdx.value = 0;
      quickFlipped.value = false;
      quickMode.value = true;
      toast(`⚡ ${due.length} 张新卡需要快速校验`, 'info');
    }
  }, 60000);
});
watch(intensity, v => localStorage.setItem('sxy_rv_intensity', String(v)));
watch(retrievalStrength, v => localStorage.setItem('sxy_rv_retrieval', v));
// P3-C：切到新卡时若开启自动朗读，先停旧朗读再读题面
watch([idx, queue], () => {
  stopRead();
  if (autoRead.value && tab.value === 'due' && current()) {
    setTimeout(() => readAloud('front'), 120);
  }
});
onBeforeUnmount(() => {
  clearInterval(focusTimer);
  clearInterval(sessionTimer);
  clearInterval(quickCheckTimer);
  localStorage.setItem('sxy_rv_focus', String(focusSeconds.value));
  document.body.classList.remove('review-focus');
  document.removeEventListener('keydown', onKey);
  stopRead(); // 离开页面停止朗读
});

// ---- 键盘快捷键（P0 效率包）：空格翻面 · 1 没记住 · 2 还模糊 · 3 记住了 ----
const flipRef = ref(null);
function onKey(e) {
  if (tab.value !== 'due' || showComplete.value || loading.value) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  // 短期提取巩固快捷键：空格翻面 · 1 没记住 · 2 记住了
  if (quickMode.value && quickCurrent.value) {
    if (e.code === 'Space') { e.preventDefault(); quickFlipped.value = true; return; }
    if (quickFlipped.value) {
      if (e.key === '1') { e.preventDefault(); quickRate(false); }
      else if (e.key === '2') { e.preventDefault(); quickRate(true); }
    }
    return;
  }
  if (!current()) return;
  // 上一张/下一张导航（与翻面/评级无关，任意翻转状态均可触发）
  if (e.key === 'ArrowLeft') { e.preventDefault(); prevCard(); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); nextCard(); return; }
  if (e.code === 'Space') {
    e.preventDefault();
    const wasFlipped = flipRef.value?.flipped;
    flipRef.value?.showBack?.();
    if (!wasFlipped) { try { T.reviewFlip(current()?.id); } catch {} }
    return;
  }
  if (!flipRef.value?.flipped) return; // 未翻面不允许评级，防盲评
  if (e.key === '1') { e.preventDefault(); flipRef.value?.doRate?.(0); }
  else if (e.key === '2') { e.preventDefault(); flipRef.value?.doRate?.(1); }
  else if (e.key === '3') { e.preventDefault(); flipRef.value?.doRate?.(2); }
}

// ---- C3 复习会话包：25 分钟倒计时，结束提醒去番茄钟休息 ----
const sessionOn = ref(false);
const sessionLeft = ref(0);
const sessionDone = ref(false);
let sessionTimer = null;
function fmtClock(s) { const m = Math.floor(s / 60), sec = s % 60; return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`; }
let sessionEndTs = 0;
function startSessionTimer() {
  sessionTimer = setInterval(() => {
    sessionLeft.value = Math.max(0, Math.round((sessionEndTs - Date.now()) / 1000));
    if (sessionLeft.value <= 0) {
      clearInterval(sessionTimer);
      sessionOn.value = false; sessionDone.value = true;
      localStorage.removeItem('sxy_rv_session_end');
      toast('25 分钟复习会话结束，去休息一下吧！', 'success');
    }
  }, 1000);
}
function toggleSession() {
  if (sessionOn.value) { sessionOn.value = false; clearInterval(sessionTimer); localStorage.removeItem('sxy_rv_session_end'); return; }
  sessionOn.value = true; sessionDone.value = false; sessionLeft.value = 25 * 60;
  sessionEndTs = Date.now() + 25 * 60 * 1000;
  localStorage.setItem('sxy_rv_session_end', String(sessionEndTs));
  startSessionTimer();
}

// ---- C4 难度自适应：按历史错误率微调间隔（保守/稳健档，默认关） ----
const adaptiveOn = ref(localStorage.getItem('sxy_adaptive') === '1');
function toggleAdaptive() {
  adaptiveOn.value = !adaptiveOn.value;
  localStorage.setItem('sxy_adaptive', adaptiveOn.value ? '1' : '0');
  toast(adaptiveOn.value ? '已开启自适应节奏：频繁出错的卡会加快重现，稳定掌握的卡会拉长间隔' : '已切回基准间隔', 'info');
}

// ---- C6 短期提取巩固：新卡快速校验 ----
function flipQuick() { quickFlipped.value = true; }
async function quickRate(remembered) {
  const card = quickCurrent.value;
  if (!card) return;
  await recordQuickCheck(card.id, remembered);
  if (!remembered) {
    // 没记住：微调 ease，提前到期（趁热重练）
    await applyCardFeedback(card.id, { score: 30 });
  }
  quickIdx.value++;
  quickFlipped.value = false;
  if (quickIdx.value >= quickQueue.value.length) {
    quickMode.value = false;
    toast('⚡ 快速校验完成，继续正常复习', 'success');
  }
}
function skipQuick() {
  quickMode.value = false;
  toast('已跳过快速校验', 'info');
}

// ---- C5 易混卡对决：看答案归属，练辨析 ----
const duelOpen = ref(false);
const duelIdx = ref(0);
const duelTarget = ref(null); // 当前问的答案属于哪张卡
const duelPicked = ref(null); // null | 选中卡 id
const duelOptions = ref([]); // 本轮两个选项（随机顺序）
const duelBack = ref(''); // 当前考问的答案文本（confusable 对里没有 back，需从库读）
function shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function startDuel() {
  if (!confusablePairs.value.length) { toast('暂无易混卡对：多答错几道带共同标签的题就会出现', 'info'); return; }
  duelOpen.value = true;
  duelIdx.value = 0;
  nextDuel();
}
async function nextDuel() {
  const p = confusablePairs.value[duelIdx.value % confusablePairs.value.length];
  duelTarget.value = Math.random() < 0.5 ? p.a : p.b;
  duelOptions.value = shuffle([p.a, p.b]);
  duelPicked.value = null;
  const full = await db.cards.get(duelTarget.value.id);
  duelBack.value = full?.back || '';
}
function pickDuel(card) {
  if (duelPicked.value) return;
  const correct = card.id === duelTarget.value.id;
  duelPicked.value = card.id;
  toast(correct ? '✅ 辨析正确！' : `❌ 这张答案其实属于「${duelTarget.value.front.slice(0, 18)}」`, correct ? 'success' : 'error');
  if (!correct) recordDuelWrong(card.id, duelTarget.value.id); // 错选回流：自动加权这对易混卡
  setTimeout(() => { duelIdx.value++; nextDuel(); }, 1200);
}
// 易混对决错选记录（D1）：存入 db.meta，analytics 读取后加权该易混对
async function recordDuelWrong(idA, idB) {
  const key = [idA, idB].sort().join('|');
  const row = await db.meta.get('duelWrongs');
  const list = (Array.isArray(row?.value) ? row.value : []).filter(k => k !== key);
  list.push(key);
  await db.meta.put({ key: 'duelWrongs', value: list.slice(-200), updatedAt: Date.now() });
}
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
        <label class="hint" title="检索方式越强，记忆越牢固，下次间隔越长（生成效应 + 费曼学习法）">检索方式</label>
        <select v-model="retrievalStrength" class="input" style="width:auto">
          <option v-for="o in RETRIEVAL_STRENGTH_OPTIONS" :key="o.code" :value="o.code" :title="o.desc">{{ o.label }}</option>
        </select>
        <button class="chip" :class="{ on: interleave }" @click="toggleInterleave">交错混科</button>
        <button class="chip" :class="{ on: smartMode }" @click="toggleSmart" title="综合到期+薄弱+精力曲线+交错混科+变式分散的智能排程（本地算法，零 LLM 开销）">🎯 今日最优序列</button>
        <button class="chip" :class="{ on: graphMode }" @click="toggleGraph" title="按知识图谱的前置/依赖关系编排复习顺序：基础知识卡在前，易混卡挨着复习">图驱动复习</button>
        <button class="chip" :class="{ on: adaptiveOn }" @click="toggleAdaptive" title="自适应节奏：按这张卡的历史错误率微调复习间隔">自适应节奏</button>
        <button class="chip" :class="{ on: sessionOn }" @click="toggleSession">{{ sessionOn ? `会话中 ${fmtClock(sessionLeft)}` : '25 分钟会话' }}</button>
        <button class="chip" @click="startDuel">易混对决</button>
        <button v-if="sessionDone" class="chip" style="color:var(--green);border-color:var(--green)" @click="router.push('/pomodoro')">去番茄钟休息 →</button>
        <button class="chip" :class="{ on: filterActive }" @click="filterOpen = !filterOpen">
          筛选背诵{{ filterActive ? '（已选）' : '' }}
        </button>
        <button v-if="speechSupported" class="chip" :class="{ on: voiceListening }" @click="voiceEval">{{ voiceListening ? '聆听中…' : '语音作答' }}</button>
        <template v-if="ttsSupported">
          <button class="chip" :class="{ on: reading === 'front' }" @click="readAloud('front')" title="用语音朗读题面">🔊 朗读题面</button>
          <button class="chip" :class="{ on: reading === 'back' }" @click="readAloud('back')" title="翻面后朗读答案">朗读答案</button>
          <button class="chip" :class="{ on: autoRead }" @click="toggleAutoRead" title="切到每张卡时自动朗读题面">自动朗读</button>
          <button v-if="reading" class="chip" style="color:var(--red);border-color:var(--red)" @click="stopRead">停止</button>
        </template>
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
          <button v-for="r in WRONG_REASONS" :key="r.code" class="chip" :class="{ on: fWrongReasons.includes(r.code) }" @click="toggleFWrong(r.code)">{{ r.label }}</button>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary" @click="applyFilter">应用筛选</button>
          <button class="btn" @click="clearFilter">清除全部</button>
        </div>
      </div>

      <div v-if="loading" class="hint" style="text-align:center;padding:60px">加载中…</div>

      <!-- 短期提取巩固：新卡快速校验（不计 SRS） -->
      <template v-else-if="quickMode && quickCurrent">
        <div class="quick-check panel" style="margin-top:12px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <span style="font-size:18px">⚡</span>
            <b>短期提取巩固</b>
            <span class="hint">{{ quickIdx + 1 }} / {{ quickQueue.length }}</span>
            <span style="flex:1"></span>
            <button class="chip" @click="skipQuick">跳过</button>
          </div>
          <div class="hint" style="margin-bottom:8px">刚学的卡在 10 分钟后快速回忆一次，巩固工作记忆（不计入复习排期）· 快捷键：空格翻面，1 没记住 2 记住了</div>
          <div v-if="!quickFlipped" class="quick-front" @click="flipQuick">
            <MarkdownRenderer :content="quickCurrent.front" />
            <div class="hint" style="text-align:center;margin-top:8px">点击卡片查看答案</div>
          </div>
          <div v-else>
            <div class="quick-back">
              <MarkdownRenderer :content="quickCurrent.back" />
            </div>
            <div style="display:flex;gap:12px;margin-top:12px;justify-content:center">
              <button class="btn" style="border-color:var(--red);color:var(--red)" @click="quickRate(false)">没记住</button>
              <button class="btn primary" @click="quickRate(true)">记住了</button>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="current()">
        <!-- 卡片 + 难度/错因/自评（FlipCard 内部已拆分：舞台内滚 + 操作区在舞台外独立块） -->
        <div class="review-card-wrap">
          <FlipCard ref="flipRef" :card="current()" @rate="rate" @edit="openEdit" />
        </div>

        <div v-if="smartHint" class="consolidation-hint" style="color:var(--accent)">{{ smartHint }}</div>
        <div v-if="graphHint" class="consolidation-hint" style="color:var(--blue)">{{ graphHint }}</div>
        <div v-if="consolidationHint" class="consolidation-hint">{{ consolidationHint }}</div>
        <div v-if="confusableHint" class="confusable-hint">{{ confusableHint }}</div>

        <!-- 底部占位：高度等于底部 sticky 快捷键条，避免被遮挡 -->
        <div class="review-kb-spacer" aria-hidden="true"></div>
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

    <!-- 易混卡对决弹窗（C5）：看答案归属，练辨析 -->
    <teleport to="body">
      <div v-if="duelOpen" class="modal-mask" @click.self="duelOpen = false">
        <div class="modal" style="max-width:460px">
          <h3 style="margin-top:0">易混卡对决</h3>
          <p class="hint" style="margin-top:0">下面这段「答案」属于哪张卡？</p>
          <div class="hint" style="margin:0 0 12px;font-size:15px;color:var(--ink);font-weight:600">
            「{{ duelBack.slice(0, 60) }}…」
          </div>
          <div style="display:flex;flex-direction:column;gap:10px">
            <button v-for="o in duelOptions" :key="o.id" class="duel-opt btn" :class="{ right: duelPicked === o.id && o.id === duelTarget?.id, wrong: duelPicked === o.id && o.id !== duelTarget?.id }"
              :disabled="!!duelPicked" style="width:100%;text-align:left" @click="pickDuel(o)">
              {{ o.front.slice(0, 60) }}
            </button>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px">
            <span class="hint">第 {{ duelIdx + 1 }} 轮</span>
            <button class="btn small" @click="duelOpen = false">结束</button>
          </div>
        </div>
      </div>
    </teleport>

    <!-- 独立底部快捷键提示条（position: sticky）：永远不与卡片难度/错因/自评按钮重叠 -->
    <div v-if="tab === 'due' && current() && !showComplete" class="review-kb-bar no-print">
      <div class="kb-col">
        <button class="chip" :disabled="idx <= 0" @click="prevCard" title="上一张（←）">←</button>
        <span class="kb-page">第 <b>{{ idx + 1 }}</b> / {{ queue.length }} 张</span>
        <button class="chip" :disabled="idx >= queue.length - 1" @click="nextCard" title="下一张（→）">→</button>
        <span v-if="current()?.subject" class="kb-subj">{{ current().subject }}</span>
      </div>
      <div class="kb-col kb-keys">
        <span class="kb" title="上一张">← 上一张</span>
        <span class="kb" title="下一张">→ 下一张</span>
        <span class="kb" title="翻面">␣ 翻面</span>
        <span class="kb bad" title="没记住">1 没记住</span>
        <span class="kb mid" title="还模糊">2 还模糊</span>
        <span class="kb good" title="记住了">3 记住了</span>
      </div>
    </div>
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
.duel-opt.right { border-color: var(--green); background: var(--code-inline); color: var(--green); }
.duel-opt.wrong { border-color: var(--red); background: var(--code-inline); color: var(--red); }
.rating-pill { font-size: 12px; border-radius: 6px; padding: 2px 10px; font-weight: 600; }
.rating-pill.r0 { background: #fee2e2; color: var(--red); }
.rating-pill.r1 { background: #fef3c7; color: var(--amber); }
.rating-pill.r2 { background: #dcfce7; color: var(--green); }
.history-detail { border-top: 1px dashed var(--line); margin-top: 8px; padding-top: 4px; }
.confusable-hint { margin-top: 12px; padding: 10px 14px; border: 1px solid #fcd34d; background: #fef3c7; color: #92400e; border-radius: 8px; font-size: 13px; }
.consolidation-hint { margin-top: 12px; padding: 10px 14px; border: 1px solid var(--blue, #2563eb); background: color-mix(in srgb, var(--blue, #2563eb) 8%, var(--panel, #fff)); color: var(--blue, #2563eb); border-radius: 8px; font-size: 13px; text-align: center; }
/* 短期提取巩固 */
.quick-check { border-left: 3px solid var(--amber) !important; }
.quick-front { cursor: pointer; padding: 20px; border: 1px solid var(--line); border-radius: var(--radius); transition: background .15s; }
.quick-front:hover { background: var(--code-bg); }
.quick-back { padding: 20px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--code-bg); }

/* P0·1 防遮挡：背诵容器加底部安全区，为 sticky 快捷键条预留空间 */
.review-card-wrap { margin-top: 12px; }
.review-kb-spacer { height: 0; }
@media (min-width: 721px) { .review-kb-spacer { height: 74px; } }
.review-kb-bar {
  position: sticky;
  left: 0; right: 0; bottom: 0;
  margin: 14px -12px -16px;
  padding: 10px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  background: color-mix(in srgb, var(--page-bg, #fff) 94%, var(--ink, #111) 6%);
  backdrop-filter: saturate(1.2) blur(6px);
  border-top: 1px solid var(--line);
  z-index: 50;
}
.kb-col { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.kb-page { color: var(--ink-2); font-size: 13px; }
.kb-page b { color: var(--ink); font-weight: 700; }
/* 导航按钮：禁用时灰显不可点 */
.chip:disabled { opacity: .4; cursor: not-allowed; }
.kb-subj { font-size: 12px; background: var(--code-inline); color: var(--ink-2); padding: 2px 8px; border-radius: 6px; }
.kb-keys .kb {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--panel);
  font-size: 12px; color: var(--ink-2); line-height: 1.4;
}
.kb.bad { color: var(--red); border-color: #fecaca; background: #fff1f2; }
.kb.mid { color: #b45309; border-color: #fcd34d; background: #fffbeb; }
.kb.good { color: var(--green); border-color: #86efac; background: #f0fdf4; }

@media (max-width: 720px) {
  .review-kb-spacer { height: 98px; }
  .review-kb-bar { margin: 12px -14px -24px; padding: 8px 12px; gap: 8px; }
  .kb-col { width: 100%; justify-content: space-between; }
  .kb-keys { justify-content: flex-start; }
  .kb-keys .kb { font-size: 11px; padding: 3px 8px; }
}
</style>
