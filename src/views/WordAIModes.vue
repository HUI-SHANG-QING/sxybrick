<script setup>
// 英语 AI 智能模块（v31）
// 复用 AI 助手通道（services/word-llm.js callLlmJson：agent 优先 → 用户 Key 兜底），
// 提供两个能力：
//   1. 智能出题：为一词按 13 种背诵模式的判分口径自动生成题目/答案，不合规丢弃并展示原因；
//   2. 释义补齐：为大纲词表中缺失的中文释义批量补齐（分批落库、可中断）。
// 生成物落在 wordCards.modeQuestions（受 WORD_EXT_FIELDS 并集保护，跨设备同步不丢）。
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { t } from '../i18n/index.js';
import { toast } from '../utils/toast.js';
import { listWordCards, getWordSettings, updateWordCard } from '../word-repo.js';
import {
  REVIEW_MODES, generateModeQuestions, applyModeQuestions, batchGenerateMeanings, hasLlmChannel,
} from '../services/word-ai-modes.js';
import { syncWithSyllabus } from '../services/word-meaning.js';
import { getAIConfig, hasAIKey } from '../ai.js';
import { chat as llmChat } from '../agent/llm.js';
import WordQuickBar from '../components/WordQuickBar.vue';

const router = useRouter();
const settings = ref(null);
const tab = ref('modes'); // modes | meanings

// ---- AI 通道：优先全局 AI 助手（复用现有 AI 助手的 API）→ 英语模块 LLM Key 兜底 ----
// agentCtx 只做「低层聊天」桥接：把全局 AI 配置转成 callLlmJson 期望的 runAgent 形态。
// 走 agent 分支时用量由 agent/llm.js 的 chat 自行记账（source=english-modes），不重复记录。
function buildAgentCtx() {
  try {
    if (hasAIKey()) {
      return {
        runAgent: async ({ prompt }) => llmChat(
          [{ role: 'user', content: prompt }],
          getAIConfig(),
          { source: 'english-modes', temperature: 0.6, maxTokens: 1600 },
        ),
      };
    }
  } catch { /* 全局 AI 不可用时回落 Key */ }
  return null;
}
const agentCtx = buildAgentCtx();
const channelReady = computed(() => hasLlmChannel(settings.value, agentCtx));

// ---- 智能出题 ----
const cards = ref([]);
const q = ref('');
const selectedId = ref('');
const filteredCards = computed(() => {
  const kw = String(q.value || '').trim().toLowerCase();
  if (!kw) return cards.value;
  return cards.value.filter((c) =>
    (c.word || '').toLowerCase().includes(kw) || (c.meaning || '').toLowerCase().includes(kw));
});
const selectedCard = computed(() => cards.value.find((c) => c.id === selectedId.value) || null);
const generating = ref(false);
const saving = ref(false);
const genResult = ref(null); // { modes, dropped, via }

// 已生成/已存模式 id 集合（用于 UI 高亮标记）
const existingModeIds = computed(() => {
  const mq = selectedCard.value?.modeQuestions;
  if (!mq || typeof mq !== 'object') return new Set();
  return new Set(Object.keys(mq));
});

async function doGenerate() {
  const card = selectedCard.value;
  if (!card) { toast(t('views.wordAiModes.modesNoCards'), 'warn'); return; }
  if (!channelReady.value) { toast(t('views.wordAiModes.modesNoChannel'), 'warn'); return; }
  generating.value = true;
  genResult.value = null;
  try {
    const r = await generateModeQuestions({ card, settings: settings.value, agentCtx });
    if (r.ok) genResult.value = r;
    else toast(t('views.wordAiModes.modesGenFailed') + '：' + (r.reason || ''), 'error');
  } catch (e) {
    toast(t('views.wordAiModes.modesGenFailed') + '：' + (e?.message || e), 'error');
  } finally {
    generating.value = false;
  }
}

async function doSave() {
  const card = selectedCard.value;
  if (!card || !genResult.value?.modes) return;
  const merged = applyModeQuestions(card, genResult.value.modes);
  saving.value = true;
  try {
    await updateWordCard(card.id, { modeQuestions: merged.modeQuestions });
    // 更新本地列表缓存，避免刷新后 modeQuestions 消失
    const i = cards.value.findIndex((c) => c.id === card.id);
    if (i >= 0) cards.value[i] = { ...cards.value[i], modeQuestions: merged.modeQuestions };
    toast(t('views.wordAiModes.modesSaved', undefined, { n: Object.keys(merged.modeQuestions).length }), 'success');
  } catch (e) {
    toast(t('views.wordAiModes.modesSaveFailed') + '：' + (e?.message || e), 'error');
  } finally {
    saving.value = false;
  }
}

// 模式中文/英文标签：复用 wordReview 字典里的 13 模式名（避免在数据层重复维护文案）
function modeLabel(id) {
  return t('views.wordReview.mode' + id.charAt(0).toUpperCase() + id.slice(1), id);
}

// ---- 释义补齐 ----
const coverage = ref(null);
const filling = ref(false);
const stopRequested = ref(false);
const fillProgress = ref(null);

async function refreshCoverage() {
  try {
    const s = await syncWithSyllabus();
    coverage.value = { total: s.total, covered: s.covered, coverage: s.coverage, missing: s.missing };
  } catch { coverage.value = null; }
}

async function doFillMeanings() {
  if (!channelReady.value) { toast(t('views.wordAiModes.meaningsNoChannel'), 'warn'); return; }
  const missing = coverage.value?.missing || [];
  if (!missing.length) { toast(t('views.wordAiModes.meaningsEmpty'), 'info'); return; }
  filling.value = true;
  stopRequested.value = false;
  fillProgress.value = null;
  try {
    const r = await batchGenerateMeanings({
      words: missing, settings: settings.value, agentCtx, batchSize: 40,
      onBatch: ({ done, total, generated, failed }) => {
        fillProgress.value = { done, total, generated, failed };
        return !stopRequested.value; // 返回 false 即中断后续批次
      },
    });
    toast(t('views.wordAiModes.meaningsDone', undefined, { generated: r.generated, failed: r.failed }),
      r.generated > 0 ? 'success' : 'info');
    await refreshCoverage();
  } catch (e) {
    toast(t('views.wordAiModes.meaningsNoChannel') + '：' + (e?.message || e), 'error');
  } finally {
    filling.value = false;
    fillProgress.value = null;
  }
}

function stopFill() { stopRequested.value = true; }

onMounted(async () => {
  try {
    settings.value = await getWordSettings();
    cards.value = await listWordCards({ schedulableOnly: true });
  } catch { /* 忽略加载失败，页面仍可用 */ }
  await refreshCoverage();
});
</script>

<template>
  <div class="waim">
    <div class="waim-head">
      <button class="back" @click="router.push('/english')">← {{ t('views.wordHub.title') }}</button>
      <h1>{{ t('views.wordAiModes.title') }}</h1>
      <p>{{ t('views.wordAiModes.subtitle') }}</p>
    </div>

    <!-- AI 通道状态 -->
    <div class="chan" :class="{ ok: channelReady }">
      <span class="dot"></span>
      <span>{{ channelReady ? t('views.wordAiModes.channelReady') : t('views.wordAiModes.channelMissing') }}</span>
    </div>

    <!-- Tab 切换 -->
    <div class="tabs">
      <button class="tb" :class="{ on: tab === 'modes' }" @click="tab = 'modes'">{{ t('views.wordAiModes.tabModes') }}</button>
      <button class="tb" :class="{ on: tab === 'meanings' }" @click="tab = 'meanings'">{{ t('views.wordAiModes.tabMeanings') }}</button>
    </div>

    <!-- 智能出题 -->
    <div v-if="tab === 'modes'" class="pane">
      <p class="hint">{{ t('views.wordAiModes.modesHint') }}</p>

      <div class="picker">
        <input class="search" v-model="q" :placeholder="t('views.wordAiModes.modesSearch')" />
        <select class="card-sel" v-model="selectedId">
          <option value="" disabled>{{ t('views.wordAiModes.modesSelectCard') }}</option>
          <option v-for="c in filteredCards" :key="c.id" :value="c.id">
            {{ c.word }}{{ c.meaning ? ' · ' + c.meaning : '' }}
          </option>
        </select>
      </div>

      <p v-if="!filteredCards.length" class="empty">{{ t('views.wordAiModes.modesNoCards') }}</p>

      <div v-if="selectedCard" class="card-info">
        <span class="ci-word">{{ selectedCard.word }}</span>
        <span v-if="selectedCard.phonetic" class="ci-phon">/{{ selectedCard.phonetic }}/</span>
        <span v-if="selectedCard.meaning" class="ci-mean">{{ selectedCard.meaning }}</span>
        <span v-if="existingModeIds.size" class="ci-tag">
          {{ t('views.wordAiModes.modesSaved', undefined, { n: existingModeIds.size }) }}
        </span>
      </div>

      <div class="actions">
        <button class="btn-primary" :disabled="generating || !selectedCard" @click="doGenerate">
          {{ generating ? t('views.wordAiModes.modesGenerating')
            : (genResult ? t('views.wordAiModes.modesRegenerate') : t('views.wordAiModes.modesGenerate')) }}
        </button>
        <button v-if="genResult?.modes" class="btn-ghost" :disabled="saving" @click="doSave">
          {{ saving ? t('views.wordAiModes.modesSaving') : t('views.wordAiModes.modesSave') }}
        </button>
      </div>

      <!-- 生成结果预览 -->
      <div v-if="genResult" class="preview">
        <div class="pv-head">
          <span class="pv-title">{{ t('views.wordAiModes.modesPreview') }}</span>
          <span class="pv-via">
            {{ genResult.via === 'agent' ? t('views.wordAiModes.modesViaAgent') : t('views.wordAiModes.modesViaKey') }}
          </span>
        </div>
        <div v-if="!Object.keys(genResult.modes || {}).length" class="pv-empty">
          {{ t('views.wordAiModes.modesGenFailed') }}：{{ (genResult.dropped || []).map(d => d.mode + '(' + d.reason + ')').join('，') }}
        </div>
        <template v-else>
          <div v-for="m in REVIEW_MODES" :key="m.id" class="pv-item" v-show="genResult.modes[m.id]">
            <div class="pv-mode">
              <b>{{ modeLabel(m.id) }}</b>
              <span v-if="existingModeIds.has(m.id)" class="pv-exist">· {{ t('views.wordAiModes.modesSaved', undefined, { n: 1 }) }}</span>
            </div>
            <div class="pv-q">Q：{{ genResult.modes[m.id].q }}</div>
            <div class="pv-a">A：{{ genResult.modes[m.id].a }}</div>
            <div v-if="genResult.modes[m.id].options" class="pv-opts">
              {{ t('views.wordAiModes.modesOptions') }}：{{ genResult.modes[m.id].options.join(' / ') }}
            </div>
            <div v-if="genResult.modes[m.id].tip" class="pv-tip">
              {{ t('views.wordAiModes.modesTip') }}：{{ genResult.modes[m.id].tip }}
            </div>
          </div>
        </template>
        <div v-if="genResult.dropped?.length" class="pv-dropped">
          {{ t('views.wordAiModes.modesDropped', undefined, { n: genResult.dropped.length }) }}：
          {{ genResult.dropped.map(d => modeLabel(d.mode) + '(' + d.reason + ')').join('、') }}
        </div>
      </div>
    </div>

    <!-- 释义补齐 -->
    <div v-else class="pane">
      <p class="hint">{{ t('views.wordAiModes.meaningsHint') }}</p>

      <div v-if="coverage" class="cov-card">
        <div class="cov-row">
          <span>{{ t('views.wordAiModes.meaningsCoverage') }}</span>
          <b>{{ coverage.covered }} / {{ coverage.total }}（{{ coverage.coverage }}%）</b>
        </div>
        <div class="cov-bar"><div class="cov-fill" :style="{ width: coverage.coverage + '%' }"></div></div>
        <div class="cov-row">
          <span>{{ t('views.wordAiModes.meaningsMissing') }}</span>
          <b>{{ coverage.missing.length }}</b>
        </div>
        <button class="btn-ghost cov-refresh" @click="refreshCoverage">{{ t('views.wordAiModes.meaningsRefresh') }}</button>
      </div>

      <div v-if="filling && fillProgress" class="fill-progress">
        <span>{{ t('views.wordAiModes.meaningsRunning', undefined, { done: fillProgress.done, total: fillProgress.total }) }}</span>
        <span>{{ t('views.wordAiModes.meaningsProgress', undefined, { generated: fillProgress.generated, failed: fillProgress.failed }) }}</span>
      </div>

      <div class="actions">
        <button v-if="!filling" class="btn-primary" :disabled="!coverage?.missing?.length" @click="doFillMeanings">
          {{ t('views.wordAiModes.meaningsStart') }}
        </button>
        <button v-else class="btn-danger" @click="stopFill">{{ t('views.wordAiModes.meaningsStop') }}</button>
      </div>

      <p v-if="coverage && !coverage.missing.length" class="empty">{{ t('views.wordAiModes.meaningsEmpty') }}</p>
    </div>

    <WordQuickBar />
  </div>
</template>

<style scoped>
.waim { min-height: 100vh; padding-bottom: 90px; }
.waim-head { padding: 16px 16px 4px; }
.waim-head .back { border: none; background: transparent; color: var(--ink-2); cursor: pointer; font-size: 13px; }
.waim-head h1 { margin: 6px 0 2px; font-size: 20px; color: var(--ink); }
.waim-head p { margin: 0; font-size: 12px; color: var(--ink-2); }

.chan {
  margin: 12px 16px 0; padding: 9px 12px; border-radius: 12px; font-size: 12px;
  background: var(--line); color: var(--ink-2); display: flex; align-items: center; gap: 8px;
}
.chan.ok { background: var(--code-inline); color: var(--accent); }
.chan .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex-shrink: 0; }

.tabs { display: flex; gap: 8px; padding: 12px 16px 0; }
.tb { flex: 1; border: 1px solid var(--line); background: var(--panel); color: var(--ink-2); border-radius: 12px; padding: 10px; font-size: 14px; cursor: pointer; }
.tb.on { border-color: var(--accent); background: var(--accent); color: #fff; font-weight: 600; }

.pane { padding: 12px 16px 0; display: flex; flex-direction: column; gap: 12px; }
.hint { margin: 0; font-size: 12px; color: var(--ink-2); line-height: 1.6; }

.picker { display: flex; gap: 8px; flex-direction: column; }
.search, .card-sel {
  border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px;
  background: var(--panel); color: var(--ink); font-size: 13px; width: 100%;
}
.empty { margin: 0; font-size: 13px; color: var(--ink-2); text-align: center; padding: 18px 0; }

.card-info {
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px;
}
.ci-word { font-size: 18px; font-weight: 700; color: var(--ink); }
.ci-phon { font-size: 12px; color: var(--ink-2); }
.ci-mean { font-size: 13px; color: var(--ink-2); }
.ci-tag { font-size: 11px; color: var(--accent); background: var(--code-inline); border-radius: 8px; padding: 2px 8px; }

.actions { display: flex; gap: 8px; }
.btn-primary { flex: 1; border: none; background: var(--accent); color: #fff; border-radius: 12px; padding: 12px; font-size: 14px; cursor: pointer; }
.btn-primary:disabled { opacity: .5; cursor: default; }
.btn-ghost { border: 1px solid var(--line); background: transparent; border-radius: 12px; padding: 12px 16px; cursor: pointer; color: var(--ink); font-size: 14px; }
.btn-danger { flex: 1; border: none; background: #f0506e; color: #fff; border-radius: 12px; padding: 12px; font-size: 14px; cursor: pointer; }

.preview {
  background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 14px;
  display: flex; flex-direction: column; gap: 10px;
}
.pv-head { display: flex; align-items: center; justify-content: space-between; }
.pv-title { font-size: 14px; font-weight: 600; color: var(--ink); }
.pv-via { font-size: 11px; color: var(--accent); }
.pv-empty { font-size: 12px; color: #d9534f; line-height: 1.6; }
.pv-item { border: 1px solid var(--line); border-radius: 10px; padding: 10px; }
.pv-mode { display: flex; align-items: baseline; gap: 6px; margin-bottom: 6px; }
.pv-mode b { font-size: 13px; color: var(--accent); }
.pv-exist { font-size: 11px; color: var(--ink-2); }
.pv-q, .pv-a { font-size: 13px; color: var(--ink); line-height: 1.6; }
.pv-q { color: var(--ink); }
.pv-a { color: #1f9255; }
.pv-opts, .pv-tip { font-size: 12px; color: var(--ink-2); line-height: 1.6; }
.pv-dropped { font-size: 11px; color: #c47f1a; background: #fdeede; border-radius: 8px; padding: 8px 10px; line-height: 1.6; }

.cov-card {
  background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 14px;
  display: flex; flex-direction: column; gap: 10px;
}
.cov-row { display: flex; justify-content: space-between; font-size: 13px; color: var(--ink); }
.cov-row b { color: var(--accent); }
.cov-bar { height: 8px; background: var(--line); border-radius: 6px; overflow: hidden; }
.cov-fill { height: 100%; background: var(--accent); transition: width .4s; }
.cov-refresh { align-self: flex-start; padding: 6px 12px; font-size: 12px; }
.fill-progress { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--accent); }
</style>
