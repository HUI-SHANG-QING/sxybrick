<script setup>
// AI 智能助手：结合用户真实学习数据做自然语言问答
import { ref, onMounted, nextTick } from 'vue';
import { toast } from '../utils/toast.js';
import { chatAI, buildContext, getAIConfig, setAIConfig, hasAIKey } from '../ai.js';

const messages = ref([]);
const input = ref('');
const loading = ref(false);
const box = ref(null);

const showSettings = ref(false);
const cfg = ref(getAIConfig());

const SYSTEM_PROMPT = '你是「SxyBrick 记忆卡片」的智能学习助手。你会拿到用户的真实学习数据（卡片、复习记录、错题、标签、掌握度）。请用中文、简洁、友好地回答。当用户问学习情况、薄弱点、错因、复习建议时，务必结合下面提供的数据给出针对性建议，不要泛泛而谈。';

async function send() {
  const text = input.value.trim();
  if (!text || loading.value) return;
  if (!hasAIKey()) { showSettings.value = true; toast('请先配置 AI 密钥', 'error'); return; }
  input.value = '';
  messages.value.push({ role: 'user', content: text });
  loading.value = true;
  scroll();
  try {
    const ctx = await buildContext();
    const reply = await chatAI([
      { role: 'system', content: SYSTEM_PROMPT + '\n\n' + ctx },
      ...messages.value,
    ]);
    messages.value.push({ role: 'assistant', content: reply });
  } catch (e) {
    toast(e.message, 'error');
    messages.value.push({ role: 'assistant', content: '（出错了：' + e.message + '）' });
  } finally {
    loading.value = false;
    scroll();
  }
}

function saveSettings() {
  setAIConfig(cfg.value);
  showSettings.value = false;
  toast('AI 配置已保存', 'success');
}

function scroll() { nextTick(() => { box.value?.scrollTo({ top: box.value.scrollHeight }); }); }

onMounted(() => {
  messages.value.push({ role: 'assistant', content: '你好，我是你的学习助手。我能看到你的卡片、复习记录、错题、标签和掌握度。你可以问「我最近哪些科目薄弱？」「错得最多的是什么错因？」「给我一个针对性复习计划」等等。' });
});
</script>

<template>
  <div class="ai-wrap">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">AI 学习助手</h2>
      <span class="hint">基于你的真实复习数据回答</span>
      <span style="flex:1"></span>
      <button class="btn small" @click="cfg = getAIConfig(); showSettings = true">AI 设置</button>
    </div>

    <div ref="box" class="chat-box">
      <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
        <div class="bubble">{{ m.content }}</div>
      </div>
      <div v-if="loading" class="msg assistant"><div class="bubble">思考中…</div></div>
    </div>

    <div class="input-row">
      <input v-model="input" class="input" placeholder="问我任何关于你学习的问题…" @keydown.enter="send" />
      <button class="btn primary" :disabled="loading" @click="send">发送</button>
    </div>

    <!-- 设置弹窗 -->
    <teleport to="body">
      <div v-if="showSettings" class="modal-mask" @click.self="showSettings = false">
        <div class="modal">
          <h3>AI 设置</h3>
          <div class="field-label" style="margin-top:4px">API 地址（OpenAI 兼容）</div>
          <input v-model="cfg.baseUrl" class="input" placeholder="https://api.deepseek.com" />
          <div class="field-label">API 密钥</div>
          <input v-model="cfg.apiKey" class="input" type="password" placeholder="sk-..." />
          <div class="field-label">模型名</div>
          <input v-model="cfg.model" class="input" placeholder="deepseek-chat" />
          <div class="hint" style="margin-top:8px">DeepSeek 默认地址 https://api.deepseek.com，模型 deepseek-chat。密钥只存在你的浏览器本地。</div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
            <button class="btn" @click="showSettings = false">取消</button>
            <button class="btn primary" @click="saveSettings">保存</button>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.ai-wrap { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; height: calc(100vh - 140px); }
.chat-box { flex: 1; overflow-y: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 16px; margin: 16px 0; }
.msg { display: flex; margin-bottom: 12px; }
.msg.user { justify-content: flex-end; }
.bubble { max-width: 78%; padding: 10px 14px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; line-height: 1.6; }
.msg.user .bubble { background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
.msg.assistant .bubble { background: var(--code-bg); color: var(--ink); border-bottom-left-radius: 4px; }
.input-row { display: flex; gap: 8px; }
.input-row .input { flex: 1; }
</style>