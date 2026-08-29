<template>
  <div class="insight">
    <h2>卡片洞察 · 为什么今天该复习</h2>
    <div class="bar">
      <select class="input" v-model="subject" @change="load">
        <option value="">全部科目</option>
        <option v-for="s in subjects" :key="s" :value="s">{{ s }}</option>
      </select>
      <input class="input" v-model="kw" placeholder="搜索正面内容" />
      <button class="btn" @click="buildGraph">重建知识图谱</button>
      <label class="exam">目标考试日 <input class="input exam-in" type="date" v-model="examDate" /></label>
    </div>

    <!-- 冷启动前测：自评该科目熟悉度 → 估计初始稳定度（新卡首次排程用） -->
    <div class="pretest">
      <span class="pt-label">前测 · {{ ptSubject || '选科目' }} 熟悉度</span>
      <select class="input pt-subj" v-model="ptSubject">
        <option v-for="s in subjects" :key="s" :value="s">{{ s }}</option>
      </select>
      <input type="range" min="0" max="5" step="1" v-model.number="ptFam" class="pt-range" />
      <span class="pt-val">{{ ptFam }}（{{ ['完全不会','刚接触','有点印象','基本掌握','比较熟','滚瓜烂熟'][ptFam] }}）</span>
      <button class="btn small" @click="savePretest">保存前测</button>
      <span class="pt-saved" v-if="ptSaved">已存：S ≈ {{ ptSavedS }} 天</span>
    </div>

    <div class="cols">
      <div class="list">
        <div v-for="c in filtered" :key="c.id" class="row" :class="{ on: c.id === sel?.id }" @click="sel = c">
          <span class="subj">{{ c.subject }}</span>
          <span class="front">{{ (c.front || '').slice(0, 30) }}</span>
          <span v-if="c.examUrgency!=null" class="urg" :style="{ background: urgencyColor(c.examUrgency) }">考 {{ (c.examUrgency*100).toFixed(0) }}</span>
        </div>
        <EmptyState v-if="!filtered.length" icon="🗂️" title="暂无卡片" message="先去「我的卡片」添加，再回来看洞察" />
      </div>

      <div class="detail" v-if="sel">
        <ForgettingCurve :card="sel" :reviews="hist" :examAt="examTs" />
        <div class="sec" v-if="prereq.length">
          <h3>建议先补的前置卡片</h3>
          <div v-for="id in prereq" :key="id" class="chip" @click="jump(id)">{{ cardTitle(id) }}</div>
        </div>
        <div class="sec" v-if="related.length">
          <h3>相关薄弱卡</h3>
          <div v-for="id in related" :key="id" class="chip" @click="jump(id)">{{ cardTitle(id) }}</div>
        </div>
        <EmptyState v-if="!prereq.length && !related.length" compact icon="🕸️" title="暂无图谱关联" message="点「重建知识图谱」自动生成" />
      </div>
      <EmptyState v-else icon="🗂️" title="从左侧选择一张卡片" message="查看遗忘曲线与知识图谱关联" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { db } from '../db.js';
import ForgettingCurve from '../components/ForgettingCurve.vue';
import EmptyState from '../components/EmptyState.vue';
import { derivePrereqPlan, autoBuildGraph } from '../algorithms/graphAuto.js';
import { prioritizeForExam } from '../algorithms/scheduling.js';
import { estimateInitialStability } from '../algorithms/pretest.js';

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

const examTs = computed(() => examDate.value ? new Date(examDate.value).getTime() : 0);

// 考试日期落库（db.meta.examAt）：供复习页/调度器跨页读取（考试窗口压缩 + 紧迫度标注）
watch(examDate, async (v) => {
  await db.meta.put({ key: 'examAt', value: v || '' });
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
  const reviews = await db.reviews.where('cardId').equals(c.id).toArray();
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

async function buildGraph() {
  const res = await autoBuildGraph();
  await load();
  sel.value && selectCard(sel.value);
  alert(`图谱已重建：${res.stats.prereq} 条前置边 / ${res.stats.related} 条相关边 / ${res.stats.cards} 张卡`);
}

// 保存前测：把该科目的估计初始稳定度写入 meta['pretestStability']
async function savePretest() {
  if (!ptSubject.value) { alert('请先选择科目'); return; }
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
.empty { color: var(--ink-2); padding: 20px; text-align: center; }
.pretest { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 14px; margin-bottom: 14px; font-size: 13px; color: var(--ink-2); }
.pt-label { font-weight: 600; color: var(--ink); }
.pt-subj { width: 140px; }
.pt-range { width: 160px; }
.pt-val { min-width: 90px; }
.pt-saved { color: var(--green); }
.sec { margin-top: 14px; }
.sec h3 { font-size: 14px; margin: 0 0 8px; color: var(--ink-2); }
.chip { display: inline-block; margin: 4px; cursor: pointer; }
</style>
