<script setup>
// 背诵页（图14-16：不背式揭释义 + 两段式自适应 + 13 种模式）
// 默认模式 adaptive：先看词 → 手动揭释义 → 认识/模糊/忘记；
//   若选「忘记」，立即切到 4 选 1 强化一遍（两段式）。
// 其余 12 种模式由 mode 决定出题与判分方式。
// 对标成熟单词 App 补全（v27）：
//   · 闪卡/自适应题干带音标（看词 → 音标 → 揭释义）
//   · 进度计数 N/M（图3 的 0/20）
//   · 学习时长记录（wordStudyLog，每题累加、单次封顶 5 分钟）
//   · 拼写类模式收尾页（图5：拼写全部/拼写错误/跳过，过滤标熟）
//   · 小结页（图6：每词下次复习时间 + 今日已复习 X 词还剩 Y 词）
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { t } from '../i18n/index.js';
import { escapeRegExp } from '../utils/regexp.js';
import { toast } from '../utils/toast.js';
import { speak, speechSupported } from '../utils/speak.js';
import {
  dueWordCards, listWordCards, reviewWord, getWordSettings, listWordGroups,
  wordStats, wordReviewedToday, recordWordStudyTime,
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

// ---- 会话级追踪（拼写收尾 + 小结 + 学习时长，v27） ----
// 拼写类模式：结束后进「继续拼写」收尾页（拼写全部/拼写错误/跳过）
const SPELL_MODES = ['spell', 'listenSpell', 'cloze', 'sentenceCloze'];
const wrongCards = ref([]);        // 本轮答错的卡（重拼写用）
// 每题日志：{word, dueAt, intervalDays, level, familiar} —— 小结页「N天后复习/复习完成」数据源
const sessionLog = ref([]);
let lastActiveTs = 0;              // 上次活跃时刻（学习时长增量分母）
const doneStats = ref(null);       // {reviewedToday, remaining} 小结页底部统计

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
  let correct = pickMeaning ? card.meaning : card.word;
  // 空值防护：correct 为空/undefined 时，所有选项 v===correct 恒 true → 选什么都对。
  // 兜底到另一侧字段（meaning 空则用 word，word 空则用 meaning），仍空则跳过本题。
  if (!correct || !String(correct).trim()) {
    correct = pickMeaning ? card.word : card.meaning;
  }
  if (!correct || !String(correct).trim()) return []; // 无有效内容，调用方应跳过本题
  const correctStr = String(correct).trim();

  let wrongs = others
    .map(c => pickMeaning ? c.meaning : c.word)
    .filter(v => v && String(v).trim() && String(v).trim() !== correctStr);

  // 去重
  const seen = new Set([correctStr]);
  wrongs = wrongs.filter(v => { const s = String(v).trim(); if (seen.has(s)) return false; seen.add(s); return true; });

  // 兜底：队列不足时用占位干扰项，保证至少 3 个干扰（否则正确答案一目了然）
  if (wrongs.length < 3) {
    const placeholders = pickMeaning
      ? [t('views.wordReview.choicePlaceholder1'), t('views.wordReview.choicePlaceholder2'), t('views.wordReview.choicePlaceholder3')]
      : ['placeholder_a', 'placeholder_b', 'placeholder_c'];
    for (const ph of placeholders) {
      if (wrongs.length >= 3) break;
      if (!seen.has(ph)) { wrongs.push(ph); seen.add(ph); }
    }
  }
  const all = shuffle([correctStr, ...wrongs.slice(0, 3)]);
  return all.map(v => ({ text: v, ok: v === correctStr }));
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
  // pickMeaning=true → 题干显示英文词，选项列释义（看词选义）；false → 题干显示释义/英英，选项列单词（看义选词）。
  // 此前把 reverseChoice/englishEnglish 误设为 pickMeaning=true，导致题干与选项同为英文/同为释义，答案倒挂。
  if (['choice', 'listenChoice', 'reverseChoice', 'englishEnglish', 'collocations', 'quiz'].includes(mode.value)) {
    const pickMeaning = ['choice', 'listenChoice', 'quiz'].includes(mode.value);
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
  // readAloud/flashcard：自评后立即展示释义（result 触发 meaning-show 渲染），
  // 让用户在判分前可核对词义——此前 selfRate 不设 result，释义永不展示。
  result.value = { correct: rating >= 2, selfRated: true, rating };
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
  // 看词写义（spell）：答案应比对中文释义；其余（听音写词/填空拼写/例句挖空）：比对英文单词。
  const target = mode.value === 'spell' ? String(c.meaning || '').trim() : String(c.word || '').trim();
  // target 为空防护：meaning/word 都为空时空输入 ''==='' 恒 true → 误判正确。
  // 此时视为作答失败，rating=0（忘记），不给虚假正反馈。
  if (!target) {
    result.value = { correct: false, your: input.value, noTarget: true };
    await commit(0);
    return;
  }
  if (!ans) {
    // 空输入：不判正确，给"忘记"评级（拼写类必须有输入才给分）
    result.value = { correct: false, your: input.value };
    await commit(0);
    return;
  }
  const correct = ans === target.toLowerCase();
  result.value = { correct, your: input.value };
  // 听写/拼写：写错也算"模糊"，正确算"认识"
  await commit(correct ? 2 : 1);
}

async function commit(rating) {
  const c = current.value;
  const t0 = Date.now();
  if (c && c.kind !== 'template') {
    try {
      const res = await reviewWord(c.id, rating);
      sessionCount.value++;
      // 会话日志：记录调度后的下次到期/间隔/级别，供小结页展示「N天后复习 / 复习完成」
      sessionLog.value.push({
        word: c.word,
        dueAt: res?.dueAt ?? null,
        intervalDays: res?.intervalDays ?? 0,
        level: res?.level ?? 0,
        familiar: !!c.familiar,
      });
      // 答错（0 档）记入错词集，拼写收尾页「拼写错误」用
      if (!rating) wrongCards.value.push(c);
      // 学习时长：本答间隔封顶 5 分钟（recordWordStudyTime 内截断），静默失败不影响主流程
      const delta = Date.now() - lastActiveTs;
      lastActiveTs = Date.now();
      try { await recordWordStudyTime(delta); } catch { /* 时长记录失败不影响复习 */ }
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
  if (idx.value >= queue.value.length - 1) { finishSession(); return; }
  idx.value++;
  setupQuestion();
}

// 一轮结束：拼写类模式 → 「继续拼写」收尾页；其余 → 小结页
async function finishSession() {
  lastActiveTs = Date.now();
  if (SPELL_MODES.includes(mode.value)) {
    phase.value = 'spellFinish';
    return;
  }
  await showSummary();
}

// 拼写收尾页（图5）：拼写全部 / 拼写错误 / 跳过
// 重拼写队列过滤标熟（familiar=1）——标熟词刻意不再消耗时间（图5「已为你过滤标熟单词」）
function restartSpell(kind) {
  let rows;
  if (kind === 'wrong') rows = wrongCards.value.filter((c) => !c.familiar);
  else rows = queue.value.filter((c) => !c.familiar);
  if (!rows.length) { toast(t('views.wordReview.spellNoCards'), 'info'); return; }
  queue.value = rows;
  idx.value = 0;
  lastActiveTs = Date.now();
  phase.value = 'question';
  setupQuestion();
}

// 小结页（图6）：每词下次复习时间 + 今日已复习 X 词 · 还剩 Y 词
async function showSummary() {
  phase.value = 'done';
  try {
    const [s, rt] = await Promise.all([wordStats(), wordReviewedToday()]);
    doneStats.value = { reviewedToday: rt, remaining: s.due };
  } catch {
    doneStats.value = null;
  }
}

// 小结页每词状态文本：已标熟 > 复习完成（间隔≥21天或级别≥4）> N天后复习
function nextReviewText(log) {
  if (log.familiar) return { text: t('views.wordReview.stFamiliar'), cls: 'st-fam' };
  if ((log.intervalDays || 0) >= 21 || (log.level || 0) >= 4) {
    return { text: t('views.wordReview.stDone'), cls: 'st-done' };
  }
  if (!log.dueAt) return { text: '—', cls: 'st-wait' };
  const days = Math.max(1, Math.ceil((log.dueAt - Date.now()) / 86400000));
  return { text: t('views.wordReview.stDays', undefined, { n: days }), cls: 'st-wait' };
}

function restart() { phase.value = 'setup'; }
function goBook() { router.push('/english/book'); }

const modeHint = computed(() => MODES.find(m => m.id === mode.value)?.hint || '');
// 文本作答的输入框提示：
//   spell（看词写义）→ 提示写中文释义；listenSpell/cloze（听写/填空拼写）→ 首字母+长度提示；
//   sentenceCloze（例句挖空）→ 无提示（避免泄露答案）。
const spellPlaceholder = computed(() => {
  if (mode.value === 'spell') return t('views.wordReview.typeMeaning');
  if (['listenSpell', 'cloze'].includes(mode.value) && settings.value?.spellHint) {
    const c = current.value;
    return c ? c.word[0] + '…(' + c.word.length + ')' : '';
  }
  return '';
});
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
    <div v-else-if="phase !== 'done' && phase !== 'spellFinish'" class="wr-stage">
      <div class="wr-progress">
        <span class="wr-count">{{ idx + 1 }}/{{ queue.length }}</span>
        <div class="wr-bar"><div class="wr-bar-fill" :style="{ width: progressPct + '%' }"></div></div>
        <span class="wr-left">{{ t('views.wordReview.remainingLabel') }} {{ remaining }} · {{ t('views.wordReview.countLabel', undefined, { total: queue.length }) }}</span>
      </div>

      <div class="card-flip" :class="{ revealed }">
        <!-- 题干 -->
        <div class="q-main">
          <div v-if="['listenChoice','listenSpell'].includes(mode)" class="q-listen">
            <button class="q-spk" @click="speak(current.word, { lang: accentLang() })">🔊 {{ t('views.wordReview.replay') }}</button>
          </div>

          <!-- 不背式 / 闪卡：显示英文词 + 音标（图3：看词 → 音标 → 揭释义） -->
          <div v-if="['adaptive','flashcard','choice','spell','readAloud','quiz'].includes(mode)" class="q-word">
            <div class="q-word-text">{{ current.word }}</div>
            <div v-if="current.phonetic" class="q-phon">
              /{{ current.phonetic }}/
              <button class="q-spk2" @click="speak(current.word, { lang: accentLang() })">🔊</button>
            </div>
            <button v-else class="q-spk2" @click="speak(current.word, { lang: accentLang() })">🔊</button>
          </div>

          <!-- 反向 / 英英 / 词组：显示释义或提示（空值兜底） -->
          <div v-if="mode === 'reverseChoice'" class="q-prompt">{{ current.meaning || current.word || t('views.wordReview.noMeaningHint', '（该单词暂无释义）') }}</div>
          <div v-if="mode === 'englishEnglish'" class="q-prompt">{{ current.defs?.length ? current.defs.map(d => d.meaning).join('; ') : (current.meaning || current.word || t('views.wordReview.noMeaningHint', '（该单词暂无释义）')) }}</div>
          <div v-if="mode === 'collocations'" class="q-prompt">{{ current.meaning || current.word || t('views.wordReview.noMeaningHint', '（该单词暂无释义）') }}</div>

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
            <input v-model="input" :placeholder="spellPlaceholder" @keyup.enter="submitText" />
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
          <!-- adaptive/flashcard 已在 q-word 显示英文词，此处只显示中文释义，避免英文词重复出现 -->
          <div v-if="revealed || (mode==='readAloud' && result)" class="meaning-show">
            <div v-if="!['adaptive','flashcard','choice','spell','readAloud','quiz'].includes(mode)" class="ms-word">{{ current.word }} <span v-if="current.phonetic" class="ms-phon">/{{ current.phonetic }}/</span></div>
            <div class="ms-mean">{{ current.meaning || t('views.wordReview.noMeaningHint', '（该单词暂无释义）') }}</div>
            <div v-if="current.example" class="ms-ex">{{ current.example }} <span class="ms-ext">· {{ current.exampleTrans }}</span></div>
          </div>

          <!-- 判分后：不背式/闪卡 自评（必须先揭释义再自评，否则用户看到英文词就直接点"记住了"跳过检索） -->
          <!-- readAloud 无揭释义步骤，自评按钮直接显示 -->
          <div v-if="(mode==='adaptive' || mode==='flashcard') && revealed && !result || mode==='readAloud' && !result" class="rate-row">
            <button class="rate rate-good" @click="selfRate(2)">{{ t('views.wordReview.rateGood') }}</button>
            <button class="rate rate-hard" @click="selfRate(1)">{{ t('views.wordReview.rateHard') }}</button>
            <button class="rate rate-again" @click="selfRate(0)">{{ t('views.wordReview.rateAgain') }}</button>
          </div>

          <!-- 结果反馈 -->
          <div v-if="result" class="grade-fb" :class="result.correct ? 'ok' : 'no'">
            <template v-if="result.noTarget">
              ⚠️ {{ t('views.wordReview.noTargetHint', '此单词缺少释义/拼写，无法判分，请跳过') }}
            </template>
            <template v-else>
              {{ result.correct ? '✓ ' + t('views.wordReview.correctToast') : '✗ ' + t('views.wordReview.wrongToast') }}
              <span v-if="!result.correct" class="gf-ans">{{ t('views.wordReview.correctAnswer') }}：{{ ['reverseChoice','englishEnglish','collocations','listenSpell','cloze','sentenceCloze'].includes(mode) ? current.word : current.meaning }}</span>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 拼写收尾（图5）：继续拼写加强记忆 -->
    <div v-else-if="phase === 'spellFinish'" class="wr-done wr-spellfinish">
      <div class="done-emoji">✍️</div>
      <h2>{{ t('views.wordReview.spellFinishTitle') }}</h2>
      <p class="sf-filtered">{{ t('views.wordReview.spellFilteredHint') }}</p>
      <div class="sf-actions">
        <button class="sf-btn" @click="restartSpell('all')">
          <b>{{ t('views.wordReview.spellAll') }}</b>
          <span>{{ t('views.wordReview.spellAllCount', undefined, { n: queue.filter(c => !c.familiar).length }) }}</span>
        </button>
        <button class="sf-btn" :disabled="!wrongCards.filter(c => !c.familiar).length" @click="restartSpell('wrong')">
          <b>{{ t('views.wordReview.spellWrong') }}</b>
          <span>{{ t('views.wordReview.spellWrongCount', undefined, { n: wrongCards.filter(c => !c.familiar).length }) }}</span>
        </button>
        <button class="sf-btn sf-skip" @click="showSummary">
          <b>{{ t('views.wordReview.spellSkip') }}</b>
        </button>
      </div>
    </div>

    <!-- 小结（图6）：每词下次复习时间 + 今日已复习 X 词 · 还剩 Y 词 -->
    <div v-else class="wr-done wr-summary">
      <div class="done-emoji">🎉</div>
      <h2>{{ t('views.wordReview.sessionDone') }}</h2>
      <p>{{ t('views.wordReview.sessionDoneHint', undefined, { n: sessionCount }) }}</p>

      <div class="sum-list" v-if="sessionLog.length">
        <div v-for="(lg, i) in sessionLog" :key="i" class="sum-row">
          <span class="sum-word">{{ lg.word }}</span>
          <span class="sum-st" :class="nextReviewText(lg).cls">{{ nextReviewText(lg).text }}</span>
        </div>
      </div>

      <div class="sum-stats" v-if="doneStats">
        {{ t('views.wordReview.todayReviewed', undefined, { n: doneStats.reviewedToday }) }}
        · {{ t('views.wordReview.todayRemaining', undefined, { n: doneStats.remaining }) }}
      </div>

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
.wr-count { font-size: 12px; font-weight: 700; color: var(--accent); white-space: nowrap; font-variant-numeric: tabular-nums; }
.wr-bar { flex: 1; height: 6px; background: var(--line); border-radius: 4px; overflow: hidden; }
.wr-bar-fill { height: 100%; background: var(--accent); transition: width .3s; }
.wr-left { font-size: 11px; color: var(--ink-2); white-space: nowrap; }

.card-flip { background: var(--panel); border: 1px solid var(--line); border-radius: 20px; padding: 22px 18px; min-height: 320px; display: flex; flex-direction: column; }
.q-main { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; }
.q-word { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.q-word-text { font-size: 34px; font-weight: 700; color: var(--ink); }
.q-phon { font-size: 15px; color: var(--ink-2); display: flex; align-items: center; gap: 8px; }
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
