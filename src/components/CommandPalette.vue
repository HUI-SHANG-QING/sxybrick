<script setup>
// 全局命令面板（Cmd/Ctrl+K）：快速搜卡/跳页/AI 提问一站式（#7）
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { useRouter } from 'vue-router';
import { db } from '../db.js';
import { searchCards } from '../repo.js';
import { toast } from '../utils/toast.js';

const router = useRouter();
const open = ref(false);
const q = ref('');
const sel = ref(0);
const inputEl = ref(null);
const results = ref([]);

const NAV_CMDS = [
  { kind: 'nav', label: '总览', desc: '学习数字孪生', path: '/', icon: '📊' },
  { kind: 'nav', label: '复习', desc: '今日到期卡片', path: '/review', icon: '🔁' },
  { kind: 'nav', label: '卡片库', desc: '管理所有卡片', path: '/cards', icon: '🗂️' },
  { kind: 'nav', label: '错题本', desc: '薄弱点', path: '/wrong', icon: '⚠️' },
  { kind: 'nav', label: '思维导图', desc: '多风格导图', path: '/mindmap', icon: '🗺️' },
  { kind: 'nav', label: '知识图谱', desc: '关联网络', path: '/graph', icon: '🔗' },
  { kind: 'nav', label: '费曼学习', desc: '以教代学', path: '/feynman', icon: '🎓' },
  { kind: 'nav', label: 'AI 助手', desc: '问答对话', path: '/ai', icon: '💬' },
  { kind: 'nav', label: '番茄钟', desc: '专注计时', path: '/pomodoro', icon: '🍅' },
  { kind: 'nav', label: '学习计划', desc: '阶段规划', path: '/plans', icon: '📋' },
  { kind: 'nav', label: '模考', desc: '组卷自测', path: '/exam', icon: '📝' },
  { kind: 'nav', label: '统计', desc: '学习数据', path: '/stats', icon: '📈' },
  { kind: 'nav', label: '同步', desc: '导出导入', path: '/sync', icon: '☁️' },
];

const list = computed(() => {
  const query = q.value.trim().toLowerCase();
  if (!query) return NAV_CMDS;
  const nav = NAV_CMDS.filter(c => c.label.toLowerCase().includes(query) || c.desc.toLowerCase().includes(query));
  const cards = results.value.map(c => ({ kind: 'card', label: String(c.front).slice(0, 40), desc: c.subject || '未分类', cardId: c.id, icon: '🗂️' }));
  const ai = query.length > 1 ? [{ kind: 'ai', label: `AI 提问：${q.value.trim().slice(0, 30)}`, desc: '回车发送到 AI 助手', icon: '🤖' }] : [];
  return [...nav, ...cards.slice(0, 6), ...ai];
});

let searchTimer = null;
watch(q, (v) => {
  clearTimeout(searchTimer);
  if (!v.trim()) { results.value = []; return; }
  searchTimer = setTimeout(async () => {
    try {
      const cards = await searchCards(v.trim(), { mode: 'all' });
      results.value = cards.slice(0, 8);
    } catch { results.value = []; }
    sel.value = 0;
  }, 200);
});

function show() { open.value = true; q.value = ''; sel.value = 0; nextTick(() => inputEl.value?.focus()); }
function hide() { open.value = false; }

function exec(item) {
  if (!item) return;
  if (item.kind === 'nav') { router.push(item.path); hide(); }
  else if (item.kind === 'card') { router.push(`/cards?id=${item.cardId}`); hide(); }
  else if (item.kind === 'ai') { router.push(`/ai?q=${encodeURIComponent(q.value.trim())}`); hide(); }
}

function onKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open.value ? hide() : show(); return; }
  if (!open.value) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); sel.value = Math.min(sel.value + 1, list.value.length - 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); sel.value = Math.max(sel.value - 1, 0); }
  else if (e.key === 'Enter') { e.preventDefault(); exec(list.value[sel.value]); }
  else if (e.key === 'Escape') { hide(); }
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

defineExpose({ show });
</script>

<template>
  <Transition name="cp-fade">
    <div v-if="open" class="cp-mask" @click.self="hide">
      <div class="cp-box">
        <div class="cp-input-wrap">
          <span class="cp-icon">🔍</span>
          <input ref="inputEl" v-model="q" class="cp-input" placeholder="搜卡片 / 跳页面 / AI 提问…" @keydown="onKey" />
          <kbd class="cp-esc">ESC</kbd>
        </div>
        <div class="cp-list">
          <div v-for="(item, i) in list" :key="item.kind + i" class="cp-item" :class="{ active: i === sel }" @mouseenter="sel = i" @click="exec(item)">
            <span class="cp-item-icon">{{ item.icon }}</span>
            <span class="cp-item-label">{{ item.label }}</span>
            <span class="cp-item-desc">{{ item.desc }}</span>
            <kbd v-if="item.kind === 'nav'" class="cp-kbd">↵</kbd>
          </div>
          <div v-if="!list.length" class="cp-empty">无匹配，回车作为 AI 提问</div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.cp-mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 200; display: flex; justify-content: center; align-items: flex-start; padding-top: 12vh; }
.cp-box { width: 560px; max-width: 92vw; background: var(--panel); border-radius: 14px; box-shadow: 0 16px 50px rgba(0,0,0,.3); overflow: hidden; border: 1px solid var(--line); }
.cp-input-wrap { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.cp-icon { font-size: 16px; opacity: .7; }
.cp-input { flex: 1; border: none; outline: none; background: transparent; color: var(--ink); font-size: 15px; }
.cp-esc { font-size: 10px; padding: 2px 6px; background: var(--code-bg); border-radius: 4px; color: var(--ink-2); }
.cp-list { max-height: 360px; overflow-y: auto; padding: 6px; }
.cp-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; cursor: pointer; }
.cp-item.active { background: var(--code-bg); }
.cp-item-icon { font-size: 16px; }
.cp-item-label { font-size: 14px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cp-item-desc { font-size: 12px; color: var(--ink-2); margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
.cp-kbd { font-size: 11px; padding: 1px 5px; background: var(--code-bg); border-radius: 3px; color: var(--ink-2); }
.cp-empty { text-align: center; padding: 24px; color: var(--ink-2); font-size: 13px; }
.cp-fade-enter-active, .cp-fade-leave-active { transition: opacity .15s; }
.cp-fade-enter-from, .cp-fade-leave-to { opacity: 0; }
</style>