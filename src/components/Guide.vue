<script setup>
// 新手指引：分步介绍系统核心功能，可跳过
import { ref } from 'vue';

const emit = defineEmits(['done']);

const steps = [
  { title: '欢迎来到 SxyBrick', text: '一款本地优先的记忆卡片系统。数据存在你自己的设备里，不经过任何服务器，隐私无忧。' },
  { title: '建卡片', text: '在「我的卡片」新建：正面写问题、背面写答案。支持正反面、填空（{{答案}}）、选择三种题型。' },
  { title: '背诵复习', text: '「背诵」页按记忆曲线自动安排到期卡片，自评「没记住/还模糊/蒙对/记住了」后自动算好下次时间。' },
  { title: 'AI 学习助手', text: '「AI助手」能结合你的真实数据答疑、智能组卡、费曼学习法、生成周报、诊断卡片。' },
  { title: '多端同步', text: '「同步」页可一键导出数据包，或连电脑局域网一键同步，实现电脑/平板/手机三端一致。' },
];
const idx = ref(0);

function next() {
  if (idx.value < steps.length - 1) idx.value++;
  else emit('done');
}
function skip() { emit('done'); }
</script>

<template>
  <div class="guide">
    <div class="card">
      <div class="dots">
        <span v-for="(s, i) in steps" :key="i" class="dot" :class="{ on: i === idx }"></span>
      </div>
      <div class="step-num">{{ idx + 1 }} / {{ steps.length }}</div>
      <h2 class="g-title">{{ steps[idx].title }}</h2>
      <p class="g-text">{{ steps[idx].text }}</p>
      <div class="btns">
        <button class="btn" @click="skip">跳过</button>
        <button class="btn primary" @click="next">{{ idx === steps.length - 1 ? '开始使用' : '下一步' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.guide { position: fixed; inset: 0; z-index: 1000; background: rgba(5, 6, 10, .72); backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; padding: 20px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; max-width: 420px; width: 100%; padding: 28px 26px; text-align: center; box-shadow: 0 24px 60px rgba(0,0,0,.4); }
.dots { display: flex; justify-content: center; gap: 8px; margin-bottom: 18px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line-strong); transition: all .3s; }
.dot.on { background: var(--accent); width: 22px; border-radius: 4px; }
.step-num { font-size: 12px; color: var(--ink-2); margin-bottom: 8px; }
.g-title { margin: 0 0 14px; font-size: 22px; }
.g-text { color: var(--ink-2); line-height: 1.8; font-size: 15px; margin: 0 0 26px; }
.btns { display: flex; gap: 12px; justify-content: center; }
</style>