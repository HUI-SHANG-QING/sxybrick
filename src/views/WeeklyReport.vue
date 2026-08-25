<script setup>
// 每周学习报告（借鉴 Progress AI，纯本地聚合 + 可选 AI 总结）：按周统计学习数据，
// 可生成 AI 点评并保存存档（按周 upsert），历史报告可回看/删除，全部随数据包同步
import { ref, computed, onMounted } from 'vue';
import { db } from '../db.js';
import { listWeeklyReports, getWeeklyReportByWeek, saveWeeklyReport, deleteWeeklyReport } from '../repo.js';
import { chatAI, hasAIKey } from '../ai.js';
import { toast } from '../utils/toast.js';

const DAY = 86400000;
const reports = ref([]);
const weekStart = ref(0);
const data = ref(null);
const summary = ref('');
const aiLoading = ref(false);
const existing = ref(null);

function mondayOf(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}
const p2 = n => String(n).padStart(2, '0');
function fmtShort(ts) {
  const d = new Date(ts);
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
const weekLabel = computed(() => `${fmtShort(weekStart.value)} ~ ${fmtShort(weekStart.value + 6 * DAY)}`);

async function loadHistory() { reports.value = await listWeeklyReports(); }

async function aggregate(ws) {
  const from = ws, to = ws + 7 * DAY;
  const [reviews, cards, pomos, docs, plans, chats, edges, memos] = await Promise.all([
    db.reviews.toArray(), db.cards.toArray(), db.pomoSessions.toArray(),
    db.docs.toArray(), db.plans.toArray(), db.aiChats.toArray(), db.graphEdges.toArray(), db.memos.toArray(),
  ]);
  const rWeek = reviews.filter(r => r.reviewedAt >= from && r.reviewedAt < to);
  const correct = rWeek.filter(r => r.rating === 2).length;
  const cardIds = new Set(rWeek.map(r => r.cardId));
  const cardsMap = new Map(cards.map(c => [c.id, c]));
  const subjectReview = new Map();
  for (const r of rWeek) {
    const s = cardsMap.get(r.cardId)?.subject || '未分类';
    subjectReview.set(s, (subjectReview.get(s) || 0) + 1);
  }
  const newCards = cards.filter(c => c.createdAt >= from && c.createdAt < to);
  const subjectNew = new Map();
  for (const c of newCards) subjectNew.set(c.subject || '未分类', (subjectNew.get(c.subject || '未分类') || 0) + 1);
  const topSubjects = [...subjectReview.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const pomosWeek = pomos.filter(p => p.startedAt >= from && p.startedAt < to);
  return {
    reviews: rWeek.length,
    reviewedCards: cardIds.size,
    correctRate: rWeek.length ? Math.round((correct / rWeek.length) * 100) : 0,
    wrong: rWeek.filter(r => r.rating === 0).length,
    fuzzy: rWeek.filter(r => r.rating === 1).length,
    newCards: newCards.length,
    pomo: pomosWeek.length,
    pomoMinutes: pomosWeek.reduce((s, p) => s + (p.duration || 0), 0),
    docs: docs.filter(d => d.createdAt >= from && d.createdAt < to).length,
    plansDone: plans.filter(p => p.status === 'done' && (p.updatedAt >= from && p.updatedAt < to)).length,
    feynman: chats.filter(c => c.type === 'feynman' && (c.updatedAt >= from && c.updatedAt < to)).length,
    graphEdges: edges.filter(e => e.createdAt >= from && e.createdAt < to).length,
    memos: memos.filter(m => m.at >= from && m.at < to).length,
    topSubjects,
    topNewSubjects: [...subjectNew.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

async function selectWeek(ws) {
  weekStart.value = ws;
  data.value = await aggregate(ws);
  existing.value = await getWeeklyReportByWeek(ws);
  summary.value = existing.value?.summary || '';
}

function shiftWeek(delta) { selectWeek(weekStart.value + delta * 7 * DAY); }

async function aiSummarize() {
  if (!hasAIKey()) { toast('请先在「AI 设置」里填入密钥', 'error'); return; }
  if (!data.value) return;
  aiLoading.value = true;
  try {
    const d = data.value;
    const text = [
      `本周复习 ${d.reviews} 次（涉及 ${d.reviewedCards} 张卡），正确率 ${d.correctRate}%，没记住 ${d.wrong} 次、还模糊 ${d.fuzzy} 次；`,
      `新建卡片 ${d.newCards} 张；番茄专注 ${d.pomo} 个（${d.pomoMinutes} 分钟）；新文档 ${d.docs} 篇；完成计划 ${d.plansDone} 个；费曼练习 ${d.feynman} 次；新增图谱关联 ${d.graphEdges} 条；备忘 ${d.memos} 条。`,
      `复习最多的科目：${d.topSubjects.map(([s, n]) => `${s}(${n})`).join('、') || '无'}；`,
      `新建卡片最多的科目：${d.topNewSubjects.map(([s, n]) => `${s}(${n})`).join('、') || '无'}。`,
    ].join('\n');
    const r = await chatAI([
      { role: 'system', content: '你是学习教练。根据下面这周的学习数据，写一段 150~250 字的周报总结：肯定亮点、指出薄弱点、给出下周 2~3 条具体可执行的建议。用中文，语气亲切。' },
      { role: 'user', content: text },
    ]);
    summary.value = String(r || '').trim();
    toast('AI 总结已生成，可编辑后再保存', 'success');
  } catch (e) { toast('生成失败：' + e.message, 'error'); }
  finally { aiLoading.value = false; }
}

async function saveReport() {
  if (!data.value) return;
  await saveWeeklyReport({ weekStart: weekStart.value, title: `${weekLabel.value} 学习周报`, data: data.value, summary: summary.value });
  await loadHistory();
  existing.value = await getWeeklyReportByWeek(weekStart.value);
  toast('周报已保存（可跨设备同步）', 'success');
}

async function removeReport(r) {
  if (!confirm(`删除「${r.title}」？`)) return;
  await deleteWeeklyReport(r.id);
  if (r.weekStart === existing.value?.weekStart) { existing.value = null; summary.value = ''; }
  await loadHistory();
}

function openReport(r) {
  selectWeek(r.weekStart).then(() => { summary.value = r.summary || ''; });
}

onMounted(async () => {
  await loadHistory();
  await selectWeek(mondayOf(Date.now()));
});
</script>

<template>
  <div class="wr-wrap">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">每周报告</h2>
      <span style="flex:1"></span>
      <button class="btn small" @click="shiftWeek(-1)">← 上一周</button>
      <span class="hint" style="font-weight:600">{{ weekLabel }}</span>
      <button class="btn small" @click="shiftWeek(1)">下一周 →</button>
    </div>
    <p class="hint" style="margin:4px 0 14px">自动汇总本周学习数据；点「AI 生成总结」让 AI 点评并给建议，保存后可随时回看。</p>

    <div class="wr-body">
      <aside class="wr-list">
        <div v-if="!reports.length" class="hint" style="padding:10px">还没有存档。选好周、点「保存周报」即可归档。</div>
        <div v-for="r in reports" :key="r.id" class="wr-item" :class="{ active: existing?.id === r.id }" @click="openReport(r)">
          <div class="wr-title">{{ r.title }}</div>
          <div class="wr-meta">{{ new Date(r.updatedAt).toLocaleDateString() }} <a class="wr-del" @click.stop="removeReport(r)">删</a></div>
        </div>
      </aside>

      <section class="wr-main">
        <div v-if="data" class="wr-cards">
          <div class="stat"><div class="num">{{ data.reviews }}</div><div class="lbl">本周复习次数</div></div>
          <div class="stat"><div class="num">{{ data.reviewedCards }}</div><div class="lbl">涉及卡片</div></div>
          <div class="stat"><div class="num">{{ data.correctRate }}%</div><div class="lbl">正确率</div></div>
          <div class="stat"><div class="num">{{ data.newCards }}</div><div class="lbl">新建卡片</div></div>
          <div class="stat"><div class="num">{{ data.pomo }}</div><div class="lbl">番茄（{{ data.pomoMinutes }} 分钟）</div></div>
          <div class="stat"><div class="num">{{ data.docs }}</div><div class="lbl">新文档</div></div>
          <div class="stat"><div class="num">{{ data.plansDone }}</div><div class="lbl">完成计划</div></div>
          <div class="stat"><div class="num">{{ data.feynman }}</div><div class="lbl">费曼练习</div></div>
        </div>

        <div v-if="data?.topSubjects.length" class="wr-line hint">
          复习最多：{{ data.topSubjects.map(([s, n]) => `${s} ${n} 次`).join(' · ') }}
        </div>

        <div class="wr-ai">
          <div class="wr-ai-head">
            <span class="field-label" style="margin:0">AI 总结（可手动编辑）</span>
            <span style="flex:1"></span>
            <button class="btn small" :disabled="aiLoading" @click="aiSummarize">{{ aiLoading ? 'AI 生成中…' : 'AI 生成总结' }}</button>
            <button class="btn small primary" @click="saveReport">保存周报</button>
          </div>
          <textarea v-model="summary" class="input" rows="8" placeholder="点「AI 生成总结」，或自己写一段本周复盘…"></textarea>
        </div>

        <div v-if="!data?.reviews && data?.newCards === 0" class="hint" style="margin-top:10px">这一周还没有学习记录；前后翻周看看，或开始今天的学习。</div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.wr-wrap { max-width: 1000px; margin: 0 auto; }
.wr-body { display: grid; grid-template-columns: 240px 1fr; gap: 12px; }
.wr-list { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 8px; max-height: calc(100vh - 220px); overflow-y: auto; }
.wr-item { padding: 8px 10px; border-radius: 8px; cursor: pointer; margin-bottom: 4px; border: 1px solid transparent; }
.wr-item:hover { background: var(--code-inline); }
.wr-item.active { background: var(--code-bg); border-color: var(--accent); }
.wr-title { font-weight: 600; font-size: 13px; }
.wr-meta { font-size: 11px; color: var(--ink-2); margin-top: 2px; }
.wr-del { color: var(--red); margin-left: 6px; cursor: pointer; }
.wr-main { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 14px 16px; }
.wr-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
.stat { background: var(--code-bg); border: 1px solid var(--line); border-radius: 10px; padding: 10px; text-align: center; }
.stat .num { font-size: 22px; font-weight: 700; color: var(--accent); }
.stat .lbl { font-size: 11px; color: var(--ink-2); margin-top: 2px; }
.wr-line { margin-top: 10px; }
.wr-ai { margin-top: 14px; }
.wr-ai-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.wr-ai textarea { width: 100%; box-sizing: border-box; }
@media (max-width: 720px) { .wr-body { grid-template-columns: 1fr; } .wr-list { max-height: 160px; } }
</style>