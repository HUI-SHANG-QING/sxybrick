<script setup>
// 组卷模考（借鉴 Progress AI，纯本地实现）：从卡片库抽题组成简答式试卷，
// 关键词覆盖判分，成绩自动存档（exams 表，随数据包同步），错题可一键加入错题本
import { confirmDialog } from '../utils/confirm.js';
import { ref, computed, onMounted, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { db } from '../db.js';
import { getSubjects, listExams, saveExam, deleteExam, setMarked, updateExam } from '../repo.js';
import { chatAI, hasAIKey } from '../ai.js';
// P2-2 模考-错题-AI补卡闭环：错题一键生成卡片入复习队列（与生成式测验共享逻辑）
import { wrongQuestionsToCards } from '../utils/wrongToCards.js';
// P2-4 模考分析与预测：成绩趋势 + 薄弱科目 + 通过率预估
import { getExamTrend, getWeakSubjects, predictPassRate } from '../agent/examAnalytics.js';
import { mdToSpeech } from '../utils/tts.js';
import EmptyState from '../components/EmptyState.vue';
import { toast } from '../utils/toast.js';
import { T } from '../utils/telemetry.js';
import { t } from '../i18n/index.js';

const route = useRoute();

const subjects = ref([]);
const selSubjects = ref([]);
const count = ref(10);
const phase = ref('setup'); // setup | doing | result
const questions = ref([]);
const answers = ref([]);
const examTitle = ref('');
const history = ref([]);
const viewing = ref(null); // 查看历史成绩

function toggleSubject(name) {
  const i = selSubjects.value.indexOf(name);
  if (i >= 0) selSubjects.value.splice(i, 1); else selSubjects.value.push(name);
}

async function loadHistory() { history.value = await listExams(); }

function keywordCoverage(answerText, userText) {
  const keywords = mdToSpeech(answerText).split(/[\s，。、；：,.;:!?！？]+/).filter(w => w.length >= 2);
  if (!keywords.length) return 0;
  const hit = keywords.filter(k => userText.includes(k)).length;
  return Math.round((hit / keywords.length) * 100);
}

async function startExam() {
  let pool = await db.cards.toArray();
  if (selSubjects.value.length) pool = pool.filter(c => selSubjects.value.includes(c.subject || t('views.exam.uncategorized')));
  if (!pool.length) { toast(t('views.exam.noCardsInRange'), 'error'); return; }
  // 随机抽题（Fisher-Yates）
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const n = Math.min(Number(count.value) || 10, shuffled.length);
  questions.value = shuffled.slice(0, n).map(c => ({ cardId: c.id, front: c.front, back: c.back, subject: c.subject || t('views.exam.uncategorized') }));
  answers.value = new Array(n).fill('');
  examTitle.value = t('views.exam.examTitle', { subject: selSubjects.value.join('+') || t('views.exam.subjectAll'), date: new Date().toLocaleDateString() });
  phase.value = 'doing';
}

const graded = computed(() => questions.value.map((q, i) => ({
  ...q,
  cov: keywordCoverage(q.back, answers.value[i] || ''),
  correct: keywordCoverage(q.back, answers.value[i] || '') >= 60,
})));
const score = computed(() => graded.value.filter(g => g.correct).length);
const wrongList = computed(() => graded.value.filter(g => !g.correct));

async function submit() {
  if (answers.value.some(a => !a.trim())) {
    if (!(await confirmDialog(t('views.exam.confirmSubmit')))) return;
  }
  const g = graded.value;
  const saved = await saveExam({
    title: examTitle.value,
    subject: selSubjects.value.join('+'),
    questions: questions.value.map((q, i) => ({
      cardId: q.cardId, front: q.front, back: q.back,
      user: answers.value[i] || '', cov: g[i].cov, correct: g[i].correct,
    })),
    score: score.value,
    total: g.length,
  });
  savedExam.value = saved;
  phase.value = 'result';
  await loadHistory();
  try { T.examEnd(score.value, g.length); } catch {}
  toast(t('views.exam.submitted', { score: score.value, total: g.length }), score.value === g.length ? 'success' : 'info');
}

// ---- D1 模考讲解：AI 逐题讲解错题（错因 + 关联知识点），讲解写回成绩存档 ----
const savedExam = ref(null);
const explains = ref([]);
const explainBusy = ref(false);
async function aiExplain() {
  if (!hasAIKey()) { toast(t('views.exam.needAiKey'), 'error'); return; }
  const wrongIdx = graded.value.map((g, i) => (g.correct ? -1 : i)).filter(i => i >= 0);
  if (!wrongIdx.length) { toast(t('views.exam.noWrongToExplain'), 'success'); return; }
  explainBusy.value = true;
  try {
    for (const i of wrongIdx) {
      const q = questions.value[i];
      const my = answers.value[i] || t('views.exam.notAnswered');
      const r = await chatAI([
        { role: 'system', content: '你是答疑老师。针对学生这道错题，讲清楚：1) 正确答案为什么对（≤60字）；2) 学生的答案错在哪（≤40字）；3) 关联知识点（短语列表）。输出纯文本，用「讲解：/错因：/关联：」三行格式。' },
        { role: 'user', content: `题目：${q.front}\n标准答案：${q.back}\n学生答案：${my}` },
      ]);
      explains.value[i] = String(r || '').trim().slice(0, 300);
    }
    if (savedExam.value) {
      await updateExam(savedExam.value.id, {
        questions: savedExam.value.questions.map((q, i) => ({ ...q, explain: explains.value[i] || '' })),
      });
      savedExam.value.questions = savedExam.value.questions.map((q, i) => ({ ...q, explain: explains.value[i] || '' }));
    }
    await loadHistory();
    toast(t('views.exam.explainDone'), 'success');
  } catch (e) { toast(t('views.exam.explainFail', { msg: e.message }), 'error'); }
  finally { explainBusy.value = false; }
}

async function markWrong() {
  let n = 0;
  for (const w of wrongList.value) { await setMarked(w.cardId, true); n++; }
  toast(t('views.exam.markedWrong', { n }), 'success');
}

// P2-2 模考-错题-AI补卡闭环：错题一键生成卡片入复习队列
// 与 markWrong（加入错题本）正交：错题本=标记重点，补卡=把错题本身作为新卡入复习轮
const supplementBusy = ref(false);
async function supplementWrongToCards() {
  if (supplementBusy.value) return;
  supplementBusy.value = true;
  try {
    const wrongs = wrongList.value;
    if (!wrongs.length) { toast(t('views.exam.noWrongToSupplement'), 'info'); return; }
    const r = await wrongQuestionsToCards(wrongs, { tag: '模考错题', source: '模考-错题补卡' });
    if (r.created > 0) {
      const failPart = r.failed ? t('views.exam.supplementFailCount', { n: r.failed }) : '';
      toast(t('views.exam.supplemented', { n: r.created }) + failPart, 'success');
    } else {
      const reason = r.failed ? t('views.exam.supplementFailCount2', { n: r.failed }) : t('views.exam.unknownError');
      toast(t('views.exam.supplementFailPrefix') + reason, 'error');
    }
  } catch (e) {
    toast(t('views.exam.supplementError', { msg: e?.message || e }), 'error');
  } finally {
    supplementBusy.value = false;
  }
}

function viewExam(ex) { viewing.value = ex; }
function closeView() { viewing.value = null; }
async function removeExam(ex) {
  if (!(await confirmDialog(t('views.exam.confirmDelete', { title: ex.title, score: ex.score, total: ex.total })))) return;
  await deleteExam(ex.id);
  if (viewing.value?.id === ex.id) viewing.value = null;
  await loadHistory();
}
function backToSetup() {
  phase.value = 'setup';
  answers.value = [];
  questions.value = [];
}

// ---- E3 模考纵向对比：同科多次模考正确率走势（原生 SVG 折线，零依赖） ----
const trendPoints = computed(() => {
  // 按科目分组，取最近 10 场（按创建时间升序）
  const groups = new Map();
  for (const ex of [...history.value].reverse()) {
    const key = ex.subject || t('views.exam.subjectAll');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ex);
  }
  const arr = [];
  for (const [subject, list] of groups) {
    const pts = list.slice(-10).map(ex => ({
      score: ex.score, total: ex.total,
      rate: ex.total ? Math.round((ex.score / ex.total) * 100) : 0,
      date: new Date(ex.createdAt).toLocaleDateString(),
    }));
    arr.push({ subject, pts });
  }
  return arr;
});

// P2-4 模考分析与预测：薄弱科目 + 通过率预估 + 趋势摘要
const weakSubjects = computed(() => getWeakSubjects(history.value));
const passPrediction = computed(() => predictPassRate(history.value));
const trendSummary = computed(() => getExamTrend(history.value));

const svgW = 560, svgH = 180, padX = 40, padY = 24;
function linePath(pts) {
  if (!pts.length) return '';
  const maxX = Math.max(1, pts.length - 1);
  const x = i => padX + (i / maxX) * (svgW - padX * 2);
  const y = v => svgH - padY - (v / 100) * (svgH - padY * 2);
  return pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.rate).toFixed(1)}`).join(' ');
}

onMounted(async () => {
  subjects.value = await getSubjects();
  await loadHistory();
  // 搜索结果跳转：URL ?id=xxx 自动打开对应模考成绩详情弹窗
  const id = route.query?.id ? String(route.query.id) : '';
  if (id) { await nextTick(); const ex = history.value.find(h => h.id === id); if (ex) viewing.value = ex; }
});
</script>

<template>
  <div style="max-width:860px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">{{ t('views.exam.title') }}</h2>
      <span class="hint">{{ t('views.exam.subtitle') }}</span>
      <span style="flex:1"></span>
      <button v-if="phase !== 'doing'" class="btn primary small" @click="phase = 'setup'">{{ t('views.exam.newExam') }}</button>
    </div>

    <!-- 组卷设置 -->
    <div v-if="phase === 'setup'" class="panel" style="margin-top:14px">
      <div class="field-label" style="margin-top:0">{{ t('views.exam.subjectLabel') }}</div>
      <div class="row">
        <button v-for="s in subjects" :key="s.name" class="chip" :class="{ on: selSubjects.includes(s.name) }" @click="toggleSubject(s.name)">{{ s.name }}<span class="n">{{ s.count }}</span></button>
      </div>
      <div class="field-label">{{ t('views.exam.questionCount') }}</div>
      <div class="row">
        <button v-for="n in [5, 10, 20, 50]" :key="n" class="chip" :class="{ on: count === n }" @click="count = n">{{ t('views.exam.nQuestions', { n }) }}</button>
      </div>
      <button class="btn primary" @click="startExam">{{ t('views.exam.startExam') }}</button>
    </div>

    <!-- 答题中 -->
    <div v-if="phase === 'doing'" class="panel" style="margin-top:14px">
      <div class="field-label" style="margin-top:0">{{ examTitle }}{{ t('views.exam.qTotal', { n: questions.length }) }}</div>
      <div v-for="(q, i) in questions" :key="q.cardId" class="exam-q">
        <div class="exam-num">{{ t('views.exam.qNum', { n: i + 1 }) }} <span class="hint">{{ t('views.exam.qHint') }}</span></div>
        <div class="exam-front">{{ q.front }}</div>
        <textarea v-model="answers[i]" class="input" rows="3" :placeholder="t('views.exam.answerPlaceholder')"></textarea>
      </div>
      <button class="btn primary" @click="submit">{{ t('views.exam.submit') }}</button>
    </div>

    <!-- 成绩 -->
    <div v-if="phase === 'result' && graded.length" class="panel" style="margin-top:14px">
      <div class="result-head">
        <span class="result-score">{{ score }} / {{ graded.length }}</span>
        <span class="hint" style="margin-left:10px">{{ t('views.exam.accuracy', { n: Math.round((score / graded.length) * 100) }) }}</span>
        <span style="flex:1"></span>
        <button class="btn small" :disabled="explainBusy || !wrongList.length" @click="aiExplain">{{ explainBusy ? t('views.exam.explaining') : t('views.exam.aiExplainBtn', { n: wrongList.length }) }}</button>
        <button class="btn small" :disabled="!wrongList.length" @click="markWrong">{{ t('views.exam.markWrongBtn', { n: wrongList.length }) }}</button>
        <button class="btn small primary" :disabled="supplementBusy || !wrongList.length" @click="supplementWrongToCards" :title="t('views.exam.supplementTitle')">
          {{ supplementBusy ? t('views.exam.supplementing') : t('views.exam.supplementBtn', { n: wrongList.length }) }}
        </button>
        <button class="btn small" @click="backToSetup">{{ t('views.exam.again') }}</button>
      </div>
      <div v-for="(g, i) in graded" :key="g.cardId" class="exam-q" :class="{ wrong: !g.correct }">
        <div class="exam-num">{{ g.correct ? '✅' : '❌' }} {{ t('views.exam.qNumCov', { n: i + 1, cov: g.cov }) }}</div>
        <div class="exam-front">{{ g.front }}</div>
        <div class="hint">{{ t('views.exam.yourAnswer') }}{{ answers[i] || t('views.exam.notAnswered') }}</div>
        <div class="exam-std">{{ t('views.exam.stdAnswer') }}{{ g.back }}</div>
        <div v-if="explains[i]" class="exam-explain">{{ explains[i] }}</div>
      </div>
    </div>

    <!-- 历史 -->
    <div class="panel" style="margin-top:16px">
      <div class="field-label" style="margin-top:0">{{ t('views.exam.historyTitle', { n: history.length }) }}</div>
      <EmptyState v-if="!history.length" icon="🧪" :title="t('views.exam.emptyTitle')" :message="t('views.exam.emptyMsg')" />

      <!-- 纵向对比走势图 -->
      <div v-if="trendPoints.length" style="margin-bottom:14px">
        <div class="hint" style="font-weight:600;margin-bottom:8px">{{ t('views.exam.trendTitle') }}</div>
        <div v-for="tp in trendPoints" :key="tp.subject" class="trend-line">
          <span class="hint" style="width:90px;flex:none">{{ tp.subject }}</span>
          <svg :viewBox="`0 0 ${svgW} ${svgH}`" width="100%" style="max-width:420px">
            <line :x1="padX" :y1="svgH - padY" :x2="svgW - padX" :y2="svgH - padY" :stroke="'var(--line)'" stroke-width="1" />
            <line :x1="padX" :y1="padY" :x2="padX" :y2="svgH - padY" :stroke="'var(--line)'" stroke-width="1" />
            <polyline :points="linePath(tp.pts).replace(/[ML]/g, '').split(' ').map(p => p).join(' ')" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
            <circle v-for="(p, i) in tp.pts" :key="i" :cx="padX + (tp.pts.length === 1 ? 0 : (i / (tp.pts.length - 1)) * (svgW - padX * 2))" :cy="svgH - padY - (p.rate / 100) * (svgH - padY * 2)" r="3.5" fill="var(--accent)">
              <title>{{ t('views.exam.trendPoint', { date: p.date, rate: p.rate, score: p.score, total: p.total }) }}</title>
            </circle>
          </svg>
          <span class="hint" style="flex:1">{{ tp.pts.map(p => `${p.rate}%`).join(' → ') }}</span>
        </div>
      </div>

      <!-- P2-4 模考分析与预测：通过率预估 + 薄弱科目 -->
      <div v-if="history.length >= 2" class="exam-analytics">
        <div class="field-label">{{ t('views.exam.passRateTitle') }}</div>
        <div class="prediction-card" :class="{ pass: passPrediction.willPass, fail: !passPrediction.willPass }">
          <div class="prediction-main">
            <span class="prediction-rate">{{ passPrediction.predictedRate }}%</span>
            <span class="prediction-verdict">{{ passPrediction.willPass ? t('views.exam.passVerdict') : t('views.exam.failVerdict') }}</span>
            <span class="hint">{{ t('views.exam.passLine', { n: passPrediction.passLine, m: passPrediction.confidence }) }}</span>
          </div>
          <div class="prediction-reasons">
            <span v-for="(r, i) in passPrediction.reasons" :key="i" class="reason-tag">{{ r }}</span>
          </div>
        </div>

        <div class="field-label" style="margin-top:14px">{{ t('views.exam.weakTitle') }}</div>
        <div v-if="weakSubjects.length" class="weak-grid">
          <div v-for="w in weakSubjects" :key="w.subject" class="weak-item" :class="{ weak: w.weak }">
            <div class="weak-subject">{{ w.subject }}</div>
            <div class="weak-bar-wrap">
              <div class="weak-bar" :style="{ width: w.wrongRate + '%' }"></div>
            </div>
            <div class="weak-stat">{{ w.wrong }}/{{ w.total }} · {{ w.wrongRate }}%</div>
          </div>
        </div>
        <EmptyState v-else compact icon="🧪" :title="t('views.exam.weakEmptyTitle')" :message="t('views.exam.weakEmptyMsg')" />
      </div>

      <div v-for="ex in history" :key="ex.id" class="exam-row">
        <span class="chip" style="cursor:pointer" @click="viewExam(ex)">{{ ex.title }}</span>
        <span class="hint">{{ ex.score }}/{{ ex.total }} · {{ new Date(ex.createdAt).toLocaleDateString() }}</span>
        <span style="flex:1"></span>
        <button class="btn small" @click="viewExam(ex)">{{ t('views.exam.view') }}</button>
        <button class="btn small danger" @click="removeExam(ex)">{{ t('views.exam.delete') }}</button>
      </div>
    </div>

    <!-- 历史详情弹窗 -->
    <teleport to="body">
      <div v-if="viewing" class="modal-mask" @click.self="closeView">
        <div class="modal">
          <h3 style="margin-top:0">{{ viewing.title }}{{ t('views.exam.scoreSuffix', { score: viewing.score, total: viewing.total }) }}</h3>
          <div v-for="(q, i) in viewing.questions" :key="i" class="exam-q" :class="{ wrong: !q.correct }">
            <div class="exam-num">{{ q.correct ? '✅' : '❌' }} {{ t('views.exam.qNumPlain', { n: i + 1 }) }}</div>
            <div class="exam-front">{{ q.front }}</div>
            <div class="hint">{{ t('views.exam.yourAnswer') }}{{ q.user || t('views.exam.notAnswered') }}</div>
            <div class="exam-std">{{ t('views.exam.stdAnswer') }}{{ q.back }}</div>
            <div v-if="q.explain" class="exam-explain">{{ q.explain }}</div>
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:14px">
            <button class="btn" @click="closeView">{{ t('views.exam.close') }}</button>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.field-label { font-size: 13px; font-weight: 600; color: var(--ink-2); margin: 12px 0 6px; }
.exam-q { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; background: var(--code-bg); }
.exam-q.wrong { border-color: var(--red); }
.exam-num { font-size: 13px; font-weight: 700; margin-bottom: 6px; }
.exam-front { font-weight: 600; margin-bottom: 8px; line-height: 1.6; }
.exam-std { color: var(--green); margin-top: 6px; line-height: 1.6; font-size: 14px; }
.exam-explain { background: var(--code-inline); border-left: 3px solid var(--blue); border-radius: 6px; padding: 8px 12px; margin-top: 8px; font-size: 13px; line-height: 1.7; white-space: pre-wrap; }
.result-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.result-score { font-size: 28px; font-weight: 800; color: var(--accent); }
.exam-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 0; border-bottom: 1px dashed var(--line); }
.exam-row:last-child { border-bottom: none; }
.trend-line { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
/* P2-4 模考分析与预测 */
.exam-analytics { margin: 14px 0; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--code-inline); }
.prediction-card { padding: 12px; border-radius: 8px; border-left: 4px solid var(--ink-2); background: var(--panel); }
.prediction-card.pass { border-left-color: var(--accent, #27ae60); }
.prediction-card.fail { border-left-color: var(--warn, #e74c3c); }
.prediction-main { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.prediction-rate { font-size: 26px; font-weight: 800; color: var(--accent, #27ae60); }
.prediction-card.fail .prediction-rate { color: var(--warn, #e74c3c); }
.prediction-verdict { font-weight: 700; font-size: 15px; }
.prediction-reasons { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; }
.reason-tag { font-size: 11px; padding: 2px 8px; border-radius: 4px; background: var(--code-inline); color: var(--ink-2); }
.weak-grid { display: flex; flex-direction: column; gap: 8px; }
.weak-item { display: grid; grid-template-columns: 100px 1fr auto; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 6px; background: var(--panel); font-size: 13px; }
.weak-item.weak { border-left: 3px solid var(--warn, #e74c3c); }
.weak-subject { font-weight: 600; }
.weak-bar-wrap { height: 8px; background: var(--code-inline); border-radius: 4px; overflow: hidden; }
.weak-bar { height: 100%; background: var(--accent, #27ae60); transition: width .3s; }
.weak-item.weak .weak-bar { background: var(--warn, #e74c3c); }
.weak-stat { font-size: 11px; color: var(--ink-2); }
</style>