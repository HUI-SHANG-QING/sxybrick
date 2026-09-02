<script setup>
// 背诵页（图14-16：不背式揭释义 + 两段式自适应 + 13 种模式）
// 默认模式 adaptive：先看词 → 手动揭释义 → 认识/模糊/忘记；
//   若选「忘记」，立即切到 4 选 1 强化一遍（两段式）。
// 其余 12 种模式由 mode 决定出题与判分方式。
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { t } from '../i18n/index.js';
import { escapeRegExp } from '../utils/regexp.js';
import { toast } from '../utils/toast.js';
import { speak, speechSupported } from '../utils/speak.js';
import {
  dueWordCards, listWordCards, reviewWord, getWordSettings, listWordGroups,
} from '../word-repo.js';

const route = useRoute();
const router = useRouter();

const settings = ref(null);
const queue = ref([]);
const idx = ref(0);
const phase = ref('setup'); // setup | question | reveal | grade | done

const scope = ref('due');      // due / all / word / phrase / sentence / group
const groupId = ref('');
const groups = ref([]);
const mode = ref('adaptive');  // 见 MODES

const revealed = ref(false);
const forgiven = ref(false);     // adaptive 段内是否已错过
const adaptiveStage = ref(1);   // 1=揭释义, 2=选择题强化

// 选择题
const options = ref([]);
const chosen = ref(null);
// 填空 / 听写 / 拼写
const input = ref('');

const result = ref(null); // {correct, rating}
const sessionCount = ref(0);

const MODES = [
  { id: 'adaptive', label: t('views.wordReview.modeAdaptive'), hint: t('views.wordReview.hintAdaptive') },
  { id: 'choice', label: t('views.wordReview.modeChoice'), hint: t('views.wordReview.hintChoice') },
  { id: 'listenChoice', label: t('views.wordReview.modeListenChoice'), hint: t('views.wordReview.hintListenChoice') },
  { id: 'spell', label: t('views.wordReview.modeSpell'), hint: t('views.wordReview.hintSpell') },
  { id: 'listenSpell', label: t('views.wordReview.modeListenSpell'), hint: t('views.wordReview.hintListenSpell') },
  { id: 'reverseChoice', label: t('views.wordReview.modeReverseChoice'), hint: t('views.wordReview.hintReverseChoice') },
  { id: 'cloze', label: t('views.wordReview.modeCloze'), hint: t('views.wordReview.hintCloze') },
  { id: 'sentenceCloze', label: t('views.wordReview.modeSentenceCloze'), hint: t('views.wordReview.hintSentenceCloze') },
  { id: 'flashcard', label: t('views.wordReview.modeFlashcard'), hint: t('views.wordReview.hintFlashcard') },
  { id: 'englishEnglish', label: t('views.wordReview.modeEnglishEnglish'), hint: t('views.wordReview.hintEnglishEnglish') },
  { id: 'collocations', label: t('views.wordReview.modeCollocations'), hint: t('views.wordReview.hintCollocations') },
  { id: 'readAloud', label: t('views.wordReview.modeReadAloud'), hint: t('views.wordReview.hintReadAloud') },
  { id: 'quiz', label: t('views.wordReview.modeQuiz'), hint: t('views.wordReview.hintQuiz') },
];

onMounted(async () => {
  settings.value = await getWordSettings();
  groups.value = await listWordGroups();
  if (route.query.mode) mode.value = String(route.query.mode);
});

const current = computed(() => queue.value[idx.value] || null);
const remaining = computed(() => Math.max(0, queue.value.length - idx.value));
const progressPct = computed(() => queue.value.length ? Math.round((idx.value / queue.value.length) * 100) : 0);

async function start() {
  let rows;
  if (scope.value === 'due') rows = await dueWordCards();
  else if (scope.value === 'group') rows = await dueWordCards({ groupId: groupId.value });
  else if (scope.value === 'all') rows = await listWordCards({ schedulableOnly: true });
  else rows = await listWordCards({ kind: scope.value, schedulableOnly: true });
  if (!rows.length) { toast(t('views.wordReview.noCards'), 'warn'); return; }
  queue.value = rows;
  idx.value = 0; sessionCount.value = 0;
  phase.value = 'question';
  setupQuestion();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// 生成 4 选 1 干扰项（从队列其余卡取释义/单词）
function buildChoices(card, pickMeaning) {
  const pool = queue.value.filter(c => c.id !== card.id);
  const others = shuffle(pool).slice(0, 3);
  const correct = pickMeaning ? card.meaning : card.word;
  const wrongs = others.map(c => pickMeaning ? c.meaning : c.word);
  const all = shuffle([correct, ...wrongs]);
  return all.map(v => ({ text: v, ok: v === correct }));
}

function setupQuestion() {
  revealed.value = false; forgiven.value = false; adaptiveStage.value = 1;
  chosen.value = null; input.value = '';
  result.value = null;
  const c = current.value;
  if (!c) { phase.value = 'done'; return; }
  phase.value = 'question';
  // 听音类模式：自动朗读
  if (mode.value === 'listenChoice' || mode.value === 'listenSpell') speak(c.word, { lang: accentLang() });
  // 选择题 / 反向 / 英英 / 词组 / 综合：预生成选项
  if (['choice', 'listenChoice', 'reverseChoice', 'englishEnglish', 'collocations', 'quiz'].includes(mode.value)) {
    const pickMeaning = mode.value === 'reverseChoice' || mode.value === 'englishEnglish';
    options.value = buildChoices(c, pickMeaning);
  }
  // 挖空拼写：生成带缺口词形
  if (mode.value === 'cloze') prepareCloze(c);
  if (mode.value === 'sentenceCloze') prepareSentenceCloze(c);
}

function accentLang() { return settings.value?.accent === 'auto' ? 'en-US' : (settings.value?.accent || 'en-US'); }

// 挖空拼写：去掉 30%~50% 字母（保留首尾）
const clozeWord = ref('');
function prepareCloze(c) {
  const w = c.word;
  if (w.length <= 2) { clozeWord.value = w; return; }
  const keep = Math.max(1, Math.ceil(w.length * 0.4));
  const blanks = w.length - keep;
  const positions = shuffle([...Array(w.length).keys()]).slice(0, blanks);
  clozeWord.value = w.split('').map((ch, i) => positions.includes(i) ? '_' : ch).join('');
}

const sentenceClozeText = ref('');
const sentenceClozeFallback = ref(false); // 例句挖空无例句时退化为「看释义拼单词」
// P2-D（round14）：c.word 是用户输入（手动/AI 生成，phrase/sentence 可能含 ()、[]、*、+ 等元字符），
// 直传 new RegExp 会抛 SyntaxError 且调用链无 try/catch → 整个会话启动崩溃。先转义再构造，兜底保留原句。
function prepareSentenceCloze(c) {
  const ex = (c.examples && c.examples[0]) || (c.example ? { sentence: c.example } : null);
  if (!ex) {
    // 无例句：退化为「看释义拼单词」——题干显示释义、输入框留空（绝不预填答案，否则答案直接泄露）
    sentenceClozeFallback.value = true;
    sentenceClozeText.value = c.meaning || '';
    input.value = '';
    return;
  }
  sentenceClozeFallback.value = false;
  try {
    sentenceClozeText.value = ex.sentence.replace(new RegExp(escapeRegExp(c.word), 'gi'), '____');
  } catch {
    sentenceClozeText.value = ex.sentence; // 挖空失败：保留原句，不阻塞会话
  }
}

function reveal() {
  if (mode.value === 'adaptive') { adaptiveStage.value = 1; }
  revealed.value = true;
  phase.value = 'reveal';
}

// 不背式自评（adaptive / flashcard）
async function selfRate(rating) {
  // rating: 2=认识, 1=模糊, 0=忘记
  if (mode.value === 'adaptive' && rating === 0 && !forgiven.value) {
    // 两段式：第一次忘记 → 切到 4 选 1 强化
    forgiven.value = true; adaptiveStage.value = 2;
    options.value = buildChoices(current.value, true);
    phase.value = 'question';
    toast(t('views.wordReview.adaptiveForgotTitle'), 'info');
    return;
  }
  await commit(rating);
}

async function submitChoice() {
  const ok = chosen.value != null && options.value[chosen.value]?.ok;
  result.value = { correct: !!ok, chosen: chosen.value };
  await commit(ok ? 2 : 0);
}

async function submitText() {
  const c = current.value;
  const ans = input.value.trim().toLowerCase();
  const correct = ans === c.word.toLowerCase();
  result.value = { correct, your: input.value };
  // 听写/拼写：写错也算"模糊"，正确算"认识"
  await commit(correct ? 2 : 1);
}

async function commit(rating) {
  const c = current.value;
  if (c && c.kind !== 'template') {
    try {
      await reviewWord(c.id, rating);
      sessionCount.value++;
    } catch (e) {
      // round17 R17-35：写库失败不再静默吞——否则用户已评级但 dueAt 未推进，
      // 词下次重复出现、调度状态与 UI 不一致
      toast(t('views.wordReview.commitFailed', '复习结果保存失败，请重试') + '：' + (e?.message || e), 'error');
      return; // 留在当前词不推进，等待用户重试
    }
  }
  phase.value = 'grade';
  setTimeout(next, 900);
}

function next() {
  if (idx.value >= queue.value.length - 1) { phase.value = 'done'; return; }
  idx.value++;
  setupQuestion();
}

function restart() { phase.value = 'setup'; }
function goBook() { router.push('/english/book'); }

const modeHint = computed(() => MODES.find(m => m.id === mode.value)?.hint || '');
const speakSupported = speechSupported();
</script>

<template>
  <div class="wrev">
    <div class="wr-head">
      <button class="back" @click="router.push('/english')">← {{ t('views.wordHub.title') }}</button>
      <h1>{{ t('views.wordReview.title') }}</h1>
    </div>

    <!-- 设置页 -->
    <div v-if="phase === 'setup'" class="wr-setup">
      <p class="wr-sub">{{ t('views.wordReview.subtitle') }}</p>

      <section class="wr-block">
        <label class="wr-label">{{ t('views.wordReview.scopeLabel') }}</label>
        <div class="wr-chips">
          <button class="wc" :class="{ on: scope === 'due' }" @click="scope = 'due'">{{ t('views.wordReview.scopeDue') }}</button>
          <button class="wc" :class="{ on: scope === 'all' }" @click="scope = 'all'">{{ t('views.wordReview.scopeAll') }}</button>
          <button class="wc" :class="{ on: scope === 'word' }" @click="scope = 'word'">{{ t('views.wordReview.scopeWord') }}</button>
          <button class="wc" :class="{ on: scope === 'phrase' }" @click="scope = 'phrase'">{{ t('views.wordReview.scopePhrase') }}</button>
          <button class="wc" :class="{ on: scope === 'sentence' }" @click="scope = 'sentence'">{{ t('views.wordReview.scopeSentence') }}</button>
        </div>
      </section>

      <section class="wr-block">
        <label class="wr-label">{{ t('views.wordReview.modeLabel') }}</label>
        <div class="wr-modes">
          <button v-for="m in MODES" :key="m.id" class="wm" :class="{ on: mode === m.id }" @click="mode = m.id">
            <b>{{ m.label }}</b><span>{{ m.hint }}</span>
          </button>
        </div>
      </section>

      <button class="wr-start" @click="start">▶ {{ t('views.wordReview.startBtn') }}</button>
    </div>

    <!-- 复习中 -->
    <div v-else-if="phase !== 'done'" class="wr-stage">
      <div class="wr-progress">
        <div class="wr-bar"><div class="wr-bar-fill" :style="{ width: progressPct + '%' }"></div></div>
        <span class="wr-left">{{ t('views.wordReview.remainingLabel') }} {{ remaining }} · {{ t('views.wordReview.countLabel', undefined, { total: queue.length }) }}</span>
      </div>

      <div class="card-flip" :class="{ revealed }">
        <!-- 题干 -->
        <div class="q-main">
          <div v-if="['listenChoice','listenSpell'].includes(mode)" class="q-listen">
            <button class="q-spk" @click="speak(current.word, { lang: accentLang() })">🔊 {{ t('views.wordReview.replay') }}</button>
          </div>

          <!-- 不背式 / 闪卡：显示英文词 -->
          <div v-if="['adaptive','flashcard','choice','spell','readAloud','quiz'].includes(mode)" class="q-word">
            {{ current.word }}
            <button class="q-spk2" @click="speak(current.word, { lang: accentLang() })">🔊</button>
          </div>

          <!-- 反向 / 英英 / 词组：显示释义或提示 -->
          <div v-if="mode === 'reverseChoice'" class="q-prompt">{{ current.meaning }}</div>
          <div v-if="mode === 'englishEnglish'" class="q-prompt">{{ current.defs?.[0]?.meaning || current.meaning }}</div>
          <div v-if="mode === 'collocations'" class="q-prompt">{{ current.meaning }}</div>

          <!-- 挖空拼写 -->
          <div v-if="mode === 'cloze'" class="q-cloze">{{ clozeWord }}</div>
          <!-- 例句挖空（无例句时退化为看释义拼单词） -->
          <div v-if="mode === 'sentenceCloze'" class="q-sent">
            <template v-if="sentenceClozeFallback">
              <span class="scl-fb">{{ t('views.wordReview.noExampleFallback') }}</span>
              <span class="scl-mean">{{ current.meaning }}</span>
            </template>
            <template v-else>{{ sentenceClozeText }}</template>
          </div>
        </div>

        <!-- 答案区 -->
        <div class="q-answer">
          <!-- 选择题 -->
          <div v-if="['choice','listenChoice','reverseChoice','englishEnglish','collocations','quiz'].includes(mode) && (!revealed || adaptiveStage===2)" class="opts">
            <button v-for="(o, i) in options" :key="i" class="opt"
              :class="{ on: chosen===i, correct: result && result.correct && chosen===i, wrong: result && chosen===i && !result.correct }"
              :disabled="result" @click="chosen = i">{{ o.text }}</button>
            <button v-if="!result" class="q-submit" @click="submitChoice">{{ t('views.wordReview.submit') }}</button>
          </div>

          <!-- 填空 / 听写 / 拼写 / 例句挖空 -->
          <div v-if="['spell','listenSpell','cloze','sentenceCloze'].includes(mode)" class="text-in">
            <input v-model="input" :placeholder="(settings?.spellHint && mode!=='sentenceCloze') ? current.word[0] + '…(' + current.word.length + ')' : ''" @keyup.enter="submitText" />
            <button v-if="!result" class="q-submit" @click="submitText">{{ t('views.wordReview.submit') }}</button>
          </div>

          <!-- 不背式揭释义（段1） -->
          <div v-if="mode === 'adaptive' && !revealed" class="reveal-area">
            <button class="q-reveal" @click="reveal">{{ t('views.wordReview.reveal') }}</button>
            <p class="reveal-hint">{{ t('views.wordReview.adaptiveRevealHint') }}</p>
          </div>

          <!-- 闪卡翻面 -->
          <div v-if="(mode === 'flashcard') && !revealed" class="reveal-area">
            <button class="q-reveal" @click="reveal">{{ t('views.wordReview.reveal') }}</button>
          </div>

          <!-- 跟读自评 -->
          <div v-if="mode === 'readAloud' && !result" class="reveal-area">
            <button class="q-spk" @click="speak(current.word, { lang: accentLang() })">🔊 {{ t('views.wordReview.replay') }}</button>
          </div>

          <!-- 释义展示（揭开后 / 跟读） -->
          <div v-if="revealed || (mode==='readAloud' && result)" class="meaning-show">
            <div class="ms-word">{{ current.word }} <span v-if="current.phonetic" class="ms-phon">/{{ current.phonetic }}/</span></div>
            <div class="ms-mean">{{ current.meaning }}</div>
            <div v-if="current.example" class="ms-ex">{{ current.example }} <span class="ms-ext">· {{ current.exampleTrans }}</span></div>
          </div>

          <!-- 判分后：不背式/闪卡 自评 -->
          <div v-if="(mode==='adaptive' || mode==='flashcard' || mode==='readAloud') && !result" class="rate-row">
            <button class="rate rate-good" @click="selfRate(2)">{{ t('views.wordReview.rateGood') }}</button>
            <button class="rate rate-hard" @click="selfRate(1)">{{ t('views.wordReview.rateHard') }}</button>
            <button class="rate rate-again" @click="selfRate(0)">{{ t('views.wordReview.rateAgain') }}</button>
          </div>

          <!-- 结果反馈 -->
          <div v-if="result" class="grade-fb" :class="result.correct ? 'ok' : 'no'">
            {{ result.correct ? '✓ ' + t('views.wordReview.correctToast') : '✗ ' + t('views.wordReview.wrongToast') }}
            <span v-if="!result.correct" class="gf-ans">{{ t('views.wordReview.correctAnswer') }}：{{ current.meaning }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 完成 -->
    <div v-else class="wr-done">
      <div class="done-emoji">🎉</div>
      <h2>{{ t('views.wordReview.sessionDone') }}</h2>
      <p>{{ t('views.wordReview.sessionDoneHint', undefined, { n: sessionCount }) }}</p>
      <div class="done-actions">
        <button class="btn-ghost" @click="restart">{{ t('views.wordReview.againReview') }}</button>
        <button class="btn-primary" @click="goBook">{{ t('views.wordReview.nextCard') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrev { padding: 16px 16px 30px; max-width: 640px; margin: 0 auto; }
.wr-head .back { border: none; background: transparent; color: var(--ink-2); cursor: pointer; font-size: 13px; }
.wr-head h1 { margin: 6px 0 0; font-size: 20px; color: var(--ink); }
.wr-sub { font-size: 12px; color: var(--ink-2); margin: 4px 0 14px; }

.wr-block { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 14px; margin-bottom: 12px; }
.wr-label { display: block; font-size: 13px; font-weight: 600; color: var(--ink); margin-bottom: 8px; }
.wr-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.wc { border: 1px solid var(--line); background: transparent; border-radius: 10px; padding: 6px 12px; font-size: 13px; cursor: pointer; color: var(--ink); }
.wc.on { border-color: var(--accent); background: var(--code-inline); color: var(--accent); }
.wr-modes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.wm { display: flex; flex-direction: column; gap: 2px; text-align: left; border: 1px solid var(--line); background: transparent; border-radius: 12px; padding: 10px; cursor: pointer; color: var(--ink); }
.wm.on { border-color: var(--accent); background: var(--code-inline); }
.wm b { font-size: 13px; }
.wm span { font-size: 11px; color: var(--ink-2); }
.wr-start { width: 100%; border: none; background: var(--accent); color: #fff; border-radius: 12px; padding: 13px; font-size: 15px; cursor: pointer; }

.wr-progress { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.wr-bar { flex: 1; height: 6px; background: var(--line); border-radius: 4px; overflow: hidden; }
.wr-bar-fill { height: 100%; background: var(--accent); transition: width .3s; }
.wr-left { font-size: 11px; color: var(--ink-2); white-space: nowrap; }

.card-flip { background: var(--panel); border: 1px solid var(--line); border-radius: 20px; padding: 22px 18px; min-height: 320px; display: flex; flex-direction: column; }
.q-main { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; }
.q-word { font-size: 34px; font-weight: 700; color: var(--ink); }
.q-spk2 { border: none; background: transparent; cursor: pointer; font-size: 22px; margin-left: 8px; vertical-align: middle; }
.q-prompt { font-size: 22px; color: var(--ink); }
.q-listen .q-spk { border: 1px solid var(--line); background: transparent; border-radius: 12px; padding: 12px 18px; font-size: 15px; cursor: pointer; color: var(--ink); }
.q-cloze { font-size: 30px; letter-spacing: 4px; color: var(--accent); font-family: monospace; }
.q-sent { font-size: 16px; color: var(--ink); line-height: 1.8; }
.scl-fb { display: block; font-size: 12px; color: var(--ink-2); margin-bottom: 6px; }
.scl-mean { font-size: 20px; color: var(--ink); }
.q-sent :deep(__), .q-sent { }

.q-answer { margin-top: 16px; }
.opts { display: flex; flex-direction: column; gap: 8px; }
.opt { border: 1px solid var(--line); background: transparent; border-radius: 12px; padding: 12px; font-size: 14px; cursor: pointer; color: var(--ink); text-align: left; }
.opt.on { border-color: var(--accent); }
.opt.correct { border-color: #34c759; background: #e9f9ee; color: #1f9255; }
.opt.wrong { border-color: #f0506e; background: #fdeef1; color: #d9534f; }
.text-in { display: flex; gap: 8px; }
.text-in input { flex: 1; border: 1px solid var(--line); border-radius: 12px; padding: 12px; font-size: 15px; background: var(--bg, #fff); color: var(--ink); }
.q-submit { border: none; background: var(--accent); color: #fff; border-radius: 12px; padding: 0 18px; font-size: 14px; cursor: pointer; }
.reveal-area { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.q-reveal { border: none; background: var(--accent); color: #fff; border-radius: 12px; padding: 12px 28px; font-size: 15px; cursor: pointer; }
.reveal-hint { font-size: 12px; color: var(--ink-2); margin: 0; }
.meaning-show { text-align: center; padding: 10px 0; }
.ms-word { font-size: 24px; font-weight: 700; color: var(--ink); }
.ms-phon { font-size: 13px; color: var(--ink-2); font-weight: 400; }
.ms-mean { font-size: 16px; color: var(--ink-2); margin-top: 4px; }
.ms-ex { font-size: 13px; color: var(--ink-2); margin-top: 6px; }
.ms-ext { color: var(--ink-2); opacity: .8; }
.rate-row { display: flex; gap: 8px; margin-top: 14px; }
.rate { flex: 1; border: none; border-radius: 12px; padding: 12px; font-size: 14px; cursor: pointer; color: #fff; }
.rate-good { background: #34c759; }
.rate-hard { background: #f0a020; }
.rate-again { background: #f0506e; }
.grade-fb { margin-top: 14px; text-align: center; font-size: 15px; font-weight: 600; padding: 10px; border-radius: 12px; }
.grade-fb.ok { color: #1f9255; background: #e9f9ee; }
.grade-fb.no { color: #d9534f; background: #fdeef1; }
.gf-ans { display: block; font-size: 12px; font-weight: 400; margin-top: 4px; }

.wr-done { text-align: center; padding: 40px 16px; }
.done-emoji { font-size: 48px; }
.wr-done h2 { color: var(--ink); margin: 10px 0 4px; }
.wr-done p { color: var(--ink-2); font-size: 13px; }
.done-actions { display: flex; gap: 10px; justify-content: center; margin-top: 18px; }
.btn-ghost { border: 1px solid var(--line); background: transparent; border-radius: 10px; padding: 10px 16px; cursor: pointer; color: var(--ink); font-size: 14px; }
.btn-primary { border: none; background: var(--accent); color: #fff; border-radius: 10px; padding: 10px 18px; cursor: pointer; font-size: 14px; }
@media (max-width: 520px) { .wr-modes { grid-template-columns: 1fr; } }
</style>
