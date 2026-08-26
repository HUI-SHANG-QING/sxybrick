<script setup>
// 全局搜索（E1 数字资产保值批）：跨卡/文档/导图/备忘/模考五位一体检索数字资产
import { ref, watch, onBeforeUnmount } from 'vue';
import { db } from '../db.js';
import { useRouter } from 'vue-router';

// 去除 Markdown 语法，取纯文本用于摘要展示
function plain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [图片] ')
    .replace(/\$\$?([^$\n]+)\$\$?/g, ' $1 ')
    .replace(/[*_#>`~|-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const router = useRouter();
const q = ref('');
const loading = ref(false);
const results = ref({ cards: [], docs: [], mindmaps: [], memos: [], exams: [] });

const norm = s => String(s || '').toLowerCase();

let timer = null;
watch(q, () => {
  clearTimeout(timer);
  timer = setTimeout(search, 250);
});
// 清理搜索防抖定时器，避免卸载后触发游离 search
onBeforeUnmount(() => { clearTimeout(timer); });

async function search() {
  const kw = norm(q.value.trim());
  if (!kw) { results.value = { cards: [], docs: [], mindmaps: [], memos: [], exams: [] }; return; }
  loading.value = true;
  try {
    const [cards, docs, maps, memos, exams] = await Promise.all([
      db.cards.toArray(), db.docs.toArray(), db.mindmaps.toArray(), db.memos.toArray(), db.exams.toArray(),
    ]);
    results.value = {
      cards: cards.filter(c => norm(c.front).includes(kw) || norm(c.back).includes(kw) || norm(c.subject).includes(kw) || (c.tags || []).some(t => norm(t).includes(kw))).slice(0, 30)
        .map(c => ({ id: c.id, title: String(c.front).slice(0, 60), sub: `[${c.subject || '未分类'}] ${plain(c.back).slice(0, 60)}`, go: '/' })),
      docs: docs.filter(d => norm(d.title).includes(kw) || norm(d.content).includes(kw)).slice(0, 20)
        .map(d => ({ id: d.id, title: d.title, sub: plain(d.content).slice(0, 60), go: '/docs' })),
      mindmaps: maps.filter(m => norm(m.title).includes(kw) || JSON.stringify(m.root || {}).toLowerCase().includes(kw)).slice(0, 20)
        .map(m => ({ id: m.id, title: m.title, sub: '思维导图', go: '/mindmap' })),
      memos: memos.filter(m => norm(m.text).includes(kw)).slice(0, 20)
        .map(m => ({ id: m.id, title: m.text.slice(0, 60), sub: '备忘录', go: '/memo' })),
      exams: exams.filter(e => norm(e.title).includes(kw) || (e.questions || []).some(x => norm(x.front).includes(kw))).slice(0, 20)
        .map(e => ({ id: e.id, title: `${e.title}（${e.score}/${e.total}）`, sub: '模考成绩', go: '/exam' })),
    };
  } finally { loading.value = false; }
}

const total = () => results.value.cards.length + results.value.docs.length + results.value.mindmaps.length + results.value.memos.length + results.value.exams.length;

// 搜索结果点击跳转：把具体条目的 id 编码到 URL，目标页面读取后自动筛选/定位
function go(item) {
  if (!item || !item.go) return;
  const base = item.go === '/' ? '/cards' : item.go;
  const params = new URLSearchParams();
  if (item.id) params.set('id', String(item.id));
  // 卡片还可附加关键字，便于 Cards 页延续搜索上下文
  if (base === '/cards' && q.value.trim()) params.set('q', q.value.trim());
  router.push(`${base}${params.toString() ? '?' + params.toString() : ''}`);
}
</script>

<template>
  <div style="max-width:860px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">全局搜索</h2>
      <span class="hint">一次搜遍卡片 · 文档 · 导图 · 备忘 · 模考成绩</span>
    </div>

    <input v-model="q" class="input" style="margin-top:14px;font-size:16px;padding:12px 14px" placeholder="输入关键词，例如：死锁 / 特征值 / 操作系统…" autofocus />

    <div v-if="q.trim()" class="hint" style="margin-top:10px">
      {{ loading ? '搜索中…' : `找到 ${total()} 条结果` }}
    </div>

    <template v-if="results.cards.length">
      <div class="sec-title">卡片（{{ results.cards.length }}）</div>
      <div v-for="r in results.cards" :key="'c' + r.id" class="sr-row" @click="go(r)">
        <span class="sr-title">🗂️ {{ r.title }}</span>
        <span class="hint">{{ r.sub }}</span>
      </div>
    </template>

    <template v-if="results.docs.length">
      <div class="sec-title">AI 文档（{{ results.docs.length }}）</div>
      <div v-for="r in results.docs" :key="'d' + r.id" class="sr-row" @click="go(r)">
        <span class="sr-title">📄 {{ r.title }}</span>
        <span class="hint">{{ r.sub }}</span>
      </div>
    </template>

    <template v-if="results.mindmaps.length">
      <div class="sec-title">思维导图（{{ results.mindmaps.length }}）</div>
      <div v-for="r in results.mindmaps" :key="'m' + r.id" class="sr-row" @click="go(r)">
        <span class="sr-title">🗺️ {{ r.title }}</span>
        <span class="hint">{{ r.sub }}</span>
      </div>
    </template>

    <template v-if="results.memos.length">
      <div class="sec-title">备忘录（{{ results.memos.length }}）</div>
      <div v-for="r in results.memos" :key="'mm' + r.id" class="sr-row" @click="go(r)">
        <span class="sr-title">📝 {{ r.title }}</span>
        <span class="hint">{{ r.sub }}</span>
      </div>
    </template>

    <template v-if="results.exams.length">
      <div class="sec-title">模考成绩（{{ results.exams.length }}）</div>
      <div v-for="r in results.exams" :key="'e' + r.id" class="sr-row" @click="go(r)">
        <span class="sr-title">🧪 {{ r.title }}</span>
        <span class="hint">{{ r.sub }}</span>
      </div>
    </template>

    <div v-if="q.trim() && !loading && !total()" class="hint" style="text-align:center;padding:50px">
      没有找到与「{{ q }}」相关的资产
    </div>
  </div>
</template>

<style scoped>
.sec-title { font-size: 13px; font-weight: 700; color: var(--ink-2); margin: 16px 0 6px; }
.sr-row { display: flex; flex-direction: column; gap: 2px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); margin-bottom: 8px; cursor: pointer; transition: border-color .15s; }
.sr-row:hover { border-color: var(--accent); }
.sr-title { font-weight: 600; }
</style>