<script setup>
// AI 智能助手：对话历史（存 IndexedDB 并可同步）+ 快捷指令 + 智能组卡 + 数轴定位
import { confirmDialog } from '../utils/confirm.js';
import { ref, computed, onMounted, nextTick } from 'vue';
import { toast } from '../utils/toast.js';
import { chatAI, buildContext, getAIConfig, setAIConfig, hasAIKey, listChats, getChat, saveChat, deleteChat, newChat, buildMemoryText, extractMemories, listMemories, addMemory, deleteMemory } from '../ai.js';
import { generateDeck, bulkCreateCards, generateColdStartDeck, COLD_START_TEMPLATES } from '../utils/genDeck.js';
import VoiceInput from '../components/VoiceInput.vue';
import EmptyState from '../components/EmptyState.vue';
import TextZoomBar from '../components/TextZoomBar.vue';
import { useTextZoom } from '../composables/useTextZoom.js';
import { speak } from '../utils/tts.js';
import { T } from '../utils/telemetry.js';
import { t } from '../i18n/index.js';
import { stringifyReply } from '../agent/reply.js';

const chats = ref([]);
const currentChat = ref(newChat());
const input = ref('');
const loading = ref(false);
const box = ref(null);

// 阅读缩放：AI 长回答要能放大专注阅读（字号重排，Ctrl+滚轮；按模块记忆）
const { scale: zoomScale, fontStyle, zoomIn, zoomOut, reset: resetZoom, onWheel } = useTextZoom('aiAssistant');

const showSettings = ref(false);
const cfg = ref(getAIConfig());

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

const SYSTEM_PROMPT = '你是「SxyBrick 记忆卡片」的智能学习助手。你会拿到用户的真实学习数据（卡片、复习记录、错题、标签、掌握度）。请用中文、简洁、友好地回答。当用户问学习情况、薄弱点、错因、复习建议时，务必结合下面提供的数据给出针对性建议，不要泛泛而谈。';

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

async function send() {
  const text = input.value.trim();
  if (!text || loading.value) return;
  if (!hasAIKey()) { showSettings.value = true; toast(t('views.aiAssistant.needKey'), 'error'); return; }
  input.value = '';
  currentChat.value.messages.push({ role: 'user', content: text });
  if (currentChat.value.messages.filter(m => m.role === 'user').length === 1) currentChat.value.title = text.slice(0, 18);
  loading.value = true;
  scroll();
  try {
    const [ctx, mem] = await Promise.all([buildContext(), buildMemoryText()]);
    const reply = await chatAI([
      { role: 'system', content: SYSTEM_PROMPT + '\n\n' + (mem ? mem + '\n\n' : '') + ctx },
      ...currentChat.value.messages,
    ]);
    // 空白回复兜底：O4 收口到 stringifyReply（统一口径 + 计入 AI 回复质量监控 getReplyStats）
    const final = stringifyReply(reply, t('views.aiAssistant.noContent'));
    try { T.aiCall('chat', final.length); } catch {}
    currentChat.value.messages.push({ role: 'assistant', content: final });
    if (voiceOn.value) speak(final);
    const n = await extractMemories(text, final);
    if (n > 0) toast(t('views.aiAssistant.memSaved', undefined, { n }), 'success');
  } catch (e) {
    toast(e.message, 'error');
    currentChat.value.messages.push({ role: 'assistant', content: t('views.aiAssistant.chatError', undefined, { msg: e.message }) });
  } finally {
    loading.value = false;
    await persist();
    scroll();
  }
}

function scroll() { nextTick(() => { box.value?.scrollTo({ top: box.value.scrollHeight }); }); }
function scrollToUser(i) { document.getElementById('msg-' + i)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

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
  <div class="ai-wrap">
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

    <div class="ai-body">
      <!-- 左栏：历史对话 -->
      <div class="chat-side">
        <div class="side-title">{{ t('views.aiAssistant.historyTitle') }}</div>
        <EmptyState v-if="!chats.length" compact icon="🤖" :title="t('views.aiAssistant.emptyHistoryTitle')" :message="t('views.aiAssistant.emptyHistoryMsgPrefix') + t('views.aiAssistant.genDeckBtn') + t('views.aiAssistant.emptyHistoryMsgSuffix')" />
        <div v-for="c in chats" :key="c.id" class="chat-item" :class="{ active: c.id === currentChat.id }" @click="selectChat(c.id)">
          <div class="chat-item-title">{{ c.title || t('views.aiAssistant.newChatTitle') }}</div>
          <div class="chat-item-meta">{{ c.messages?.length || 0 }}{{ t('views.aiAssistant.msgCountSuffix') }}
            <a style="float:right;color:var(--red);cursor:pointer" @click.stop="removeChat(c.id)">{{ t('views.aiAssistant.delLink') }}</a>
          </div>
        </div>
      </div>

      <!-- 中间：消息流 -->
      <div class="chat-zoom-row">
        <TextZoomBar :scale="zoomScale" @zoom-in="zoomIn" @zoom-out="zoomOut" @reset="resetZoom" />
      </div>
      <div ref="box" class="chat-box" :style="fontStyle" @wheel="onWheel">
        <div v-if="!currentChat.messages.length" class="hint" style="text-align:center;padding:40px">
          {{ t('views.aiAssistant.chatEmpty') }}
        </div>
        <div v-for="(m, i) in currentChat.messages" :key="i" :id="'msg-' + i" class="msg" :class="m.role">
          <div class="bubble">{{ m.content }}</div>
        </div>
        <div v-if="loading" class="msg assistant"><div class="bubble">{{ t('views.aiAssistant.aiThinking') }}</div></div>
      </div>

      <!-- 右栏：数轴节点 -->
      <div class="timeline">
        <div class="side-title">{{ t('views.aiAssistant.nodesTitle') }}</div>
        <EmptyState v-if="!userNodes.length" compact icon="🤖" :title="t('views.aiAssistant.emptyNodesTitle')" :message="t('views.aiAssistant.emptyNodesMsg')" />
        <div v-for="n in userNodes" :key="n.index" class="tl-node" :title="n.text" @click="scrollToUser(n.index)">
          <span class="tl-dot"></span>
          <span class="tl-text">{{ n.text.slice(0, 12) }}</span>
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
          <div class="hint" style="margin-top:8px">{{ t('views.aiAssistant.apiHint') }}</div>
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
                    {{ c.front }}
                  </div>
                  <div class="gen-a">{{ c.back }}</div>
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
          <div class="mem-list">
            <EmptyState v-if="!memories.length" icon="🤖" :title="t('views.aiAssistant.emptyMemTitle')" :message="t('views.aiAssistant.emptyMemMsg')" />
            <div v-for="m in memories" :key="m.id" class="mem-item">
              <span class="mem-cat" :class="'cat-' + m.category">{{ catName(m.category) }}</span>
              <span class="mem-content">{{ m.content }}</span>
              <a style="color:var(--red);cursor:pointer" @click="removeMem(m.id)">{{ t('views.aiAssistant.delLink') }}</a>
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:12px">
            <button class="btn" @click="memOpen = false">{{ t('views.aiAssistant.close') }}</button>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.ai-wrap { max-width: 960px; margin: 0 auto; display: flex; flex-direction: column; height: calc(100vh - 140px); }
.quick-bar { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
.ai-body { flex: 1; display: grid; grid-template-columns: 180px 1fr 120px; gap: 12px; min-height: 0; }
.chat-side, .timeline { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 10px; overflow-y: auto; }
.side-title { font-size: 13px; font-weight: 600; color: var(--ink-2); margin-bottom: 8px; }
.chat-item { padding: 8px; border-radius: 8px; cursor: pointer; margin-bottom: 4px; }
.chat-item:hover { background: var(--code-inline); }
.chat-item.active { background: var(--code-bg); }
.chat-item-title { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chat-item-meta { font-size: 11px; color: var(--ink-2); margin-top: 2px; }
.chat-zoom-row { display: flex; justify-content: flex-end; margin-bottom: 6px; }
.chat-box { overflow-y: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 16px; }
.msg { display: flex; margin-bottom: 12px; }
.msg.user { justify-content: flex-end; }
.bubble { max-width: 78%; padding: 10px 14px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; line-height: 1.6; }
.msg.user .bubble { background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
.msg.assistant .bubble { background: var(--code-bg); color: var(--ink); border-bottom-left-radius: 4px; }
.tl-node { display: flex; align-items: center; gap: 6px; padding: 5px 0; cursor: pointer; border-bottom: 1px dashed var(--line); }
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
.gen-q { font-weight: 600; display: flex; align-items: center; gap: 6px; }
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

@media (max-width: 720px) {
  .ai-body { grid-template-columns: 1fr; }
  .chat-side, .timeline { max-height: 120px; }
}
</style>