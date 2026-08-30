<script setup>
// 错题集：独立页面，汇总所有错题（手动标记 + 遗忘多次），支持筛选/复习/取消标记
// P0 增补：AI 变式补卡（错题→生成同考点变式题，写入卡片库形成闭环）
// 2026-08-26 速赢区：SRS 阶段自动归类 + "重点区"快捷过滤
import { ref, computed, onMounted, watch } from 'vue';
import { db } from '../db.js';
import { weakCards, setMarked, getSubjects, gradeCard, createCard } from '../repo.js';
import { chatAI, hasAIKey, getAIConfig } from '../ai.js';
import { toast } from '../utils/toast.js';
import { smartRemediation } from '../intelligence.js';
import { t } from '../i18n/index.js';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import EmptyState from '../components/EmptyState.vue';

const expandedId = ref(localStorage.getItem('sxy_wb_expanded') || '');
// 错题详情：默认全展开（与「背诵 → 已背记录」一致），collapsedIds 存储被用户手动收起的卡 id
const collapsedIds = ref(new Set(JSON.parse(localStorage.getItem('sxy_wb_collapsed') || '[]')));
function persistCollapsed() { localStorage.setItem('sxy_wb_collapsed', JSON.stringify([...collapsedIds.value])); }
function toggleExpand(id) {
  const next = new Set(collapsedIds.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  collapsedIds.value = next; persistCollapsed();
  expandedId.value = String(id);
  localStorage.setItem('sxy_wb_expanded', expandedId.value);
}
function expandAll() { collapsedIds.value = new Set(); persistCollapsed(); }
function collapseAll() {
  const ids = new Set(filteredItems.value.map(c => c.id));
  collapsedIds.value = ids; persistCollapsed();
}

const items = ref([]);
const subjects = ref([]);
const filterSubject = ref(localStorage.getItem('sxy_wrong_subject') || '');
const filterStage = ref(localStorage.getItem('sxy_wrong_stage') || '');    // '' 全部 / 'focus' 重点区 / 'marked' 错题标记 / 'learning' / 'growing' / 'mastered'
watch(filterSubject, v => localStorage.setItem('sxy_wrong_subject', v));
watch(filterStage, v => localStorage.setItem('sxy_wrong_stage', v));
const genBusy = ref(new Set()); // 正在生成变式的卡 id 集合
const batchBusy = ref(false);
const loading = ref(true); // P2-30 初始加载态

// P2·#11 错题闭环：智能补救结果面板
const remediation = ref(null); // { card, diagnosis, feynmanHint, variantCards, graphLinks }
const remediationBusy = ref(new Set()); // 正在补救的卡 id 集合

async function startRemediation(c, withCards = false) {
  if (remediationBusy.value.has(c.id)) return;
  remediationBusy.value.add(c.id);
  try {
    const opt = { linkGraph: true };
    if (withCards && hasAIKey()) {
      opt.generateCards = true;
      opt.aiCfg = getAIConfig();
    }
    const r = await smartRemediation(c.id, opt);
    remediation.value = r;
    if (withCards && r.variantCards?.length) {
      toast(t('views.wrongBook.remediationDoneCards', { n: r.variantCards.length, m: r.graphLinks.length }), 'success');
    } else {
      toast(t('views.wrongBook.remediationDoneLinks', { m: r.graphLinks.length }), 'success');
    }
    await load();
  } catch (e) { toast(t('views.wrongBook.remediationFail', { msg: e.message }), 'error'); }
  finally { remediationBusy.value.delete(c.id); }
}

function closeRemediation() { remediation.value = null; }

async function goFeynman() {
  if (!remediation.value?.feynmanHint) return;
  // 跳转费曼页并带参数（用 sessionStorage 传递主题，避免 url 编码问题）
  sessionStorage.setItem('sxy_feynman_topic', remediation.value.feynmanHint.topic);
  sessionStorage.setItem('sxy_feynman_prompt', remediation.value.feynmanHint.prompt);
  location.hash = '#/feynman';
}

function plain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, t('views.wrongBook.plainCode'))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, t('views.wrongBook.plainImage'))
    .replace(/\$\$?([^$\n]+)\$\$?/g, ' $1 ')
    .replace(/[*_#>`~|-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function load() {
  const w = await weakCards(1000, 1);
  items.value = w.filter(c => !filterSubject.value || c.subject === filterSubject.value);
}
async function loadSubjects() { subjects.value = await getSubjects(); }

// 阶段分组计数（用于 chip 上的数字徽章）
const stageCounts = computed(() => {
  const c = { focus: 0, marked: 0, learning: 0, growing: 0, mastered: 0 };
  for (const it of items.value) {
    if ((it.failCount || 0) >= 3) c.focus++;
    if (it.marked) c.marked++;
    const g = gradeCard(it).cls;
    if (g === 'g-learning') c.learning++;
    else if (g === 'g-good') c.growing++;
    else if (g === 'g-master') c.mastered++;
  }
  return c;
});
// 按 SRS 阶段过滤后的列表
const filteredItems = computed(() => {
  if (!filterStage.value) return items.value;
  return items.value.filter(c => {
    if (filterStage.value === 'focus') return (c.failCount || 0) >= 3;
    if (filterStage.value === 'marked') return !!c.marked;
    const g = gradeCard(c).cls;
    if (filterStage.value === 'learning') return g === 'g-learning';
    if (filterStage.value === 'growing') return g === 'g-good';
    if (filterStage.value === 'mastered') return g === 'g-master';
    return true;
  });
});

async function unmark(card) {
  await setMarked(card.id, false);
  toast(t('views.wrongBook.unmarkDone'), 'success');
  await load();
}
async function dueNow(card) {
  // 用 db.cards.update 局部更新（而非 put 整对象）：避免 Vue reactive Proxy 写入 IDB 失败 + 不覆盖其他字段
  // ⚠ 只 bump reviewedAt，绝不 bump updatedAt（2026-08-29 修复）：
  //   内容字段按 updatedAt 合并决胜，此处只是调度调整（dueAt 属 SRS 侧），
  //   若推高 updatedAt 会让本机这份「旧内容」成为 winner，把其他设备对卡面的
  //   文字编辑整段覆盖掉。与 Cards.vue 的 rescueCard 保持一致。
  await db.cards.update(card.id, { dueAt: Date.now(), reviewedAt: Date.now() });
  toast(t('views.wrongBook.addedToReview'), 'success');
}
function reason(c) {
  if (c.wrongReason) return c.wrongReason;
  if (c.marked) return t('views.wrongBook.reasonMarked');
  return t('views.wrongBook.reasonForgotten', { n: c.failCount || 0 });
}

// AI 变式补卡：针对错题生成同考点变式，写入卡片库（错题→补卡闭环，smart-reviewer 思路的按钮化）
async function genVariant(c) {
  if (!hasAIKey()) { toast(t('views.wrongBook.noAiKey'), 'error'); return; }
  if (genBusy.value.has(c.id)) return;
  genBusy.value.add(c.id);
  try {
    const r = await chatAI([
      { role: 'system', content: '你是出题老师。针对下面的错题出一道「变式」巩固题（同知识点、不同问法、难度相当），输出严格 JSON：{"front":"问题","back":"答案"}。只输出 JSON，不要多余文字。' },
      { role: 'user', content: `原题：${plain(c.front)}\n原答案：${plain(c.back)}\n错因：${reason(c)}` },
    ]);
    const m = String(r).match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : r);
    if (!obj?.front || !obj?.back) throw new Error(t('views.wrongBook.genFormatError'));
    await createCard({
      front: String(obj.front).slice(0, 8000),
      back: String(obj.back).slice(0, 8000),
      subject: c.subject || '',
      tags: ['错题变式', ...(c.tags || []).slice(0, 3)],
      type: 'basic',
      source: '错题智能补卡',
    });
    toast(t('views.wrongBook.variantGenDone', { q: String(obj.front).slice(0, 24) }), 'success');
  } catch (e) { toast(t('views.wrongBook.genFail', { msg: e.message }), 'error'); }
  finally { genBusy.value.delete(c.id); }
}

// 批量为最薄弱的 5 道错题生成变式卡
async function genTop5() {
  if (!hasAIKey()) { toast(t('views.wrongBook.noAiKey'), 'error'); return; }
  if (batchBusy.value) return;
  const targets = items.value.filter(c => !genBusy.value.has(c.id)).slice(0, 5);
  if (!targets.length) { toast(t('views.wrongBook.noWrongAvailable'), 'error'); return; }
  batchBusy.value = true;
  let n = 0;
  for (const c of targets) { await genVariant(c); n++; }
  batchBusy.value = false;
  toast(t('views.wrongBook.genTop5Done', { n }), 'success');
  await load();
}

onMounted(async () => { loading.value = true; try { await Promise.all([load(), loadSubjects()]); } finally { loading.value = false; } });
</script>

<template>
  <div style="max-width:820px;margin:0 auto" v-loading="loading" :element-loading-text="t('views.wrongBook.loading')">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">{{ t('views.wrongBook.title') }}</h2>
      <span class="hint">{{ t('views.wrongBook.countHint', { n: filteredItems.length }) }}</span>
      <span style="flex:1"></span>
      <button class="btn small" :disabled="batchBusy" @click="genTop5">{{ batchBusy ? t('views.wrongBook.genTop5Busy') : t('views.wrongBook.genTop5Btn') }}</button>
      <select v-model="filterSubject" class="input" style="width:auto" @change="load">
        <option value="">{{ t('views.wrongBook.subjectAll') }}</option>
        <option v-for="s in subjects" :key="s.name" :value="s.name">{{ s.name }}</option>
      </select>
    </div>

    <!-- 速赢区：SRS 阶段快捷过滤 -->
    <div class="stage-bar">
      <button class="chip" :class="{ on: !filterStage }" @click="filterStage = ''">{{ t('views.wrongBook.stageAll') }} <span class="n">{{ items.length }}</span></button>
      <button class="chip" :class="{ on: filterStage === 'focus' }" @click="filterStage = 'focus'" :disabled="!stageCounts.focus">{{ t('views.wrongBook.stageFocus') }} <span class="n">{{ stageCounts.focus }}</span></button>
      <button class="chip" :class="{ on: filterStage === 'marked' }" @click="filterStage = 'marked'" :disabled="!stageCounts.marked">{{ t('views.wrongBook.stageMarked') }} <span class="n">{{ stageCounts.marked }}</span></button>
      <button class="chip" :class="{ on: filterStage === 'learning' }" @click="filterStage = 'learning'" :disabled="!stageCounts.learning">{{ t('views.wrongBook.stageLearning') }} <span class="n">{{ stageCounts.learning }}</span></button>
      <button class="chip" :class="{ on: filterStage === 'growing' }" @click="filterStage = 'growing'" :disabled="!stageCounts.growing">{{ t('views.wrongBook.stageGrowing') }} <span class="n">{{ stageCounts.growing }}</span></button>
      <button class="chip" :class="{ on: filterStage === 'mastered' }" @click="filterStage = 'mastered'" :disabled="!stageCounts.mastered">{{ t('views.wrongBook.stageMastered') }} <span class="n">{{ stageCounts.mastered }}</span></button>
      <span style="flex:1"></span>
      <button class="chip" @click="expandAll">{{ t('views.wrongBook.expandAll') }}</button>
      <button class="chip" @click="collapseAll">{{ t('views.wrongBook.collapseAll') }}</button>
    </div>

    <EmptyState v-if="!filteredItems.length" icon="❌" :title="t('views.wrongBook.emptyTitle')" :message="t('views.wrongBook.emptyMsg')" />

    <div v-for="c in filteredItems" :key="c.id" class="wb-item" :class="{ expanded: !collapsedIds.has(c.id) }">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;cursor:pointer" @click="toggleExpand(c.id)" :title="t('views.wrongBook.expandTitle')">
        <span class="chip">{{ c.subject || t('views.wrongBook.unclassified') }}</span>
        <span class="chip" style="color:var(--red);border-color:var(--red)">{{ reason(c) }}</span>
        <span class="hint" style="font-size:12px">{{ gradeCard(c).label }}</span>
        <span style="flex:1"></span>
        <span class="hint" style="font-size:12px">{{ collapsedIds.has(c.id) ? t('views.wrongBook.expandAnswer') : t('views.wrongBook.collapseAnswer') }}</span>
        <button class="btn small" :disabled="remediationBusy.has(c.id)" @click.stop="startRemediation(c, false)" :title="t('views.wrongBook.remediateTitleAttr')">{{ remediationBusy.has(c.id) ? t('views.wrongBook.remediating') : t('views.wrongBook.remediateBtn') }}</button>
        <button v-if="hasAIKey()" class="btn small" :disabled="remediationBusy.has(c.id)" @click.stop="startRemediation(c, true)" :title="t('views.wrongBook.remediateCardsTitleAttr')">{{ remediationBusy.has(c.id) ? t('views.wrongBook.remediating') : t('views.wrongBook.remediateCardsBtn') }}</button>
        <button class="btn small" :disabled="genBusy.has(c.id)" @click.stop="genVariant(c)">{{ genBusy.has(c.id) ? t('views.wrongBook.generating') : t('views.wrongBook.genVariantBtn') }}</button>
        <button class="btn small" @click.stop="dueNow(c)">{{ t('views.wrongBook.addReviewBtn') }}</button>
        <button class="btn small danger" @click.stop="unmark(c)">{{ t('views.wrongBook.unmarkBtn') }}</button>
      </div>
      <!-- 默认全展开（collapsedIds 里没有=显示详情）；手动收起的才显示 plain 预览 -->
      <template v-if="collapsedIds.has(c.id)">
        <div class="wb-front">{{ plain(c.front) }}</div>
        <div class="wb-back">{{ plain(c.back) }}</div>
      </template>
      <template v-else>
        <div class="wb-detail">
          <div class="hint" style="margin:4px 0 4px">{{ t('views.wrongBook.frontLabel') }}</div>
          <MarkdownRenderer :content="c.front" />
          <div class="hint" style="margin:14px 0 4px">{{ t('views.wrongBook.backLabel') }}</div>
          <MarkdownRenderer :content="c.back" />
        </div>
      </template>

      <!-- P2·#11 智能补救结果面板 -->
      <div v-if="remediation && remediation.card?.id === c.id" class="remediation-box">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <b>{{ t('views.wrongBook.remediateTitle') }}</b>
          <span class="hint">{{ t('views.wrongBook.remediateChain') }}</span>
          <span style="flex:1"></span>
          <button class="btn small" @click="closeRemediation">{{ t('views.wrongBook.closeBtn') }}</button>
        </div>
        <div class="rm-section">
          <div class="rm-section-title">{{ t('views.wrongBook.diagTitle') }}</div>
          <div>{{ remediation.diagnosis.summary }}</div>
          <div class="hint" style="margin-top:4px">
            {{ t('views.wrongBook.recentReview', { fail: remediation.diagnosis.failCount, fuzzy: remediation.diagnosis.fuzzyCount, rate: Math.round(remediation.diagnosis.failRate * 100) }) }}<span v-if="remediation.diagnosis.wrongReason">{{ t('views.wrongBook.wrongReasonPrefix') }}{{ remediation.diagnosis.wrongReason }}</span>
          </div>
        </div>
        <div class="rm-section">
          <div class="rm-section-title">{{ t('views.wrongBook.feynmanTitle') }}</div>
          <div class="hint" style="margin:4px 0">{{ remediation.feynmanHint.prompt }}</div>
          <button class="btn small primary" @click="goFeynman">{{ t('views.wrongBook.goFeynmanBtn') }}</button>
        </div>
        <div v-if="remediation.variantCards?.length" class="rm-section">
          <div class="rm-section-title">{{ t('views.wrongBook.variantCardsTitle', { n: remediation.variantCards.length }) }}</div>
          <div v-for="(v, i) in remediation.variantCards" :key="i" class="rm-variant">
            <div v-if="!v.error"><b>{{ t('views.wrongBook.variantFront') }}</b>{{ v.front }} <span class="hint">→ {{ v.subject }}</span></div>
            <div v-else style="color:var(--red)">{{ v.error }}</div>
          </div>
        </div>
        <div v-if="remediation.graphLinks?.length" class="rm-section">
          <div class="rm-section-title">{{ t('views.wrongBook.graphLinksTitle', { n: remediation.graphLinks.length }) }}</div>
          <div v-for="(e, i) in remediation.graphLinks" :key="i" class="rm-edge">
            <span>{{ e.from }}</span>
            <span class="rm-rel">{{ e.label }}</span>
            <span>{{ e.to }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wb-item { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--red); border-radius: var(--radius); padding: 14px 16px; margin-bottom: 12px; transition: border-color .2s, box-shadow .2s; }
.wb-item.expanded { border-color: var(--accent); box-shadow: 0 6px 20px rgba(0,0,0,.08); }
.wb-front { font-weight: 600; line-height: 1.6; }
.wb-back { color: var(--ink-2); margin-top: 6px; line-height: 1.6; font-size: 14px; }
.wb-detail { border-top: 1px dashed var(--line); margin-top: 10px; padding-top: 10px; }

/* —— 速赢区：阶段过滤条 —— */
.stage-bar { display: flex; gap: 6px; flex-wrap: wrap; margin: 12px 0 16px; }
.stage-bar .chip { padding: 5px 12px; font-size: 13px; }
.stage-bar .chip .n { opacity: .65; margin-left: 4px; font-weight: 600; }
.stage-bar .chip[disabled] { opacity: .4; cursor: not-allowed; }
.stage-bar .chip.on[disabled] { opacity: 1; cursor: default; }
.remediation-box { margin-top: 12px; padding: 12px 14px; background: var(--code-bg); border-radius: 8px; border: 1px solid var(--accent); }
.rm-section { margin-top: 10px; padding: 8px 10px; background: var(--panel); border-radius: 6px; }
.rm-section-title { font-size: 13px; font-weight: 600; color: var(--ink); margin-bottom: 4px; }
.rm-variant { padding: 4px 0; font-size: 13px; }
.rm-edge { display: flex; gap: 6px; align-items: center; padding: 4px 0; font-size: 13px; }
.rm-rel { color: var(--accent); font-size: 12px; }
</style>
