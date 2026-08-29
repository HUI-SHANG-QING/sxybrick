<script setup>
// 全局搜索（E1 数字资产保值批 → M4 统一搜索服务）：
// 全量搜索（聚合所有模块，分类展示）+ 针对性搜索（指定模块）；关键词高亮，点击跳转定位。
// 数据源全部走当前 db 实例（live binding）→ 演示模式下自动搜测试数据。
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { search, highlight, SCOPE_ORDER, SCOPE_LABELS } from '../search/search-service.js';

const router = useRouter();
const q = ref('');
const loading = ref(false);
const scope = ref(localStorage.getItem('sxy_search_scope') || 'all');
const results = ref({ modules: [], total: 0 });

const scopeOptions = [
  { key: 'all', label: '全部（全局搜索）', icon: '🌐' },
  ...SCOPE_ORDER.map(k => ({ key: k, label: SCOPE_LABELS[k], icon: '' })),
];
watch(scope, v => localStorage.setItem('sxy_search_scope', v));

let timer = null;
watch(q, () => {
  clearTimeout(timer);
  timer = setTimeout(runSearch, 250);
});

async function runSearch() {
  const kw = q.value.trim();
  if (!kw) { results.value = { modules: [], total: 0 }; return; }
  loading.value = true;
  try {
    results.value = await search(scope.value, kw);
  } finally { loading.value = false; }
}

// 模板高亮：先转义再包 <mark>（search-service.highlight 已做 XSS 转义）
function hl(text) { return highlight(text, q.value.trim()); }

// 搜索结果点击跳转：把具体条目的 id 编码到 URL，目标页面读取后自动筛选/定位
function go(item) {
  if (!item || !item.go) return;
  const base = item.go === '/' ? '/cards' : item.go;
  const params = new URLSearchParams();
  if (item.id) params.set('id', String(item.id));
  // 卡片附加关键字，便于 Cards 页延续搜索上下文
  if (base === '/cards' && q.value.trim()) params.set('q', q.value.trim());
  router.push(`${base}${params.toString() ? '?' + params.toString() : ''}`);
}

// 快捷键：/ 聚焦搜索框（输入框内不触发）
const inputEl = ref(null);
function onKeydown(e) {
  if (e.key !== '/') return;
  const t = document.activeElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  e.preventDefault();
  inputEl.value?.focus();
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => { clearTimeout(timer); window.removeEventListener('keydown', onKeydown); });
</script>

<template>
  <div style="max-width:860px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">全局搜索</h2>
      <span class="hint">按 / 快速聚焦 · 一次搜遍所有模块</span>
    </div>

    <!-- M4：搜索范围选择器（全量 / 指定模块） -->
    <div class="scope-row">
      <button v-for="s in scopeOptions" :key="s.key" class="chip" :class="{ on: scope === s.key }" @click="scope = s.key">
        {{ s.icon }} {{ s.label }}
      </button>
    </div>

    <input ref="inputEl" v-model="q" class="input" style="margin-top:14px;font-size:16px;padding:12px 14px"
           placeholder="输入关键词，例如：死锁 / 特征值 / 操作系统…" @keyup.enter="runSearch" autofocus />

    <div v-if="q.trim()" class="hint" style="margin-top:10px">
      {{ loading ? '搜索中…' : `找到 ${results.total} 条结果` }}
    </div>

    <!-- 结果：按模块分组（scope=all 时多组；指定模块时单组） -->
    <template v-for="m in results.modules" :key="m.key" v-if="m.items.length">
      <div class="sec-title">{{ m.icon }} {{ m.label }}（{{ m.items.length }}）</div>
      <div v-for="r in m.items" :key="m.key + r.id" class="sr-row" @click="go(r)">
        <span class="sr-title" v-html="hl(r.title)"></span>
        <span class="hint" v-html="hl(r.sub)"></span>
      </div>
    </template>

    <div v-if="q.trim() && !loading && !results.total" class="hint" style="text-align:center;padding:50px">
      在「{{ scope === 'all' ? '全部模块' : (SCOPE_LABELS[scope] || scope) }}」没有找到与「{{ q }}」相关的资产
    </div>
  </div>
</template>

<style scoped>
.scope-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.sec-title { font-size: 13px; font-weight: 700; color: var(--ink-2); margin: 16px 0 6px; }
.sr-row { display: flex; flex-direction: column; gap: 2px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); margin-bottom: 8px; cursor: pointer; transition: border-color .15s; }
.sr-row:hover { border-color: var(--accent); }
.sr-title { font-weight: 600; }
:deep(mark) { background: #ffe58f; color: inherit; border-radius: 3px; padding: 0 1px; }
</style>
