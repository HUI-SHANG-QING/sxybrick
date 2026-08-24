<script setup>
// 开场动画：约 12 秒，逐行文字 + 语音朗读 + 跳过
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { speak } from '../utils/tts.js';

const emit = defineEmits(['done']);

const lines = [
  '维度之创造者',
  '法则之缔造者',
  '众天之永恒',
  '至尊无上之无极',
  '在存在中不存在，在不存在中存在',
  '跳脱一切而又感受一切',
  '是为全知全能',
];
const cur = ref(0);
let timer = null;
const DURATION = 12000;
const PER = Math.floor(DURATION / lines.length);

function finish() { clearInterval(timer); emit('done'); }

onMounted(() => {
  speak(lines.join('，') + '。');
  timer = setInterval(() => {
    cur.value++;
    if (cur.value >= lines.length) finish();
  }, PER);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="intro">
    <div class="glow glow-a"></div>
    <div class="glow glow-b"></div>
    <button class="skip" @click="finish">跳过</button>

    <div class="core">
      <div class="title">SxyBrick</div>
      <div class="lines">
        <div v-for="(l, i) in lines" :key="i" class="line" :class="{ show: i <= cur }">{{ l }}</div>
      </div>
      <div class="foot" :class="{ show: cur >= lines.length - 1 }">赐予你驾驭知识的力量</div>
    </div>
  </div>
</template>

<style scoped>
.intro { position: fixed; inset: 0; z-index: 1000; background: #05060a; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.glow { position: absolute; border-radius: 50%; filter: blur(80px); opacity: .55; animation: breathe 4s ease-in-out infinite; }
.glow-a { width: 420px; height: 420px; background: #6d5dfc; top: -10%; left: -10%; }
.glow-b { width: 380px; height: 380px; background: #22c1ff; bottom: -12%; right: -8%; animation-delay: 1.5s; }
@keyframes breathe { 0%, 100% { transform: scale(1); opacity: .4; } 50% { transform: scale(1.18); opacity: .7; } }
.skip { position: absolute; top: 20px; right: 22px; z-index: 2; background: rgba(255,255,255,.08); color: #cbd5e1; border: 1px solid rgba(255,255,255,.15); border-radius: 20px; padding: 8px 18px; cursor: pointer; font-size: 14px; }
.skip:hover { background: rgba(255,255,255,.16); color: #fff; }
.core { position: relative; text-align: center; padding: 0 24px; }
.title { font-size: clamp(44px, 8vw, 84px); font-weight: 800; letter-spacing: .06em; background: linear-gradient(120deg, #a78bfa, #22c1ff 60%, #a78bfa); -webkit-background-clip: text; background-clip: text; color: transparent; margin-bottom: 34px; animation: fadeIn 1s ease both; }
.lines { min-height: 200px; display: flex; flex-direction: column; gap: 12px; }
.line { font-size: clamp(17px, 3vw, 22px); letter-spacing: .16em; color: #e9e6ff; opacity: 0; transform: translateY(14px); transition: opacity .6s ease, transform .6s ease; }
.line.show { opacity: 1; transform: translateY(0); }
.foot { margin-top: 30px; font-size: 14px; letter-spacing: .3em; color: #7c86b0; opacity: 0; transition: opacity .8s ease; }
.foot.show { opacity: 1; }
@keyframes fadeIn { from { opacity: 0; transform: scale(.92); } to { opacity: 1; transform: scale(1); } }
</style>