<script setup>
// 3D 翻转卡片：正面任意区域点击翻转；背面提供 看回问题 / 编辑 / 三档自评
import { ref, watch } from 'vue';
import MarkdownRenderer from './MarkdownRenderer.vue';

const props = defineProps({ card: { type: Object, required: true } });
const emit = defineEmits(['rate', 'edit', 'flipped']);

const flipped = ref(false);
watch(() => props.card.id, () => { flipped.value = false; });

function showBack() { if (!flipped.value) { flipped.value = true; emit('flipped', true); } }
function showFront() { flipped.value = false; emit('flipped', false); }
</script>

<template>
  <div class="flip-scene">
    <div class="flip-inner" :class="{ flipped }">
      <div class="flip-face flip-front card-item" @click="showBack">
        <div class="tags">
          <span v-if="card.subject" class="tag-pill subj">{{ card.subject }}</span>
          <span v-for="t in card.tags" :key="t" class="tag-pill">{{ t }}</span>
        </div>
        <MarkdownRenderer :content="card.front" />
        <div class="hint" style="margin-top:10px">点击卡片任意区域翻看答案</div>
      </div>

      <div class="flip-face flip-back card-item">
        <div class="back-top">
          <button class="btn small" @click="showFront">看回问题</button>
          <button class="btn small" @click.stop="emit('edit', card)">编辑这张卡</button>
        </div>
        <MarkdownRenderer :content="card.back" />
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
.rate-row { display: flex; gap: 10px; justify-content: flex-end; margin-top: 14px; }
.rate { border-radius: 8px; font-weight: 600; }
.rate.bad { color: var(--red); border-color: #fca5a5; }
.rate.mid { color: var(--amber); border-color: #fcd34d; }
.rate.good { color: var(--green); border-color: #86efac; }
.flip-inner .flip-back { pointer-events: none; }
.flip-inner.flipped .flip-front { position: absolute; inset: 0; pointer-events: none; }
.flip-inner.flipped .flip-back { position: relative; pointer-events: auto; }
</style>