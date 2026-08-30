<script setup>
// M2 卡片智能联动分析工作台
// 左：已选卡片（可增删）｜中：对话/结果区（多轮，每轮基于当前卡片集）｜底：输入框 + 预设快捷按钮
// 双模式：本地（离线启发式）/ AI（统一 LLM 入口，失败自动降级本地并提示）
// 结果类型：graph（ECharts，卸载 dispose 防泄漏）/ timeline / list / text（Markdown）
// 会话与消息持久化到 db.analysisSessions / analysisMessages（参与同步）
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as echarts from 'echarts';
import { toast } from '../utils/toast.js';
import { db, uid } from '../db.js';
import { listCards, createCardGroup } from '../repo.js';
import { getAIConfig, hasAIKey } from '../ai.js';
import { runAnalysis } from '../analysis/link-engine.js';
import { normalizeGraphEnds } from '../algorithms/graph-resolve.js';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';

const route = useRoute();
const router = useRouter();

// 写库前脱 reactive：Vue ref/reactive 的 proxy 不能被 IndexedDB 的 structuredClone 克隆，
// 直接 put 会抛 DataCloneError（#<Object> could not be cloned）。见 tests/vue-clone-sankey.test.mjs。
function dbRow(obj) { return JSON.parse(JSON.stringify(obj ?? {})); }

// ---------- 已选卡片 ----------
const cards = ref([]);
const addFilter = ref('');
async function loadCards() {
  const q = String(route.query.cardIds || '');
  const ids = q ? q.split(',').filter(Boolean) : [];
  if (ids.length) {
    cards.value = (await db.cards.bulkGet(ids)).filter(Boolean);
  } else {
    // 无 query 时取最近更新的 30 张（listCards 默认按 updatedAt 降序）
    cards.value = (await listCards({})).items.slice(0, 30);
  }
}
async function addCardById() {
  const kw = addFilter.value.trim();
  if (!kw) return;
  const hit = (await db.cards.filter(c => (c.front || '').includes(kw) || (c.back || '').includes(kw)).limit(5)).toArray();
  if (!hit.length) return toast('未找到匹配卡片', 'info');
  const missing = hit.filter(c => !cards.value.some(x => x.id === c.id));
  if (!missing.length) return toast('已在列表中', 'info');
  cards.value = [...cards.value, ...missing];
  addFilter.value = '';
}
function removeCard(id) { cards.value = cards.value.filter(c => c.id !== id); }

// ---------- 会话与消息 ----------
const sessions = ref([]);
const currentSession = ref(null);
const messages = ref([]); // 当前会话消息（时间正序）
const question = ref('');
const busy = ref(false);
const mode = ref(localStorage.getItem('sxy_analysis_mode') || 'auto'); // auto|local|ai
const aiReady = computed(() => hasAIKey());
watch(mode, v => localStorage.setItem('sxy_analysis_mode', v));

async function loadSessions() {
  sessions.value = (await db.analysisSessions.orderBy('updatedAt').reverse().limit(50).toArray())
    .map(s => ({ ...s, cardIds: safeArr(s.cardIds) }));
}
function safeArr(v) { try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a : []; } catch { return []; } }

async function openSession(s) {
  currentSession.value = s;
  messages.value = (await db.analysisMessages.where('sessionId').equals(s.id).sortBy('t'))
    .map(m => ({ ...m, resultData: safeObj(m.resultData) }));
  await nextTick();
  renderGraphs();
}
function safeObj(v) { try { return typeof v === 'string' ? JSON.parse(v) : (v || null); } catch { return null; } }

async function ensureSession() {
  if (currentSession.value) {
    // 卡片集变更 → 更新会话快照（bump updatedAt 便于同步）
    currentSession.value.cardIds = JSON.stringify(cards.value.map(c => c.id));
    currentSession.value.updatedAt = Date.now();
    await db.analysisSessions.put(dbRow(currentSession.value));
    return currentSession.value;
  }
  const s = {
    id: uid(),
    title: cards.value[0] ? (cards.value[0].front || '').slice(0, 20) + ` 等 ${cards.value.length} 卡` : '分析会话',
    cardIds: JSON.stringify(cards.value.map(c => c.id)),
    mode: mode.value,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.analysisSessions.put(s);
  currentSession.value = s;
  messages.value = [];
  await loadSessions();
  return s;
}
async function newSession() {
  currentSession.value = null;
  messages.value = [];
}

async function deleteSession(s) {
  await db.transaction('rw', db.analysisSessions, db.analysisMessages, async () => {
    await db.analysisMessages.where('sessionId').equals(s.id).delete();
    await db.analysisSessions.delete(s.id);
  });
  if (currentSession.value?.id === s.id) { currentSession.value = null; messages.value = []; }
  await loadSessions();
}

// ---------- 分析执行 ----------
const PRESETS = [
  { key: 'graph', label: '🕸 关系图谱' },
  { key: 'topo', label: '🧭 拓扑排序' },
  { key: 'critical', label: '🎯 关键路径' },
  { key: 'common', label: '🔍 共同知识点' },
  { key: 'path', label: '📋 学习顺序' },
  { key: 'compare', label: '⚖️ 对比前两张' },
];

async function runPreset(key) {
  await ensureSession();
  const s = currentSession.value;
  const userMsg = { id: uid(), sessionId: s.id, role: 'user', question: `预设：${PRESETS.find(p => p.key === key)?.label || key}`, resultType: null, resultData: null, engine: null, t: Date.now() };
  await db.analysisMessages.add(userMsg);
  messages.value.push(userMsg);

  busy.value = true;
  try {
    const result = await runAnalysis(cards.value, { preset: key, mode: mode.value }, getAIConfig(), {});
    await pushResult(result, userMsg.question);
  } catch (e) {
    await pushResult({ type: 'text', data: { text: `分析失败：${e.message || e}` }, engine: 'local' }, userMsg.question);
  } finally {
    busy.value = false;
  }
}

async function ask() {
  const q = question.value.trim();
  if (!q || busy.value) return;
  await ensureSession();
  const s = currentSession.value;
  const userMsg = { id: uid(), sessionId: s.id, role: 'user', question: q, resultType: null, resultData: null, engine: null, t: Date.now() };
  await db.analysisMessages.add(userMsg);
  messages.value.push(userMsg);
  question.value = '';

  busy.value = true;
  try {
    // 多轮上下文：带最近几轮问答（本地模式忽略，AI 模式作为上下文）
    const history = messages.value.filter(m => m.role === 'assistant').slice(-4)
      .map(m => ({ question: m.question, answer: m.resultType === 'text' ? m.resultData?.text || '' : (m.resultData ? JSON.stringify(m.resultData).slice(0, 400) : '') }));
    const result = await runAnalysis(cards.value, { question: q, mode: mode.value, history }, getAIConfig(), {});
    await pushResult(result, q);
  } catch (e) {
    await pushResult({ type: 'text', data: { text: `分析失败：${e.message || e}` }, engine: 'local' }, q);
  } finally {
    busy.value = false;
  }
}

async function pushResult(result, q) {
  const s = currentSession.value;
  const msg = {
    id: uid(), sessionId: s.id, role: 'assistant', question: q,
    resultType: result.type, resultData: JSON.stringify(result.data ?? {}),
    engine: result.engine, note: result.note || null,
    t: Date.now(),
  };
  s.updatedAt = Date.now();
  await db.transaction('rw', db.analysisMessages, db.analysisSessions, async () => {
    await db.analysisMessages.add(dbRow(msg));
    await db.analysisSessions.put(dbRow(s));
  });
  messages.value.push({ ...msg, resultData: result.data ?? null });
  await nextTick();
  renderGraphs();
  scrollBottom();
}

// ---------- 结果 → 操作 ----------
async function createGroupFromResult() {
  // 把 timeline/list/拓扑序（graph.order）结果按顺序建为卡组（临时复习卡组）
  const m = messages.value.filter(x => x.role === 'assistant' && (x.resultType === 'timeline' || x.resultType === 'list' || (x.resultType === 'graph' && x.resultData?.order)))
    .pop();
  if (!m) return toast('当前没有可建组的顺序结果', 'info');
  const d = m.resultData;
  const ids = (d.steps || d.items || d.order || (Array.isArray(d) ? d : [])).map ? (d.steps || d.items || d.order || []).map(x => x.id ?? x) : [];
  const valid = ids.filter(id => cards.value.some(c => c.id === id));
  if (!valid.length) return toast('结果中没有可用卡片', 'info');
  const g = await createCardGroup({ name: `分析顺序 · ${new Date().toLocaleDateString()}`, status: 'active' });
  await import('../repo.js').then(r => r.setCardGroups(valid, [g.id], []));
  toast(`已创建卡组并放入 ${valid.length} 张卡（按结果顺序）`, 'success');
}

// ---------- ECharts 图谱（卸载必 dispose） ----------
let charts = [];
const scrollAnchor = ref(null);
function registerGraph(el) {
  if (!el) return;
  if (!el._chart) el._chart = echarts.init(el);
  requestAnimationFrame(() => renderGraphs());
}
async function scrollBottom() {
  await nextTick();
  scrollAnchor.value?.scrollIntoView({ behavior: 'smooth', block: 'end' });
}
function renderGraphs() {
  charts.forEach(c => c.dispose());
  charts = [];
  // 从 DOM 收集（v-for 更新后 DOM 顺序 = 消息顺序）；实例挂在 el._chart 上复用
  requestAnimationFrame(() => {
    document.querySelectorAll('.al-graph').forEach(el => {
      if (!el._chart) el._chart = echarts.init(el);
      charts.push(el._chart);
    });
    // 按出现顺序把 graph 消息与 .al-graph DOM 一一对应渲染
    const graphMsgs = messages.value.filter(m => m.role === 'assistant' && m.resultType === 'graph');
    const els = [...document.querySelectorAll('.al-graph')];
    graphMsgs.forEach((m, i) => {
      const el = els[i];
      if (!el || !el._chart) return;
      el._chart.setOption(graphOption(m.resultData), true);
    });
  });
}

function graphOption(d) {
  const rawNodes = d?.nodes || [];
  // 端点归一化：本地分析器（relationGraph）用卡片 id 建边，AI 却常常按语义返回节点名。
  // ECharts 在节点带 id 时只按 id 匹配边，不归一化 → 边被静默丢弃，图变成一堆散点。
  const { edges: normEdges, dropped } = normalizeGraphEnds(rawNodes, d?.edges || []);
  if (dropped) console.warn(`[CardLinkAnalysis] ${dropped} 条边的端点定位不到节点，已丢弃`);
  const layout = d?.layout || 'force';

  // 拓扑排序：固定坐标（x=学习顺序，y=科目聚类），有向箭头链
  if (layout === 'topo') {
    const nodes = rawNodes.map(n => ({
      id: n.id, name: n.name, x: n.x, y: n.y,
      symbolSize: n.symbolSize || 16,
      itemStyle: { color: groupColor(n.group) },
      label: { show: true, fontSize: 10 },
    }));
    const edges = normEdges.map(e => ({
      source: e.source, target: e.target, value: e.value,
      symbol: ['none', 'arrow'],
      lineStyle: { width: 2, opacity: 0.7, color: '#888', curveness: 0.04 },
    }));
    return {
      tooltip: { formatter: p => p.dataType === 'edge' ? '学习顺序 →' : (p.data?.name || '') },
      series: [{
        type: 'graph', layout: 'none', roam: true, draggable: true,
        data: nodes, links: edges,
        emphasis: { focus: 'adjacency' },
      }],
    };
  }

  // 关键路径：力导向网络，核心卡（红大节点）高亮，与其相连的边加粗
  if (layout === 'critical') {
    const critSet = new Set(d?.criticalIds || []);
    const nodes = rawNodes.map(n => ({
      id: n.id, name: n.name, symbolSize: n.critical ? 32 : (n.symbolSize || 16),
      itemStyle: { color: n.critical ? '#f56c6c' : groupColor(n.group) },
      label: { show: true, fontSize: 10 },
    }));
    const edges = normEdges.map(e => {
      const isCrit = critSet.has(e.source) && critSet.has(e.target);
      return {
        source: e.source, target: e.target, value: e.value,
        label: e.label ? { show: true, formatter: e.label, fontSize: 9 } : { show: false },
        lineStyle: { width: 1 + (e.value || 0) * 4, opacity: isCrit ? 0.9 : 0.32, color: isCrit ? '#f56c6c' : 'source', curveness: 0.1 },
      };
    });
    return {
      tooltip: { formatter: p => p.dataType === 'edge' ? `${p.data.value ?? ''}` : (p.data?.name || '') },
      legend: { show: false },
      series: [{
        type: 'graph', layout: 'force', roam: true, draggable: true,
        force: { repulsion: 140, edgeLength: 90 },
        data: nodes, links: edges,
        lineStyle: { curveness: 0.1 },
        emphasis: { focus: 'adjacency' },
      }],
    };
  }

  // 默认：关系图谱（力导向）
  const nodes = rawNodes.map(n => ({
    id: n.id, name: n.name, symbolSize: n.symbolSize || 18,
    itemStyle: { color: groupColor(n.group) },
    label: { show: true, fontSize: 10 },
  }));
  const edges = normEdges.map(e => ({
    source: e.source, target: e.target,
    value: e.value, label: e.label ? { show: true, formatter: e.label, fontSize: 9 } : { show: false },
    lineStyle: { width: 1 + (e.value || 0) * 4, opacity: 0.5 },
  }));
  return {
    tooltip: { formatter: p => p.dataType === 'edge' ? `${p.data.value ?? ''}` : (p.data?.name || '') },
    legend: { show: false },
    series: [{
      type: 'graph', layout: 'force', roam: true, draggable: true,
      force: { repulsion: 120, edgeLength: 90 },
      data: nodes, links: edges,
      lineStyle: { color: 'source', curveness: 0.1 },
      emphasis: { focus: 'adjacency' },
    }],
  };
}
const PALETTE = ['#4f7cff', '#2fbf71', '#e6a23c', '#f56c6c', '#9b59b6', '#16a085', '#e67e22', '#607d8b'];
function groupColor(g) {
  const key = String(g || '');
  let h = 0; for (const ch of key) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// list 型结果归一（模板用）
function normalizeList(d) {
  if (!d) return [];
  if (Array.isArray(d)) return d;
  if (Array.isArray(d.items)) return d.items;
  if (Array.isArray(d.same) || Array.isArray(d.diff)) return [...(d.same || []), ...(d.diff || [])];
  return Object.values(d).filter(v => typeof v === 'object').slice(0, 20);
}
function isPathList(d) {
  if (!d) return false;
  if (d.steps) return true;
  const arr = Array.isArray(d.items) ? d.items : (Array.isArray(d) ? d : []);
  return arr.length > 1 && arr.every(x => x && typeof x === 'object' && 'id' in x && ('front' in x || 'step' in x));
}

// 移动端适配：窗口变化时 resize 所有图表
let onResize = null;
onMounted(async () => {
  await loadCards();
  await loadSessions();
  if (sessions.value.length && !route.query.cardIds) {
    // 无 query 时默认打开最近会话（展示历史）
    await openSession(sessions.value[0]);
  } else {
    await nextTick();
  }
  onResize = () => charts.forEach(c => c.resize());
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  // 铁律：ECharts 实例随组件销毁（防内存泄漏）
  charts.forEach(c => c.dispose());
  charts = [];
  if (onResize) window.removeEventListener('resize', onResize);
});
</script>

<template>
  <div class="page al-page">
    <div class="page-head">
      <div>
        <h1>🔗 卡片联动分析</h1>
        <div class="hint">预设一键分析 或 自由提问；本地模式离线可用，AI 模式失败自动降级。</div>
      </div>
      <div class="mode-row">
        <select v-model="mode" class="input" style="width:auto">
          <option value="auto">自动（有密钥用 AI）</option>
          <option value="local">本地模式（离线）</option>
          <option value="ai" :disabled="!aiReady">AI 模式</option>
        </select>
        <span v-if="!aiReady" class="hint">未配置 AI 密钥</span>
        <button class="btn" @click="newSession">＋ 新会话</button>
      </div>
    </div>

    <div class="al-layout">
      <!-- 左：已选卡片 -->
      <aside class="al-side">
        <div class="side-title">已选卡片（{{ cards.length }}）</div>
        <div class="side-add">
          <input v-model="addFilter" class="input" placeholder="按内容搜卡加入…" @keyup.enter="addCardById" />
          <button class="btn" @click="addCardById">＋</button>
        </div>
        <div class="side-list">
          <div v-for="c in cards" :key="c.id" class="side-item">
            <div class="side-text" :title="c.front">
              {{ (c.front || '').slice(0, 26) }}{{ (c.front || '').length > 26 ? '…' : '' }}
            </div>
            <button class="mini-x" @click="removeCard(c.id)" title="移除">✕</button>
          </div>
          <div v-if="!cards.length" class="hint">从「卡片」页多选后点「联动分析」进入，或在上方搜索加入。</div>
        </div>
        <div class="side-sessions">
          <div class="side-title">历史会话（同步）</div>
          <div v-for="s in sessions" :key="s.id" class="sess-row" :class="{ on: currentSession?.id === s.id }" @click="openSession(s)">
            <span class="sess-name">{{ s.title }}</span>
            <button class="mini-x" @click.stop="deleteSession(s)" title="删除会话">✕</button>
          </div>
          <div v-if="!sessions.length" class="hint">暂无</div>
        </div>
      </aside>

      <!-- 中：对话/结果 -->
      <main class="al-main">
        <div v-if="busy" class="hint busy">分析中…（本地即时；AI 约 5-20s）</div>
        <div v-else-if="!messages.length" class="hint empty-hint">
          点下方快捷按钮开始，或直接输入问题，例如：
          「这些卡片之间有什么联系？」「哪张是前置知识？」「帮我排个复习顺序」
        </div>
        <template v-else>
          <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
            <div class="msg-head">
              <span class="msg-role">{{ m.role === 'user' ? '🙋 你' : `🤖 ${m.engine === 'ai' ? 'AI' : m.engine === 'fallback' ? '本地(降级)' : '本地'}` }}</span>
              <span v-if="m.role === 'assistant' && m.note" class="msg-note">{{ m.note }}</span>
            </div>
            <div v-if="m.role === 'user'" class="msg-q">{{ m.question }}</div>
            <template v-else>
              <!-- graph -->
              <div v-if="m.resultType === 'graph'" class="al-graph" :ref="el => registerGraph(el)"></div>
              <button v-if="m.resultType === 'graph' && m.resultData?.order" class="btn mini-btn" @click="createGroupFromResult">🎴 按此顺序创建复习卡组</button>
              <!-- timeline -->
              <div v-else-if="m.resultType === 'timeline'" class="timeline">
                <div v-for="s in (m.resultData?.steps || [])" :key="s.step" class="tl-item">
                  <span class="tl-step">{{ s.step }}</span>
                  <span class="tl-text">{{ s.front || s.title || s.detail }}</span>
                  <span v-if="s.weak" class="tl-weak">薄弱</span>
                </div>
                <button class="btn mini-btn" @click="createGroupFromResult">🎴 按此顺序创建复习卡组</button>
              </div>
              <!-- list -->
              <div v-else-if="m.resultType === 'list'" class="res-list">
                <div v-for="(it, i) in (m.resultData?.items || normalizeList(m.resultData))" :key="i" class="res-item">
                  <b>{{ it.term || it.title || it.rank && `#${it.rank}` || '' }}</b>
                  <span v-if="it.cards" class="hint">{{ it.cards }} 张卡</span>
                  <span v-if="it.front" class="res-front">{{ it.front }}</span>
                  <span v-if="it.detail" class="res-detail">{{ it.detail }}</span>
                  <template v-if="it.text"><MarkdownRenderer :content="it.text" /></template>
                </div>
                <button v-if="m.resultData?.steps || isPathList(m.resultData)" class="btn mini-btn" @click="createGroupFromResult">🎴 按此顺序创建复习卡组</button>
              </div>
              <!-- text -->
              <div v-else class="msg-text"><MarkdownRenderer :content="m.resultData?.text || '(无内容)'" /></div>
            </template>
          </div>
        </template>
        <div ref="scrollAnchor" class="al-scroll-end"></div>
      </main>
    </div>

    <!-- 底：输入 + 预设 -->
    <div class="al-inputbar">
      <div class="preset-row">
        <button v-for="p in PRESETS" :key="p.key" class="chip" :disabled="busy || !cards.length" @click="runPreset(p.key)">{{ p.label }}</button>
      </div>
      <div class="ask-row">
        <input v-model="question" class="input" placeholder="自由提问，例如：如果我要用这些卡片准备考试，应该先复习什么？"
               :disabled="busy || !cards.length" @keyup.enter="ask" />
        <button class="btn primary" :disabled="busy || !cards.length || !question.trim()" @click="ask">提问</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.al-page { display: flex; flex-direction: column; height: calc(100vh - 84px); }
.mode-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.al-layout { flex: 1; display: flex; gap: 12px; min-height: 0; }
.al-side { width: 260px; flex-shrink: 0; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.side-title { font-weight: 600; margin-bottom: 4px; }
.side-add { display: flex; gap: 6px; }
.side-list { display: flex; flex-direction: column; gap: 4px; }
.side-item { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
.side-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.mini-x { border: none; background: none; color: var(--ink-2); cursor: pointer; font-size: 12px; padding: 2px 4px; }
.mini-x:hover { color: var(--red); }
.side-sessions { border-top: 1px dashed var(--line); padding-top: 8px; }
.sess-row { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 8px; cursor: pointer; }
.sess-row:hover { background: var(--panel); }
.sess-row.on { background: var(--panel); border: 1px solid var(--line); }
.sess-name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.al-main { flex: 1; min-width: 0; overflow-y: auto; padding: 4px 8px; }
.busy { padding: 16px; }
.empty-hint { padding: 40px 16px; text-align: center; }
.msg { border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; margin-bottom: 10px; background: var(--panel); }
.msg.user { border-style: dashed; }
.msg-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.msg-role { font-weight: 600; font-size: 13px; }
.msg-note { font-size: 12px; color: var(--ink-2); }
.msg-q { white-space: pre-wrap; }
.msg-text { line-height: 1.6; }
.al-graph { width: 100%; height: 380px; border: 1px dashed var(--line); border-radius: 8px; }
.timeline { display: flex; flex-direction: column; gap: 4px; }
.tl-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.tl-step { min-width: 22px; height: 22px; border-radius: 50%; background: var(--blue); color: #fff; font-size: 12px; display: inline-flex; align-items: center; justify-content: center; }
.tl-text { flex: 1; }
.tl-weak { font-size: 11px; color: var(--red); border: 1px solid var(--red); border-radius: 6px; padding: 0 5px; }
.mini-btn { margin-top: 8px; }
.res-list { display: flex; flex-direction: column; gap: 4px; }
.res-item { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 3px 0; }
.res-front { font-size: 12px; color: var(--ink-2); }
.res-detail { font-size: 12px; }
.al-inputbar { border-top: 1px solid var(--line); padding: 10px 0 0; background: var(--bg); }
.preset-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.ask-row { display: flex; gap: 8px; }
.ask-row .input { flex: 1; }
@media (max-width: 767px) {
  .al-layout { flex-direction: column; }
  .al-side { width: 100%; max-height: 200px; }
  .al-graph { height: 300px; }
}
</style>
