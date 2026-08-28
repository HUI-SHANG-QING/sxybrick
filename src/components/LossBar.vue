<template>
  <transition name="loss-fade">
    <div v-if="loss && loss.hasLoss" :class="['loss-bar', `is-${loss.severity}`]" role="alert">
      <div class="loss-icon">
        <span v-if="loss.severity === 'critical'">🚨</span>
        <span v-else-if="loss.severity === 'warn'">📉</span>
        <span v-else>📚</span>
      </div>
      <div class="loss-text">
        <div class="loss-headline">{{ loss.headline }}</div>
        <div v-if="loss.recommendations.length" class="loss-rec">
          💡 <span v-for="(rec, i) in loss.recommendations" :key="i">{{ rec }}</span>
        </div>
        <div class="loss-meter" v-if="loss.severity !== 'none'">
          <div class="loss-meter-bar" :style="{ width: lossLevelPct + '%' }"></div>
          <span class="loss-meter-label">紧迫度 {{ Math.round(loss.level * 100) }}%</span>
        </div>
      </div>
      <button v-if="dismissible" class="loss-close" @click="dismissed = true" aria-label="关闭">×</button>
    </div>
  </transition>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { computeLoss } from '../utils/loss-math.js';

const props = defineProps({
  stats: { type: Object, default: () => ({}) },
  /** false = 强提醒，重要监督场景不可关 */
  dismissible: { type: Boolean, default: false },
});

const loss = computed(() => computeLoss(props.stats));
const lossLevelPct = computed(() => Math.min(100, Math.round((loss.value?.level || 0) * 100)));
const dismissed = ref(false);

// 显示条件：未关闭 + 真的有损失
const show = computed(() => !dismissed.value && loss.value?.hasLoss);

// 当 stats 变化时（用户开始复习），重新允许显示
watch(() => props.stats, () => { dismissed.value = false; });
</script>

<style scoped>
.loss-bar {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 12px 16px; margin: 0 0 14px;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--panel);
}
.loss-icon { font-size: 22px; line-height: 1; }
.loss-text { flex: 1; min-width: 0; }
.loss-headline { font-weight: 600; font-size: 14px; line-height: 1.5; }
.loss-rec { font-size: 12px; color: var(--ink-2); margin-top: 6px; line-height: 1.6; }
.loss-meter { height: 4px; background: rgba(0,0,0,0.05); border-radius: 4px; margin-top: 8px; position: relative; overflow: hidden; }
.loss-meter-bar { height: 100%; background: currentColor; transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1); }
.loss-meter-label { position: absolute; right: 0; top: -18px; font-size: 11px; color: var(--ink-2); }
.loss-close { background: none; border: 0; font-size: 20px; color: var(--ink-2); cursor: pointer; padding: 0 4px; }

/* Severity 配色 */
.is-info { border-color: #93c5fd; background: #eff6ff; color: #1e40af; }
.is-warn { border-color: #fcd34d; background: #fffbeb; color: #92400e; }
.is-critical { border-color: #f87171; background: #fef2f2; color: #991b1b;
  animation: loss-pulse 2s ease-in-out infinite; }
.is-critical .loss-headline { font-weight: 700; }

@keyframes loss-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(248,113,113,0.5); }
  50% { box-shadow: 0 0 0 4px rgba(248,113,113,0); }
}

.loss-fade-enter-active, .loss-fade-leave-active { transition: opacity 0.3s, transform 0.3s; }
.loss-fade-enter-from, .loss-fade-leave-to { opacity: 0; transform: translateY(-6px); }
</style>
