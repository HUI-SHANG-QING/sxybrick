<template>
  <el-dialog
    v-model="visible"
    :title="title"
    :width="520"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="false"
    :modal="true"
    align-center
  >
    <div class="um-content">
      <div v-if="severity" :class="['um-badge', `is-${severity}`]">
        {{ severity === 'critical' ? '🚨' : severity === 'warn' ? '⚠️' : '📌' }}
        {{ severityLabel }}
      </div>
      <div class="um-headline">{{ headline }}</div>
      <div v-if="body" class="um-body">{{ body }}</div>
      <div v-if="recommendations?.length" class="um-recs">
        <div v-for="(r, i) in recommendations" :key="i" class="um-rec">
          <span class="um-rec-num">{{ i + 1 }}.</span> {{ r }}
        </div>
      </div>
      <div class="um-input" v-if="requireReflection">
        <label>请用一句话写下你今天的承诺（不少于 {{ minReflectionLen }} 字）：</label>
        <textarea
          v-model="reflection"
          rows="3"
          :placeholder="placeholder"
          maxlength="200"
          class="um-textarea"
        />
        <div class="um-counter" :class="{ low: reflection.length < minReflectionLen }">
          {{ reflection.length }} / {{ minReflectionLen }}
        </div>
      </div>
    </div>
    <template #footer>
      <div class="um-footer">
        <div v-if="countdown > 0" class="um-countdown">
          <span class="um-cd-num">{{ countdown }}</span>
          <span class="um-cd-label">秒后可关闭</span>
        </div>
        <el-button
          :disabled="countdown > 0 || (requireReflection && reflection.length < minReflectionLen)"
          :type="severity === 'critical' ? 'danger' : 'primary'"
          @click="onConfirm"
        >
          {{ countdown > 0 ? `等待 ${countdown}s` : '我承诺，继续学' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, watch, onBeforeUnmount, computed } from 'vue';
import { ElMessage } from 'element-plus';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** 数据 - 必须有 headline/recommendations */
  data: { type: Object, default: () => null },
  /** 倒计时秒数（默认 5） */
  countdownSeconds: { type: Number, default: 5 },
  /** 是否强制写承诺（写完才可关闭）；在 critical/warn 默认开启 */
  requireReflection: { type: Boolean, default: false },
  /** 最小承诺字数 */
  minReflectionLen: { type: Number, default: 10 },
  placeholder: { type: String, default: '例如：今晚专注复习 25 分钟，完成卡片 N 张。' },
});
const emit = defineEmits(['update:modelValue', 'confirm']);

const reflection = ref('');
let timer = null;

const visible = ref(props.modelValue);
watch(() => props.modelValue, (v) => {
  visible.value = v;
  if (v) startCountdown();
  else stopCountdown();
});

const countdown = ref(0);
function startCountdown() {
  countdown.value = props.countdownSeconds;
  reflection.value = '';
  stopCountdown();
  timer = setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0) stopCountdown();
  }, 1000);
}
function stopCountdown() { if (timer) { clearInterval(timer); timer = null; } }
onBeforeUnmount(stopCountdown);

const title = computed(() => '学习状态评估 — 不能跳过');
const severity = computed(() => props.data?.severity || 'warn');
const severityLabel = computed(() => {
  if (severity.value === 'critical') return '危机状态';
  if (severity.value === 'warn') return '落后警告';
  return '状态提醒';
});
const headline = computed(() => props.data?.headline || '你需要评估当前学习状态');
const body = computed(() => props.data?.body || '');
const recommendations = computed(() => props.data?.recommendations || []);

function onConfirm() {
  if (countdown.value > 0) return;
  if (props.requireReflection && reflection.value.length < props.minReflectionLen) {
    ElMessage.warning(`至少写 ${props.minReflectionLen} 字`);
    return;
  }
  emit('confirm', { reflection: reflection.value });
  emit('update:modelValue', false);
}
</script>

<style scoped>
.um-content { padding: 0 6px; }
.um-badge { display: inline-block; padding: 4px 12px; border-radius: 14px; font-size: 13px; font-weight: 600; margin-bottom: 14px; }
.um-badge.is-info { background: #eff6ff; color: #1e40af; }
.um-badge.is-warn { background: #fffbeb; color: #92400e; }
.um-badge.is-critical { background: #fef2f2; color: #991b1b; }

.um-headline { font-size: 16px; font-weight: 700; line-height: 1.6; margin-bottom: 12px; color: var(--ink); }
.um-body { font-size: 14px; color: var(--ink-2); line-height: 1.7; margin-bottom: 14px; }
.um-recs { background: var(--panel-2, #f7f7f9); border-radius: 8px; padding: 12px 14px; }
.um-rec { font-size: 13px; line-height: 1.7; color: var(--ink-2); }
.um-rec-num { display: inline-block; min-width: 20px; font-weight: 700; color: var(--ink); }

.um-input { margin-top: 16px; }
.um-input > label { display: block; font-size: 13px; color: var(--ink-2); margin-bottom: 6px; }
.um-textarea { width: 100%; padding: 10px; border: 1px solid var(--line); border-radius: 6px; font-size: 14px; resize: vertical; box-sizing: border-box; }
.um-counter { text-align: right; font-size: 12px; color: var(--ink-2); margin-top: 4px; }
.um-counter.low { color: #f87171; font-weight: 600; }

.um-footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.um-countdown { display: flex; align-items: baseline; gap: 4px; }
.um-cd-num { font-size: 22px; font-weight: 700; color: #f87171; }
.um-cd-label { font-size: 13px; color: var(--ink-2); }

:deep(.el-dialog) { border-radius: 12px; }
</style>
