// src/components/AiQuizView.vue
// AI 出的题 → **可直接点击作答的题目**（round76 复习闭环）。
//
// 为什么需要：此前 AI 出的题只是聊天里的一段文字（A/B/C/D 写在正文里），用户得自己记答案、
// 自己判对错、自己找解析；而 App 里的 SRS 复习记录完全不参与 —— 于是「AI 帮我出题复习」
// 这件事在数据上等于没发生（44 张卡 0 复习、0% 掌握度就是这么来的）。
//
// 本组件把 quiz 结构化结果渲染成：点选项 → 立即判分 + 显示解析；题目带 cardId 时，
// 可一键「记入复习」（对 → rating 2 记住了 / 错 → rating 0 没记住），把自测变成真实复习记录。
<template>
  <div class="ai-quiz">
    <div class="ai-quiz-head">
      <span class="ai-quiz-progress">{{ t('components.aiQuiz.progress', undefined, { done: answeredCount, total: questions.length }) }}</span>
      <span v-if="answeredCount" class="ai-quiz-score">{{ t('components.aiQuiz.score', undefined, { right: rightCount, total: answeredCount }) }}</span>
      <span style="flex:1"></span>
      <button v-if="answeredCount" class="btn small" @click="reset">{{ t('components.aiQuiz.reset') }}</button>
    </div>

    <div v-for="(q, i) in questions" :key="i" class="ai-quiz-q">
      <div class="ai-quiz-stem">{{ i + 1 }}. {{ q.q }}</div>
      <button
        v-for="(o, j) in q.options"
        :key="j"
        class="ai-quiz-opt"
        :class="optClass(i, j)"
        :disabled="picked[i] != null"
        @click="pick(i, j)"
      >
        <b>{{ LETTERS[j] }}</b>. {{ o }}
      </button>
      <div v-if="picked[i] != null" class="ai-quiz-fb">
        <span v-if="picked[i] === q.answer" class="ai-quiz-ok">{{ t('components.aiQuiz.correct') }}</span>
        <span v-else class="ai-quiz-bad">{{ t('components.aiQuiz.wrong', undefined, { answer: LETTERS[q.answer] }) }}</span>
        <div v-if="q.explain" class="ai-quiz-explain">{{ t('components.aiQuiz.explain') }}{{ q.explain }}</div>
        <button v-if="q.cardId" class="btn small" :disabled="recorded[i]" @click="record(i)">
          {{ recorded[i] ? t('components.aiQuiz.recorded') : t('components.aiQuiz.record') }}
        </button>
      </div>
    </div>

    <div v-if="note" class="ai-quiz-note">{{ note }}</div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { normalizeQuizData } from '../utils/ai-structured.js';
import { isQuizRecorded, markQuizRecorded } from '../utils/quiz-recorded.js';
import { review } from '../repo.js';
import { toast } from '../utils/toast.js';
import { t } from '../i18n/index.js';

const props = defineProps({
  data: { type: Object, default: () => ({}) },
  note: { type: String, default: '' },
});

const LETTERS = 'ABCDEF';
const questions = computed(() => normalizeQuizData(props.data) || []);
const picked = ref({});   // { [题号]: 选中的选项下标 }
// 已记入复习：**初始值来自持久化**（round83 P3-2）——只放组件内存的话，切页/刷新后
// 同一道题还能再点一次，对同一卡重复 review(2) 会把稳定性虚增。
const recorded = ref(Object.fromEntries(
  questions.value.map((q, i) => [i, q.cardId ? isQuizRecorded(q.cardId, q.q) : false]),
));

const answeredCount = computed(() => Object.keys(picked.value).length);
const rightCount = computed(() => questions.value.reduce(
  (n, q, i) => n + (picked.value[i] === q.answer ? 1 : 0), 0,
));

function pick(i, j) {
  if (picked.value[i] != null) return; // 已作答不可改（否则分数无意义）
  picked.value = { ...picked.value, [i]: j };
}

function optClass(i, j) {
  const p = picked.value[i];
  if (p == null) return '';
  const q = questions.value[i];
  if (j === q.answer) return 'is-right';       // 答完后高亮正确项（无论用户选没选它）
  if (j === p) return 'is-wrong';
  return 'is-dim';
}

function reset() {
  picked.value = {};
  recorded.value = {};
}

/**
 * 记入复习：把「自测对错」变成真实的 SRS 复习记录。
 * 映射：答对 → rating 2（记住了）；答错 → rating 0（没记住）。
 * ⚠️ 必须由用户**主动点**才写：AI 出题不等于用户真的复习过，替用户记账会污染掌握度。
 */
async function record(i) {
  const q = questions.value[i];
  if (!q?.cardId || recorded.value[i]) return;
  // round83 P3-1 硬化：**未作答不得记账**。模板里按钮本就在「已作答」块内（点了才有），
  // 但函数级再设一道闸——否则将来有人挪动模板结构，这里就会把"没答"写成 rating 0（记成忘了），
  // 直接拉低该卡稳定性且完全违背按钮语义。
  if (picked.value[i] == null) return;
  try {
    await review(q.cardId, picked.value[i] === q.answer ? 2 : 0);
    markQuizRecorded(q.cardId, q.q);
    recorded.value = { ...recorded.value, [i]: true };
    toast(t('components.aiQuiz.recorded'), 'success');
  } catch (e) {
    toast(e.message || String(e), 'error');
  }
}
</script>

<style scoped>
.ai-quiz { display: flex; flex-direction: column; gap: 12px; }
.ai-quiz-head { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--muted); }
.ai-quiz-score { color: var(--green); font-weight: 600; }
.ai-quiz-q { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.ai-quiz-stem { font-weight: 600; margin-bottom: 8px; line-height: 1.6; }
.ai-quiz-opt {
  display: block; width: 100%; text-align: left; margin: 6px 0; padding: 8px 10px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--surface);
  color: var(--text); cursor: pointer; line-height: 1.5;
}
.ai-quiz-opt:hover:not(:disabled) { border-color: var(--brand); }
.ai-quiz-opt:disabled { cursor: default; }
.ai-quiz-opt.is-right { border-color: var(--green); background: color-mix(in srgb, var(--green) 12%, transparent); }
.ai-quiz-opt.is-wrong { border-color: var(--red); background: color-mix(in srgb, var(--red) 12%, transparent); }
.ai-quiz-opt.is-dim { opacity: 0.6; }
.ai-quiz-fb { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.ai-quiz-ok { color: var(--green); font-weight: 600; }
.ai-quiz-bad { color: var(--red); font-weight: 600; }
.ai-quiz-explain { font-size: 13px; line-height: 1.7; color: var(--muted); }
.ai-quiz-note { font-size: 12px; color: var(--muted); }
</style>
