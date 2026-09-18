<script setup>
// AI 智能助手：对话历史（存 IndexedDB 并可同步）+ 快捷指令 + 智能组卡 + 数轴定位
import { confirmDialog } from '../utils/confirm.js';
import { ref, computed, onMounted, nextTick } from 'vue';
import { toast } from '../utils/toast.js';
// round100：AI 学习助手已改为「自己查数据」——走 Agent 框架（runAgentTurn + 'assistant' Agent + 工具循环），
// 不再本地预注入上下文（buildFullContext / buildModuleNodesContext 已从本视图退场）。
// 历史教训（round82）：这类「改了调用忘了导入」的错误 npm test 抓不到，已把 eslint 纳入门禁（见 package.json）。
import { chatAI, runAgentTurn, getAIConfig, setAIConfig, hasAIKey, listChats, getChat, saveChat, deleteChat, newChat, extractMemories, listMemories, addMemory, deleteMemory, clearMemories } from '../ai.js';
import { probeEmbedding } from '../agent/embedding.js';
import { downloadText } from '../utils/exporters.js';
import { runAction } from '../utils/action.js';
import { generateDeck, bulkCreateCards, generateColdStartDeck, COLD_START_TEMPLATES } from '../utils/genDeck.js';
import VoiceInput from '../components/VoiceInput.vue';
import EmptyState from '../components/EmptyState.vue';
import FullscreenButton from '../components/FullscreenButton.vue';
import TextZoomBar from '../components/TextZoomBar.vue';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import { useFullscreen } from '../composables/useFullscreen.js';
import { useTextZoom } from '../composables/useTextZoom.js';
import { mdRender, toggleMdRender } from '../utils/md-pref.js';
import { speak } from '../utils/tts.js';
import { T } from '../utils/telemetry.js';
import { t } from '../i18n/index.js';
import ImagePolicySetting from '../components/ImagePolicySetting.vue';
import { stringifyReply } from '../agent/reply.js';

const chats = ref([]);
const currentChat = ref(newChat());
const input = ref('');
const loading = ref(false);
const box = ref(null);

// 全屏/非全屏：真正的浏览器全屏（requestFullscreen），iframe/CSP 拦下时退化 CSS 铺满。
// 全屏目标 = 整个 .ai-wrap（AI 助手页占满整屏）；aiFs 同时驱动 fs-mode 隐藏左右侧栏。
const aiRoot = ref(null);
const { isFullscreen: aiFs, toggle: toggleAiFs } = useFullscreen(aiRoot);
// 阅读文本字号缩放（复用项目统一机制：字号重排，非 transform，不糊；按模块持久化；Ctrl+滚轮快捷）
const { scale, fontStyle, zoomIn, zoomOut, reset, onWheel } = useTextZoom('aiAssistant');
// 侧栏/提问节点显隐：桌面端默认展开（点 ✕ 才收起），移动端默认收起为抽屉（点按钮展开）。
// 用初始视口宽度判定，避免桌面默认就按 no-left/no-right 把两栏藏掉。
const __isWide = typeof window !== 'undefined' && window.matchMedia('(min-width: 901px)').matches;
const showSidebar = ref(__isWide);
const showTimeline = ref(__isWide);

const showSettings = ref(false);
const cfg = ref(getAIConfig());

// 最大输出长度档位（round50）：数值越大单次回答能写越长，费用/等待也越高。
// 让用户按自己模型的上限选（V4 Pro/Flash 上限 384K；V3 约 8K~16K；R1 约 16K~32K），
// 并随所选档位动态给出选择建议（mtHint）+ 一句通用提醒（mtHintNote）。
const MT_OPTIONS = computed(() => [
  { value: 4096, label: `4096 · ${t('views.aiAssistant.mtShort')}` },
  { value: 8192, label: `8192 · ${t('views.aiAssistant.mtDefault')}` },
  { value: 16384, label: `16384 · ${t('views.aiAssistant.mtLong')}` },
  { value: 32768, label: `32768 · ${t('views.aiAssistant.mtReason')}` },
  { value: 65536, label: `65536 · ${t('views.aiAssistant.mtV4')}` },
  { value: 131072, label: `131072 · ${t('views.aiAssistant.mtHuge')}` },
]);
const mtHint = computed(() => {
  const v = Number(cfg.value.maxTokens) || 8192;
  if (v <= 4096) return t('views.aiAssistant.mtHint4096');
  if (v <= 8192) return t('views.aiAssistant.mtHint8192');
  if (v <= 16384) return t('views.aiAssistant.mtHint16384');
  if (v <= 32768) return t('views.aiAssistant.mtHint32768');
  return t('views.aiAssistant.mtHintBig');
});

const genOpen = ref(false);
const genText = ref('');
const genSubject = ref('');
const deck = ref(null);
const deckLoading = ref(false);
const deckSelected = ref(new Set());
const deckFilter = ref('all');

const coldOpen = ref(false);
const coldLoading = ref(false);
const coldTemplates = ref(COLD_START_TEMPLATES.map(tpl => ({ id: tpl.id, name: tpl.name, subject: tpl.subject, description: tpl.description })));

// round100：人设与「先取数据再回答」的指令已上移到 agent 框架的 'assistant' Agent
// （src/agent/agents/index.js），这里不再本地拼 system —— 改由 runAgentTurn 注入上下文 + 工具循环。

const userNodes = computed(() => {
  const nodes = [];
  (currentChat.value.messages || []).forEach((m, i) => { if (m.role === 'user') nodes.push({ index: i, text: m.content }); });
  return nodes;
});

async function loadChatList() { chats.value = await listChats(); }

async function selectChat(id) {
  currentChat.value = (await getChat(id)) || newChat();
  localStorage.setItem('sxy_last_chat', currentChat.value.id);
  await loadChatList();
  scroll();
  // 窄屏（抽屉式侧栏）：选中后自动收起抽屉，让消息流立即可见。
  // 旧行为抽屉保持展开盖在消息区上，用户以为「点了没反应 / 没跳转」。
  if (window.matchMedia('(max-width: 900px)').matches) showSidebar.value = false;
}

async function createNew() {
  currentChat.value = newChat();
  localStorage.setItem('sxy_last_chat', currentChat.value.id);
  await loadChatList();
}

async function removeChat(id) {
  if (!(await confirmDialog(t('views.aiAssistant.confirmDeleteChat')))) return;
  await deleteChat(id);
  if (currentChat.value.id === id) currentChat.value = newChat();
  await loadChatList();
}

async function persist() {
  try { await saveChat(currentChat.value); await loadChatList(); }
  catch (e) { toast(t('views.aiAssistant.chatSaveFail', undefined, { msg: e.message }), 'error'); }
}

// Agent 只在收尾返回整段回答（内部流式仅用于防读超时）→ 这里客户端渐进显示，保留「打字机」手感。
// 全程有界（约 50 帧）、并在会话被切换 / 消息被覆盖时立即停止。
async function revealBubble(idx, text) {
  const total = String(text ?? '').length;
  if (!total) return;
  const step = Math.max(8, Math.ceil(total / 50));
  for (let n = step; n < total; n += step) {
    const m = currentChat.value.messages[idx];
    if (!m || m.content === text) return; // 已切换会话 / 已被替换 → 停
    m.content = text.slice(0, n);
    scroll();
    await new Promise((r) => setTimeout(r, 16));
  }
  const m = currentChat.value.messages[idx];
  if (m) m.content = text;
}

async function send() {
  const text = input.value.trim();
  if (!text || loading.value) return;
  if (!hasAIKey()) { showSettings.value = true; toast(t('views.aiAssistant.needKey'), 'error'); return; }
  input.value = '';
  currentChat.value.messages.push({ role: 'user', content: text });
  if (currentChat.value.messages.filter(m => m.role === 'user').length === 1) currentChat.value.title = text.slice(0, 18);
  loading.value = true;
  scroll();
  // round76：占位消息下标要在 try 外声明——**错误分支也要用它**（把报错写进那个占位气泡，
  // 而不是留下一个空气泡再追加一条错误消息，界面会出现"空的 AI 回复 + 一条报错"两条）。
  let replyIdx = -1;
  try {
    // round100：AI 学习助手改为**自己查数据**——走 Agent 框架（'assistant' Agent + ReAct 工具循环）。
    // AI 按需调 get_card_detail / read_note / read_doc / read_chat / get_pomodoro_sessions … 取真实数据，
    // 卡片 / 笔记 / 文档里的图片由 enrichForLlm 作为附图送出。彻底取代「预注入 + 关键词猜模块」：
    // 问什么取什么（不再「猜不准就漏」），也不会无条件全量外发（不再费 token / 外发隐私）。
    // ⚠️ 请求消息必须用**推入占位之前**的快照，否则空消息会被当成历史发给模型。
    const history = [...currentChat.value.messages];
    currentChat.value.messages.push({ role: 'assistant', content: '' });
    replyIdx = currentChat.value.messages.length - 1;
    let res = await runAgentTurn({ userInput: text, history, agentId: 'assistant', confirmWrites: true });
    // 空白回复兜底：O4 收口到 stringifyReply（统一口径 + 计入 AI 回复质量监控 getReplyStats）
    let final = stringifyReply(res?.reply, t('views.aiAssistant.noContent'));
    for (let guard = 0; guard < 3 && res?.pendingWrite; guard++) {
      const ok = await confirmDialog({
        title: t('views.aiAssistant.writeConfirmTitle'),
        message: describeWriteRequest(res.pendingWrite),
        confirmText: t('views.aiAssistant.writeConfirmOk'),
        cancelText: t('views.aiAssistant.writeConfirmCancel'),
      });
      if (ok) {
        // 清掉占位，用同一轮历史重跑：模型将执行已被批准的那次写入并给出结果
        currentChat.value.messages[replyIdx].content = '';
        res = await runAgentTurn({ userInput: text, history, agentId: 'assistant', confirmWrites: true, approvedWrite: res.pendingWrite });
        final = stringifyReply(res?.reply, t('views.aiAssistant.noContent'));
      } else {
        final = t('views.aiAssistant.writeCancelled'); break;
      }
    }
    try { T.aiCall('chat', final.length); } catch {}
    // Agent 内部虽全程流式（防超时），但只在收尾返回整段 → 客户端渐进显示，保留打字机手感
    await revealBubble(replyIdx, final);
    if (voiceOn.value) speak(final);
    const n = await extractMemories(text, final);
    if (n > 0) toast(t('views.aiAssistant.memSaved', undefined, { n }), 'success');
  } catch (e) {
    toast(e.message, 'error');
    const errText = t('views.aiAssistant.chatError', undefined, { msg: e.message });
    const ph = replyIdx >= 0 ? currentChat.value.messages[replyIdx] : null;
    // 空气泡就直接写报错（复用气泡），否则再补一条
    if (ph && !String(ph.content || '').trim()) ph.content = errText;
    else currentChat.value.messages.push({ role: 'assistant', content: errText });
  } finally {
    loading.value = false;
    await persist();
    scroll();
  }
}

function describeWriteRequest(pw) {
  const name = pw?.name || '';
  const labels = t('views.aiAssistant.writeToolLabels') || {};
  const label = labels[name] || name;
  const args = pw?.args || {};
  const brief = ['text', 'title', 'name', 'plan', 'content', 'task', 'note', 'summary', 'front', 'back']
    .filter((k) => args[k] != null && String(args[k]).trim() !== '')
    .map((k) => `${k}: ${String(args[k]).slice(0, 80)}`).join('；');
  return `${label}${brief ? '（' + brief + '）' : ''}${t('views.aiAssistant.writeAskSuffix')}`;
}

function scroll() { nextTick(() => { box.value?.scrollTo({ top: box.value.scrollHeight }); }); }
function scrollToUser(i) { document.getElementById('msg-' + i)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

// 删除时间轴上的某个提问节点：连同其后紧跟的 AI 回复一起删除
function deleteUserNode(nodeIdx) {
  const n = userNodes.value[nodeIdx];
  if (!n) return;
  // 竞态防护：AI 正在回复时，该提问的回复还没 push 进来。此刻删问题，
  // 回复 resolve 后会 push 到消息末尾，变成「没有问题的孤儿回答」。直接拒绝。
  if (loading.value) { toast(t('views.aiAssistant.waitReply', 'AI 正在回复，请稍候再删除'), 'warning'); return; }
  const start = n.index;
  let end = start + 1;
  if (currentChat.value.messages[end]?.role === 'assistant') end++;
  currentChat.value.messages.splice(start, end - start);
  persist();
}

// ---- 设置 / 测试 ----
const testing = ref(false);
async function testConnection() {
  setAIConfig(cfg.value);
  testing.value = true;
  try {
    const r = await chatAI([{ role: 'user', content: '请只回复「连接成功」四个字' }]);
    toast(r ? t('views.aiAssistant.connOkWith') + r.trim().slice(0, 30) : t('views.aiAssistant.connOk'), 'success');
  } catch (e) {
    toast(t('views.aiAssistant.connFail', undefined, { msg: e.message }), 'error');
  } finally { testing.value = false; }
}
function saveSettings() { setAIConfig(cfg.value); showSettings.value = false; toast(t('views.aiAssistant.cfgSaved'), 'success'); }

// ---- 快捷指令 ----
const quickActions = [
  { label: 'quickQuiz', prompt: '请根据我的数据，出 3 道选择题考我（给出 A-D 选项，先别公布答案，等我回答后再判对错）' },
  { label: 'quickWeekly', prompt: '请根据我的数据，生成一份本周学习周报：学了什么、哪里薄弱、下周复习建议' },
  { label: 'quickRelate', prompt: '请分析我的卡片涉及的知识点之间的关联，帮我把它们串成一个知识网络' },
];
function clickQuick(q) { input.value = q.prompt; send(); }

// ---- 智能卡组生成（Phase 2 杀手锏）----
async function generateDeckFlow() {
  const txt = genText.value.trim();
  if (!txt) return toast(t('views.aiAssistant.needPaste'), 'error');
  if (!hasAIKey()) { showSettings.value = true; toast(t('views.aiAssistant.needKey'), 'error'); return; }
  deckLoading.value = true;
  deck.value = null;
  deckSelected.value = new Set();
  try {
    const r = await generateDeck(txt, { subject: genSubject.value.trim() });
    deck.value = r;
    const sel = new Set();
    r.deduped.forEach((c) => {
      const idx = r.candidates.indexOf(c);
      if (idx >= 0 && (c.score?.overall ?? 0) >= 60) sel.add(idx);
    });
    deckSelected.value = sel;
    if (!r.candidates.length) toast(t('views.aiAssistant.genNoCards'), 'error');
    else toast(t('views.aiAssistant.genDone', undefined, { cand: r.candidates.length, dedup: r.deduped.length, sel: sel.size }), 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { deckLoading.value = false; }
}

function toggleCard(i) {
  const s = new Set(deckSelected.value);
  if (s.has(i)) s.delete(i); else s.add(i);
  deckSelected.value = s;
}

function selectAllVisible() {
  if (!deck.value) return;
  const s = new Set(deckSelected.value);
  for (const x of filteredCandidates.value) s.add(x._idx);
  deckSelected.value = s;
}
function clearSelection() { deckSelected.value = new Set(); }

const filteredCandidates = computed(() => {
  if (!deck.value) return [];
  const all = deck.value.candidates.map((c, i) => ({ ...c, _idx: i }));
  if (deckFilter.value === 'deduped') {
    const dedupIdx = new Set(deck.value.deduped.map(c => deck.value.candidates.indexOf(c)));
    return all.filter(x => dedupIdx.has(x._idx));
  }
  if (deckFilter.value === 'selected') return all.filter(x => deckSelected.value.has(x._idx));
  return all;
});

async function importDeck() {
  if (!deck.value) return;
  const picks = [...deckSelected.value].map(i => deck.value.candidates[i]).filter(Boolean);
  if (!picks.length) return toast(t('views.aiAssistant.genPickOne'), 'error');
  deckLoading.value = true;
  try {
    const r = await bulkCreateCards(picks, { sourceDocId: deck.value.sourceDocId });
    toast(t('views.aiAssistant.importDone', undefined, { created: r.created }) + (r.failed.length ? t('views.aiAssistant.importFailed', undefined, { n: r.failed.length }) : ''), r.failed.length ? 'error' : 'success');
    if (!r.failed.length) {
      genOpen.value = false; deck.value = null; genText.value = ''; genSubject.value = ''; deckSelected.value = new Set();
    }
  } catch (e) { toast(e.message, 'error'); }
  finally { deckLoading.value = false; }
}

// ---- 冷启动卡组（0 卡新用户首选）----
async function runColdStart(tplId) {
  if (!hasAIKey()) { showSettings.value = true; toast(t('views.aiAssistant.needKey'), 'error'); return; }
  coldLoading.value = true;
  try {
    const r = await generateColdStartDeck(tplId);
    deck.value = { sourceDocId: null, candidates: r.candidates, deduped: r.deduped, chunks: 1, count: r.count };
    const sel = new Set();
    r.deduped.forEach((c) => {
      const idx = r.candidates.indexOf(c);
      if (idx >= 0 && (c.score?.overall ?? 0) >= 60) sel.add(idx);
    });
    deckSelected.value = sel;
    deckFilter.value = 'all';
    coldOpen.value = false;
    genOpen.value = true;
    toast(t('views.aiAssistant.coldDone', undefined, { cand: r.candidates.length, dedup: r.deduped.length }), 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { coldLoading.value = false; }
}

// ---- 记忆库 ----
const memOpen = ref(false);
const memories = ref([]);
const newMemContent = ref('');
const newMemCat = ref('fact');
async function openMem() { memories.value = await listMemories(); memOpen.value = true; }
async function addMem() {
  await addMemory({ content: newMemContent.value, category: newMemCat.value });
  newMemContent.value = '';
  memories.value = await listMemories();
}
async function removeMem(id) { await deleteMemory(id); memories.value = await listMemories(); }
function catName(c) { return c === 'core' ? t('views.aiAssistant.catCore') : c === 'preference' ? t('views.aiAssistant.catPref') : t('views.aiAssistant.catFact'); }

// ---- 记忆库：按类型筛选 / 批量清空 / 导出（round110）----
// 此前只有「逐条删除」：记忆攒到几十条后想清理只能一条条点，也没法带走或整体备份。
const memFilter = ref('all'); // all | core | preference | fact
const memCounts = computed(() => {
  const c = { all: memories.value.length, core: 0, preference: 0, fact: 0 };
  for (const m of memories.value) if (c[m.category] !== undefined) c[m.category] += 1;
  return c;
});
const filteredMems = computed(() => (memFilter.value === 'all'
  ? memories.value
  : memories.value.filter((m) => m.category === memFilter.value)));
/** 清空当前筛选（清空会写墓碑，跨设备同步删除；见 memory.clearMemories） */
async function clearMems() {
  const n = filteredMems.value.length;
  if (!n) { toast(t('views.aiAssistant.memEmpty'), 'info'); return; }
  const label = memFilter.value === 'all' ? t('views.aiAssistant.memAll') : catName(memFilter.value);
  if (!(await confirmDialog(t('views.aiAssistant.memClearConfirm', undefined, { label, n })))) return;
  await runAction(
    () => clearMemories(memFilter.value === 'all' ? undefined : memFilter.value),
    {
      then: async (removed) => {
        memories.value = await listMemories();
        toast(t('views.aiAssistant.memCleared', undefined, { n: removed ?? n }), 'success');
      },
    },
  );
}
/** 导出当前筛选的记忆（JSON 便于备份/迁回，Markdown 便于阅读与归档进笔记） */
function exportMems(fmt) {
  const rows = filteredMems.value;
  if (!rows.length) { toast(t('views.aiAssistant.memEmpty'), 'info'); return; }
  const stamp = new Date().toISOString().slice(0, 10);
  const base = t('views.aiAssistant.memFileName', undefined, { date: stamp });
  const pick = (r) => ({ id: r.id, category: r.category, content: r.content, importance: r.importance ?? 2, createdAt: r.createdAt, updatedAt: r.updatedAt });
  if (fmt === 'json') {
    downloadText(JSON.stringify(rows.map(pick), null, 2), `${base}.json`, 'application/json');
  } else {
    const md = [
      `# ${t('views.aiAssistant.memMdTitle')}`,
      '',
      t('views.aiAssistant.memMdMeta', undefined, { n: rows.length, time: new Date().toLocaleString() }),
      '',
      ...rows.map((r) => t('views.aiAssistant.memMdItem', undefined, {
        cat: catName(r.category), content: String(r.content || '').trim(), imp: r.importance ?? 2,
      })),
      '',
    ].join('\n');
    downloadText(md, `${base}.md`, 'text/markdown');
  }
  toast(t('views.aiAssistant.memExported', undefined, { n: rows.length }), 'success');
}

// ---- 向量检索（embeddings）设置与探针（round110）----
const embTesting = ref(false);
const embResult = ref('');
/** 探针：真实发一条向量请求，直接告诉你「现在走远程还是本地降级、多少维」 */
async function testEmbedding() {
  setAIConfig(cfg.value); // 先落盘：探针读的就是输入框里的当前值（与「改即保存」的其它设置一致）
  embTesting.value = true;
  embResult.value = '';
  try {
    const r = await probeEmbedding();
    embResult.value = (r.remote && !r.degraded)
      ? t('views.aiAssistant.embOk', undefined, { model: r.model, dim: r.dim })
      : t('views.aiAssistant.embLocal', undefined, { dim: r.dim });
    toast(embResult.value, 'success');
  } catch (e) {
    embResult.value = t('views.aiAssistant.embFail', undefined, { msg: String(e?.message || e) });
    toast(embResult.value, 'error');
  } finally { embTesting.value = false; }
}

const voiceOn = ref(localStorage.getItem('sxy_voice') !== '0');
function toggleVoice() {
  voiceOn.value = !voiceOn.value;
  localStorage.setItem('sxy_voice', voiceOn.value ? '1' : '0');
  if (!voiceOn.value && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

onMounted(async () => {
  await loadChatList();
  const last = localStorage.getItem('sxy_last_chat');
  if (last && chats.value.some(c => c.id === last)) await selectChat(last);
});
</script>

<template>
  <div ref="aiRoot" class="ai-wrap" :class="{ 'ai-fs': aiFs }">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">{{ t('views.aiAssistant.headerTitle') }}</h2>
      <button class="btn primary small" @click="createNew">{{ t('views.aiAssistant.newChatBtn') }}</button>
      <span style="flex:1"></span>
      <button class="chip" :class="{ on: voiceOn }" @click="toggleVoice">{{ t('views.aiAssistant.voiceBroadcast') }}</button>
      <button class="btn small" @click="openMem">{{ t('views.aiAssistant.memLabel') }}</button>
      <button class="btn small" @click="cfg = getAIConfig(); showSettings = true">{{ t('views.aiAssistant.settingsLabel') }}</button>
    </div>

    <div class="quick-bar">
      <button v-for="q in quickActions" :key="q.label" class="chip" @click="clickQuick(q)">{{ t('views.aiAssistant.' + q.label) }}</button>
      <button class="chip" style="border-color:var(--blue);color:var(--blue)" @click="genOpen = true">{{ t('views.aiAssistant.genDeckBtn') }}</button>
      <button class="chip" style="border-color:var(--green);color:var(--green)" @click="coldOpen = true">{{ t('views.aiAssistant.coldDeckBtn') }}</button>
    </div>

    <div class="ai-body" :class="{ 'fs-mode': aiFs, 'no-left': !showSidebar || aiFs, 'no-right': !showTimeline }">
      <!-- 左栏：历史对话（移动端默认隐藏，点按钮展开） -->
      <div class="chat-side" :class="{ expanded: showSidebar }">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div class="side-title" style="margin-bottom:0">{{ t('views.aiAssistant.historyTitle') }}</div>
          <button class="btn mini" @click="showSidebar = false" style="font-size:11px">✕</button>
        </div>
        <EmptyState v-if="!chats.length" compact icon="🤖" :title="t('views.aiAssistant.emptyHistoryTitle')" :message="t('views.aiAssistant.emptyHistoryMsgPrefix') + t('views.aiAssistant.genDeckBtn') + t('views.aiAssistant.emptyHistoryMsgSuffix')" />
        <div v-for="c in chats" :key="c.id" class="chat-item" :class="{ active: c.id === currentChat.id }" @click="selectChat(c.id)">
          <div class="chat-item-title">{{ c.title || t('views.aiAssistant.newChatTitle') }}</div>
          <div class="chat-item-meta">{{ c.messages?.length || 0 }}{{ t('views.aiAssistant.msgCountSuffix') }}</div>
          <button class="node-close" :title="t('views.aiAssistant.delLink')" @click.stop="removeChat(c.id)">✕</button>
        </div>
      </div>

      <!-- 中间：消息流（移动端含侧栏 toggle 按钮） -->
      <div class="chat-fs-row">
        <button class="btn mini" @click="showSidebar = !showSidebar" style="margin-right:6px;font-size:12px">📋 {{ t('views.aiAssistant.historyTitle') }}</button>
        <button class="btn mini" @click="showTimeline = !showTimeline" style="margin-right:6px;font-size:12px">📌 {{ t('views.aiAssistant.nodesTitle') }}</button>
        <button class="btn mini" style="margin-right:6px;font-size:12px"
                :title="t('views.aiAssistant.mdToggleHint')" @click="toggleMdRender">
          M↓ {{ t('views.aiAssistant.mdToggle', undefined, { state: mdRender ? t('views.aiAssistant.mdOn') : t('views.aiAssistant.mdOff') }) }}
        </button>
        <TextZoomBar :scale="scale" @zoom-in="zoomIn" @zoom-out="zoomOut" @reset="reset" />
        <FullscreenButton :active="aiFs" @toggle="toggleAiFs" />
      </div>
      <div ref="box" class="chat-box" :style="fontStyle" @wheel="onWheel">
        <div v-if="!currentChat.messages.length" class="hint" style="text-align:center;padding:40px">
          {{ t('views.aiAssistant.chatEmpty') }}
        </div>
        <div v-for="(m, i) in currentChat.messages" :key="i" :id="'msg-' + i" class="msg" :class="m.role">
          <div class="bubble" :class="{ 'md-bubble': m.role === 'assistant' && mdRender }">
            <MarkdownRenderer v-if="m.role === 'assistant' && mdRender" :content="m.content" />
            <template v-else>{{ m.content }}</template>
          </div>
        </div>
        <div v-if="loading" class="msg assistant"><div class="bubble">{{ t('views.aiAssistant.aiThinking') }}</div></div>
      </div>

      <!-- 右栏：数轴节点（移动端默认隐藏，点按钮展开为浮动面板） -->
      <div class="timeline" :class="{ expanded: showTimeline }">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div class="side-title" style="margin-bottom:0">{{ t('views.aiAssistant.nodesTitle') }}</div>
          <button class="btn mini" @click="showTimeline = false" style="font-size:11px">✕</button>
        </div>
        <EmptyState v-if="!userNodes.length" compact icon="🤖" :title="t('views.aiAssistant.emptyNodesTitle')" :message="t('views.aiAssistant.emptyNodesMsg')" />
        <div v-for="(n, ni) in userNodes" :key="n.index" class="tl-node" :title="n.text" @click="scrollToUser(n.index)">
          <span class="tl-dot"></span>
          <span class="tl-text">{{ n.text.slice(0, 12) }}</span>
          <button class="node-close sm" @click.stop="deleteUserNode(ni)">✕</button>
        </div>
      </div>
    </div>

    <div class="input-row">
      <VoiceInput @result="(res) => input = input ? input + res : res" />
      <input v-model="input" class="input" :placeholder="t('views.aiAssistant.inputPlaceholder')" @keydown.enter="send" />
      <button class="btn primary" :disabled="loading" @click="send">{{ t('views.aiAssistant.sendBtn') }}</button>
    </div>

    <!-- AI 设置弹窗 -->
    <teleport to="body">
      <div v-if="showSettings" class="modal-mask" @click.self="showSettings = false">
        <div class="modal">
          <h3>{{ t('views.aiAssistant.settingsLabel') }}</h3>
          <div class="field-label" style="margin-top:4px">{{ t('views.aiAssistant.apiUrlLabel') }}</div>
          <input v-model="cfg.baseUrl" class="input" :placeholder="t('views.aiAssistant.apiUrlPlaceholder')" />
          <div class="field-label">{{ t('views.aiAssistant.apiKeyLabel') }}</div>
          <input v-model="cfg.apiKey" class="input" type="password" :placeholder="t('views.aiAssistant.apiKeyPlaceholder')" />
          <div class="field-label">{{ t('views.aiAssistant.modelLabel') }}</div>
          <input v-model="cfg.model" class="input" :placeholder="t('views.aiAssistant.modelPlaceholder')" />
          <!-- 最大输出长度（round50）：默认 8192；长回答（分析多图 / 生成完整依赖链）可调高。
               设置超出模型上限时接口会报错，llm.js 会自动降到 2000 重试一次。 -->
          <div class="field-label">{{ t('views.aiAssistant.maxTokensLabel') }}</div>
          <select v-model.number="cfg.maxTokens" class="input">
            <option v-for="o in MT_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <div class="hint" style="margin-top:6px">{{ mtHint }}</div>
          <div class="hint" style="margin-top:4px">{{ t('views.aiAssistant.mtHintNote') }}</div>
          <div class="hint" style="margin-top:8px">{{ t('views.aiAssistant.apiHint') }}</div>
          <!-- 图片分析策略：影响本页对话 / Agent / 卡片联动 / 资料问答里「图片怎么送到模型」。
               与「英语中心 → 设置」共用同一组件与同一份设置（改即保存）——
               此前只有英语中心有入口，用户在这里找不到（2026-09-14 反馈）。 -->
          <!-- 向量检索（embeddings）：可单独指定供应商（round110）。
               为什么必须独立：embedding 与 chat 是两种能力、供应商常不同——
               用 DeepSeek 聊天（它没有 /embeddings 端点）时，此前向量检索只能永久跑本地降级算法。
               留空=逐项沿用上面的聊天配置（老行为完全不变）。 -->
          <details style="margin-top:14px">
            <summary class="field-label" style="cursor:pointer;margin:0">{{ t('views.aiAssistant.embTitle') }}</summary>
            <div class="hint" style="margin-top:6px">{{ t('views.aiAssistant.embHint') }}</div>
            <div class="field-label">{{ t('views.aiAssistant.embBaseLabel') }}</div>
            <input v-model="cfg.embeddingBaseUrl" class="input" :placeholder="t('views.aiAssistant.embBasePlaceholder')" />
            <div class="field-label">{{ t('views.aiAssistant.embKeyLabel') }}</div>
            <input v-model="cfg.embeddingApiKey" class="input" type="password" :placeholder="t('views.aiAssistant.embKeyPlaceholder')" />
            <div class="field-label">{{ t('views.aiAssistant.embModelLabel') }}</div>
            <input v-model="cfg.embeddingModel" class="input" placeholder="text-embedding-3-small" />
            <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
              <button class="btn small" :disabled="embTesting" @click="testEmbedding">{{ embTesting ? t('views.aiAssistant.embTesting') : t('views.aiAssistant.embTest') }}</button>
              <span class="hint" style="margin:0">{{ embResult }}</span>
            </div>
          </details>
          <ImagePolicySetting style="margin-top:14px" />
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
            <button class="btn" :disabled="testing" @click="testConnection">{{ testing ? t('views.aiAssistant.testing') : t('views.aiAssistant.testConn') }}</button>
            <button class="btn" @click="showSettings = false">{{ t('views.aiAssistant.cancel') }}</button>
            <button class="btn primary" @click="saveSettings">{{ t('views.aiAssistant.save') }}</button>
          </div>
        </div>
      </div>
    </teleport>

    <!-- 智能卡组弹窗（Phase 2 杀手锏：质量评分 + 多题型 + 去重 + 源文档溯源）-->
    <teleport to="body">
      <div v-if="genOpen" class="modal-mask" @click.self="genOpen = false">
        <div class="modal">
          <h3>{{ t('views.aiAssistant.genTitle') }}</h3>
          <p class="hint" style="margin-top:0">{{ t('views.aiAssistant.genHint') }}</p>
          <textarea v-model="genText" class="input" rows="6" :placeholder="t('views.aiAssistant.genTextPlaceholder')"></textarea>
          <input v-model="genSubject" class="input" style="margin-top:8px" :placeholder="t('views.aiAssistant.genSubjectPlaceholder')" />
          <div style="display:flex;gap:10px;margin-top:12px">
            <button class="btn primary" :disabled="deckLoading" @click="generateDeckFlow">{{ deckLoading ? t('views.aiAssistant.generating') : t('views.aiAssistant.genBtn') }}</button>
            <button class="btn" @click="coldOpen = true">{{ t('views.aiAssistant.genFromTemplate') }}</button>
          </div>

          <div v-if="deck" style="margin-top:14px">
            <div class="deck-summary">
              <span>{{ t('views.aiAssistant.deckCandidate') }} <b>{{ deck.count }}</b></span>
              <span>{{ t('views.aiAssistant.deckDeduped') }} <b style="color:var(--green)">{{ deck.deduped.length }}</b></span>
              <span>{{ t('views.aiAssistant.deckSelected') }} <b style="color:var(--blue)">{{ deckSelected.size }}</b></span>
              <span v-if="deck.sourceDocId" :title="t('views.aiAssistant.deckSourceTooltip')">{{ t('views.aiAssistant.deckSourceDoc') }}</span>
              <span v-if="deck.chunks > 1">{{ t('views.aiAssistant.deckChunks') }} {{ deck.chunks }}</span>
            </div>
            <div class="deck-filter">
              <button :class="['chip-sm', deckFilter==='all'?'on':'']" @click="deckFilter='all'">{{ t('views.aiAssistant.deckFilterAll') }} {{ deck.count }}</button>
              <button :class="['chip-sm', deckFilter==='deduped'?'on':'']" @click="deckFilter='deduped'">{{ t('views.aiAssistant.deckFilterDeduped') }} {{ deck.deduped.length }}</button>
              <button :class="['chip-sm', deckFilter==='selected'?'on':'']" @click="deckFilter='selected'">{{ t('views.aiAssistant.deckFilterSelected') }} {{ deckSelected.size }}</button>
              <span style="flex:1"></span>
              <button class="chip-sm" @click="selectAllVisible">{{ t('views.aiAssistant.deckSelectAll') }}</button>
              <button class="chip-sm" @click="clearSelection">{{ t('views.aiAssistant.deckClear') }}</button>
            </div>
            <div class="gen-list">
              <label v-for="c in filteredCandidates" :key="c._idx" class="gen-item" :class="{ sel: deckSelected.has(c._idx), dup: c.dupScore >= 0.35, low: (c.score?.overall ?? 0) < 60 }">
                <input type="checkbox" :checked="deckSelected.has(c._idx)" @change="toggleCard(c._idx)" />
                <div class="gen-main">
                  <div class="gen-q">
                    <span class="badge" :class="'t-' + c.type">{{ c.type === 'cloze' ? t('views.aiAssistant.typeCloze') : c.type === 'choice' ? t('views.aiAssistant.typeChoice') : t('views.aiAssistant.typeBasic') }}</span>
                    <MarkdownRenderer class="gen-q-md" :content="c.front" />
                  </div>
                  <div class="gen-a"><MarkdownRenderer :content="c.back" /></div>
                  <div class="gen-meta">
                    <span :class="['sc', c.score?.overall >= 80 ? 's-hi' : c.score?.overall >= 60 ? 's-mid' : 's-low']">{{ t('views.aiAssistant.deckQuality') }} {{ c.score?.overall ?? '-' }}</span>
                    <span v-if="c.subject">· {{ c.subject }}</span>
                    <span v-if="c.dupScore >= 0.35" class="dup-warn">{{ t('views.aiAssistant.deckDupWarnPrefix') }}{{ (c.dupScore * 100).toFixed(0) }}%{{ t('views.aiAssistant.deckDupWarnSuffix') }}</span>
                  </div>
                </div>
              </label>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px">
              <button class="btn" @click="genOpen = false">{{ t('views.aiAssistant.cancel') }}</button>
              <button class="btn primary" :disabled="deckLoading || !deckSelected.size" @click="importDeck">{{ t('views.aiAssistant.deckImportPrefix') }} {{ deckSelected.size }} {{ t('views.aiAssistant.deckImportSuffix') }}</button>
            </div>
          </div>
        </div>
      </div>
    </teleport>

    <!-- 冷启动卡组弹窗（0 卡新用户首选：预设学科模板）-->
    <teleport to="body">
      <div v-if="coldOpen" class="modal-mask" @click.self="coldOpen = false">
        <div class="modal">
          <h3>{{ t('views.aiAssistant.coldTitle') }}</h3>
          <p class="hint" style="margin-top:0">{{ t('views.aiAssistant.coldHint') }}</p>
          <div class="cold-list">
            <div v-for="tpl in coldTemplates" :key="tpl.id" class="cold-item" @click="runColdStart(tpl.id)">
              <div class="cold-name">{{ tpl.name }} <span class="cold-sub">{{ tpl.subject }}</span></div>
              <div class="cold-desc">{{ tpl.description }}</div>
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:12px">
            <button class="btn" :disabled="coldLoading" @click="coldOpen = false">{{ coldLoading ? t('views.aiAssistant.generating') : t('views.aiAssistant.close') }}</button>
          </div>
        </div>
      </div>
    </teleport>

    <!-- 记忆库弹窗 -->
    <teleport to="body">
      <div v-if="memOpen" class="modal-mask" @click.self="memOpen = false">
        <div class="modal">
          <h3>{{ t('views.aiAssistant.memTitle') }}</h3>
          <p class="hint" style="margin-top:0">{{ t('views.aiAssistant.memHint') }}</p>
          <div class="mem-add">
            <select v-model="newMemCat" class="input" style="width:auto">
              <option value="core">{{ t('views.aiAssistant.catCore') }}</option>
              <option value="preference">{{ t('views.aiAssistant.catPref') }}</option>
              <option value="fact">{{ t('views.aiAssistant.catFact') }}</option>
            </select>
            <input v-model="newMemContent" class="input" :placeholder="t('views.aiAssistant.memPlaceholder')" @keydown.enter="addMem" />
            <button class="btn primary" @click="addMem">{{ t('views.aiAssistant.memAdd') }}</button>
          </div>
          <!-- 筛选：全部 / 核心 / 偏好 / 事实（带条数）——记忆多了才好找、好清 -->
          <div class="mem-filter">
            <span class="hint" style="margin:0">{{ t('views.aiAssistant.memFilterLabel') }}</span>
            <button v-for="f in [{ k: 'all' }, { k: 'core' }, { k: 'preference' }, { k: 'fact' }]" :key="f.k"
              class="btn small" :class="{ primary: memFilter === f.k }" @click="memFilter = f.k">
              {{ f.k === 'all' ? t('views.aiAssistant.memAll') : catName(f.k) }} {{ memCounts[f.k] || 0 }}
            </button>
          </div>
          <div class="mem-list">
            <EmptyState v-if="!filteredMems.length" icon="🤖" :title="t('views.aiAssistant.emptyMemTitle')" :message="t('views.aiAssistant.emptyMemMsg')" />
            <div v-for="m in filteredMems" :key="m.id" class="mem-item">
              <span class="mem-cat" :class="'cat-' + m.category">{{ catName(m.category) }}</span>
              <span class="mem-content">{{ m.content }}</span>
              <a style="color:var(--red);cursor:pointer" @click="removeMem(m.id)">{{ t('views.aiAssistant.delLink') }}</a>
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:12px">
            <button class="btn small" @click="exportMems('json')">{{ t('views.aiAssistant.memExportJson') }}</button>
            <button class="btn small" @click="exportMems('md')">{{ t('views.aiAssistant.memExportMd') }}</button>
            <button class="btn small danger" @click="clearMems">{{ t('views.aiAssistant.memClear') }}</button>
            <button class="btn" @click="memOpen = false">{{ t('views.aiAssistant.close') }}</button>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.ai-wrap {
  max-width: 960px; margin: 0 auto; display: flex; flex-direction: column;
  height: calc(100vh - 140px);
  height: calc(100dvh - 140px); /* 移动浏览器地址栏收起时 100vh 偏大 → 用 dvh（不支持时回退 vh） */
}
/* 全屏态：真实 Fullscreen 或 CSS 退化铺满都会带 .ai-fs。
   去掉 960px 居中约束、占满整屏高度（否则真实全屏里仍被 max-width 卡成窄条、且底部留 140px）。 */
.ai-wrap.ai-fs { max-width: none; height: 100vh; height: 100dvh; }
.quick-bar { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
/* 4 个子元素但只声明了 3 列 → 旧的 auto-flow 把「全屏按钮行」塞进中间列、
   「消息流」被挤到第 3 列(120px)顶到右上角，中间只剩一块灰底。
   这里显式定位：左栏/右栏跨满两行，全屏行占中间第 1 行，消息流占中间第 2 行。 */
.ai-body { flex: 1; display: grid; grid-template-columns: 180px 1fr 120px; grid-template-rows: auto 1fr; gap: 12px; min-height: 0; position: relative; }
.chat-side { grid-column: 1; grid-row: 1 / -1; }
.chat-fs-row { grid-column: 2; grid-row: 1; }
.chat-box { grid-column: 2; grid-row: 2; min-height: 0; }
.timeline { grid-column: 3; grid-row: 1 / -1; }
.chat-side, .timeline { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 10px; overflow-y: auto; overflow-x: hidden; }
/* 缩放/全屏模式：只藏左侧历史栏，保留右侧提问节点（方便全屏里快速定位问题）；
   对话区占主列、节点固定在右列。桌面媒体查询里 .no-left 已是同口径两列。 */
.ai-body.fs-mode { grid-template-columns: 1fr 120px; grid-template-rows: auto 1fr; }
.ai-body.fs-mode .chat-side { display: none; }
.ai-body.fs-mode .chat-fs-row { grid-column: 1 / -1; grid-row: 1; }
.ai-body.fs-mode .chat-box { grid-column: 1; grid-row: 2; }
.ai-body.fs-mode .timeline { display: block; grid-column: 2; grid-row: 1 / -1; }
/* 桌面端：点左右栏 ✕ 关闭按钮隐藏对应侧栏、对话区扩宽（移动端侧栏是抽屉，单独处理，不在此列）。
   仅桌面生效，避免 `grid-template-columns` 覆盖移动端单列布局。 */
@media (min-width: 901px) {
  /* 仅关左栏（历史）：右栏(提问节点)保留，对话区占中间全部宽度 */
  .ai-body.no-left { grid-template-columns: 1fr 120px; }
  .ai-body.no-left .chat-side { display: none; }
  .ai-body.no-left .chat-fs-row { grid-column: 1; }
  .ai-body.no-left .chat-box { grid-column: 1; }
  .ai-body.no-left .timeline { grid-column: 2; grid-row: 1 / -1; }
  /* 仅关右栏（提问节点）：左栏(历史)保留，对话区扩宽 */
  .ai-body.no-right { grid-template-columns: 180px 1fr; }
  .ai-body.no-right .timeline { display: none; }
  .ai-body.no-right .chat-fs-row { grid-column: 2; }
  .ai-body.no-right .chat-box { grid-column: 2; }
  /* 两边都关（或全屏）：对话区占满整行 */
  .ai-body.no-left.no-right { grid-template-columns: 1fr; }
  .ai-body.no-left.no-right .chat-side,
  .ai-body.no-left.no-right .timeline { display: none; }
  .ai-body.no-left.no-right .chat-fs-row { grid-column: 1; }
  .ai-body.no-left.no-right .chat-box { grid-column: 1; }
}
.side-title { font-size: 13px; font-weight: 600; color: var(--ink-2); margin-bottom: 8px; }
/* 历史对话 / 提问节点：悬停时节点区域明显展开、移开自动收缩（任何 hover 设备；触屏走 :active） */
@media (hover: hover) {
  .chat-item { transition: transform .18s ease, background .18s ease, box-shadow .18s ease; }
  .chat-item:hover { transform: scale(1.04); background: var(--code-inline); box-shadow: 0 2px 8px rgba(0,0,0,.06); z-index: 1; }
  .chat-item:active { transform: scale(.99); }
  .tl-node { transition: transform .18s ease, background .18s ease, box-shadow .18s ease; }
  .tl-node:hover { transform: scale(1.06); background: var(--code-inline); border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,.06); z-index: 1; }
  .tl-node:active { transform: scale(.97); }
}
.chat-item { padding: 8px; border-radius: 8px; cursor: pointer; margin-bottom: 4px; position: relative; transition: background .18s ease; }
.chat-item.active { background: var(--code-bg); }
.chat-item-title { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 20px; }
.chat-item-meta { font-size: 11px; color: var(--ink-2); margin-top: 2px; }
/* 关闭按钮：常驻可见（避免用户找不到），悬停节点或按钮本身时高亮为红色；
   桌面 hover 展开、触控端 :active 反馈，均保证可点按删除。 */
.node-close {
  position: absolute; top: 6px; right: 4px;
  width: 20px; height: 20px; line-height: 1;
  border: none; border-radius: 5px; background: transparent;
  color: var(--ink-2); font-size: 13px; cursor: pointer;
  opacity: .75;
  transition: opacity .15s ease, background .15s ease, color .15s ease, transform .15s ease;
  display: flex; align-items: center; justify-content: center;
}
.chat-item:hover .node-close, .tl-node:hover .node-close { opacity: 1; color: var(--red); }
.node-close:hover, .chat-item:hover .node-close:hover, .tl-node:hover .node-close:hover { background: var(--red); color: #fff; transform: scale(1.1); }
.node-close.sm { position: static; margin-left: auto; width: 18px; height: 18px; font-size: 11px; flex: none; }
/* 触屏设备：关闭按钮保持可见、底色更明显、点按变红，触碰目标扩到 24px */
@media (hover: none) {
  .node-close { opacity: .85; background: var(--code-bg); }
  .chat-item:active .node-close, .tl-node:active .node-close { opacity: 1; background: var(--red); color: #fff; }
  .node-close.sm { width: 24px; height: 24px; font-size: 13px; }
}
.chat-fs-row { display: flex; justify-content: flex-end; margin-bottom: 6px; }
.chat-box { overflow-y: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 16px; transition: font-size .15s ease; }
.msg { display: flex; margin-bottom: 12px; }
.msg.user { justify-content: center; }
.msg.assistant { justify-content: center; }
.bubble { max-width: 82%; width: 100%; padding: 12px 18px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; line-height: 1.75; font-size: 1em; transition: font-size .15s ease; }
/* Markdown 已把换行表达成块级结构：此时关闭 pre-wrap，否则标签间的源码换行会变成额外空行 */
.bubble.md-bubble { white-space: normal; }
.msg.user .bubble { background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
.msg.assistant .bubble { background: var(--code-bg); color: var(--ink); border-bottom-left-radius: 4px; }
.tl-node { display: flex; align-items: center; gap: 6px; padding: 7px 4px; cursor: pointer; border-bottom: 1px dashed var(--line); }
.tl-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
.tl-text { font-size: 11px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.input-row { display: flex; gap: 8px; margin-top: 12px; }
.input-row .input { flex: 1; }
.gen-list { max-height: 420px; overflow-y: auto; border: 1px solid var(--line); border-radius: 8px; padding: 4px 12px; }
.gen-item { display: flex; align-items: flex-start; gap: 8px; padding: 8px 4px; border-bottom: 1px dashed var(--line); cursor: pointer; }
.gen-item:last-child { border-bottom: none; }
.gen-item:hover { background: var(--code-inline); }
.gen-item.sel { background: var(--code-bg); }
.gen-item.dup { border-left: 3px solid var(--red); padding-left: 5px; }
.gen-item.low { opacity: 0.7; }
.gen-item input { margin-top: 4px; flex: none; }
.gen-main { flex: 1; min-width: 0; }
.gen-q { font-weight: 600; display: flex; align-items: flex-start; gap: 6px; }
.gen-q-md { flex: 1; min-width: 0; }
.gen-a { color: var(--ink-2); font-size: 13px; margin-top: 2px; word-break: break-word; }
.gen-meta { font-size: 11px; color: var(--ink-2); margin-top: 4px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.badge { font-size: 10px; padding: 1px 6px; border-radius: 4px; background: var(--code-inline); color: var(--ink-2); flex: none; }
.t-cloze { background: #eef2ff; color: #4338ca; }
.t-choice { background: #fef3c7; color: #b45309; }
.t-basic { background: var(--code-inline); color: var(--ink-2); }
.sc { font-weight: 600; }
.s-hi { color: var(--green); }
.s-mid { color: var(--blue); }
.s-low { color: var(--red); }
.dup-warn { color: var(--red); }
.deck-summary { display: flex; gap: 14px; font-size: 13px; color: var(--ink-2); margin-bottom: 8px; flex-wrap: wrap; }
.deck-summary b { color: var(--ink); }
.deck-filter { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
.chip-sm { font-size: 12px; padding: 3px 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); color: var(--ink-2); cursor: pointer; }
.chip-sm.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.cold-list { display: flex; flex-direction: column; gap: 8px; }
.cold-item { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; cursor: pointer; transition: border-color 0.15s; }
.cold-item:hover { border-color: var(--accent); }
.cold-name { font-weight: 600; display: flex; align-items: center; gap: 8px; }
.cold-sub { font-size: 11px; color: var(--accent); background: var(--code-bg); padding: 1px 6px; border-radius: 4px; }
.cold-desc { font-size: 12px; color: var(--ink-2); margin-top: 2px; }
.mem-filter { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 10px 0 4px; }
.mem-add { display: flex; gap: 8px; margin-bottom: 12px; }
.mem-add .input[type="text"], .mem-add .input:not(select) { flex: 1; }
.mem-list { max-height: 320px; overflow-y: auto; }
.mem-item { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px dashed var(--line); }
.mem-cat { font-size: 11px; border-radius: 4px; padding: 1px 6px; flex: none; }
.mem-content { flex: 1; font-size: 13px; word-break: break-word; }
.cat-core { background: #fee2e2; color: #dc2626; }
.cat-preference { background: #eef2ff; color: #4338ca; }
.cat-fact { background: #dcfce7; color: #16a34a; }
.ext-item { display: flex; align-items: flex-start; gap: 8px; padding: 8px 0; border-bottom: 1px dashed var(--line); cursor: pointer; }
.ext-item:last-child { border-bottom: none; }
.ext-item input { margin-top: 3px; }
.ext-body { flex: 1; font-size: 13px; line-height: 1.5; }

/* 手机/平板（≤900px）：父网格改单列时**必须同步重置子元素的 grid-column/row**——
   否则浏览器为满足 `grid-column:2/3` 会生成隐式列，消息流被塞进一条按内容收缩的窄列
   （用户反馈「手机端非常反人类」的直接根因）。这里显式改为纵向堆叠：
   工具行 → 消息流(占满剩余)。侧栏/提问节点改为「浮动抽屉」绝对定位盖在消息区上方。

   历史 bug（点击无反应根因）：旧实现把 .chat-side 与 .chat-fs-row 都放进 grid 第 1 行
   同一格——展开历史列表时两者重叠，.chat-fs-row（flex 容器默认 align-items: stretch）
   被拉成整行高、背景透明地盖在列表上，把全部点击吞掉 → 手机上点历史没反应。
   现让两者彻底脱离同一布局轨道：.chat-fs-row 独占 grid 行 1，抽屉走 absolute。 */
@media (max-width: 900px) {
  .ai-wrap { height: calc(100vh - 100px); height: calc(100dvh - 100px); }
  .ai-body { grid-template-columns: 1fr; grid-template-rows: auto 1fr; gap: 8px; }
  .chat-fs-row { grid-column: 1; grid-row: 1; margin-bottom: 0; }
  .chat-box { grid-column: 1; grid-row: 2; min-height: 0; }
  .chat-side, .timeline {
    position: absolute; top: 44px; z-index: 12; width: min(248px, 78vw);
    max-height: 0; overflow: hidden; padding: 0; border: none;
    opacity: 0; pointer-events: none; transform: translateY(-6px);
    background: var(--panel); border-radius: var(--radius);
    box-shadow: 0 8px 22px rgba(0, 0, 0, .18);
    transition: opacity .2s ease, transform .2s ease, max-height .3s ease;
  }
  .chat-side { left: 0; }
  .timeline { right: 0; }
  .chat-side.expanded, .timeline.expanded {
    max-height: 58vh; overflow-y: auto; padding: 10px;
    border: 1px solid var(--line); opacity: 1; pointer-events: auto; transform: none;
  }
  /* 顶部标签栏：横向滚动，不换行 */
  .quick-bar { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; margin: 8px 0; gap: 6px; padding-bottom: 4px; }
  .quick-bar::-webkit-scrollbar { display: none; }
  .quick-bar .chip { flex-shrink: 0; font-size: 12px; padding: 4px 10px; }
  /* 头部：紧凑化 */
  .ai-wrap > div:first-child { flex-wrap: wrap; gap: 8px; }
  .ai-wrap > div:first-child h2 { font-size: 16px; }
  /* 输入区：语音+输入框+发送挤一行会误触，窄屏改为输入框独占一行 */
  .input-row { flex-wrap: wrap; }
  .input-row .input { flex: 1 1 100%; }
  .bubble { max-width: 95%; font-size: .92em; padding: 10px 14px; }
}
</style>