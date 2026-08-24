<script setup>
// Agent 工作台：集中展示“专业 AI Agent 应用”的四大特征——
// 模块化 Agent（可切换/自动路由）、可扩展工具接口（实时列出）、任务编排轨迹（思考→工具→观察）、以及可注册的扩展能力。
import { ref, computed, onMounted, nextTick } from 'vue';
import { runAgentTurn, hasAIKey, saveChat, listChats, deleteChat } from '../ai.js';
import { agentSystem } from '../ai.js';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import { toast } from '../utils/toast.js';
import { TraceKind } from '../agent/types.js';
import { uid } from '../db.js';

const agents = ref(agentSystem.listAgents());
const tools = ref(agentSystem.listTools());
const selectedAgent = ref(''); // 空 = 自动路由
const input = ref('');
const loading = ref(false);
const messages = ref([]); // 当前会话消息 {role, content}
const traceNodes = ref([]); // 编排轨迹
const showTools = ref(false);
const streamBox = ref(null);
const sessions = ref([]); // Agent 会话历史（持久化到 aiChats，随数据包同步）
const currentId = ref('');

const traceMeta = {
  [TraceKind.ROUTE]: { label: '路由', cls: 't-route', icon: '➤' },
  [TraceKind.THOUGHT]: { label: '思考', cls: 't-thought', icon: '💡' },
  [TraceKind.TOOL_CALL]: { label: '调用工具', cls: 't-call', icon: '🔧' },
  [TraceKind.TOOL_RESULT]: { label: '工具返回', cls: 't-result', icon: '📦' },
  [TraceKind.FINAL]: { label: '结论', cls: 't-final', icon: '✅' },
  [TraceKind.ERROR]: { label: '异常', cls: 't-error', icon: '⚠️' },
  [TraceKind.PLAN]: { label: '计划', cls: 't-plan', icon: '🗂️' },
};

async function send() {
  const text = input.value.trim();
  if (!text || loading.value) return;
  if (!hasAIKey()) { toast('请先在「AI 设置」里填入 API 密钥', 'error'); return; }
  if (!currentId.value) currentId.value = uid();
  input.value = '';
  messages.value.push({ role: 'user', content: text });
  const bubble = { role: 'assistant', content: '', loading: true };
  messages.value.push(bubble);
  traceNodes.value = [];
  loading.value = true;
  scroll();
  try {
    const { reply, agentName, trace } = await runAgentTurn({
      userInput: text,
      history: messages.value.slice(0, -1),
      agentId: selectedAgent.value || null,
      onTrace: (node) => { traceNodes.value.push(node); },
    });
    bubble.content = reply;
    bubble.loading = false;
    bubble.agentName = agentName;
  } catch (e) {
    bubble.content = '（出错：' + e.message + '）';
    bubble.loading = false;
  } finally {
    loading.value = false;
    scroll();
    await persist();
  }
}

// ---- 会话持久化（存 aiChats type=agent，随数据包同步） ----
async function loadSessions() {
  const all = await listChats();
  sessions.value = all.filter(c => c.type === 'agent');
}
function newSession() {
  currentId.value = uid();
  messages.value = [];
  traceNodes.value = [];
}
function selectSession(id) {
  const s = sessions.value.find(x => x.id === id);
  if (!s) { newSession(); return; }
  currentId.value = id;
  messages.value = (s.messages || []).map(m => ({ role: m.role, content: m.content }));
  traceNodes.value = [];
}
async function persist() {
  if (!currentId.value) return;
  const clean = messages.value.filter(m => m.role && !m.loading).map(m => ({ role: m.role, content: m.content }));
  const firstUser = messages.value.find(m => m.role === 'user');
  const title = firstUser?.content?.slice(0, 18) || 'Agent 会话';
  await saveChat({ id: currentId.value, type: 'agent', title, messages: clean, createdAt: Date.now() });
  await loadSessions();
}
async function removeSession(id) {
  if (!confirm('删除这个 Agent 会话？')) return;
  await deleteChat(id);
  if (currentId.value === id) newSession();
  await loadSessions();
}

function scroll() { nextTick(() => { streamBox.value?.scrollTo({ top: streamBox.value.scrollHeight }); }); }

function clearTrace() { traceNodes.value = []; }
function clearChat() { newSession(); }

// 演示“可扩展接口”：运行时注册一个新工具/Agent（点击后生效，体现开闭原则）
function demoExtend() {
  agentSystem.registerTool({
    name: 'echo_demo',
    description: '【演示扩展】把输入原样返回，证明工具可在运行时注册并被编排器识别。',
    parameters: { text: 'string: 任意文本' },
    async execute(args) { return { ok: true, data: { echoed: args?.text || '' } }; },
  });
  tools.value = agentSystem.listTools();
  toast('已运行时注册工具 echo_demo（可在上方工具列表看到）', 'success');
}

const counts = computed(() => {
  const c = {};
  for (const n of traceNodes.value) c[n.kind] = (c[n.kind] || 0) + 1;
  return c;
});

onMounted(async () => {
  await loadSessions();
});
</script>

<template>
  <div class="wb-wrap">
    <div class="wb-head">
      <div>
        <h2 style="margin:0">Agent 工作台</h2>
        <div class="hint" style="margin-top:4px">
          模块化 Agent · 自动意图路由 · 多步工具编排 · 运行时可扩展接口
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select v-model="currentId" class="input" style="width:auto" @change="selectSession(currentId)">
          <option value="">＋ 新会话</option>
          <option v-for="s in sessions" :key="s.id" :value="s.id">{{ s.title }}</option>
        </select>
        <select v-model="selectedAgent" class="input" style="width:auto">
          <option value="">自动路由</option>
          <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
        <button class="chip" @click="showTools = !showTools">工具接口 ({{ tools.length }})</button>
        <button class="chip" @click="demoExtend">＋运行时扩展</button>
        <button class="chip" @click="clearChat">清空对话</button>
      </div>
    </div>

    <div class="wb-body">
      <!-- 左：Agent 与工具 -->
      <aside class="wb-side no-print">
        <div class="side-title">可用 Agent（{{ agents.length }}）</div>
        <div
          v-for="a in agents"
          :key="a.id"
          class="agent-card"
          :class="{ active: selectedAgent === a.id }"
          @click="selectedAgent = selectedAgent === a.id ? '' : a.id"
        >
          <div class="agent-name">{{ a.name }}</div>
          <div class="agent-desc">{{ a.description }}</div>
          <div class="agent-tools">
            <span v-for="t in a.tools" :key="t" class="tag">{{ t }}</span>
            <span v-if="!a.tools.length" class="tag muted">纯对话</span>
          </div>
        </div>

        <div v-if="showTools" style="margin-top:14px">
          <div class="side-title">可扩展工具接口（{{ tools.length }}）</div>
          <div v-for="t in tools" :key="t.name" class="tool-item">
            <div class="tool-name">
              {{ t.name }}
              <span v-if="t.writesData" class="badge w">写</span>
              <span v-if="t.readsData" class="badge r">读</span>
            </div>
            <div class="tool-desc">{{ t.description }}</div>
          </div>
        </div>
      </aside>

      <!-- 中：对话 -->
      <section class="wb-chat">
        <div ref="streamBox" class="chat-box">
          <div v-if="!messages.length" class="hint" style="text-align:center;padding:40px">
            试试：<br />「分析我本周的薄弱科目」<br />「把这段笔记拆成卡片」<br />「出 3 道数据结构选择题考我」
          </div>
          <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
            <div class="bubble">
              <div v-if="m.role === 'assistant' && m.loading" class="loading">思考/编排中…</div>
              <MarkdownRenderer v-else :content="m.content" />
              <div v-if="m.role === 'assistant' && m.agentName && !m.loading" class="agent-tag">🤖 {{ m.agentName }}</div>
            </div>
          </div>
        </div>
        <div class="input-row">
          <input v-model="input" class="input" placeholder="描述你的任务，Agent 会自动编排执行…" @keydown.enter="send" />
          <button class="btn primary" :disabled="loading" @click="send">执行</button>
        </div>
      </section>

      <!-- 右：编排轨迹 -->
      <aside class="wb-trace no-print">
        <div class="side-title">
          编排轨迹
          <span v-if="counts[TraceKind.THOUGHT]" class="mini">思考{{ counts[TraceKind.THOUGHT] }}</span>
          <span v-if="counts[TraceKind.TOOL_CALL]" class="mini">工具{{ counts[TraceKind.TOOL_CALL] }}</span>
          <a style="float:right;color:var(--red);cursor:pointer" @click="clearTrace">清</a>
        </div>
        <div v-if="!traceNodes.length" class="hint" style="padding:8px">提交任务后，这里实时展示 Agent 的「路由→思考→调用工具→观察→结论」。</div>
        <div v-for="(n, i) in traceNodes" :key="i" class="trace-node" :class="(traceMeta[n.kind] || {}).cls">
          <div class="trace-head">
            <span class="trace-icon">{{ (traceMeta[n.kind] || {}).icon || '•' }}</span>
            <span class="trace-label">{{ (traceMeta[n.kind] || {}).label || n.kind }}</span>
          </div>
          <div class="trace-text">{{ n.text }}</div>
          <pre v-if="n.detail" class="trace-detail">{{ n.detail }}</pre>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.wb-wrap { max-width: 1280px; margin: 0 auto; display: flex; flex-direction: column; height: calc(100vh - 140px); }
.wb-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.wb-body { flex: 1; display: grid; grid-template-columns: 240px 1fr 280px; gap: 12px; min-height: 0; }
.wb-side, .wb-trace { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 10px; overflow-y: auto; }
.side-title { font-size: 13px; font-weight: 600; color: var(--ink-2); margin-bottom: 8px; }
.agent-card { padding: 10px; border: 1px solid var(--line); border-radius: 10px; margin-bottom: 8px; cursor: pointer; transition: .15s; }
.agent-card:hover { border-color: var(--accent); }
.agent-card.active { background: var(--code-bg); border-color: var(--accent); }
.agent-name { font-weight: 600; font-size: 14px; }
.agent-desc { font-size: 12px; color: var(--ink-2); margin: 4px 0 6px; line-height: 1.5; }
.agent-tools { display: flex; flex-wrap: wrap; gap: 4px; }
.tag { font-size: 11px; background: var(--code-inline); border-radius: 4px; padding: 1px 6px; color: var(--ink-2); }
.tag.muted { opacity: .6; }
.tool-item { padding: 6px 0; border-bottom: 1px dashed var(--line); }
.tool-name { font-size: 12px; font-weight: 600; }
.tool-desc { font-size: 11px; color: var(--ink-2); line-height: 1.5; }
.badge { font-size: 10px; border-radius: 3px; padding: 0 4px; margin-left: 4px; }
.badge.w { background: #fee2e2; color: #dc2626; }
.badge.r { background: #dbeafe; color: #2563eb; }
.wb-chat { display: flex; flex-direction: column; min-height: 0; }
.chat-box { flex: 1; overflow-y: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 16px; }
.msg { display: flex; margin-bottom: 12px; }
.msg.user { justify-content: flex-end; }
.bubble { max-width: 80%; padding: 10px 14px; border-radius: 12px; white-space: normal; word-break: break-word; line-height: 1.6; }
.msg.user .bubble { background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
.msg.assistant .bubble { background: var(--code-bg); color: var(--ink); border-bottom-left-radius: 4px; }
.agent-tag { font-size: 11px; color: var(--ink-2); margin-top: 6px; }
.loading { color: var(--ink-2); }
.input-row { display: flex; gap: 8px; margin-top: 12px; }
.input-row .input { flex: 1; }
.trace-node { border-left: 3px solid var(--line); padding: 6px 8px; margin-bottom: 8px; border-radius: 0 8px 8px 0; background: var(--code-bg); }
.trace-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; }
.trace-text { font-size: 12px; color: var(--ink); margin-top: 3px; white-space: pre-wrap; line-height: 1.5; }
.trace-detail { font-size: 11px; background: var(--code-inline); border-radius: 6px; padding: 6px; margin: 6px 0 0; max-height: 160px; overflow: auto; white-space: pre-wrap; }
.t-route { border-left-color: #6366f1; }
.t-thought { border-left-color: #f59e0b; }
.t-call { border-left-color: #0ea5e9; }
.t-result { border-left-color: #10b981; }
.t-final { border-left-color: #22c55e; }
.t-error { border-left-color: #ef4444; }
.mini { font-size: 11px; background: var(--code-inline); border-radius: 4px; padding: 0 5px; margin-left: 4px; color: var(--ink-2); }
.chip { font-size: 12px; border: 1px solid var(--line); background: var(--panel); border-radius: 999px; padding: 4px 12px; cursor: pointer; }
.chip:hover { border-color: var(--accent); }
@media (max-width: 980px) {
  .wb-body { grid-template-columns: 1fr; }
  .wb-side, .wb-trace { max-height: 160px; }
}
</style>
