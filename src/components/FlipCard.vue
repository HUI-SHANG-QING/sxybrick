<script setup>
// 翻转卡：支持三种题型
//   basic  正反面：点击翻转
//   cloze  填空：正面把 {{答案}} 挖空，翻转后显示答案
//   choice 选择：正面点选项作答，翻转后判对错
import { ref, computed, watch } from 'vue';
import MarkdownRenderer from './MarkdownRenderer.vue';

const props = defineProps({ card: { type: Object, required: true } });
const emit = defineEmits(['rate', 'edit']);

const flipped = ref(false);
const picked = ref(null);
watch(() => props.card.id, () => { flipped.value = false; picked.value = null; });

const type = computed(() => props.card.type || 'basic');
const typeText = computed(() => type.value === 'cloze' ? '填空' : type.value === 'choice' ? '选择' : '正反面');

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
          <div class="hint" style="margin-top:10px">点击一个选项作答</div>
        </template>

        <template v-else>
          <MarkdownRenderer :content="maskedFront" />
          <div class="hint" style="margin-top:10px">点击卡片任意区域翻看答案</div>
        </template>
      </div>

      <!-- 背面 -->
      <div class="flip-face flip-back card-item">
        <div class="back-top">
          <button class="btn small" @click="showFront">看回问题</button>
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

        <div class="rate-row" @click.stop>
          <button class="btn rate bad" @click="emit('rate', card, 0)">没记住</button>
          <button class="btn rate mid" @click="emit('rate', card, 1)">还模糊</button>
          <button class="btn rate good" @click="emit('rate', card, 2)">记住了</button>
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
.flip-inner .flip-back { pointer-events: none; }
.flip-inner.flipped .flip-front { position: absolute; inset: 0; pointer-events: none; }
.flip-inner.flipped .flip-back { position: relative; pointer-events: auto; }
</style>