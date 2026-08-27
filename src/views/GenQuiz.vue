<script setup>
// P2-1 生成式测验：从卡片/知识点用 LLM 自动生成选择/填空/简答题
// 认知科学：测试效应（Testing Effect）—— 主动检索比被动复习强 2~3 倍；
//   生成效应（Generation Effect）—— 自己产出答案比再认更牢固。
// 与 Exam.vue 模考的差异：Exam 从卡片原样抽题（再认级），本页用 LLM 重组全新题目（生成级）
// 闭环：作答 → 批改 → 错题一键生成卡片入复习队列（P2-2 模考-错题-AI补卡闭环的生成式入口）
import { ref, computed, onMounted } from 'vue';
import { db } from '../db.js';
import { getSubjects, saveExam, listExams } from '../repo.js';
import { genQuiz, gradeQuestion, QUIZ_TYPES } from '../utils/genQuiz.js';
import { wrongQuestionsToCards } from '../utils/wrongToCards.js';
import { hasAIKey } from '../ai.js';
import { toast } from '../utils/toast.js';
import { T } from '../utils/telemetry.js';

const subjects = ref([]);
const selSubjects = ref([]);
const quizType = ref('mixed'); // choice | cloze | shortAnswer | mixed
const count = ref(6);
const phase = ref('setup'); // setup | doing | result
const questions = ref([]);
const answers = ref([]);
const generating = ref(false);
const quizTitle = ref('');
const history = ref([]);
const savedQuiz = ref(null);
const supplementBusy = ref(false); // 错题补卡中（P2-2 闭环入口）

async function loadSubjects() { subjects.value = await getSubjects(); }
async function loadHistory() {
  const all = await listExams();
  // 只显示生成式测验（title 带"生成式测验"标记）
  history.value = all.filter(e => (e.title || '').includes('生成式测验'));
}
onMounted(() => { loadSubjects(); loadHistory(); });

function toggleSubject(name) {
  const i = selSubjects.value.indexOf(name);
  if (i >= 0) selSubjects.value.splice(i, 1); else selSubjects.value.push(name);
}

async function startQuiz() {
  if (!count.value || count.value < 1) { toast('请填写题目数量', 'error'); return; }
  generating.value = true;
  try {
    let pool = await db.cards.toArray();
    if (selSubjects.value.length) pool = pool.filter(c => selSubjects.value.includes(c.subject || '未分类'));
    if (!pool.length) { toast('该范围内没有卡片', 'error'); return; }
    // 过滤掉无 back 的卡（无法生成题目）
    pool = pool.filter(c => c.front && c.back);
    if (pool.length < 4) { toast('卡片不足 4 张，无法生成测验（至少需要 4 张以构造干扰项）', 'error'); return; }
    const opts = quizType.value === 'mixed' ? { mixTypes: true, count: count.value } : { type: quizType.value, count: count.value };
    const qs = await genQuiz(pool, opts);
    questions.value = qs;
    answers.value = new Array(qs.length).fill(quizType.value === 'choice' ? -1 : '');
    quizTitle.value = `${selSubjects.value.join('+') || '综合'} 生成式测验 ${new Date().toLocaleDateString()}`;
    phase.value = 'doing';
    toast(`已生成 ${qs.length} 道题（${quizType.value === 'mixed' ? '混合题型' : QUIZ_TYPES.find(t => t.code === quizType.value)?.label}）`, 'success');
  } catch (e) {
    toast('生成失败：' + (e?.message || e), 'error');
  } finally {
    generating.value = false;
  }
}

const graded = computed(() => questions.value.map((q, i) => {
  const g = gradeQuestion(q, answers.value[i]);
  return { ...q, user: answers.value[i], ...g };
}));
const score = computed(() => graded.value.filter(g => g.correct).length);
const wrongList = computed(() => graded.value.filter(g => !g.correct));

async function submit() {
  const unanswered = answers.value.filter((a, i) => {
    const q = questions.value[i];
    if (q.type === 'choice') return a === -1 || a === undefined;
    return !String(a).trim();
  }).length;
  if (unanswered > 0 && !confirm(`还有 ${unanswered} 题未作答，确定交卷？`)) return;
  const g = graded.value;
  savedQuiz.value = await saveExam({
    title: quizTitle.value,
    subject: selSubjects.value.join('+'),
    questions: g.map(q => ({
      cardId: q.sourceCardId,
      type: q.type,
      stem: q.stem,
      options: q.options,
      answer: q.answer,
      explanation: q.explanation,
      user: q.user,
      cov: q.cov,
      correct: q.correct,
    })),
    score: score.value,
    total: g.length,
  });
  phase.value = 'result';
  await loadHistory();
  try { T.examEnd(score.value, g.length); } catch {}
  toast(`交卷：${score.value}/${g.length} 分（已存档）`, score.value === g.length ? 'success' : 'info');
}

// P2-2 闭环入口：把错题一键生成为卡片入复习队列（复用共享工具，与 Exam.vue 模考统一逻辑）
async function supplementWrongToCards() {
  if (supplementBusy.value) return;
  supplementBusy.value = true;
  try {
    const wrongs = wrongList.value;
    if (!wrongs.length) { toast('没有错题需要补卡', 'info'); return; }
    const r = await wrongQuestionsToCards(wrongs, { tag: '生成式测验错题', source: '生成式测验-错题补卡' });
    if (r.created > 0) {
      toast(`已将 ${r.created} 道错题补卡入复习队列${r.failed ? `（${r.failed} 道失败）` : ''}`, 'success');
    } else {
      toast('补卡失败：' + (r.failed ? `${r.failed} 道无法生成` : '未知错误'), 'error');
    }
  } catch (e) {
    toast('错题补卡失败：' + (e?.message || e), 'error');
  } finally {
    supplementBusy.value = false;
  }
}

function reset() {
  phase.value = 'setup';
  questions.value = [];
  answers.value = [];
  savedQuiz.value = null;
}

function viewHistory(h) {
  // 简化：跳转到详情查看（复用 exams 表）
  savedQuiz.value = h;
  questions.value = (h.questions || []).map(q => ({ ...q, subject: h.subject || '未分类' }));
  answers.value = (h.questions || []).map(q => q.user ?? (q.type === 'choice' ? -1 : ''));
  phase.value = 'result';
}
</script>

<template>
  <div class="page">
    <h2>🧪 生成式测验</h2>
    <p class="hint">
      与模考不同：这里用 AI 从你的卡片库<b>重新出题</b>（选择/填空/简答），题干和情境都是新的，
      避免背题而非学知识。认知科学：测试效应 + 生成效应，主动检索比被动复习强 2~3 倍。
      <span v-if="!hasAIKey()" style="color:var(--warn)">⚠ 未配置 AI 密钥，将降级为本地模板出题（质量较低）</span>
    </p>

    <!-- 阶段 1：出题设置 -->
    <div v-if="phase === 'setup'" class="card panel">
      <div class="field-label">科目范围（不选=全部）</div>
      <div class="subject-grid">
        <label v-for="s in subjects" :key="s.name" class="subject-chip" :class="{ on: selSubjects.includes(s.name) }">
          <input type="checkbox" :checked="selSubjects.includes(s.name)" @change="toggleSubject(s.name)" />
          <span>{{ s.name }}</span>
          <span class="count">{{ s.count }}</span>
        </label>
      </div>

      <div class="field-label" style="margin-top:16px">题型</div>
      <div class="type-grid">
        <label v-for="t in QUIZ_TYPES" :key="t.code" class="type-chip" :class="{ on: quizType === t.code }">
          <input type="radio" :value="t.code" v-model="quizType" />
          <div>
            <div class="type-name">{{ t.label }}</div>
            <div class="type-desc">{{ t.desc }}</div>
          </div>
        </label>
        <label class="type-chip" :class="{ on: quizType === 'mixed' }">
          <input type="radio" value="mixed" v-model="quizType" />
          <div>
            <div class="type-name">混合</div>
            <div class="type-desc">三种题型各 1/3，综合训练</div>
          </div>
        </label>
      </div>

      <div class="field-label" style="margin-top:16px">题目数量</div>
      <input type="number" min="1" max="20" v-model.number="count" class="input" style="width:120px" />

      <div style="margin-top:16px">
        <button class="btn primary" :disabled="generating" @click="startQuiz">
          {{ generating ? '生成中…（LLM 出题）' : '生成测验' }}
        </button>
      </div>

      <div v-if="history.length" class="field-label" style="margin-top:24px">历史成绩</div>
      <div v-if="history.length" class="history-list">
        <div v-for="h in history" :key="h.id" class="history-item" @click="viewHistory(h)">
          <span class="h-title">{{ h.title }}</span>
          <span class="h-score">{{ h.score }}/{{ h.total }}</span>
          <span class="h-date">{{ new Date(h.createdAt).toLocaleString() }}</span>
        </div>
      </div>
    </div>

    <!-- 阶段 2：作答 -->
    <div v-if="phase === 'doing'" class="card panel">
      <div class="quiz-header">
        <span>{{ quizTitle }}</span>
        <button class="btn small primary" @click="submit">交卷</button>
      </div>
      <div v-for="(q, i) in questions" :key="i" class="quiz-item">
        <div class="quiz-stem">
          <span class="q-no">{{ i + 1 }}.</span>
          <span class="q-type-tag">{{ q.type === 'choice' ? '选择' : q.type === 'cloze' ? '填空' : '简答' }}</span>
          <pre>{{ q.stem }}</pre>
        </div>
        <!-- 选择题 -->
        <div v-if="q.type === 'choice'" class="options">
          <label v-for="(opt, oi) in q.options" :key="oi" class="option" :class="{ on: answers[i] === oi }">
            <input type="radio" :value="oi" v-model="answers[i]" />
            <span class="opt-letter">{{ 'ABCD'[oi] }}</span>
            <span>{{ opt }}</span>
          </label>
        </div>
        <!-- 填空/简答 -->
        <textarea v-else v-model="answers[i]" class="input quiz-textarea" placeholder="请输入你的答案…"></textarea>
      </div>
      <div style="margin-top:16px;text-align:right">
        <button class="btn primary" @click="submit">交卷</button>
      </div>
    </div>

    <!-- 阶段 3：批改结果 -->
    <div v-if="phase === 'result'" class="card panel">
      <div class="result-header">
        <span class="result-score">{{ score }}/{{ graded.length }}</span>
        <span class="result-pct">{{ Math.round((score / graded.length) * 100) }}%</span>
      </div>
      <div v-if="wrongList.length" style="margin:12px 0">
        <button class="btn primary" :disabled="supplementBusy" @click="supplementWrongToCards">
          {{ supplementBusy ? '补卡中…' : `把 ${wrongList.length} 道错题生成卡片入复习队列` }}
        </button>
        <span class="hint" style="margin-left:8px">闭环：错题 → 卡片 → 复习队列（P2-2）</span>
      </div>
      <div v-for="(q, i) in graded" :key="i" class="grade-item" :class="{ wrong: !q.correct }">
        <div class="grade-stem">
          <span class="q-no">{{ i + 1 }}.</span>
          <span class="q-type-tag">{{ q.type === 'choice' ? '选择' : q.type === 'cloze' ? '填空' : '简答' }}</span>
          <span class="grade-mark" :class="{ ok: q.correct }">{{ q.correct ? '✓' : '✗' }}</span>
          <pre>{{ q.stem }}</pre>
        </div>
        <div v-if="q.type === 'choice'" class="grade-options">
          <div v-for="(opt, oi) in q.options" :key="oi" class="grade-opt"
            :class="{ correct: oi === q.answer, picked: oi === q.user }">
            <span class="opt-letter">{{ 'ABCD'[oi] }}</span>
            <span>{{ opt }}</span>
            <span v-if="oi === q.answer" class="tag-correct">正确答案</span>
            <span v-if="oi === q.user && oi !== q.answer" class="tag-wrong">你的选择</span>
          </div>
        </div>
        <div v-else class="grade-ans">
          <div><b>你的答案：</b><span>{{ q.type === 'choice' ? (q.user >= 0 ? 'ABCD'[q.user] : '未选') : (q.user || '未作答') }}</span></div>
          <div><b>参考答案：</b><span>{{ q.type === 'choice' ? 'ABCD'[q.answer] + '. ' + (q.options?.[q.answer] || '') : q.answer }}</span></div>
          <div class="grade-cov">关键词覆盖：{{ q.cov }}% · {{ q.reason }}</div>
        </div>
        <div v-if="q.explanation" class="grade-explain"><b>解析：</b>{{ q.explanation }}</div>
      </div>
      <div style="margin-top:16px">
        <button class="btn" @click="reset">再来一次</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { max-width: 860px; margin: 0 auto; padding: 16px; }
.hint { color: var(--ink-2); font-size: 13px; line-height: 1.6; }
.panel { padding: 16px; }
.field-label { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
.subject-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
.subject-chip { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; font-size: 13px; transition: .15s; }
.subject-chip.on { border-color: var(--accent); background: var(--code-inline); }
.subject-chip .count { color: var(--ink-2); font-size: 11px; margin-left: auto; }
.type-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
@media (max-width: 600px) { .type-grid { grid-template-columns: 1fr; } }
.type-chip { display: flex; align-items: flex-start; gap: 8px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; transition: .15s; }
.type-chip.on { border-color: var(--accent); background: var(--code-inline); }
.type-name { font-weight: 600; font-size: 14px; }
.type-desc { font-size: 11px; color: var(--ink-2); margin-top: 2px; }
.history-list { display: flex; flex-direction: column; gap: 6px; }
.history-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; font-size: 13px; transition: .15s; }
.history-item:hover { border-color: var(--accent); }
.h-title { flex: 1; }
.h-score { font-weight: 600; margin: 0 12px; }
.h-date { color: var(--ink-2); font-size: 11px; }
.quiz-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; font-weight: 600; }
.quiz-item { padding: 12px 0; border-bottom: 1px dashed var(--line); }
.quiz-stem { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 10px; }
.q-no { font-weight: 700; flex: none; }
.q-type-tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--code-inline); color: var(--ink-2); flex: none; }
.quiz-stem pre { white-space: pre-wrap; word-break: break-word; font-family: inherit; margin: 0; flex: 1; }
.options { display: flex; flex-direction: column; gap: 6px; }
.option { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; cursor: pointer; transition: .15s; }
.option.on { border-color: var(--accent); background: var(--code-inline); }
.opt-letter { font-weight: 700; flex: none; }
.quiz-textarea { width: 100%; min-height: 80px; resize: vertical; font-family: inherit; }
.result-header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 16px; }
.result-score { font-size: 28px; font-weight: 800; color: var(--accent); }
.result-pct { font-size: 16px; color: var(--ink-2); }
.grade-item { padding: 12px; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 10px; }
.grade-item.wrong { border-left: 3px solid var(--warn, #e74c3c); }
.grade-stem { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 8px; }
.grade-mark { font-weight: 800; flex: none; color: var(--warn, #e74c3c); }
.grade-mark.ok { color: var(--accent, #27ae60); }
.grade-options { display: flex; flex-direction: column; gap: 4px; }
.grade-opt { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 4px; font-size: 13px; }
.grade-opt.correct { background: rgba(39, 174, 96, 0.12); }
.grade-opt.picked:not(.correct) { background: rgba(231, 76, 60, 0.10); }
.tag-correct { font-size: 10px; color: var(--accent, #27ae60); margin-left: auto; }
.tag-wrong { font-size: 10px; color: var(--warn, #e74c3c); margin-left: auto; }
.grade-ans { font-size: 13px; line-height: 1.7; }
.grade-cov { color: var(--ink-2); font-size: 12px; margin-top: 4px; }
.grade-explain { margin-top: 8px; padding: 8px 10px; background: var(--code-inline); border-radius: 6px; font-size: 12px; line-height: 1.6; }
</style>
