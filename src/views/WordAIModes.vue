<script setup>
// 英语 AI 智能模块（v31）
// 复用 AI 助手通道（services/word-llm.js callLlmJson：agent 优先 → 用户 Key 兜底），
// 提供两个能力：
//   1. 智能出题：为一词按 13 种背诵模式的判分口径自动生成题目/答案，不合规丢弃并展示原因；
//   2. 释义补齐：为大纲词表中缺失的中文释义批量补齐（分批落库、可中断）。
// 生成物落在 wordCards.modeQuestions（受 WORD_EXT_FIELDS 并集保护，跨设备同步不丢）。
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { t } from '../i18n/index.js';
import { toast } from '../utils/toast.js';
import {
  listWordCards, getWordSettings, updateWordCard, listWordGroups, wordGroupCardIds,
} from '../word-repo.js';
import {
  REVIEW_MODES, batchGenerateModeQuestions, batchGenerateMeanings, hasLlmChannel, KIND_LABELS,
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

// ---- Smart question generation (word-book batch, #9) ----
// Scope: all (schedulableOnly) / by group (groupId) / by type (kind: word|phrase|sentence).
// After picking a scope, "generate for the whole book" calls batchGenerateModeQuestions per card;
// a single card's failure does not block the others, each succeeded card is auto-merged & persisted
// (saveFn injects updateWordCard), and results are summarized per card.
const groups = ref([]);
const cards = ref([]);          // 全部可排程卡（schedulableOnly）
const scope = ref('all');       // all | group | kind
const scopeGroupId = ref('');
const scopeKind = ref('word');  // word | phrase | sentence
const scopeCards = ref([]);     // 当前范围内卡片（按范围筛选后的子集）
const generating = ref(false);
const batchResult = ref(null);  // batchGenerateModeQuestions 返回值
const batchProgress = ref(null);
const openIds = ref([]);        // 展开的卡片 id（仅展示明细用）
const abortCtl = ref(null);     // 批量任务 AbortController（真中断在途 LLM 请求）

const scopeCardCount = computed(() => scopeCards.value.length);
function isOpen(id) { return openIds.value.includes(id); }
function toggleDetail(id) {
  openIds.value = isOpen(id) ? openIds.value.filter((x) => x !== id) : [...openIds.value, id];
}
function kindLabel(k) { return KIND_LABELS[k] || KIND_LABELS.word; }

// Recompute candidate cards by scope (group needs async wordGroupCardIds)
async function recomputeScope() {
  if (!cards.value.length) { scopeCards.value = []; return; }
  if (scope.value === 'group' && scopeGroupId.value) {
    try {
      const ids = await wordGroupCardIds(scopeGroupId.value);
      const set = new Set(ids);
      scopeCards.value = cards.value.filter((c) => set.has(c.id));
    } catch { scopeCards.value = []; }
  } else if (scope.value === 'kind') {
    scopeCards.value = cards.value.filter((c) => (c.kind || 'word') === scopeKind.value);
  } else {
    scopeCards.value = cards.value;
  }
}
watch([scope, scopeGroupId, scopeKind], recomputeScope);

async function doGenerateBook() {
  if (!scopeCardCount.value) { toast(t('views.wordAiModes.modesBookEmpty'), 'warn'); return; }
  if (!channelReady.value) { toast(t('views.wordAiModes.modesNoChannel'), 'warn'); return; }
  generating.value = true;
  batchResult.value = null;
  batchProgress.value = null;
  stopRequested.value = false;
  openIds.value = [];
  const ac = new AbortController();
  abortCtl.value = ac;
  try {
    const r = await batchGenerateModeQuestions({
      cards: scopeCards.value.map((c) => ({ ...c })), // 浅拷贝，避免把响应式 Proxy 传入服务层
      settings: settings.value,
      agentCtx,
      signal: ac.signal,
      saveFn: async (id, patch) => { await updateWordCard(id, patch); },
      onProgress: ({ done, total, generated, failed, saved }) => {
        batchProgress.value = { done, total, generated, failed, saved };
        return !stopRequested.value; // 返回 false 即中断后续卡片
      },
    });
    batchResult.value = r;
    // 同步本地缓存，避免刷新后 modeQuestions 消失
    const savedMap = new Map(r.perCard.filter((p) => p.saved).map((p) => [p.id, p]));
    if (savedMap.size) {
      cards.value = cards.value.map((c) => {
        const p = savedMap.get(c.id);
        return p ? { ...c, modeQuestions: p.modes } : c;
      });
    }
    toast(
      t('views.wordAiModes.modesBookDone', undefined, { saved: r.saved, failed: r.failed, modes: r.generated }),
      r.saved > 0 ? 'success' : 'info',
    );
  } catch (e) {
    toast(t('views.wordAiModes.modesGenFailed') + '：' + (e?.message || e), 'error');
  } finally {
    generating.value = false;
    batchProgress.value = null;
    if (abortCtl.value === ac) abortCtl.value = null;
  }
}

function stopBook() {
  stopRequested.value = true;
  abortCtl.value?.abort(); // 中断在途 LLM 请求（P2-4 真中断，而非仅停后续卡）
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
  const ac = new AbortController();
  abortCtl.value = ac;
  try {
    const r = await batchGenerateMeanings({
      words: missing, settings: settings.value, agentCtx, batchSize: 40,
      signal: ac.signal,
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
    if (abortCtl.value === ac) abortCtl.value = null;
  }
}

function stopFill() { stopRequested.value = true; abortCtl.value?.abort(); }

onMounted(async () => {
  try {
    settings.value = await getWordSettings();
    cards.value = await listWordCards({ schedulableOnly: true });
    groups.value = await listWordGroups();
    await recomputeScope();
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

    <!-- 智能出题（单词本批量） -->
    <div v-if="tab === 'modes'" class="pane">
      <p class="hint">{{ t('views.wordAiModes.modesHint') }}</p>

      <!-- 范围选择：全部 / 按卡组 / 按分类 -->
      <div class="picker">
        <div class="scope-tabs">
          <button class="scope-tb" :class="{ on: scope === 'all' }" @click="scope = 'all'">{{ t('views.wordAiModes.modesScopeAll') }}</button>
          <button class="scope-tb" :class="{ on: scope === 'group' }" @click="scope = 'group'">{{ t('views.wordAiModes.modesScopeGroup') }}</button>
          <button class="scope-tb" :class="{ on: scope === 'kind' }" @click="scope = 'kind'">{{ t('views.wordAiModes.modesScopeKind') }}</button>
        </div>
        <select v-if="scope === 'group'" class="card-sel" v-model="scopeGroupId">
          <option value="" disabled>{{ t('views.wordAiModes.modesSelectGroup') }}</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
        </select>
        <select v-if="scope === 'kind'" class="card-sel" v-model="scopeKind">
          <option value="word">{{ KIND_LABELS.word }}</option>
          <option value="phrase">{{ KIND_LABELS.phrase }}</option>
          <option value="sentence">{{ KIND_LABELS.sentence }}</option>
        </select>
        <div class="scope-count">{{ t('views.wordAiModes.modesScopeCount', undefined, { n: scopeCardCount }) }}</div>
      </div>

      <p v-if="!scopeCardCount" class="empty">{{ t('views.wordAiModes.modesBookEmpty') }}</p>

      <div class="actions">
        <button class="btn-primary" :disabled="generating || !scopeCardCount" @click="doGenerateBook">
          {{ generating
            ? t('views.wordAiModes.modesBatchGenerating', undefined, { done: batchProgress?.done || 0, total: batchProgress?.total || scopeCardCount })
            : t('views.wordAiModes.modesGenerateBook', undefined, { n: scopeCardCount }) }}
        </button>
        <button v-if="generating" class="btn-danger" @click="stopBook">{{ t('views.wordAiModes.modesStopBook') }}</button>
      </div>

      <div v-if="generating && batchProgress" class="fill-progress">
        <span>{{ t('views.wordAiModes.modesBatchRunning', undefined, { done: batchProgress.done, total: batchProgress.total }) }}</span>
        <span>{{ t('views.wordAiModes.modesBatchProgress', undefined, { generated: batchProgress.generated, failed: batchProgress.failed, saved: batchProgress.saved }) }}</span>
      </div>

      <!-- 批量结果预览（按卡汇总） -->
      <div v-if="batchResult" class="preview">
        <div class="pv-head">
          <span class="pv-title">{{ t('views.wordAiModes.modesPreview') }}</span>
        </div>
        <div class="pv-summary">
          {{ t('views.wordAiModes.modesBatchSummary', undefined, { total: batchResult.total, generated: batchResult.generated, failed: batchResult.failed, saved: batchResult.saved }) }}
        </div>
        <div v-for="p in batchResult.perCard" :key="p.id" class="pv-card">
          <div class="pv-card-head" @click="toggleDetail(p.id)">
            <span class="pv-word">{{ p.word }}</span>
            <span class="pv-kind">{{ kindLabel(p.kind) }}</span>
            <span v-if="p.ok" class="pv-badge ok">✓ {{ Object.keys(p.modes).length }} {{ t('views.wordAiModes.modesUnit') }}</span>
            <span v-else class="pv-badge fail">✗ {{ t('views.wordAiModes.modesCardFailed') }}</span>
            <span class="pv-toggle">{{ isOpen(p.id) ? t('views.wordAiModes.modesToggleClose') : t('views.wordAiModes.modesToggleOpen') }}</span>
          </div>
          <div v-if="p.ok && isOpen(p.id)" class="pv-card-body">
            <div v-for="m in REVIEW_MODES" :key="m.id" class="pv-item" v-show="p.modes[m.id]">
              <div class="pv-mode"><b>{{ modeLabel(m.id) }}</b></div>
              <div class="pv-q">Q：{{ p.modes[m.id].q }}</div>
              <div class="pv-a">A：{{ p.modes[m.id].a }}</div>
              <div v-if="p.modes[m.id].options" class="pv-opts">{{ t('views.wordAiModes.modesOptions') }}：{{ p.modes[m.id].options.join(' / ') }}</div>
              <div v-if="p.modes[m.id].tip" class="pv-tip">{{ t('views.wordAiModes.modesTip') }}：{{ p.modes[m.id].tip }}</div>
            </div>
          </div>
          <div v-if="!p.ok" class="pv-dropped">
            {{ t('views.wordAiModes.modesCardFailReason') }}：{{ p.reason }}
          </div>
          <div v-if="p.ok && p.dropped.length" class="pv-dropped">
            {{ t('views.wordAiModes.modesDropped', undefined, { n: p.dropped.length }) }}：
            {{ p.dropped.map(d => modeLabel(d.mode) + '(' + d.reason + ')').join('、') }}
          </div>
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
.scope-tabs { display: flex; gap: 8px; }
.scope-tb {
  flex: 1; border: 1px solid var(--line); background: var(--panel); color: var(--ink-2);
  border-radius: 10px; padding: 9px; font-size: 13px; cursor: pointer;
}
.scope-tb.on { border-color: var(--accent); background: var(--accent); color: #fff; font-weight: 600; }
.card-sel {
  border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px;
  background: var(--panel); color: var(--ink); font-size: 13px; width: 100%;
}
.scope-count { font-size: 12px; color: var(--ink-2); }
.empty { margin: 0; font-size: 13px; color: var(--ink-2); text-align: center; padding: 18px 0; }

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

.pv-summary { font-size: 13px; color: var(--accent); font-weight: 600; }
.pv-card {
  border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
  background: var(--panel);
}
.pv-card-head {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  padding: 10px 12px;
}
.pv-word { font-size: 14px; font-weight: 700; color: var(--ink); }
.pv-kind { font-size: 11px; color: var(--ink-2); background: var(--line); border-radius: 6px; padding: 1px 7px; }
.pv-badge { font-size: 11px; padding: 1px 8px; border-radius: 6px; }
.pv-badge.ok { color: #1f9255; background: #e6f6ec; }
.pv-badge.fail { color: #d9534f; background: #fdeaea; }
.pv-toggle { margin-left: auto; font-size: 11px; color: var(--accent); }
.pv-card-body { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 8px; }

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
