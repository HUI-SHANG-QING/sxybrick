<script setup>
// 英语背诵页：13 种复习模式，复用 FSRS 调度。
// 每卡可随时标记熟词 / 加入词组 / 写批注；支持 TTS 朗读。
import { ref, computed, onMounted } from 'vue';
import { t } from '../i18n/index.js';
import { toast } from '../utils/toast.js';
import { confirmDialog } from '../utils/confirm.js';
import { speak, speechSupported } from '../utils/speak.js';
import {
  dueWordCards, listWordCards, reviewWord, markFamiliar, setWordNote,
  listWordGroups, createWordGroup, setWordGroups, wordGroupsOfCard,
} from '../word-repo.js';

const canSpeak = speechSupported();

// 模式元数据：13 种（≥10）
const MODES = [
  { id: 'choice', type: 'choiceMeaning', hint: 'hintChoice' },
  { id: 'spell', type: 'textMeaning', hint: 'hintSpell' },
  { id: 'listenChoice', type: 'listenChoiceMeaning', hint: 'hintListenChoice' },
  { id: 'listenSpell', type: 'textWordListen', hint: 'hintListenSpell' },
  { id: 'reverseChoice', type: 'choiceWord', hint: 'hintReverseChoice' },
  { id: 'cloze', type: 'textCloze', hint: 'hintCloze' },
  { id: 'sentenceCloze', type: 'textSentence', hint: 'hintSentenceCloze' },
  { id: 'sentenceChoice', type: 'choiceSentence', hint: 'hintEnglishEnglish' },
  { id: 'flashcard', type: 'flashcard', hint: 'hintFlashcard' },
  { id: 'ee', type: 'choiceWord', hint: 'hintEnglishEnglish' },
  { id: 'collocations', type: 'choiceWord', hint: 'hintCollocations' },
  { id: 'readAloud', type: 'readAloud', hint: 'hintReadAloud' },
  { id: 'quiz', type: 'quiz', hint: 'hintQuiz' },
];

const SCOPES = [
  { value: 'all', key: 'scopeAll' },
  { value: 'due', key: 'scopeDue' },
  { value: 'word', key: 'scopeWord' },
  { value: 'phrase', key: 'scopePhrase' },
  { value: 'sentence', key: 'scopeSentence' },
  { value: 'group', key: 'scopeGroup' },
];

const scope = ref('all');
const groupId = ref('');
const mode = ref('choice');
const groups = ref([]);

// 会话
const started = ref(false);
const queue = ref([]);
const pool = ref([]); // 干扰项池
const idx = ref(0);
const reviewedCount = ref(0);
const done = ref(false);

// 当前卡渲染态
const phase = ref('prompt'); // prompt | result
const selected = ref('');     // choice 选中
const inputText = ref('');    // text 输入
const revealed = ref(false);  // flashcard / readAloud
const result = ref(null);     // 'correct' | 'wrong' | null
const current = computed(() => queue.value[idx.value] || null);

const modeMeta = computed(() => MODES.find(m => m.id === mode.value) || MODES[0]);

// 当前卡正确答案（按模式决定取 word 还是 meaning）
const answerKey = computed(() => {
  const c = current.value; if (!c) return '';
  const ty = modeMeta.value.type;
  if (ty === 'choiceMeaning' || ty === 'listenChoiceMeaning') return c.meaning;
  if (ty === 'choiceSentence') return c.word;
  if (ty === 'choiceWord') return c.word;
  if (ty === 'quiz') return promptText.value === c.word ? c.meaning : c.word;
  if (ty === 'textMeaning') return c.meaning;
  return c.word; // textWordListen / textCloze / textSentence
});

// 干扰项 + 选项
const options = ref([]);
const promptText = ref('');
const maskText = ref(''); // cloze / sentence 遮罩

function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s_/.,!?;:'"()]/g, '');
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pickOptions(correct, side) {
  const others = pool.value.filter(c => c.id !== current.value?.id && (side === 'meaning' ? c.meaning : c.word) && (side === 'meaning' ? c.meaning : c.word) !== (side === 'meaning' ? correct : correct));
  const distract = shuffle(others).slice(0, 3).map(c => side === 'meaning' ? c.meaning : c.word);
  const set = new Set(distract);
  // 池不足时补静态兜底
  const fallback = side === 'meaning'
    ? ['记住', '理解', '重要的', '常见的']
    : ['example', 'important', 'because', 'however'];
  let i = 0;
  while (set.size < 3 && i < fallback.length) { set.add(fallback[i]); i++; }
  return shuffle([correct, ...set]);
}
function maskWord(w) {
  const chars = w.split('');
  if (chars.length <= 2) return w;
  const n = Math.max(1, Math.round(chars.length * 0.4));
  const positions = shuffle(chars.map((_, i) => i)).slice(0, n);
  return chars.map((c, i) => positions.includes(i) ? '_' : c).join('');
}

function buildCurrent() {
  const c = current.value;
  if (!c) return;
  phase.value = 'prompt';
  selected.value = '';
  inputText.value = '';
  revealed.value = false;
  result.value = null;
  options.value = [];
  promptText.value = '';
  maskText.value = '';
  const ty = modeMeta.value.type;
  if (ty === 'choiceMeaning') {
    promptText.value = c.word;
    options.value = pickOptions(c.meaning, 'meaning');
  } else if (ty === 'choiceWord') {
    promptText.value = c.meaning;
    options.value = pickOptions(c.word, 'word');
  } else if (ty === 'listenChoiceMeaning') {
    promptText.value = c.word;
    options.value = pickOptions(c.meaning, 'meaning');
    speak(c.word);
  } else if (ty === 'textMeaning') {
    promptText.value = c.word;
  } else if (ty === 'textWordListen') {
    promptText.value = c.word;
    speak(c.word);
  } else if (ty === 'textCloze') {
    promptText.value = c.word;
    maskText.value = maskWord(c.word);
  } else if (ty === 'textSentence' || ty === 'choiceSentence') {
    const ex = c.example || c.word;
    maskText.value = ex.replace(new RegExp(norm(c.word), 'i'), '_____');
    if (ty === 'choiceSentence') options.value = pickOptions(c.word, 'word');
  } else if (ty === 'flashcard') {
    promptText.value = c.word;
  } else if (ty === 'readAloud') {
    promptText.value = c.word;
    speak(c.word);
  } else if (ty === 'quiz') {
    const showWord = Math.random() < 0.5;
    if (showWord) { promptText.value = c.word; options.value = pickOptions(c.meaning, 'meaning'); }
    else { promptText.value = c.meaning; options.value = pickOptions(c.word, 'word'); }
  }
}

async function start() {
  const filter = {};
  if (scope.value === 'word') filter.kind = 'word';
  else if (scope.value === 'phrase') filter.kind = 'phrase';
  else if (scope.value === 'sentence') filter.kind = 'sentence';
  else if (scope.value === 'group') filter.groupId = groupId.value;
  const list = await dueWordCards(filter);
  queue.value = list;
  pool.value = await listWordCards({ schedulableOnly: true });
  if (!pool.value.length) pool.value = list;
  if (!list.length) { started.value = true; done.value = false; return; }
  idx.value = 0;
  reviewedCount.value = 0;
  done.value = false;
  started.value = true;
  buildCurrent();
}

function revealOrSubmit() {
  const c = current.value;
  if (!c) return;
  const ty = modeMeta.value.type;
  if (ty === 'flashcard' || ty === 'readAloud') {
    revealed.value = true;
    return;
  }
  const correct = answerKey.value;
  const isChoice = ty.startsWith('choice') || ty === 'listenChoiceMeaning' || ty === 'choiceSentence' || ty === 'quiz';
  const val = isChoice ? selected.value : inputText.value;
  result.value = val && norm(val) === norm(correct) ? 'correct' : 'wrong';
  phase.value = 'result';
  if (result.value === 'correct') toast(t('views.wordReview.correctToast'), 'success', 1200);
  else toast(t('views.wordReview.wrongToast'), 'error', 1200);
}
function textCorrect(input, answer) {
  const a = norm(input), b = norm(answer);
  if (!a) return false;
  return a === b || a.includes(b) || b.includes(a);
}

async function rate(rating) {
  const c = current.value;
  if (!c) return;
  try { await reviewWord(c.id, rating); } catch (e) { toast(e.message || 'error', 'error'); }
  reviewedCount.value++;
  next();
}
function next() {
  if (idx.value + 1 >= queue.value.length) { done.value = true; return; }
  idx.value++;
  buildCurrent();
}
function again() { start(); }

// 每卡动作
async function toggleFamiliar() {
  const c = current.value; if (!c) return;
  await markFamiliar(c.id, c.familiar ? 0 : 1);
  toast(c.familiar ? t('views.wordBook.unmarkFamiliarToast') : t('views.wordBook.markFamiliarToast'), 'success');
}
const groupOpen = ref(false), noteOpen = ref(false), groupList = ref([]), groupChecks = ref({}), groupOwned = ref([]), newGroupName = ref(''), noteCard = ref(null), noteText = ref('');
async function openGroup() {
  const c = current.value; if (!c) return;
  groupCard.value = c;
  groupList.value = await listWordGroups();
  const owned = await wordGroupsOfCard(c.id);
  groupOwned.value = owned.map(g => g.id);
  groupChecks.value = Object.fromEntries(groupList.value.map(g => [g.id, groupOwned.value.includes(g.id)]));
  newGroupName.value = '';
  groupOpen.value = true;
}
const groupCard = ref(null);
async function saveGroup() {
  const add = [], remove = [];
  for (const g of groupList.value) {
    const checked = !!groupChecks.value[g.id];
    if (checked && !groupOwned.value.includes(g.id)) add.push(g.id);
    if (!checked && groupOwned.value.includes(g.id)) remove.push(g.id);
  }
  if (newGroupName.value.trim()) { const g = await createWordGroup({ name: newGroupName.value.trim() }); add.push(g.id); }
  await setWordGroups([groupCard.value.id], add, remove);
  toast(t('views.wordBook.updated'), 'success');
  groupOpen.value = false;
}
function openNote() {
  const c = current.value; if (!c) return;
  noteCard.value = c; noteText.value = c.note || ''; noteOpen.value = true;
}
async function saveNote() {
  await setWordNote(noteCard.value.id, noteText.value);
  toast(t('views.wordBook.updated'), 'success');
  noteOpen.value = false;
}

onMounted(async () => { groups.value = await listWordGroups(); });
</script>

<template>
  <div class="rv">
    <header class="rv-head">
      <h1>{{ t('views.wordReview.title') }}</h1>
      <p class="sub">{{ t('views.wordReview.subtitle') }}</p>
    </header>

    <!-- 配置 -->
    <section v-if="!started" class="cfg">
      <div class="cfg-row">
        <label>{{ t('views.wordReview.scopeLabel') }}
          <el-select v-model="scope" style="width:100%">
            <el-option v-for="s in SCOPES" :key="s.value" :value="s.value" :label="t('views.wordReview.' + s.key)" />
          </el-select>
        </label>
        <label v-if="scope === 'group'" class="grow">{{ t('views.wordReview.scopeGroup') }}
          <el-select v-model="groupId" style="width:100%">
            <el-option v-for="g in groups" :key="g.id" :value="g.id" :label="g.name" />
          </el-select>
        </label>
      </div>
      <label>{{ t('views.wordReview.modeLabel') }}
        <el-select v-model="mode" style="width:100%">
          <el-option v-for="m in MODES" :key="m.id" :value="m.id" :label="t('views.wordReview.' + m.id)" />
        </el-select>
      </label>
      <p class="hint">{{ t('views.wordReview.' + modeMeta.hint) }}</p>
      <el-button type="primary" size="large" @click="start">{{ t('views.wordReview.startBtn') }}</el-button>
    </section>

    <!-- 无卡 -->
    <section v-else-if="!queue.length" class="empty">
      <p>{{ t('views.wordReview.noCards') }}</p>
      <p class="hint">{{ t('views.wordReview.noCardsHint') }}</p>
      <el-button @click="started = false">{{ t('views.wordBook.backHome') }}</el-button>
    </section>

    <!-- 完成 -->
    <section v-else-if="done" class="empty done">
      <h2>🎉 {{ t('views.wordReview.sessionDone') }}</h2>
      <p>{{ t('views.wordReview.sessionDoneHint', undefined, { n: reviewedCount }) }}</p>
      <div class="acts">
        <el-button type="primary" @click="again">{{ t('views.wordReview.againReview') }}</el-button>
        <el-button @click="started = false">{{ t('views.wordBook.backHome') }}</el-button>
      </div>
    </section>

    <!-- 复习卡片 -->
    <section v-else class="session">
      <div class="prog">
        <span>{{ t('views.wordReview.progress') }}：{{ idx + 1 }} / {{ queue.length }}</span>
        <span class="left">{{ t('views.wordReview.remainingLabel') }}：{{ queue.length - idx - 1 }}</span>
      </div>

      <div class="qcard">
        <div class="qtop">
          <span class="tag">{{ t('views.wordBook.' + ({ word: 'kindWord', phrase: 'kindPhrase', sentence: 'kindSentence', template: 'kindTemplate' }[current.kind] || 'kindWord')) }}</span>
          <div class="qacts">
            <button v-if="canSpeak" class="ico" @click="speak(current.word)">🔊</button>
            <button v-if="canSpeak && modeMeta.type === 'listenChoiceMeaning'" class="ico" @click="speak(current.word)">🔁</button>
            <button class="ico" :title="t('views.wordReview.addFamiliar')" @click="toggleFamiliar">{{ current.familiar ? '⭐' : '☆' }}</button>
            <button class="ico" :title="t('views.wordReview.addGroup')" @click="openGroup">📚</button>
            <button class="ico" :title="t('views.wordReview.note')" @click="openNote">📝</button>
          </div>
        </div>

        <!-- 题干 -->
        <div class="prompt">
          <template v-if="modeMeta.type === 'textCloze'">
            <p class="ptext cloze">{{ maskText }}</p>
            <p class="sub2">{{ promptText }}</p>
          </template>
          <template v-else-if="modeMeta.type === 'textSentence' || modeMeta.type === 'choiceSentence'">
            <p class="ptext ex">{{ maskText }}</p>
          </template>
          <template v-else-if="modeMeta.type === 'flashcard'">
            <p class="ptext big">{{ promptText }}</p>
            <p v-if="revealed" class="answer">{{ current.meaning }}</p>
            <p v-if="current.example" class="ex">{{ current.example }}<template v-if="current.exampleTrans"> —— {{ current.exampleTrans }}</template></p>
            <button class="flip" @click="revealed = true" v-if="!revealed">{{ t('views.wordReview.flipHint') }}</button>
          </template>
          <template v-else-if="modeMeta.type === 'readAloud'">
            <p class="ptext big">{{ promptText }}</p>
            <button class="flip" @click="speak(current.word)">🔊 {{ t('views.wordReview.replay') }}</button>
            <p v-if="revealed" class="answer">{{ current.meaning }}</p>
          </template>
          <template v-else>
            <p class="ptext big">{{ promptText }}</p>
            <p v-if="current.phonetic && (modeMeta.type === 'choiceMeaning' || modeMeta.type === 'textMeaning' || modeMeta.type === 'quiz')" class="sub2">/{{ current.phonetic }}/</p>
          </template>
        </div>

        <!-- 选项（choice 类） -->
        <div v-if="modeMeta.type.startsWith('choice') || modeMeta.type === 'listenChoiceMeaning' || modeMeta.type === 'choiceSentence' || modeMeta.type === 'quiz'" class="opts">
          <button v-for="(o, i) in options" :key="i" class="opt" :class="{ sel: selected === o, ok: phase==='result' && norm(o)===norm(answerKey), bad: phase==='result' && selected===o && norm(o)!==norm(answerKey) }" :disabled="phase==='result'" @click="selected = o">
            <b>{{ t('views.wordReview.option' + ['A','B','C','D'][i]) }}</b> {{ o }}
          </button>
        </div>

        <!-- 文本输入（text 类） -->
        <div v-else-if="modeMeta.type.startsWith('text')" class="textin">
          <el-input v-model="inputText" :placeholder="t('views.wordReview.' + (modeMeta.type === 'textMeaning' ? 'typeMeaning' : modeMeta.type === 'textWordListen' ? 'listenThenType' : 'fillBlank'))" :disabled="phase==='result'" @keyup.enter="phase==='prompt' && revealOrSubmit()" />
        </div>

        <!-- 结果 / 评分 -->
        <div class="footer">
          <template v-if="phase === 'prompt' && !revealed && modeMeta.type !== 'flashcard' && modeMeta.type !== 'readAloud'">
            <el-button type="primary" @click="revealOrSubmit">{{ t('views.wordReview.reveal') }}</el-button>
          </template>
          <template v-else>
            <div class="answerbox" v-if="modeMeta.type !== 'flashcard' && modeMeta.type !== 'readAloud'">
              <span class="lab">{{ t('views.wordReview.correctAnswer') }}：</span>
              <b>{{ answerKey }}</b>
              <template v-if="phase==='result'">
                <span class="lab" style="margin-left:12px">{{ t('views.wordReview.yourAnswer') }}：</span>
                <b :class="result==='correct' ? 'ok' : 'bad'">{{ modeMeta.type.startsWith('choice') || modeMeta.type==='listenChoiceMeaning' || modeMeta.type==='choiceSentence' || modeMeta.type==='quiz' ? selected : inputText }}</b>
              </template>
            </div>
            <div class="rates">
              <button class="rate again" @click="rate(0)">{{ t('views.wordReview.rateAgain') }}</button>
              <button class="rate hard" @click="rate(1)">{{ t('views.wordReview.rateHard') }}</button>
              <button class="rate good" @click="rate(2)">{{ t('views.wordReview.rateGood') }}</button>
            </div>
          </template>
        </div>
      </div>
    </section>

    <!-- 加入词组 -->
    <el-dialog v-model="groupOpen" :title="t('views.wordReview.addGroup')" width="520px">
      <div v-if="groupList.length" class="glist">
        <label v-for="g in groupList" :key="g.id" class="grow"><input type="checkbox" v-model="groupChecks[g.id]" /><span class="dot" :style="{ background: g.color }"></span>{{ g.name }}</label>
      </div>
      <p v-else class="hint">{{ t('views.wordBook.empty') }}</p>
      <label class="newg">{{ t('views.wordBook.createBtn') }}<el-input v-model="newGroupName" :placeholder="t('views.wordBook.namePlaceholder')" /></label>
      <template #footer>
        <el-button @click="groupOpen = false">{{ t('views.wordBook.cancel') }}</el-button>
        <el-button type="primary" @click="saveGroup">{{ t('views.wordBook.save') }}</el-button>
      </template>
    </el-dialog>

    <!-- 批注 -->
    <el-dialog v-model="noteOpen" :title="t('views.wordReview.note')" width="520px">
      <el-input v-model="noteText" type="textarea" :rows="4" :placeholder="t('views.wordBook.formNotePlaceholder')" />
      <template #footer>
        <el-button @click="noteOpen = false">{{ t('views.wordBook.cancel') }}</el-button>
        <el-button type="primary" @click="saveNote">{{ t('views.wordBook.save') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.rv { max-width: 760px; margin: 0 auto; padding: 18px 16px 60px; color: var(--el-text-color-primary); }
.rv-head h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--el-text-color-secondary); font-size: 13px; margin: 0 0 16px; }
.cfg { background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: var(--radius); padding: 18px; display: flex; flex-direction: column; gap: 14px; }
.cfg-row { display: flex; gap: 12px; }
.cfg-row label { flex: 1; display: flex; flex-direction: column; gap: 5px; font-size: 13px; }
.cfg > label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; }
.hint { font-size: 12px; color: var(--el-text-color-secondary); margin: 0; }

.session { display: flex; flex-direction: column; gap: 12px; }
.prog { display: flex; justify-content: space-between; font-size: 13px; color: var(--el-text-color-secondary); }
.qcard { background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: var(--radius); padding: 20px; }
.qtop { display: flex; justify-content: space-between; align-items: center; }
.tag { font-size: 11px; padding: 1px 8px; border-radius: 10px; background: var(--el-color-primary-light-9); color: var(--el-color-primary); }
.qacts { display: flex; gap: 6px; }
.ico { border: 1px solid var(--el-border-color-lighter); background: var(--el-bg-color-page); border-radius: 8px; width: 32px; height: 32px; cursor: pointer; }
.prompt { margin: 18px 0; text-align: center; }
.ptext { font-size: 26px; font-weight: 700; margin: 6px 0; }
.ptext.big { font-size: 30px; }
.ptext.cloze { letter-spacing: 2px; }
.ptext.ex { font-size: 18px; font-style: italic; font-weight: 400; }
.sub2 { color: var(--el-text-color-secondary); font-size: 14px; }
.answer { font-size: 20px; color: var(--accent); margin-top: 8px; }
.ex { color: var(--el-text-color-secondary); }
.flip { margin-top: 12px; border: 1px dashed var(--accent); background: transparent; color: var(--accent); border-radius: 8px; padding: 8px 16px; cursor: pointer; }

.opts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.opt { text-align: left; border: 1px solid var(--el-border-color-light); background: var(--el-bg-color-page); border-radius: 10px; padding: 12px 14px; cursor: pointer; font-size: 15px; color: var(--el-text-color-primary); }
.opt.sel { border-color: var(--accent); background: var(--el-color-primary-light-9); }
.opt.ok { border-color: var(--el-color-success); background: var(--el-color-success-light-9); }
.opt.bad { border-color: var(--el-color-danger); background: var(--el-color-danger-light-9); }

.textin { margin: 6px 0; }
.textin :deep(.el-input__inner) { font-size: 16px; }

.footer { margin-top: 16px; display: flex; flex-direction: column; gap: 12px; align-items: center; }
.answerbox { font-size: 14px; }
.answerbox .lab { color: var(--el-text-color-secondary); }
.answerbox .ok { color: var(--el-color-success); }
.answerbox .bad { color: var(--el-color-danger); }
.rates { display: flex; gap: 10px; }
.rate { border: 0; border-radius: 10px; padding: 10px 18px; cursor: pointer; font-size: 15px; color: #fff; }
.rate.again { background: var(--el-color-danger); }
.rate.hard { background: var(--el-color-warning); }
.rate.good { background: var(--el-color-success); }

.empty { text-align: center; color: var(--el-text-color-secondary); padding: 50px 0; }
.empty.done h2 { color: var(--accent); }
.empty .acts { display: flex; gap: 10px; justify-content: center; margin-top: 14px; }

.glist { display: flex; flex-direction: column; gap: 8px; max-height: 220px; overflow: auto; margin-bottom: 10px; }
.grow { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.newg { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--el-text-color-regular); }
</style>
