<script setup>
// 自动分类视图（D4.2）：零 LLM 本地 TF-IDF 分类，卡片/资料/笔记三类实体
import { ref, onMounted, computed } from 'vue';
import { toast } from '../utils/toast.js';
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

function labelFor(entity, label) {
  if (entity === 'cards') return { field: 'subject', name: '卡片' };
  if (entity === 'docs') return { field: 'subject', name: '资料' };
  return { field: 'category', name: '笔记' };
}

/** 先 dry-run 预览，再点确认真正写回 */
async function previewClassify(entity) {
  busy.value = entity;
  try {
    const fn = { cards: classifyAllCards, docs: classifyAllDocs, notes: classifyAllNotes }[entity];
    const r = await fn({ dryRun: true });
    preview.value = { entity, name: labelFor(entity).name, ...r };
    if (!r.trained) toast(r.reason || '暂无训练样本', 'error');
    else if (!r.classified) toast('没有可自动分类的' + labelFor(entity).name, 'info');
    else toast(`预览：可自动分类 ${r.classified} 条${labelFor(entity).name}`, 'success');
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
    toast(`已分类 ${r.classified} 条${name}`, 'success');
    preview.value = null;
    await loadStats();
  } catch (e) {
    toast('分类失败：' + (e?.message || e), 'error');
  } finally {
    busy.value = '';
  }
}

const entityStats = computed(() => {
  if (!stats.value) return [];
  return [
    { key: 'cards', name: '卡片', icon: '🗂️', field: 'subject', ...stats.value.cards },
    { key: 'docs', name: '资料', icon: '📚', field: 'subject', ...stats.value.docs },
    { key: 'notes', name: '笔记', icon: '📓', field: 'category', ...stats.value.notes },
  ];
});
</script>

<template>
  <div class="cls-page">
    <h2 style="margin:0 0 4px">🏷️ 自动分类</h2>
    <p class="hint" style="margin:0 0 16px">
      本地 TF-IDF 自动归类（<b>零 LLM、零网络</b>）：用已有「科目 / 分类」做训练样本，自动把未分类的卡片 / 资料 / 笔记归到最接近的类别。
      只自动填「未分类」的实体，<b>绝不覆盖你手动设的分类</b>。
    </p>

    <!-- 统计总览 -->
    <div class="cls-stats" v-if="stats">
      <div v-for="s in entityStats" :key="s.key" class="cls-stat">
        <span class="cls-stat-icon">{{ s.icon }}</span>
        <span class="cls-stat-name">{{ s.name }}</span>
        <span class="cls-stat-num">{{ s.classified }}/{{ s.total }}</span>
        <span class="hint">已分类</span>
      </div>
    </div>

    <!-- 模型质量 -->
    <div v-if="evalResult?.available" class="hint cls-eval">
      🎯 当前分类模型准确率（留一法）：<b>{{ Math.round(evalResult.accuracy * 100) }}%</b>
      （{{ evalResult.correct }}/{{ evalResult.total }}）
    </div>

    <!-- 操作按钮 -->
    <div class="cls-actions">
      <button class="btn" :disabled="!!busy" @click="previewClassify('cards')">
        {{ busy === 'cards' ? '分类中…' : '自动分类卡片' }}
      </button>
      <button class="btn" :disabled="!!busy" @click="previewClassify('docs')">
        {{ busy === 'docs' ? '分类中…' : '自动分类资料' }}
      </button>
      <button class="btn" :disabled="!!busy" @click="previewClassify('notes')">
        {{ busy === 'notes' ? '分类中…' : '自动分类笔记' }}
      </button>
    </div>

    <!-- 预览 / 确认 -->
    <div v-if="preview" class="cls-preview">
      <div class="cls-preview-head">
        <span class="cls-preview-title">
          {{ preview.trained ? `可自动分类 ${preview.classified} 条${preview.name}` : '暂无训练样本' }}
        </span>
        <span style="flex:1"></span>
        <button v-if="preview.trained && preview.classified" class="btn primary" @click="confirmClassify">确认写回</button>
        <button class="btn" @click="preview = null">取消</button>
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
