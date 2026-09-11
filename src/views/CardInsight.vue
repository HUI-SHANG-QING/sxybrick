<template>
  <div class="insight">
    <h2>{{ t('views.cardInsight.title') }}</h2>
    <div class="bar">
      <select class="input" v-model="subject" @change="load">
        <option value="">{{ t('views.cardInsight.allSubjects') }}</option>
        <option v-for="s in subjects" :key="s" :value="s">{{ s }}</option>
      </select>
      <input class="input" v-model="kw" :placeholder="t('views.cardInsight.searchPlaceholder')" />
      <button class="btn" @click="buildGraph">{{ t('views.cardInsight.rebuildGraph') }}</button>
      <label class="exam">{{ t('views.cardInsight.examLabel') }} <input class="input exam-in" type="date" v-model="examDate" /></label>
    </div>

    <!-- 冷启动前测：自评该科目熟悉度 → 估计初始稳定度（新卡首次排程用） -->
    <div class="pretest">
      <span class="pt-label">{{ t('views.cardInsight.pretestLabel', '前测 · {subject} 熟悉度', { subject: ptSubject || t('views.cardInsight.selectSubject') }) }}</span>
      <select class="input pt-subj" v-model="ptSubject">
        <option v-for="s in subjects" :key="s" :value="s">{{ s }}</option>
      </select>
      <input type="range" min="0" max="5" step="1" v-model.number="ptFam" class="pt-range" />
      <span class="pt-val">{{ ptFam }}（{{ t('views.cardInsight.famLevels')[ptFam] }}）</span>
      <button class="btn small" @click="savePretest">{{ t('views.cardInsight.savePretest') }}</button>
      <span class="pt-saved" v-if="ptSaved">{{ t('views.cardInsight.pretestSaved', '已存：S ≈ {s} 天', { s: ptSavedS }) }}</span>
      <button class="btn mini pt-detail-btn" @click="ptDetailOpen = !ptDetailOpen">{{ ptDetailOpen ? t('views.cardInsight.collapseBtn', '▲ 收起') : t('views.cardInsight.expandBtn', '▼ 点击展开查看') }}</button>
      <div v-if="ptDetailOpen" class="pt-detail">
        <div class="pt-detail-title">{{ t("views.cardInsight.ptDetailTitle", "前测数值说明") }}</div>
        <div class="pt-detail-row"><b>{{ t("views.cardInsight.ptSubjLabel", "科目") }}</b>{{ t("views.cardInsight.ptSubjDesc", "：选择冷启动科目，结果按科目分别保存。") }}</div>
        <div class="pt-detail-row"><b>{{ t("views.cardInsight.ptFamLabel", "熟悉度 0~5") }}</b>{{ t("views.cardInsight.ptFamDesc", "：0=完全不会→0.5天，5=滚瓜烂熟→12天基准。当前5对应12天。") }}</div>
        <div class="pt-detail-row"><b>{{ t("views.cardInsight.ptFactorLabel", "难度系数") }}</b>{{ t("views.cardInsight.ptFactorDesc", "：线代命中0.82（理科首次更难内化）。") }}</div>
        <div class="pt-detail-row"><b>{{ t("views.cardInsight.ptDiffLabel", "难度微调") }}</b>{{ t("views.cardInsight.ptDiffDesc", "：basic新卡×1.1。") }}</div>
        <div class="pt-detail-row"><b>{{ t("views.cardInsight.ptSLabel", "S≈10.8天") }}</b>{{ t("views.cardInsight.ptSDesc", " = 12.0 × 0.82 × 1.1 = 10.82。即新卡首次复习间隔约10.8天。") }}</div>
        <div class="pt-detail-row ok">{{ t("views.cardInsight.ptOk", "✓ 数值计算正确。保存后无复习历史的新卡用此S起步，已有历史的卡不受影响。") }}</div>
      </div>
    </div>

    <div class="cols">
      <div class="list">
        <div v-for="c in filtered" :key="c.id" class="row" :class="{ on: c.id === sel?.id }" @click="sel = c">
          <span class="subj">{{ c.subject }}</span>
          <span class="front">{{ (c.front || '').slice(0, 30) }}</span>
          <span v-if="c._examUrgency!=null" class="urg" :style="{ background: urgencyColor(c._examUrgency) }">{{ t('views.cardInsight.examBadge', '考 {n}', { n: (c._examUrgency * 100).toFixed(0) }) }}</span>
        </div>
        <EmptyState v-if="!filtered.length" icon="🗂️" :title="t('views.cardInsight.emptyListTitle')" :message="t('views.cardInsight.emptyListMsg')" />
      </div>

      <div class="detail" v-if="sel">
        <!-- 卡片正文：点击列表/相关薄弱卡后可直接查看该卡详情，避免只能看曲线看不到卡 -->
        <div class="card-body">
          <div class="cb-row"><span class="cb-tag">{{ t('views.cardInsight.frontLabel') }}</span><div class="cb-text">{{ sel.front }}</div></div>
          <div class="cb-row"><span class="cb-tag">{{ t('views.cardInsight.backLabel') }}</span><div class="cb-text">{{ sel.back }}</div></div>
          <div class="cb-actions">
            <button class="btn small primary" @click="openDetail(sel)">{{ t('views.cardInsight.viewDetail') }}</button>
          </div>
        </div>
        <ForgettingCurve :card="sel" :reviews="hist" :examAt="examTs" />
        <div class="sec" v-if="prereq.length">
          <h3>{{ t('views.cardInsight.prereqTitle') }}</h3>
          <div v-for="id in prereq" :key="id" class="chip" @click="openDetailById(id)">{{ cardTitle(id) }}</div>
        </div>
        <div class="sec" v-if="related.length">
          <h3>{{ t('views.cardInsight.relatedTitle') }}</h3>
          <div v-for="id in related" :key="id" class="chip" @click="openDetailById(id)">{{ cardTitle(id) }}</div>
        </div>
        <EmptyState v-if="!prereq.length && !related.length" compact icon="🕸️" :title="t('views.cardInsight.noGraphTitle')" :message="t('views.cardInsight.noGraphMsg')" />
      </div>
      <EmptyState v-else icon="🗂️" :title="t('views.cardInsight.noSelTitle')" :message="t('views.cardInsight.noSelMsg')" />
    </div>

    <!-- 完整卡片详情/编辑：点击相关薄弱卡、前置卡或「查看完整卡片」打开 -->
    <CardModal v-model="detailOpen" :card="detailCard" @saved="onDetailSaved" />
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { db } from '../db.js';
import ForgettingCurve from '../components/ForgettingCurve.vue';
import EmptyState from '../components/EmptyState.vue';
import CardModal from '../components/CardModal.vue';
import { toast } from '../utils/toast.js';
import { derivePrereqPlan, autoBuildGraph } from '../algorithms/graphAuto.js';
import { prioritizeForExam } from '../algorithms/scheduling.js';
import { estimateInitialStability } from '../algorithms/pretest.js';
import { t } from '../i18n/index.js';

const cards = ref([]);
const subjects = ref([]);
const subject = ref('');
const kw = ref('');
const sel = ref(null);
const hist = ref([]);
const prereq = ref([]);
const related = ref([]);
const examDate = ref('');

// 前测状态
const ptSubject = ref('');
const ptFam = ref(2);
const ptSaved = ref(false);
const ptSavedS = ref('');
const ptDetailOpen = ref(false);

const examTs = computed(() => examDate.value ? new Date(examDate.value).getTime() : 0);

// 考试日期落库（db.meta.examAt）：供复习页/调度器跨页读取（考试窗口压缩 + 紧迫度标注）
// 审计 P1-1（round36）：补 updatedAt——合并侧（sync.js/hub.js）按「updatedAt 谁新听谁」
// 裁决，旧写入端不记时间 → updatedAt 恒 0，任何远端 meta 都能覆盖本机刚设置的日期，
// 考试倒计时与临考窗口调度随之失效。
watch(examDate, async (v) => {
  // 审计 P1（round37）：load() 回填已存日期会触发本 watch → 值没变却 bump 了
  // updatedAt（「值旧章新」），多设备上会击穿 LWW 裁决、反向覆盖远端的真实修改。
  // 回写前先比对当前库里的值：一致则视为「仅回填」，不写库、不刷新时间戳。
  const cur = await db.meta.get('examAt');
  if (cur && String(cur.value ?? '') === String(v || '')) return;
  await db.meta.put({ key: 'examAt', value: v || '', updatedAt: Date.now() });
});

const filtered = computed(() => {
  let list = cards.value;
  if (subject.value) list = list.filter(c => c.subject === subject.value);
  if (kw.value.trim()) list = list.filter(c => (c.front || '').includes(kw.value.trim()));
  if (examTs.value) list = prioritizeForExam(list, examTs.value);
  return list;
});

function urgencyColor(u) {
  if (u >= 0.6) return '#e2724f';
  if (u >= 0.3) return '#e0a93b';
  return 'rgba(123,191,106,.8)';
}

async function load() {
  const all = await db.cards.toArray();
  cards.value = all;
  subjects.value = [...new Set(all.map(c => c.subject).filter(Boolean))];
  // 回填已保存的考试日期（若有）
  if (!examDate.value) {
    const row = await db.meta.get('examAt');
    if (row?.value) examDate.value = row.value;
  }
}

async function selectCard(c) {
  sel.value = c;
  const reviews = (await db.reviews.where('cardId').equals(c.id).toArray()).filter(r => r.type !== 'quick');
  hist.value = reviews;
  const plan = await derivePrereqPlan(c.id);
  prereq.value = plan.prereqCardIds;
  related.value = plan.relatedCardIds;
}
watch(sel, (c) => { if (c) selectCard(c); });

function cardTitle(id) {
  const c = cards.value.find(x => x.id === id);
  return c ? `${c.subject} · ${(c.front || '').slice(0, 20)}` : id;
}
function jump(id) {
  const c = cards.value.find(x => x.id === id);
  if (c) sel.value = c;
}

// 打开完整卡片详情（CardModal，可查看/编辑）：相关薄弱卡/前置卡点击跳转查看详情
const detailOpen = ref(false);
const detailCard = ref(null);
function openDetailById(id) {
  const c = cards.value.find(x => x.id === id);
  openDetail(c);
}
function openDetail(c) {
  if (!c) return;
  sel.value = c; // 同步选中，详情曲线跟随
  detailCard.value = c;
  detailOpen.value = true;
}
async function onDetailSaved() {
  detailOpen.value = false;
  await load(); // 内容/标签可能已改，刷新列表与关联
  if (sel.value?.id) {
    const fresh = cards.value.find(x => x.id === sel.value.id);
    if (fresh) sel.value = fresh;
  }
  toast(t('views.cardInsight.cardSaved'), 'success');
}

async function buildGraph() {
  const res = await autoBuildGraph();
  await load();
  sel.value && selectCard(sel.value);
  alert(t('views.cardInsight.graphRebuilt', '图谱已重建：{prereq} 条前置边 / {related} 条相关边 / {cards} 张卡', { prereq: res.stats.prereq, related: res.stats.related, cards: res.stats.cards }));
}

// 保存前测：把该科目的估计初始稳定度写入 meta['pretestStability']
async function savePretest() {
  if (!ptSubject.value) { alert(t('views.cardInsight.pickSubjectFirst')); return; }
  const s = estimateInitialStability({ familiarity: ptFam.value, difficulty: 'basic', subject: ptSubject.value });
  const row = await db.meta.get('pretestStability');
  const map = row && typeof row.value === 'object' ? { ...row.value } : {};
  map[ptSubject.value] = s;
  await db.meta.put({ key: 'pretestStability', value: map });
  ptSaved.value = true;
  ptSavedS.value = s.toFixed(1);
}

load();
</script>

<style scoped>
.insight { max-width: 980px; margin: 0 auto; }
.bar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; align-items: center; }
.input { width: auto; }
.exam { font-size: 13px; color: var(--ink-2); display: flex; gap: 6px; align-items: center; }
.exam-in { width: 150px; }
.cols { display: grid; grid-template-columns: 1fr 1.2fr; gap: 16px; }
.list { display: flex; flex-direction: column; gap: 6px; max-height: 520px; overflow: auto; }
.row { display: flex; gap: 8px; align-items: center; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
.row.on { border-color: var(--accent); background: var(--code-bg); }
.subj { font-size: 12px; color: var(--tag-ink); background: var(--tag-bg); border-radius: 6px; padding: 2px 6px; }
.front { flex: 1; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.urg { font-size: 11px; color: #fff; border-radius: 6px; padding: 2px 6px; }
.detail { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px; }
.card-body { margin-bottom: 14px; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--code-bg); }
.cb-row { display: flex; gap: 10px; margin-bottom: 6px; align-items: flex-start; }
.cb-row:last-of-type { margin-bottom: 0; }
.cb-tag { flex-shrink: 0; font-size: 11px; color: var(--tag-ink); background: var(--tag-bg); border-radius: 6px; padding: 2px 6px; margin-top: 2px; }
.cb-text { flex: 1; color: var(--ink); line-height: 1.55; white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow: auto; }
.cb-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
.empty { color: var(--ink-2); padding: 20px; text-align: center; }
.pretest { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 14px; margin-bottom: 14px; font-size: 13px; color: var(--ink-2); }
.pt-label { font-weight: 600; color: var(--ink); }
.pt-subj { width: 140px; }
.pt-range { width: 160px; }
.pt-val { min-width: 90px; }
.pt-saved { color: var(--green); }
.pt-detail-btn { margin-left: auto; flex: none; }
.pt-detail { width: 100%; margin-top: 8px; padding: 10px 12px; background: var(--code-bg); border-radius: 8px; font-size: 12px; line-height: 1.7; color: var(--ink-2); }
.pt-detail-title { font-weight: 600; color: var(--ink); margin-bottom: 6px; }
.pt-detail-row { margin-bottom: 4px; }
.pt-detail-row b { color: var(--ink); }
.pt-detail-row.ok { color: var(--green); margin-top: 6px; }
.sec { margin-top: 14px; }
.sec h3 { font-size: 14px; margin: 0 0 8px; color: var(--ink-2); }
.chip { display: inline-block; margin: 4px; cursor: pointer; }
</style>
