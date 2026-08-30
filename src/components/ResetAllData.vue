<script setup>
// 清空全部数据：高危操作，强制多重确认防误触。
// 规则（用户硬性要求）：
//  - 至少确认 3 次
//  - 每次确认间隔必须 > 3 秒
//  - 全程强制等待 ≥ 10 秒（三次确认落定后仍需补足到 10 秒才允许执行）
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { resetAllData } from '../stores/reset.js';
import { toast } from '../utils/toast.js';
import { downloadBackup } from '../sync.js';
import { flushTelemetry } from '../utils/telemetry.js';

const REQUIRED_CONFIRMS = 3;
const GAP_MS = 3000;   // 每次确认间隔 > 3 秒
const TOTAL_MS = 10000; // 全程强制 ≥ 10 秒

const confirmTimes = ref([]);
const busy = ref(false);
const done = ref(false);
const error = ref('');

const now = ref(Date.now());
let timer = null;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 250); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });

const count = computed(() => confirmTimes.value.length);
const lastTime = computed(() => confirmTimes.value[confirmTimes.value.length - 1] || 0);
const firstTime = computed(() => confirmTimes.value[0] || 0);

// 下一次确认按钮可用的时间点（首确认立即可用）
const nextAvailableAt = computed(() => (count.value === 0 ? 0 : lastTime.value + GAP_MS));
const waitRemainMs = computed(() => Math.max(0, nextAvailableAt.value - now.value));
const canConfirm = computed(() => !busy.value && !done.value && waitRemainMs.value === 0 && count.value < REQUIRED_CONFIRMS);

// 三次确认完成后，是否达到全程 10 秒门槛
const totalElapsed = computed(() => (count.value > 0 ? now.value - firstTime.value : 0));
const totalRemainMs = computed(() => Math.max(0, TOTAL_MS - totalElapsed.value));
const allConfirmed = computed(() => count.value >= REQUIRED_CONFIRMS);
const canExecute = computed(() => allConfirmed.value && !busy.value && !done.value && totalRemainMs.value === 0);

function fmtSec(ms) { return (Math.ceil(ms / 1000)).toString(); }

// 三重确认防的是「手滑」，防不了「没意识到该先备份」。
// 门槛已经很重了，但清空是不可逆的 —— 与其事后补救，不如在入口就把备份按钮摆出来：
// 点一下直接下载一份完整数据包（导出失败也不阻断清空流程，只提示）。
const backing = ref(false);
const backedUp = ref(false);
async function doBackupFirst() {
  if (backing.value) return;
  backing.value = true;
  try {
    await flushTelemetry();   // 埋点先落库，否则最近的操作记录不进备份包
    await downloadBackup();
    backedUp.value = true;
    toast('备份已下载（请确认文件已保存到本地）', 'success');
  } catch (e) {
    toast('备份失败：' + (e?.message || e), 'error');
  } finally { backing.value = false; }
}

function doConfirm() {
  if (!canConfirm.value) return;
  confirmTimes.value = [...confirmTimes.value, Date.now()];
  error.value = '';
}

async function execute() {
  if (!canExecute.value) return;
  busy.value = true;
  error.value = '';
  try {
    const r = await resetAllData();
    done.value = true;
    toast(`已清空 ${r.tables} 张表 / ${r.keys} 项本地标记，正在重新加载…`);
    setTimeout(() => { location.reload(); }, 900);
  } catch (e) {
    error.value = '清空失败：' + (e && e.message ? e.message : e);
    busy.value = false;
  }
}

function resetFlow() {
  confirmTimes.value = [];
  done.value = false;
  error.value = '';
}
</script>

<template>
  <div class="reset-box">
    <div class="field-label" style="margin-top:18px;color:var(--danger,#e5484d)">⚠️ 危险操作：清空全部数据</div>
    <div class="hint" style="margin-bottom:8px;line-height:1.6">
      将删除当前账户（{{ /* 单用户，无档案 */ '本机' }}）在浏览器里的<strong>全部本地数据</strong>：
      所有卡片、复习记录、错题、AI 对话、计划、图谱、备忘录、同步记录、埋点等，且<strong>不可恢复</strong>。<br/>
      为防止误触，必须<strong>确认 {{ REQUIRED_CONFIRMS }} 次</strong>，且<strong>每次间隔 &gt; 3 秒</strong>、<strong>全程等待 ≥ 10 秒</strong>。
    </div>

    <!-- 先备份引导：清空不可逆，入口处直接给按钮，而不是只写一句"请先备份" -->
    <div v-if="!done" class="backup-hint">
      <span>
        <template v-if="backedUp">✅ 已导出一份备份，可以放心继续。</template>
        <template v-else>⚠️ 清空后无法找回。建议先导出一份完整备份（JSON 数据包，可原样导入还原）。</template>
      </span>
      <el-button size="small" :loading="backing" @click="doBackupFirst">
        {{ backedUp ? '再导出一份' : '📦 先导出备份' }}
      </el-button>
    </div>

    <div v-if="!done" style="display:flex;flex-direction:column;gap:10px">
      <!-- 确认进度点 -->
      <div class="confirm-dots">
        <span v-for="i in REQUIRED_CONFIRMS" :key="i" class="dot" :class="{ on: count >= i }">{{ i }}</span>
        <span class="dot-label">已确认 {{ count }} / {{ REQUIRED_CONFIRMS }}</span>
      </div>

      <!-- 单次确认按钮 -->
      <el-button
        v-if="count < REQUIRED_CONFIRMS"
        type="danger"
        size="small"
        :disabled="!canConfirm"
        @click="doConfirm"
      >
        {{ count === 0 ? '我确认要清空（第 1 次）' : `我仍然确认清空（第 ${count + 1} 次）` }}
        <template v-if="waitRemainMs > 0">（请等待 {{ fmtSec(waitRemainMs) }} 秒）</template>
      </el-button>

      <!-- 三次确认完成后的最终执行（仍需补足 10 秒） -->
      <template v-else>
        <div class="hint" style="color:var(--danger,#e5484d)">
          三次确认已完成。为保障安全，仍需等待全程满 10 秒
          <template v-if="totalRemainMs > 0">（还差 {{ fmtSec(totalRemainMs) }} 秒）</template>
          <template v-else>（已满足）</template>
          后方可执行。
        </div>
        <el-button type="danger" size="small" :disabled="!canExecute" :loading="busy" @click="execute">
          执行清空全部数据
        </el-button>
      </template>

      <div v-if="error" class="hint" style="color:var(--danger,#e5484d)">{{ error }}</div>
      <el-button v-if="count > 0 && !done" size="small" text @click="resetFlow">取消 / 重新开始</el-button>
    </div>

    <div v-else class="hint" style="color:var(--accent,#1677ff);margin-top:8px">
      ✓ 已全部清空，页面即将重新加载…
    </div>
  </div>
</template>

<style scoped>
.reset-box { border: 1px solid var(--danger, #e5484d); border-radius: 10px; padding: 12px; margin-top: 14px; background: color-mix(in srgb, var(--danger, #e5484d) 6%, transparent); }
.confirm-dots { display: flex; align-items: center; gap: 8px; }
.confirm-dots .dot {
  width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; border: 1px solid var(--line); color: var(--ink-2); background: var(--panel);
}
.confirm-dots .dot.on { background: var(--danger, #e5484d); color: #fff; border-color: var(--danger, #e5484d); }
.confirm-dots .dot-label { font-size: 12px; color: var(--ink-2); margin-left: 4px; }
.backup-hint {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px;
  padding: 8px 12px; border-radius: 8px; font-size: 13px; line-height: 1.6;
  border: 1px dashed var(--line); color: var(--ink-2);
  background: color-mix(in srgb, var(--accent, #1677ff) 6%, transparent);
}
.backup-hint > span { flex: 1; min-width: 220px; }
</style>
