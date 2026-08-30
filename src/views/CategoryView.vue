<script setup>
// 自动分类视图（D4.2）：零 LLM 本地 TF-IDF 分类，卡片/资料/笔记三类实体
import { ref, onMounted, computed } from 'vue';
import { toast } from '../utils/toast.js';
import { t } from '../i18n/index.js';
import {
  classifyAllCards, classifyAllDocs, classifyAllNotes,
  getClassifyStats, evaluateClassification,
} from '../classify-lib.js';

const stats = ref(null);
const evalResult = ref(null);
const busy = ref('');                 // 正在分类的实体名（空 = 空闲）
const preview = ref(null);            // dry-run 预览结果

onMounted(async () => {
  await loadStats();
  evalResult.value = await evaluateClassification();
});

async function loadStats() {
  stats.value = await getClassifyStats();
}

function nameFor(entity) {
  return entity === 'cards' ? t('views.category.nameCards') : entity === 'docs' ? t('views.category.nameDocs') : t('views.category.nameNotes');
}

function labelFor(entity) {
  if (entity === 'cards') return { field: 'subject', name: nameFor(entity) };
  if (entity === 'docs') return { field: 'subject', name: nameFor(entity) };
  return { field: 'category', name: nameFor(entity) };
}

/** 先 dry-run 预览，再点确认真正写回 */
async function previewClassify(entity) {
  busy.value = entity;
  try {
    const fn = { cards: classifyAllCards, docs: classifyAllDocs, notes: classifyAllNotes }[entity];
    const r = await fn({ dryRun: true });
    preview.value = { entity, name: labelFor(entity).name, ...r };
    if (!r.trained) toast(r.reason || t('views.category.noSamplesToast'), 'error');
    else if (!r.classified) toast(t('views.category.noClassifiable', '没有可自动分类的{name}', { name: labelFor(entity).name }), 'info');
    else toast(t('views.category.previewToast', '预览：可自动分类 {n} 条{name}', { n: r.classified, name: labelFor(entity).name }), 'success');
  } finally {
    busy.value = '';
  }
}

async function confirmClassify() {
  if (!preview.value) return;
  const { entity, name } = preview.value;
  busy.value = entity;
  try {
    const fn = { cards: classifyAllCards, docs: classifyAllDocs, notes: classifyAllNotes }[entity];
    const r = await fn({ dryRun: false });
    toast(t('views.category.classifiedToast', '已分类 {n} 条{name}', { n: r.classified, name }), 'success');
    preview.value = null;
    await loadStats();
  } catch (e) {
    toast(t('views.category.classifyFail', '分类失败：{msg}', { msg: e?.message || e }), 'error');
  } finally {
    busy.value = '';
  }
}

const entityStats = computed(() => {
  if (!stats.value) return [];
  return [
    { key: 'cards', name: t('views.category.nameCards'), icon: '🗂️', field: 'subject', ...stats.value.cards },
    { key: 'docs', name: t('views.category.nameDocs'), icon: '📚', field: 'subject', ...stats.value.docs },
    { key: 'notes', name: t('views.category.nameNotes'), icon: '📓', field: 'category', ...stats.value.notes },
  ];
});
</script>

<template>
  <div class="cls-page">
    <h2 style="margin:0 0 4px">{{ t('views.category.title') }}</h2>
    <p class="hint" style="margin:0 0 16px">
      {{ t('views.category.hint') }}
    </p>

    <!-- 统计总览 -->
    <div class="cls-stats" v-if="stats">
      <div v-for="s in entityStats" :key="s.key" class="cls-stat">
        <span class="cls-stat-icon">{{ s.icon }}</span>
        <span class="cls-stat-name">{{ s.name }}</span>
        <span class="cls-stat-num">{{ s.classified }}/{{ s.total }}</span>
        <span class="hint">{{ t('views.category.statsClassified') }}</span>
      </div>
    </div>

    <!-- 模型质量 -->
    <div v-if="evalResult?.available" class="hint cls-eval">
      {{ t('views.category.evalAvailable', '🎯 当前分类模型：训练样本 {seeds} 条 / {labels} 个科目，留一法准确率 {acc}%（{correct}/{total}）', { seeds: evalResult.seedCount, labels: evalResult.labelCount, acc: Math.round(evalResult.accuracy * 100), correct: evalResult.correct, total: evalResult.total }) }}
    </div>
    <div v-else-if="evalResult" class="hint cls-eval">
      {{ t('views.category.evalNoSamples') }}
    </div>

    <!-- 操作按钮 -->
    <div class="cls-actions">
      <button class="btn" :disabled="!!busy" @click="previewClassify('cards')">
        {{ busy === 'cards' ? t('views.category.classifying') : t('views.category.classifyCards') }}
      </button>
      <button class="btn" :disabled="!!busy" @click="previewClassify('docs')">
        {{ busy === 'docs' ? t('views.category.classifying') : t('views.category.classifyDocs') }}
      </button>
      <button class="btn" :disabled="!!busy" @click="previewClassify('notes')">
        {{ busy === 'notes' ? t('views.category.classifying') : t('views.category.classifyNotes') }}
      </button>
    </div>

    <!-- 预览 / 确认 -->
    <div v-if="preview" class="cls-preview">
      <div class="cls-preview-head">
        <span class="cls-preview-title">
          {{ preview.trained ? t('views.category.previewTitle', '可自动分类 {n} 条{name}', { n: preview.classified, name: preview.name }) : t('views.category.noSamplesTitle') }}
        </span>
        <span style="flex:1"></span>
        <button v-if="preview.trained && preview.classified" class="btn primary" @click="confirmClassify">{{ t('views.category.confirmWrite') }}</button>
        <button class="btn" @click="preview = null">{{ t('views.category.cancel') }}</button>
      </div>
      <!-- 诊断明细：解释「为什么是 0 条」，而不是让用户对着 0 干瞪眼 -->
      <div v-if="preview.trained" class="cls-diag">
        {{ t('views.category.diagSummary', '共 {total} 条{name}，其中已有分类 {already} 条（不覆盖）；待判 {pending} 条里：置信度不足（<12%）{low} 条、文本为空 {empty} 条。模型依据：{seeds} 条训练样本 / {labels} 个科目。', {
          total: preview.total, name: preview.name, already: preview.already ?? 0, pending: preview.total - (preview.already ?? 0),
          low: preview.lowConfidence ?? 0, empty: preview.emptyText ?? 0, seeds: preview.seedCount ?? 0, labels: preview.labelCount ?? 0,
        }) }}
      </div>

      <div v-if="preview.results?.length" class="cls-preview-list">
        <div v-for="(r, i) in preview.results" :key="r.id" class="cls-preview-item">
          <span class="cls-idx">{{ i + 1 }}</span>
          <span class="cls-text">{{ r.front || r.name || r.title }}</span>
          <span class="cls-arrow">→</span>
          <span class="cls-label">{{ r.label }}</span>
          <span class="cls-conf">{{ Math.round(r.confidence * 100) }}%</span>
        </div>
      </div>
      <div v-else-if="preview.trained" class="cls-diag">
        <template v-if="preview.lowConfidence">
          {{ t('views.category.diagHintLow', '💡 大部分{name}与已有科目的用词重叠太低，模型不敢下判断。可以：① 多给一些卡片设上科目扩大样本；② 用「科目」页做批量归类。', { name: preview.name }) }}
        </template>
        <template v-else>{{ t('views.category.diagNone', '没有需要分类的{name}。', { name: preview.name }) }}</template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cls-page { max-width: 900px; margin: 0 auto; }
.cls-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 14px; }
.cls-stat { display: flex; align-items: center; gap: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
.cls-stat-icon { font-size: 22px; }
.cls-stat-name { font-weight: 600; }
.cls-stat-num { margin-left: auto; font-size: 18px; font-weight: 700; }
.cls-eval { margin-bottom: 14px; padding: 8px 12px; background: color-mix(in srgb, var(--accent) 6%, transparent); border-radius: 8px; }
.cls-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.cls-preview { border: 1px solid var(--line); border-radius: 12px; padding: 14px; background: var(--panel); }
.cls-diag { font-size: 12px; color: var(--ink-2); line-height: 1.7; padding: 8px 10px; margin-bottom: 8px;
  background: var(--code-bg, #f7f7f9); border-radius: 8px; }
.cls-diag b { color: var(--ink); }
.cls-preview-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.cls-preview-title { font-weight: 600; }
.cls-preview-list { display: flex; flex-direction: column; gap: 4px; max-height: 360px; overflow-y: auto; }
.cls-preview-item { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 6px; font-size: 13px; }
.cls-preview-item:hover { background: var(--panel-2, #f7f7f9); }
.cls-idx { color: var(--ink-2); min-width: 22px; text-align: right; }
.cls-text { flex: 1; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cls-arrow { color: var(--ink-2); }
.cls-label { font-weight: 700; color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); padding: 2px 10px; border-radius: 12px; }
.cls-conf { color: var(--ink-2); font-size: 12px; min-width: 40px; }

@media (max-width: 720px) {
  .cls-stats { grid-template-columns: 1fr; }
}
</style>
