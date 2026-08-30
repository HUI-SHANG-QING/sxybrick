<script setup>
// 全局搜索（E1 数字资产保值批 → M4 统一搜索服务）：
// 全量搜索（聚合所有模块，分类展示）+ 针对性搜索（指定模块）；关键词高亮，点击跳转定位。
// 数据源全部走当前 db 实例（live binding）→ 演示模式下自动搜测试数据。
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { search, highlight, SCOPE_ORDER, SCOPE_LABELS } from '../search/search-service.js';
import { t } from '../i18n/index.js';

const router = useRouter();
const q = ref('');
const loading = ref(false);
const scope = ref(localStorage.getItem('sxy_search_scope') || 'all');
const results = ref({ modules: [], total: 0 });

// 只渲染有命中的分组。
// ⚠️ 不能写成 <template v-for="m in results.modules" v-if="m.items.length">：
// Vue 3 里 v-if 的优先级高于 v-for，条件会先求值，此时 v-for 变量 m 尚未定义，
// 编译产物是 _ctx.m.items.length → 渲染时抛 TypeError，整页白屏。
const visibleModules = computed(() => (results.value.modules || []).filter(m => m.items?.length));

const scopeOptions = [
  { key: 'all', label: t('views.search.scopeAll'), icon: '🌐' },
  ...SCOPE_ORDER.map(k => ({ key: k, label: SCOPE_LABELS[k], icon: '' })),
];
// 切换范围后必须重新搜索：否则已有关键词时结果停留在旧范围（原来只写 localStorage 不重搜）
watch(scope, v => { localStorage.setItem('sxy_search_scope', v); runSearch(); });

let timer = null;
watch(q, () => {
  clearTimeout(timer);
  timer = setTimeout(runSearch, 250);
});

// 请求序号：防抖只压最后一次发起，但异步落盘快慢不定，慢的旧结果可能覆盖新结果
let seq = 0;
const err = ref('');
async function runSearch() {
  const kw = q.value.trim();
  clearTimeout(timer);
  const my = ++seq;
  if (!kw) { results.value = { modules: [], total: 0 }; err.value = ''; return; }
  loading.value = true;
  err.value = '';
  try {
    const r = await search(scope.value, kw);
    if (my !== seq) return; // 已有更新的请求，丢弃本次结果
    results.value = r;
  } catch (e) {
    if (my !== seq) return;
    err.value = String(e?.message || e);
    results.value = { modules: [], total: 0 };
  } finally {
    if (my === seq) loading.value = false;
  }
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
      <h2 style="margin:0">{{ t('views.search.title') }}</h2>
      <span class="hint">{{ t('views.search.hint') }}</span>
    </div>

    <!-- M4：搜索范围选择器（全量 / 指定模块） -->
    <div class="scope-row">
      <button v-for="s in scopeOptions" :key="s.key" class="chip" :class="{ on: scope === s.key }" @click="scope = s.key">
        {{ s.icon }} {{ s.label }}
      </button>
    </div>

    <input ref="inputEl" v-model="q" class="input" style="margin-top:14px;font-size:16px;padding:12px 14px"
           :placeholder="t('views.search.placeholder')" @keyup.enter="runSearch" autofocus />

    <div v-if="err" class="hint" style="margin-top:10px;color:var(--red)">{{ t('views.search.error', '搜索出错：{msg}', { msg: err }) }}</div>
    <div v-else-if="q.trim()" class="hint" style="margin-top:10px">
      {{ loading ? t('views.search.searching') : t('views.search.found', '找到 {n} 条结果', { n: results.total }) }}
    </div>

    <!-- 结果：按模块分组（scope=all 时多组；指定模块时单组） -->
    <template v-for="m in visibleModules" :key="m.key">
      <div class="sec-title">{{ m.icon }} {{ m.label }}（{{ m.items.length }}）</div>
      <div v-for="r in m.items" :key="m.key + ':' + r.id" class="sr-row" @click="go(r)">
        <span class="sr-title" v-html="hl(r.title)"></span>
        <span class="hint" v-html="hl(r.sub)"></span>
      </div>
    </template>

    <div v-if="q.trim() && !loading && !results.total" class="hint" style="text-align:center;padding:50px">
      {{ t('views.search.noResult', '在「{scope}」没有找到与「{q}」相关的资产', { scope: scope === 'all' ? t('views.search.scopeAllName') : (SCOPE_LABELS[scope] || scope), q }) }}
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
