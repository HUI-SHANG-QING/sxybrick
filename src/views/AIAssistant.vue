<script setup>
// AI 智能助手：对话历史（存 IndexedDB 并可同步）+ 快捷指令 + 智能组卡 + 数轴定位
import { ref, computed, onMounted, nextTick } from 'vue';
import { toast } from '../utils/toast.js';
import { chatAI, buildContext, getAIConfig, setAIConfig, hasAIKey, listChats, getChat, saveChat, deleteChat, newChat, buildMemoryText, extractMemories, listMemories, addMemory, deleteMemory } from '../ai.js';
import { createCard } from '../repo.js';
import VoiceInput from '../components/VoiceInput.vue';
import { speak } from '../utils/tts.js';

const chats = ref([]);
const currentChat = ref(newChat());
const input = ref('');
const loading = ref(false);
const box = ref(null);

const showSettings = ref(false);
const cfg = ref(getAIConfig());

const genOpen = ref(false);
const genText = ref('');
const genCards = ref([]);
const genLoading = ref(false);

const SYSTEM_PROMPT = '你是「SxyBrick 记忆卡片」的智能学习助手。你会拿到用户的真实学习数据（卡片、复习记录、错题、标签、掌握度）。请用中文、简洁、友好地回答。当用户问学习情况、薄弱点、错因、复习建议时，务必结合下面提供的数据给出针对性建议，不要泛泛而谈。';

const userNodes = computed(() => {
  const nodes = [];
  (currentChat.value.messages || []).forEach((m, i) => { if (m.role === 'user') nodes.push({ index: i, text: m.content }); });
  return nodes;
});

async function loadChatList() { chats.value = await listChats(); }

async function selectChat(id) {
  currentChat.value = (await getChat(id)) || newChat();
  await loadChatList();
  scroll();
}

async function createNew() {
  currentChat.value = newChat();
  await loadChatList();
}

async function removeChat(id) {
  if (!confirm('删除这个对话？')) return;
  await deleteChat(id);
  if (currentChat.value.id === id) currentChat.value = newChat();
  await loadChatList();
}

async function persist() {
  await saveChat(currentChat.value);
  await loadChatList();
}

async function send() {
  const text = input.value.trim();
  if (!text || loading.value) return;
  if (!hasAIKey()) { showSettings.value = true; toast('请先配置 AI 密钥', 'error'); return; }
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
    currentChat.value.messages.push({ role: 'assistant', content: reply });
    if (voiceOn.value) speak(reply);
    const n = await extractMemories(text, reply);
    if (n > 0) toast(`已自动记下 ${n} 条记忆`, 'success');
  } catch (e) {
    toast(e.message, 'error');
    currentChat.value.messages.push({ role: 'assistant', content: '（出错：' + e.message + '）' });
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
    toast(r ? '连接成功：' + r.trim().slice(0, 30) : '连接成功', 'success');
  } catch (e) {
    toast('连接失败：' + e.message, 'error');
  } finally { testing.value = false; }
}
function saveSettings() { setAIConfig(cfg.value); showSettings.value = false; toast('AI 配置已保存', 'success'); }

// ---- 快捷指令 ----
const quickActions = [
  { label: '智能出题', prompt: '请根据我的数据，出 3 道选择题考我（给出 A-D 选项，先别公布答案，等我回答后再判对错）' },
  { label: '学习周报', prompt: '请根据我的数据，生成一份本周学习周报：学了什么、哪里薄弱、下周复习建议' },
  { label: '知识关联', prompt: '请分析我的卡片涉及的知识点之间的关联，帮我把它们串成一个知识网络' },
];
function clickQuick(q) { input.value = q.prompt; send(); }

// ---- 智能组卡 ----
async function generateCards() {
  const t = genText.value.trim();
  if (!t) return toast('请先粘贴内容', 'error');
  genLoading.value = true;
  try {
    const r = await chatAI([
      { role: 'system', content: '你是学习内容拆解助手。把用户文字拆成记忆卡片，输出严格 JSON 数组，每项 {"front":"问题/提示","back":"答案","subject":"科目","tags":["标签"]}。只输出 JSON 数组，不要 markdown 代码块，不要多余文字。' },
      { role: 'user', content: t },
    ]);
    genCards.value = parseCards(r);
    if (!genCards.value.length) toast('没解析出卡片，请检查内容', 'error');
  } catch (e) { toast(e.message, 'error'); }
  finally { genLoading.value = false; }
}
function parseCards(text) {
  try {
    const m = String(text).match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : text);
    return Array.isArray(arr) ? arr.filter(c => c && c.front && c.back) : [];
  } catch { return []; }
}
async function importCards() {
  if (!genCards.value.length) return;
  for (const c of genCards.value) {
    await createCard({ front: String(c.front), back: String(c.back), subject: c.subject || '', tags: c.tags || [], type: 'basic' });
  }
  toast(`已导入 ${genCards.value.length} 张卡片`, 'success');
  genOpen.value = false; genCards.value = []; genText.value = '';
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
function catName(c) { return c === 'core' ? '核心' : c === 'preference' ? '偏好' : '事实'; }

const voiceOn = ref(localStorage.getItem('sxy_voice') !== '0');
function toggleVoice() {
  voiceOn.value = !voiceOn.value;
  localStorage.setItem('sxy_voice', voiceOn.value ? '1' : '0');
  if (!voiceOn.value && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

onMounted(loadChatList);
</script>

<template>
  <div class="ai-wrap">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">AI 学习助手</h2>
      <button class="btn primary small" @click="createNew">＋ 新建对话</button>
      <span style="flex:1"></span>
      <button class="chip" :class="{ on: voiceOn }" @click="toggleVoice">语音播报</button>
      <button class="btn small" @click="openMem">记忆</button>
      <button class="btn small" @click="cfg = getAIConfig(); showSettings = true">AI 设置</button>
    </div>

    <div class="quick-bar">
      <button v-for="q in quickActions" :key="q.label" class="chip" @click="clickQuick(q)">{{ q.label }}</button>
      <button class="chip" style="border-color:var(--blue);color:var(--blue)" @click="genOpen = true">智能组卡</button>
    </div>

    <div class="ai-body">
      <!-- 左栏：历史对话 -->
      <div class="chat-side">
        <div class="side-title">历史对话</div>
        <div v-if="!chats.length" class="hint" style="padding:8px">暂无历史对话</div>
        <div v-for="c in chats" :key="c.id" class="chat-item" :class="{ active: c.id === currentChat.id }" @click="selectChat(c.id)">
          <div class="chat-item-title">{{ c.title || '新对话' }}</div>
          <div class="chat-item-meta">{{ c.messages?.length || 0 }} 条
            <a style="float:right;color:var(--red);cursor:pointer" @click.stop="removeChat(c.id)">删</a>
          </div>
        </div>
      </div>

      <!-- 中间：消息流 -->
      <div ref="box" class="chat-box">
        <div v-if="!currentChat.messages.length" class="hint" style="text-align:center;padding:40px">
          你好，我是你的学习助手。问问我吧，例如「我最近哪些科目薄弱？」
        </div>
        <div v-for="(m, i) in currentChat.messages" :key="i" :id="'msg-' + i" class="msg" :class="m.role">
          <div class="bubble">{{ m.content }}</div>
        </div>
        <div v-if="loading" class="msg assistant"><div class="bubble">思考中…</div></div>
      </div>

      <!-- 右栏：数轴节点 -->
      <div class="timeline">
        <div class="side-title">提问节点</div>
        <div v-if="!userNodes.length" class="hint" style="padding:8px">暂无提问</div>
        <div v-for="n in userNodes" :key="n.index" class="tl-node" :title="n.text" @click="scrollToUser(n.index)">
          <span class="tl-dot"></span>
          <span class="tl-text">{{ n.text.slice(0, 12) }}</span>
        </div>
      </div>
    </div>

    <div class="input-row">
      <VoiceInput @result="(t) => input = input ? input + t : t" />
      <input v-model="input" class="input" placeholder="问我任何关于你学习的问题…" @keydown.enter="send" />
      <button class="btn primary" :disabled="loading" @click="send">发送</button>
    </div>

    <!-- AI 设置弹窗 -->
    <teleport to="body">
      <div v-if="showSettings" class="modal-mask" @click.self="showSettings = false">
        <div class="modal">
          <h3>AI 设置</h3>
          <div class="field-label" style="margin-top:4px">API 地址（OpenAI 兼容）</div>
          <input v-model="cfg.baseUrl" class="input" placeholder="https://api.deepseek.com" />
          <div class="field-label">API 密钥</div>
          <input v-model="cfg.apiKey" class="input" type="password" placeholder="sk-..." />
          <div class="field-label">模型名</div>
          <input v-model="cfg.model" class="input" placeholder="deepseek-v4-flash" />
          <div class="hint" style="margin-top:8px">推荐 deepseek-v4-flash（快、便宜、够用）；需要更强推理可换 deepseek-v4-pro。密钥只存你本地。</div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
            <button class="btn" :disabled="testing" @click="testConnection">{{ testing ? '测试中…' : '测试连接' }}</button>
            <button class="btn" @click="showSettings = false">取消</button>
            <button class="btn primary" @click="saveSettings">保存</button>
          </div>
        </div>
      </div>
    </teleport>

    <!-- 智能组卡弹窗 -->
    <teleport to="body">
      <div v-if="genOpen" class="modal-mask" @click.self="genOpen = false">
        <div class="modal">
          <h3>智能组卡</h3>
          <p class="hint" style="margin-top:0">粘贴一段学习内容（笔记/讲义/文章），AI 自动拆成记忆卡片。</p>
          <textarea v-model="genText" class="input" rows="6" placeholder="粘贴内容…"></textarea>
          <div style="display:flex;gap:10px;margin-top:12px">
            <button class="btn primary" :disabled="genLoading" @click="generateCards">{{ genLoading ? '生成中…' : '生成卡片' }}</button>
          </div>
          <div v-if="genCards.length" style="margin-top:12px">
            <div class="hint" style="margin-bottom:6px">预览（{{ genCards.length }} 张）</div>
            <div class="gen-list">
              <div v-for="(c, i) in genCards" :key="i" class="gen-item">
                <div class="gen-q">{{ c.front }}</div>
                <div class="gen-a">{{ c.back }}</div>
              </div>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px">
              <button class="btn" @click="genOpen = false">取消</button>
              <button class="btn primary" @click="importCards">导入这 {{ genCards.length }} 张</button>
            </div>
          </div>
        </div>
      </div>
    </teleport>

    <!-- 记忆库弹窗 -->
    <teleport to="body">
      <div v-if="memOpen" class="modal-mask" @click.self="memOpen = false">
        <div class="modal">
          <h3>Agent 记忆库</h3>
          <p class="hint" style="margin-top:0">Agent 会跨对话记住这些信息，并自动按分层注入。</p>
          <div class="mem-add">
            <select v-model="newMemCat" class="input" style="width:auto">
              <option value="core">核心</option>
              <option value="preference">偏好</option>
              <option value="fact">事实</option>
            </select>
            <input v-model="newMemContent" class="input" placeholder="记住什么？如：我在备考考研计算机408" @keydown.enter="addMem" />
            <button class="btn primary" @click="addMem">添加</button>
          </div>
          <div class="mem-list">
            <div v-if="!memories.length" class="hint" style="text-align:center;padding:20px">暂无记忆，对话中 Agent 会自动提取，也可手动添加。</div>
            <div v-for="m in memories" :key="m.id" class="mem-item">
              <span class="mem-cat" :class="'cat-' + m.category">{{ catName(m.category) }}</span>
              <span class="mem-content">{{ m.content }}</span>
              <a style="color:var(--red);cursor:pointer" @click="removeMem(m.id)">删</a>
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:12px">
            <button class="btn" @click="memOpen = false">关闭</button>
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
.gen-list { max-height: 320px; overflow-y: auto; border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; }
.gen-item { padding: 8px 0; border-bottom: 1px dashed var(--line); }
.gen-item:last-child { border-bottom: none; }
.gen-q { font-weight: 600; }
.gen-a { color: var(--ink-2); font-size: 13px; margin-top: 2px; }
.mem-add { display: flex; gap: 8px; margin-bottom: 12px; }
.mem-add .input[type="text"], .mem-add .input:not(select) { flex: 1; }
.mem-list { max-height: 320px; overflow-y: auto; }
.mem-item { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px dashed var(--line); }
.mem-cat { font-size: 11px; border-radius: 4px; padding: 1px 6px; flex: none; }
.mem-content { flex: 1; font-size: 13px; word-break: break-word; }
.cat-core { background: #fee2e2; color: #dc2626; }
.cat-preference { background: #eef2ff; color: #4338ca; }
.cat-fact { background: #dcfce7; color: #16a34a; }

@media (max-width: 720px) {
  .ai-body { grid-template-columns: 1fr; }
  .chat-side, .timeline { max-height: 120px; }
}
</style>