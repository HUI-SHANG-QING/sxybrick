<script setup>
// 卡片图片批量分析面板（round67c）
//
// 为什么需要：单次请求的图片总体积有硬上限（约 24MB），上千张图不可能一次送出。
// 这个面板把「带图的卡片」切成小批逐批送 AI，进度存 IndexedDB，**关页面再回来能接着跑**。
//
// 交互约定与 ImagePolicySetting 一致：改即保存、无「保存」按钮。
// 跑批循环在前台进行（纯前端没有真正的后台线程），但用户随时可暂停/离开：
// 每批结束后都会把状态落盘，因此刷新页面不会丢进度。
import { ref, onMounted, computed } from 'vue';
import { t } from '../i18n/index.js';
import {
  getBatchState, scanCandidates, startBatch, runOneBatch, pauseBatch, resumeBatch,
  resetBatchState, flushBatchNote, normalizeBatchSize,
} from '../services/batch-image-analysis.js';

const state = ref(null);
const pendingCount = ref(0);
const skippedCount = ref(0);
const busy = ref(false);      // 正在跑批（跑批循环的锁）
const scanning = ref(false);
const batchSize = ref(5);
const noteId = ref('');
const errorMsg = ref('');

const status = computed(() => state.value?.status || 'idle');
const isRunning = computed(() => status.value === 'running');
const doneCount = computed(() => Object.keys(state.value?.done || {}).length);
const failedCount = computed(() => Object.keys(state.value?.failed || {}).length);
const totalCount = computed(() => state.value?.queue?.length || 0);
const calls = computed(() => state.value?.stats?.calls || 0);
const percent = computed(() => (totalCount.value ? Math.round((doneCount.value / totalCount.value) * 100) : 0));

function applyState(s) {
  if (!s) return;
  state.value = s;
  batchSize.value = normalizeBatchSize(s.batchSize);
  if (s.noteId) noteId.value = s.noteId;
  if (s.error) errorMsg.value = s.error;
}

async function refresh() {
  applyState(await getBatchState());
}

async function doScan() {
  scanning.value = true;
  errorMsg.value = '';
  try {
    const r = await scanCandidates();
    pendingCount.value = r.totalWithImg ? r.pending.length : 0;
    skippedCount.value = r.skipped;
  } catch (e) {
    errorMsg.value = String(e?.message || e);
  } finally {
    scanning.value = false;
  }
}

/**
 * 跑批循环：逐批推进直到 done/paused/error。
 * 每批之间让出事件循环，保证 UI 能刷新（否则进度条会「卡死」到全部跑完）。
 */
async function runLoop() {
  if (busy.value) return;
  busy.value = true;
  errorMsg.value = '';
  try {
    for (;;) {
      const r = await runOneBatch({ onProgress: applyState });
      applyState(r.state);
      if (r.state?.status !== 'running') break;
      if (r.processed === 0) break; // 防御：没有推进就退出，避免死循环
      await new Promise((res) => setTimeout(res, 250));
    }
  } catch (e) {
    errorMsg.value = String(e?.message || e);
  } finally {
    busy.value = false;
  }
}

async function doStart() {
  errorMsg.value = '';
  const r = await startBatch({ batchSize: batchSize.value });
  applyState(r.state);
  skippedCount.value = r.skipped;
  if (!r.started) { pendingCount.value = 0; return; }
  pendingCount.value = r.total;
  await runLoop();
}

async function doPause() {
  applyState(await pauseBatch());
}

async function doResume() {
  applyState(await resumeBatch());
  await runLoop();
}

async function doReset() {
  applyState(await resetBatchState());
  pendingCount.value = 0;
  skippedCount.value = 0;
  noteId.value = '';
  errorMsg.value = '';
}

async function doFlush() {
  busy.value = true;
  try {
    const r = await flushBatchNote();
    noteId.value = r.noteId || '';
    await refresh();
  } catch (e) {
    errorMsg.value = String(e?.message || e);
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  await refresh();
  await doScan();
});
</script>

<template>
  <section class="fblock bia">
    <h3>{{ t('views.wordSettings.batchTitle') }}</h3>
    <p class="bia-desc">{{ t('views.wordSettings.batchDesc') }}</p>

    <div class="bia-row">
      <span class="bia-k">{{ t('views.wordSettings.batchBatchSizeLabel') }}</span>
      <input
        class="bia-input" type="number" min="1" max="10" step="1"
        :value="batchSize" :disabled="isRunning || busy"
        @change="batchSize = normalizeBatchSize($event.target.value)"
      />
      <span class="bia-muted">{{ t('views.wordSettings.visionLimitUnit') }}</span>
    </div>

    <div class="bia-buttons">
      <button class="bia-btn" :disabled="scanning || busy || isRunning" @click="doScan">
        {{ scanning ? t('views.wordSettings.batchScanning') : t('views.wordSettings.batchScan') }}
      </button>
      <button v-if="!isRunning" class="bia-btn primary" :disabled="busy" @click="doStart">
        {{ t('views.wordSettings.batchStart') }}
      </button>
      <template v-else>
        <button class="bia-btn" :disabled="busy" @click="doPause">{{ t('views.wordSettings.batchPause') }}</button>
      </template>
      <button
        v-if="status === 'paused'" class="bia-btn primary"
        :disabled="busy" @click="doResume"
      >
        {{ t('views.wordSettings.batchResume') }}
      </button>
      <button class="bia-btn" :disabled="busy || !doneCount" @click="doFlush">
        {{ t('views.wordSettings.batchFlush') }}
      </button>
      <button class="bia-btn" :disabled="busy || isRunning || status === 'idle'" @click="doReset">
        {{ t('views.wordSettings.batchReset') }}
      </button>
    </div>

    <div v-if="totalCount" class="bia-progress">
      <div class="bia-bar"><div class="bia-bar-in" :style="{ width: percent + '%' }" /></div>
      <span class="bia-stat">
        {{ t('views.wordSettings.batchStat', undefined, { done: doneCount, total: totalCount, failed: failedCount, calls }) }}
      </span>
    </div>
    <p v-if="skippedCount" class="bia-muted">{{ t('views.wordSettings.batchSkipped', undefined, { n: skippedCount }) }}</p>
    <p v-if="status === 'done'" class="bia-ok">{{ t('views.wordSettings.batchDone') }}</p>
    <p v-if="failedCount" class="bia-warn">{{ t('views.wordSettings.batchFailedNote', undefined, { n: failedCount }) }}</p>
    <p v-if="errorMsg" class="bia-err">{{ t('views.wordSettings.batchError', undefined, { msg: errorMsg }) }}</p>

    <div v-if="noteId" class="bia-note">
      <router-link class="bia-link" :to="`/notes?open=${noteId}`">
        {{ t('views.wordSettings.batchOpenNote') }}
      </router-link>
    </div>

    <p class="bia-hint">{{ t('views.wordSettings.batchPaidHint') }}</p>
  </section>
</template>

<style scoped>
.bia h3 { font-size: 15px; margin: 0 0 10px; }
.bia-desc { font-size: 12.5px; color: var(--ink-2); line-height: 1.7; margin: 0 0 10px; }
.bia-row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ink-2); }
.bia-k { font-weight: 600; color: var(--ink); }
.bia-input {
  width: 64px; padding: 4px 8px; border: 1px solid var(--line);
  border-radius: 6px; background: var(--panel); color: var(--ink); font-size: 13px;
}
.bia-buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.bia-btn {
  border: 1px solid var(--line); background: var(--panel); color: var(--ink);
  border-radius: 6px; padding: 5px 12px; font-size: 12.5px; cursor: pointer;
}
.bia-btn.primary { border-color: var(--accent); color: var(--accent); }
.bia-btn:disabled { opacity: .45; cursor: default; }
.bia-progress { margin-top: 10px; }
.bia-bar { height: 6px; border-radius: 3px; background: var(--code-bg); overflow: hidden; }
.bia-bar-in { height: 100%; background: var(--accent); transition: width .3s; }
.bia-stat { display: block; margin-top: 6px; font-size: 12px; color: var(--ink-2); }
.bia-muted { font-size: 12px; color: var(--ink-2); margin: 6px 0 0; line-height: 1.6; }
.bia-ok { font-size: 12.5px; color: #7ba87b; margin: 6px 0 0; }
.bia-warn { font-size: 12.5px; color: #d4a853; margin: 6px 0 0; line-height: 1.6; }
.bia-err { font-size: 12.5px; color: #e0735a; margin: 6px 0 0; line-height: 1.6; word-break: break-all; }
.bia-note { margin-top: 8px; }
.bia-link { font-size: 12.5px; color: var(--accent); }
.bia-hint { font-size: 12px; color: var(--ink-2); margin: 10px 0 0; line-height: 1.6; }
</style>
