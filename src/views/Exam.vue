<script setup>
// 组卷模考（借鉴 Progress AI，纯本地实现）：从卡片库抽题组成简答式试卷，
// 关键词覆盖判分，成绩自动存档（exams 表，随数据包同步），错题可一键加入错题本
import { ref, computed, onMounted } from 'vue';
import { db } from '../db.js';
import { getSubjects, listExams, saveExam, deleteExam, setMarked, updateExam } from '../repo.js';
import { chatAI, hasAIKey } from '../ai.js';
import { mdToSpeech } from '../utils/tts.js';
import { toast } from '../utils/toast.js';

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
  if (selSubjects.value.length) pool = pool.filter(c => selSubjects.value.includes(c.subject || '未分类'));
  if (!pool.length) { toast('该范围内没有卡片', 'error'); return; }
  // 随机抽题（Fisher-Yates）
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const n = Math.min(Number(count.value) || 10, shuffled.length);
  questions.value = shuffled.slice(0, n).map(c => ({ cardId: c.id, front: c.front, back: c.back, subject: c.subject || '未分类' }));
  answers.value = new Array(n).fill('');
  examTitle.value = `${selSubjects.value.join('+') || '综合'} 模考 ${new Date().toLocaleDateString()}`;
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
    if (!confirm('还有题目未作答，确定交卷？')) return;
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
  toast(`交卷：${score.value}/${g.length} 分（已存档，可跨设备同步）`, score.value === g.length ? 'success' : 'info');
}

// ---- D1 模考讲解：AI 逐题讲解错题（错因 + 关联知识点），讲解写回成绩存档 ----
const savedExam = ref(null);
const explains = ref([]);
const explainBusy = ref(false);
async function aiExplain() {
  if (!hasAIKey()) { toast('请先在「AI 设置」里填入密钥', 'error'); return; }
  const wrongIdx = graded.value.map((g, i) => (g.correct ? -1 : i)).filter(i => i >= 0);
  if (!wrongIdx.length) { toast('没有错题需要讲解，满分！', 'success'); return; }
  explainBusy.value = true;
  try {
    for (const i of wrongIdx) {
      const q = questions.value[i];
      const my = answers.value[i] || '（未作答）';
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
    toast('错题讲解已生成并存入成绩记录', 'success');
  } catch (e) { toast('讲解生成失败：' + e.message, 'error'); }
  finally { explainBusy.value = false; }
}

async function markWrong() {
  let n = 0;
  for (const w of wrongList.value) { await setMarked(w.cardId, true); n++; }
  toast(`已将 ${n} 道错题加入错题本`, 'success');
}

function viewExam(ex) { viewing.value = ex; }
function closeView() { viewing.value = null; }
async function removeExam(ex) {
  if (!confirm(`删除「${ex.title}」（${ex.score}/${ex.total} 分）？`)) return;
  await deleteExam(ex.id);
  if (viewing.value?.id === ex.id) viewing.value = null;
  await loadHistory();
}
function backToSetup() {
  phase.value = 'setup';
  answers.value = [];
  questions.value = [];
}

onMounted(async () => { subjects.value = await getSubjects(); await loadHistory(); });
</script>

<template>
  <div style="max-width:860px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">组卷模考</h2>
      <span class="hint">本地出卷 · 关键词判分 · 成绩可同步</span>
      <span style="flex:1"></span>
      <button v-if="phase !== 'doing'" class="btn primary small" @click="phase = 'setup'">新模考</button>
    </div>

    <!-- 组卷设置 -->
    <div v-if="phase === 'setup'" class="panel" style="margin-top:14px">
      <div class="field-label" style="margin-top:0">科目（不选 = 全部科目随机）</div>
      <div class="row">
        <button v-for="s in subjects" :key="s.name" class="chip" :class="{ on: selSubjects.includes(s.name) }" @click="toggleSubject(s.name)">{{ s.name }}<span class="n">{{ s.count }}</span></button>
      </div>
      <div class="field-label">题目数量</div>
      <div class="row">
        <button v-for="n in [5, 10, 20, 50]" :key="n" class="chip" :class="{ on: count === n }" @click="count = n">{{ n }} 题</button>
      </div>
      <button class="btn primary" @click="startExam">开始模考</button>
    </div>

    <!-- 答题中 -->
    <div v-if="phase === 'doing'" class="panel" style="margin-top:14px">
      <div class="field-label" style="margin-top:0">{{ examTitle }}（共 {{ questions.length }} 题）</div>
      <div v-for="(q, i) in questions" :key="q.cardId" class="exam-q">
        <div class="exam-num">第 {{ i + 1 }} 题 <span class="hint">（关键词覆盖 ≥60% 判对）</span></div>
        <div class="exam-front">{{ q.front }}</div>
        <textarea v-model="answers[i]" class="input" rows="3" placeholder="用你自己的话作答…"></textarea>
      </div>
      <button class="btn primary" @click="submit">交卷</button>
    </div>

    <!-- 成绩 -->
    <div v-if="phase === 'result' && graded.length" class="panel" style="margin-top:14px">
      <div class="result-head">
        <span class="result-score">{{ score }} / {{ graded.length }}</span>
        <span class="hint" style="margin-left:10px">正确率 {{ Math.round((score / graded.length) * 100) }}%</span>
        <span style="flex:1"></span>
        <button class="btn small" :disabled="explainBusy || !wrongList.length" @click="aiExplain">{{ explainBusy ? '讲解中…' : `AI 逐题讲解错题（${wrongList.length}）` }}</button>
        <button class="btn small" :disabled="!wrongList.length" @click="markWrong">错题加入错题本（{{ wrongList.length }}）</button>
        <button class="btn small" @click="backToSetup">再来一场</button>
      </div>
      <div v-for="(g, i) in graded" :key="g.cardId" class="exam-q" :class="{ wrong: !g.correct }">
        <div class="exam-num">{{ g.correct ? '✅' : '❌' }} 第 {{ i + 1 }} 题（覆盖 {{ g.cov }}%）</div>
        <div class="exam-front">{{ g.front }}</div>
        <div class="hint">你的答案：{{ answers[i] || '（未作答）' }}</div>
        <div class="exam-std">参考答案：{{ g.back }}</div>
        <div v-if="explains[i]" class="exam-explain">{{ explains[i] }}</div>
      </div>
    </div>

    <!-- 历史 -->
    <div class="panel" style="margin-top:16px">
      <div class="field-label" style="margin-top:0">历史成绩（{{ history.length }} 场）</div>
      <div v-if="!history.length" class="hint">还没有模考记录。</div>
      <div v-for="ex in history" :key="ex.id" class="exam-row">
        <span class="chip" style="cursor:pointer" @click="viewExam(ex)">{{ ex.title }}</span>
        <span class="hint">{{ ex.score }}/{{ ex.total }} · {{ new Date(ex.createdAt).toLocaleDateString() }}</span>
        <span style="flex:1"></span>
        <button class="btn small" @click="viewExam(ex)">查看</button>
        <button class="btn small danger" @click="removeExam(ex)">删除</button>
      </div>
    </div>

    <!-- 历史详情弹窗 -->
    <teleport to="body">
      <div v-if="viewing" class="modal-mask" @click.self="closeView">
        <div class="modal">
          <h3 style="margin-top:0">{{ viewing.title }}（{{ viewing.score }}/{{ viewing.total }}）</h3>
          <div v-for="(q, i) in viewing.questions" :key="i" class="exam-q" :class="{ wrong: !q.correct }">
            <div class="exam-num">{{ q.correct ? '✅' : '❌' }} 第 {{ i + 1 }} 题</div>
            <div class="exam-front">{{ q.front }}</div>
            <div class="hint">你的答案：{{ q.user || '（未作答）' }}</div>
            <div class="exam-std">参考答案：{{ q.back }}</div>
            <div v-if="q.explain" class="exam-explain">{{ q.explain }}</div>
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:14px">
            <button class="btn" @click="closeView">关闭</button>
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
</style>