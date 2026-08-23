<script setup>
// 导出打印：按科目/标签/搜索筛选；增量导出（上次导出后新增或修改）
// 预览采用 CodeBrick 式排版：导出头 + 按科目分组 + 编号卡片（Q/A 分区、虚线分隔）
import { ref, computed, onMounted, nextTick } from 'vue';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import { toast } from '../utils/toast.js';
import { getSubjects, getTags, listCards } from '../repo.js';
import { downloadCsv } from '../sync.js';

const subjects = ref([]);
const allTags = ref([]);

const subject = ref('');
const tagNames = ref([]);
const logic = ref('AND');
const q = ref('');
const mode = ref('all');

const previewOpen = ref(false);
const printCards = ref([]);
const scopeDesc = ref('');
const lastExport = ref(null); // { exportedAt, count, scope }

const exportDate = computed(() => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
});

// 按科目分组（未分类排最后）
const grouped = computed(() => {
  const map = new Map();
  for (const c of printCards.value) {
    const key = c.subject || '未分类';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  const groups = [...map.entries()].map(([name, cards]) => ({ name, cards }));
  groups.sort((a, b) => {
    if (a.name === '未分类') return 1;
    if (b.name === '未分类') return -1;
    return a.name.localeCompare(b.name);
  });
  return groups;
});

async function loadMeta() {
  subjects.value = await getSubjects();
  allTags.value = await getTags();
}

function toggleTag(name) {
  const i = tagNames.value.indexOf(name);
  if (i >= 0) tagNames.value.splice(i, 1);
  else tagNames.value.push(name);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function generate() {
  try {
    let cards = (await listCards({
      subject: subject.value, q: q.value.trim(), tags: tagNames.value, logic: logic.value,
    })).items;

    // 增量：只导出上次导出之后新增/修改过的卡片
    if (mode.value === 'incremental' && lastExport.value?.exportedAt) {
      cards = cards.filter(c => (c.updatedAt || 0) > (lastExport.value.exportedAt || 0));
    }

    if (!cards.length) {
      return toast(mode.value === 'incremental' ? '上次导出后没有新增或修改' : '没有符合条件的卡片', 'error');
    }

    printCards.value = cards;
    const parts = [];
    if (subject.value) parts.push(`科目=${subject.value}`);
    if (tagNames.value.length) parts.push(`标签[${logic.value}]=${tagNames.value.join(',')}`);
    if (q.value.trim()) parts.push(`搜索=${q.value.trim()}`);
    if (!parts.length) parts.push('全部卡片');
    scopeDesc.value = parts.join('；') + (mode.value === 'incremental' ? '（仅新增）' : '');
    previewOpen.value = true;
    await nextTick();
  } catch (e) { toast(e.message, 'error'); }
}

function doPrint() {
  window.print();
}

async function doCsv() {
  try { await downloadCsv(); toast('已导出 CSV/TSV 文件，可用 Excel 或 Anki 导入', 'success'); }
  catch (e) { toast(e.message, 'error'); }
}

async function onAfterPrint() {
  if (!previewOpen.value) return;
  lastExport.value = { exportedAt: Date.now(), count: printCards.value.length, scope: scopeDesc.value };
  localStorage.setItem('sxy_last_export', JSON.stringify(lastExport.value));
  toast(`已导出 ${printCards.value.length} 张卡片，可在打印对话框选择「另存为 PDF」`, 'success');
}

onMounted(() => {
  loadMeta();
  try { lastExport.value = JSON.parse(localStorage.getItem('sxy_last_export') || 'null'); } catch {}
});
</script>

<template>
  <div>
    <h2>导出打印</h2>

    <div class="panel no-print">
      <div class="field-label" style="margin-top:0">筛选范围</div>
      <div class="row">
        <select v-model="subject" class="input" style="max-width:220px">
          <option value="">全部科目</option>
          <option v-for="s in subjects" :key="s.name" :value="s.name">{{ s.name }}</option>
        </select>
        <input v-model="q" class="input" style="max-width:260px" placeholder="搜索内容（可选）" />
      </div>
      <div class="row">
        <button v-for="t in allTags.slice(0, 16)" :key="t.name" class="chip"
                :class="{ on: tagNames.includes(t.name) }" @click="toggleTag(t.name)">{{ t.name }}</button>
        <select v-if="tagNames.length" v-model="logic" class="input" style="width:auto">
          <option value="AND">交集 AND</option>
          <option value="OR">并集 OR</option>
          <option value="NOT">差集 NOT</option>
        </select>
      </div>

      <div class="field-label">导出模式</div>
      <div class="row">
        <button class="chip" :class="{ on: mode === 'all' }" @click="mode = 'all'">重新全部导出</button>
        <button class="chip" :class="{ on: mode === 'incremental' }" @click="mode = 'incremental'"
                :disabled="!lastExport">仅导出新增卡片</button>
      </div>
      <div v-if="lastExport" class="hint">
        上次导出：{{ fmtTime(lastExport.exportedAt) }} · {{ lastExport.count }} 张 · {{ lastExport.scope }}
      </div>
      <div v-else class="hint">尚未导出过，首次将导出全部符合条件的卡片。</div>

      <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary" @click="generate">生成 PDF 预览</button>
        <button class="btn" @click="doCsv">导出 CSV（Anki/Excel 可导入）</button>
      </div>
    </div>

    <teleport to="body">
      <div v-if="previewOpen" class="modal-mask" style="padding:20px">
        <div class="modal export-modal">
          <div class="no-print modal-bar">
            <h3 style="margin:0">打印预览（{{ printCards.length }} 张）</h3>
            <div>
              <button class="btn" @click="previewOpen = false">关闭</button>
              <button class="btn primary" @click="doPrint">打印 / 另存为 PDF</button>
            </div>
          </div>

          <div id="print-area" class="export-sheet">
            <!-- 导出头部 -->
            <div class="export-head">
              <div class="export-head-title">
                <div class="export-logo">SxyBrick</div>
                <div class="export-subtitle">记忆卡片</div>
              </div>
              <div class="export-head-meta">
                <div>导出日期：{{ exportDate }}</div>
                <div>卡片总数：{{ printCards.length }} 张</div>
                <div>范围：{{ scopeDesc }}</div>
              </div>
            </div>

            <!-- 按科目分组 -->
            <div v-for="g in grouped" :key="g.name" class="export-group">
              <div class="group-title">
                <span class="group-bar"></span>
                <span class="group-name">{{ g.name }}</span>
                <span class="group-count">{{ g.cards.length }} 张</span>
              </div>

              <div v-for="(c, i) in g.cards" :key="c.id" class="print-card">
                <div class="card-head">
                  <span class="card-no">{{ g.name === '未分类' ? '' : g.name + ' · ' }}#{{ i + 1 }}</span>
                  <span class="card-tags">
                    <span v-for="t in c.tags" :key="t" class="tag-pill">{{ t }}</span>
                  </span>
                </div>
                <div class="qa q-side"><span class="qa-mark">Q</span><MarkdownRenderer :content="c.front" /></div>
                <div class="qa-divider"></div>
                <div class="qa a-side"><span class="qa-mark a">A</span><MarkdownRenderer :content="c.back" /></div>
              </div>
            </div>

            <div class="export-foot">— SxyBrick 记忆卡片 · {{ exportDate }} —</div>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }

/* 预览弹窗 */
.export-modal { max-width: 900px; }
.modal-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }

/* 导出纸张样式 */
.export-sheet { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 28px 32px; }
.export-head {
  display: flex; justify-content: space-between; align-items: flex-end;
  border-bottom: 2px solid #16202c; padding-bottom: 14px; margin-bottom: 22px;
}
.export-head-title .export-logo { font-size: 26px; font-weight: 800; color: #16202c; line-height: 1.1; }
.export-head-title .export-subtitle { font-size: 14px; color: #5b6b7d; letter-spacing: 4px; }
.export-head-meta { text-align: right; font-size: 12px; color: #5b6b7d; line-height: 1.7; }

.export-group { margin-bottom: 20px; }
.group-title { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.group-bar { width: 5px; height: 18px; background: #16202c; border-radius: 2px; }
.group-name { font-size: 17px; font-weight: 700; color: #16202c; }
.group-count { font-size: 12px; color: #9aa5b1; }

.print-card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px 18px; margin-bottom: 12px; }
.card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.card-no { font-size: 12px; color: #9aa5b1; font-weight: 600; }
.card-tags { display: flex; gap: 5px; flex-wrap: wrap; }

.qa { display: flex; gap: 10px; }
.qa-mark {
  flex: none; width: 22px; height: 22px; border-radius: 6px; background: #16202c; color: #fff;
  display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; margin-top: 2px;
}
.qa-mark.a { background: #2563eb; }
.q-side { font-weight: 600; }
.qa-divider { border-top: 1px dashed #d1d5db; margin: 12px 0 12px 32px; }
.a-side { color: #2b3440; }

.export-foot { text-align: center; font-size: 12px; color: #9aa5b1; margin-top: 20px; padding-top: 12px; border-top: 1px solid #e5e7eb; }

/* 表格着色（作用于 Markdown 渲染出的 table） */
.print-card :deep(table) { border-collapse: collapse; width: 100%; margin: 8px 0; }
.print-card :deep(th) { background: #16202c; color: #fff; font-weight: 600; }
.print-card :deep(th), .print-card :deep(td) { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; }
.print-card :deep(tr:nth-child(even) td) { background: #f8fafc; }
</style>