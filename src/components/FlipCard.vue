<script setup>
// 翻转卡：支持三种题型
//   basic  正反面：点击翻转
//   cloze  填空：正面把 {{答案}} 挖空，翻转后显示答案
//   choice 选择：正面点选项作答，翻转后判对错
import { ref, computed, watch } from 'vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import { speak, mdToSpeech } from '../utils/tts.js';
import { WRONG_REASONS } from '../repo.js';

const props = defineProps({ card: { type: Object, required: true } });
const emit = defineEmits(['rate', 'edit']);

const flipped = ref(false);
const picked = ref(null);
const hintReveal = ref(false);
// 本次复习难度评分（0易/1中/2难）：默认取卡片固有难度的映射值
const DIFF_DEFAULT = { basic: 0, applied: 1, challenge: 2 };
const difficulty = ref(DIFF_DEFAULT[props.card.difficulty] ?? (Number.isFinite(Number(props.card.difficulty)) ? Number(props.card.difficulty) : 1));
const wrongReason = ref(props.card.wrongReason || '');
const customWrong = ref('');
const showCustomWrong = ref(false);
// 默写题型（C7）：输入作答，逐字匹配判定
const writingAnswer = ref('');
const writingChecked = ref(false);
const writingCorrect = ref(false);
watch(() => props.card.id, () => {
  flipped.value = false; picked.value = null; hintReveal.value = false;
  difficulty.value = DIFF_DEFAULT[props.card.difficulty] ?? (Number.isFinite(Number(props.card.difficulty)) ? Number(props.card.difficulty) : 1);
  wrongReason.value = props.card.wrongReason || '';
  customWrong.value = '';
  showCustomWrong.value = false;
  writingAnswer.value = '';
  writingChecked.value = false;
  writingCorrect.value = false;
});

const type = computed(() => {
  const t = props.card.type || 'basic';
  // 难度梯度：basic 卡在 level>=4（巩固期）自动升级为默写模式（自由回忆）
  // 认知科学：再认(level 0-1) → 线索回忆(level 2-3 自动展示首字+字数) → 自由回忆(level 4+ 默写)
  if (t === 'basic' && (props.card.level ?? 0) >= 4) return 'writing';
  return t;
});
const autoWriting = computed(() => (!props.card.type || props.card.type === 'basic') && (props.card.level ?? 0) >= 4);
// 线索回忆层（level 2-3 的 basic 卡）：自动展示"首字+字数"提示，强迫主动提取
// 不暴露完整答案，只给最小线索，降低再认依赖、提升回忆难度
const autoClue = computed(() =>
  (!props.card.type || props.card.type === 'basic') &&
  !autoWriting.value &&
  (props.card.level ?? 0) >= 2 && (props.card.level ?? 0) <= 3,
);
const clueHint = computed(() => {
  if (!autoClue.value) return '';
  // 清洗 markdown/标点后取首字 + 字数
  const back = String(props.card.back || '')
    .replace(/[#*`_\[\]()!~>\-]/g, '')
    .replace(/\s+/g, '')
    .trim();
  if (!back) return '';
  const first = back[0] || '';
  return `首字「${first}」· 共 ${back.length} 字`;
});
const typeText = computed(() => {
  if (autoWriting.value) return '默写（巩固）';
  if (autoClue.value) return '线索回忆';
  return type.value === 'cloze' ? '填空' : type.value === 'choice' ? '选择' : type.value === 'writing' ? '默写' : '正反面';
});
const hintText = computed(() => mdToSpeech(props.card.back).slice(0, 40) || '（无提示）');

// 默写判定：忽略空格/标点/大小写后逐字比对
function normalizeWriting(s) {
  return String(s || '').toLowerCase().replace(/[\s，。、；：,.;:!?！？'"“”‘’()（）\[\]【】]/g, '');
}
function checkWriting() {
  const user = normalizeWriting(writingAnswer.value);
  const want = normalizeWriting(props.card.back);
  writingChecked.value = true;
  writingCorrect.value = !!user && user === want;
  if (writingCorrect.value) {
    doRate(2, false); // 默写全对：直接按「记住了」评判并进入下一张
  } else {
    flipped.value = true; // 展示标准答案，由用户自行评级
  }
}

// 填空：{{答案}} → 挖空下划线
const maskedFront = computed(() =>
  type.value === 'cloze'
    ? String(props.card.front || '').replace(/\{\{([^}]+)\}\}/g, '＿＿＿')
    : props.card.front);

// 填空：翻转后答案加粗显示
const clozeReveal = computed(() =>
  String(props.card.front || '').replace(/\{\{([^}]+)\}\}/g, '**$1**'));

// 选择：解析 back 里的选项（A~D）与答案行
const choiceData = computed(() => {
  if (type.value !== 'choice') return null;
  const options = [];
  let answer = '';
  for (const line of String(props.card.back || '').split('\n')) {
    const m = line.match(/^\s*([A-Da-d])[\.、．)）]\s*(.+)/);
    if (m) options.push({ key: m[1].toUpperCase(), text: m[2].trim() });
    const am = line.match(/答案\s*[:：]\s*([A-Da-d])/);
    if (am) answer = am[1].toUpperCase();
  }
  return { options, answer };
});

const isCorrect = computed(() => !!picked.value && picked.value === choiceData.value?.answer);

function showBack() { if (!flipped.value) flipped.value = true; }
function showFront() { flipped.value = false; }
function pick(key) { if (picked.value) return; picked.value = key; flipped.value = true; }
function doRate(rating, guessed = false) {
  emit('rate', props.card, rating, guessed, { difficulty: difficulty.value, wrongReason: wrongReason.value });
}
function setDifficulty(d) { difficulty.value = d; }
function setWrongReason(r) {
  if (r === '__custom__') { showCustomWrong.value = !showCustomWrong.value; return; }
  wrongReason.value = wrongReason.value === r ? '' : r;
}
function applyCustomWrong() {
  const v = customWrong.value.trim();
  if (v) wrongReason.value = v;
  customWrong.value = '';
  showCustomWrong.value = false;
}

// 暴露给父级（键盘快捷键：空格翻面 / 1·2·3 评级）
defineExpose({ flipped, showBack, doRate });
</script>

<template>
  <div class="flip-scene">
    <div class="flip-inner" :class="{ flipped }">
      <!-- 正面 -->
      <div class="flip-face flip-front card-item" @click="type !== 'choice' && showBack()">
        <div class="tags">
          <span class="tag-pill subj">{{ typeText }}</span>
          <span v-if="card.subject" class="tag-pill subj">{{ card.subject }}</span>
          <span v-for="t in card.tags" :key="t" class="tag-pill">{{ t }}</span>
        </div>

        <template v-if="type === 'choice'">
          <MarkdownRenderer :content="card.front" />
          <div class="options">
            <button v-for="o in choiceData.options" :key="o.key" class="opt" @click.stop="pick(o.key)">
              <b>{{ o.key }}.</b> <span>{{ o.text }}</span>
            </button>
          </div>
          <button class="btn small" @click.stop="speak(card.front)" style="margin-top:10px">朗读题干</button>
          <div class="hint" style="margin-top:10px">点击一个选项作答</div>
        </template>

        <template v-else>
          <MarkdownRenderer :content="maskedFront" />
          <template v-if="type === 'writing'">
            <div v-if="autoWriting" class="hint" style="margin-top:4px;color:var(--green)">巩固期 · 默写模式（自由回忆，检验真实掌握度）</div>
            <div style="display:flex;gap:8px;margin-top:12px" @click.stop>
              <input v-model="writingAnswer" class="input" style="flex:1" placeholder="默写你的答案…" @keydown.enter="checkWriting" />
              <button class="btn small primary" @click="checkWriting">提交</button>
            </div>
            <div v-if="writingChecked && !writingCorrect" class="hint" style="color:var(--red);margin-top:8px">与标准答案不完全一致，翻看答案后自评</div>
          </template>
          <template v-else>
            <div v-if="autoClue && clueHint" class="hint" style="margin-top:8px;color:var(--blue)">🧠 线索回忆 · {{ clueHint }}（先主动提取，再翻面对照）</div>
            <div style="display:flex;gap:8px;margin-top:12px;align-items:center" @click.stop>
              <button class="btn small" @click="speak(maskedFront)">朗读</button>
              <button class="btn small" @click="hintReveal = !hintReveal">{{ hintReveal ? '收起提示' : '看提示' }}</button>
            </div>
            <div v-if="hintReveal" class="hint" style="margin-top:8px">提示：{{ hintText }}</div>
            <div v-else-if="!autoClue" class="hint" style="margin-top:10px">点击卡片任意区域翻看答案</div>
          </template>
        </template>
      </div>

      <!-- 背面 -->
      <div class="flip-face flip-back card-item">
        <div class="back-top">
          <button class="btn small" @click="showFront">看回问题</button>
          <button class="btn small" @click="speak(card.back)">朗读答案</button>
          <button class="btn small" @click.stop="emit('edit', card)">编辑这张卡</button>
        </div>

        <template v-if="type === 'choice'">
          <MarkdownRenderer :content="card.front" />
          <div class="options">
            <div v-for="o in choiceData.options" :key="o.key" class="opt"
                 :class="{ correct: o.key === choiceData.answer, wrong: picked === o.key && o.key !== choiceData.answer }">
              <b>{{ o.key }}.</b> <span>{{ o.text }}</span>
              <span v-if="o.key === choiceData.answer" class="mark">✓</span>
            </div>
          </div>
          <div v-if="isCorrect" class="hint" style="color:var(--green);margin-top:8px">答对了</div>
          <div v-else class="hint" style="color:var(--red);margin-top:8px">正确答案是 {{ choiceData.answer }}</div>
        </template>

        <template v-else-if="type === 'cloze'">
          <MarkdownRenderer :content="clozeReveal" />
          <div v-if="card.back" class="hint" style="margin-top:10px;border-top:1px dashed var(--line);padding-top:10px">{{ card.back }}</div>
        </template>

        <template v-else>
          <MarkdownRenderer :content="card.back" />
        </template>

        <div v-if="card.mnemonic" class="mnemonic">助记：{{ card.mnemonic }}</div>
        <div v-if="type === 'writing' && writingChecked && !writingCorrect" class="hint" style="margin-top:8px;color:var(--amber)">你的作答：「{{ writingAnswer }}」与标准答案有差异，请对照后自评</div>

        <div class="meta-row" @click.stop>
          <div class="meta-group">
            <span class="meta-label">难度</span>
            <button v-for="d in [{v:0,t:'易'},{v:1,t:'中'},{v:2,t:'难'}]" :key="d.v" class="chip mini" :class="{ on: difficulty === d.v }" @click="setDifficulty(d.v)">{{ d.t }}</button>
          </div>
          <div class="meta-group">
            <span class="meta-label">错因</span>
            <button v-for="r in WRONG_REASONS" :key="r" class="chip mini" :class="{ on: wrongReason === r }" @click="setWrongReason(r)">{{ r }}</button>
            <button class="chip mini" :class="{ on: showCustomWrong }" @click="setWrongReason('__custom__')">自定义</button>
            <template v-if="showCustomWrong">
              <input v-model="customWrong" class="input" style="width:130px" placeholder="自定义错因（20字内）" maxlength="20" @keydown.enter="applyCustomWrong" />
              <button class="chip mini" @click="applyCustomWrong">确定</button>
            </template>
          </div>
        </div>

        <div class="rate-row" @click.stop>
          <button class="btn rate bad" @click="doRate(0)">没记住</button>
          <button class="btn rate mid" @click="doRate(1)">还模糊</button>
          <button class="btn rate guess" @click="doRate(2, true)">蒙对</button>
          <button class="btn rate good" @click="doRate(2)">记住了</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.back-top { display: flex; gap: 8px; margin-bottom: 10px; }
.options { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.opt {
  text-align: left; border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px;
  background: var(--panel); cursor: pointer; display: flex; gap: 8px; align-items: flex-start;
  font: inherit; color: var(--ink); width: 100%;
}
.opt:hover { border-color: var(--blue); }
.opt.correct { border-color: var(--green); background: rgba(22, 163, 74, .08); cursor: default; }
.opt.wrong { border-color: var(--red); background: rgba(220, 38, 38, .08); }
.mark { color: var(--green); font-weight: 700; }
.rate-row { display: flex; gap: 10px; justify-content: flex-end; margin-top: 14px; }
.rate { border-radius: 8px; font-weight: 600; }
.rate.bad { color: var(--red); border-color: #fca5a5; }
.rate.mid { color: var(--amber); border-color: #fcd34d; }
.rate.good { color: var(--green); border-color: #86efac; }
.rate.guess { color: var(--blue); border-color: #93c5fd; }
.mnemonic { margin-top: 12px; padding: 8px 12px; background: var(--code-bg); border-radius: 8px; font-size: 13px; color: var(--ink-2); }
/* 3D 翻转动效：正反面 grid 叠放，容器高度 = max(正面, 背面)，背面内容长时不溢出/不遮挡 */
.flip-scene { perspective: 1400px; }
.flip-inner { position: relative; transform-style: preserve-3d; transition: transform .55s cubic-bezier(.2, .7, .3, 1); display: grid; }
.flip-inner.flipped { transform: rotateY(180deg); }
.flip-face { backface-visibility: hidden; -webkit-backface-visibility: hidden; grid-area: 1 / 1; min-width: 0; }
.flip-back { grid-area: 1 / 1; transform: rotateY(180deg); backface-visibility: hidden; -webkit-backface-visibility: hidden; }
.meta-row { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--line); }
.meta-group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.meta-label { font-size: 12px; color: var(--ink-2); }
.chip.mini { font-size: 12px; padding: 2px 10px; }

/* 移动端/平板：收紧卡片内边距、图片限高，防止长图+标签+自评按钮底部被遮挡 */
@media (max-width: 720px) {
  .flip-face.card-item { padding: 14px 14px; }
  .flip-face :deep(img), .flip-face img { max-height: 40vh; width: auto; }
  .rate-row { flex-wrap: wrap; justify-content: stretch; gap: 8px; }
  .rate-row .btn { flex: 1 1 44%; }
  .meta-row { gap: 8px; }
  .back-top { flex-wrap: wrap; }
}
</style>