<script setup>
// 新手指引：分步介绍系统核心功能，可跳过
import { ref } from 'vue';

const emit = defineEmits(['done']);

const steps = [
  { title: '欢迎来到 SxyBrick', text: '一款本地优先的记忆卡片 + AI Agent 学习系统。数据存在你自己的设备里，不经过服务器，隐私无忧。' },
  { title: '建卡片', text: '在「我的卡片」新建：正面写问题、背面写答案。支持正反面、填空（{{答案}}）、选择三种题型。支持图片插入与自动 OCR 识别。' },
  { title: '背诵复习', text: '「背诵」页按 FSRS 记忆曲线自动安排到期卡片，自评「没记住/还模糊/记住了」后自动推算下次复习时间。支持考前优先排序，自适应节奏微调。' },
  { title: '英语专项', text: '「单词」页内置 13 种复习模式（看词选义/看义选词/拼写/听力/词根搭配/英英互译等），复用 FSRS 调度算法，支持 AI 生成学习材料、批量导入与智能拆解。' },
  { title: '每日计划与任务', text: '「每日计划」拆解学习目标为可执行任务，自动关联到期卡片与复习清单，支持番茄钟专注计时与进度可视化。' },
  { title: 'AI 学习助手', text: '「AI助手」能结合你的真实数据答疑、智能组卡、费曼学习法、生成周报、诊断卡片薄弱点。' },
  { title: 'Agent 工作台', text: '「Agent工作台」内置 10 个专业 Agent（答疑/分析/组卡/出题/计划/口诀/错题/图谱/智能复习等），支持自动路由、多步工具编排与轨迹可视化。' },
  { title: '学习工具箱', text: '费曼学习法（以教代学）、错题集、番茄钟、四象限备忘录、模考大赛，帮你科学安排复习节奏。' },
  { title: '图谱·计划·文档', text: '知识图谱可视化知识点关联；学习计划拆解目标；AI文档沉淀总结笔记。三者都可保存并跨设备同步。' },
  { title: '跨模块智能复习', text: '系统会把「薄弱卡 + 昨天答错的题 + 到期卡 + 计划 + 费曼反馈」串起来，由智能复习教练给出针对性复习清单。' },
  { title: '个性主题皮肤', text: '「设置」中切换多种主题：国风山水水墨（含山水鸟互动）、猫咪生活报等。主题覆盖全局视觉元素，可随时切回默认。' },
  { title: '多端同步', text: '「同步」页提供两种本地同步：① 导出/导入数据包（含冲突预览与6阶段进度条，坏图不影响主数据）；② 同一局域网手机/平板/电脑一键同步。所有模块数据全覆盖。' },
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