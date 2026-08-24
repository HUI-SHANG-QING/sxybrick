<script setup>
// 导出打印：自由组合筛选（多科目 × 多标签 × 搜索 × 逻辑）+ 批量勾选单卡
// 预览采用 CodeBrick 式排版：导出头 + 按科目分组 + 编号卡片（Q/A 分区、虚线分隔）
import { ref, computed, onMounted, nextTick, watch } from 'vue';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import { toast } from '../utils/toast.js';
import { getSubjects, getTags, listCards } from '../repo.js';
import { downloadCsv } from '../sync.js';

const subjects = ref([]);
const allTags = ref([]);
const subjectSel = ref([]);   // 已选科目（多选）
const tagNames = ref([]);     // 已选标签（多选）
const logic = ref('AND');     // 标签间逻辑 AND/OR/NOT
const q = ref('');
const mode = ref('all');      // all | incremental
const checkedIds = ref([]);   // 批量勾选的卡片 id
const allCache = ref([]);     // 全量卡片缓存

const previewOpen = ref(false);
const printCards = ref([]);
const scopeDesc = ref('');
const lastExport = ref(null); // { exportedAt, count, scope }

const exportDate = computed(() => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
});

// 筛选后的候选卡片（科目并集 → 标签逻辑 → 搜索）
const candidates = computed(() => {
  let cards = allCache.value;
  const k = q.value.trim();
  if (k) cards = cards.filter(c => c.front.includes(k) || c.back.includes(k));
  if (subjectSel.value.length) {
    cards = cards.filter(c => subjectSel.value.includes(c.subject || '未分类'));
  }
  const ts = tagNames.value;
  if (ts.length) {
    if (logic.value === 'AND') cards = cards.filter(c => ts.every(t => (c.tags || []).includes(t)));
    else if (logic.value === 'OR') cards = cards.filter(c => ts.some(t => (c.tags || []).includes(t)));
    else cards = cards.filter(c => !ts.some(t => (c.tags || []).includes(t)));
  }
  return cards;
});

// 当候选变化时，清掉已不在候选里的勾选
watch(candidates, (list) => {
  const ids = new Set(list.map(c => c.id));
  checkedIds.value = checkedIds.value.filter(id => ids.has(id));
});

// 按科目分组（未分类排最后）—— 导出排版用
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

const checkedCount = computed(() => checkedIds.value.length);
const allChecked = computed(() =>
  candidates.value.length > 0 && checkedIds.value.length === candidates.value.length,
);

function plain(text) {
  return String(text || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图]')
    .replace(/[#>*`~|=-]+/g, '')
    .replace(/\$\$?/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

async function loadMeta() {
  subjects.value = await getSubjects();
  allTags.value = await getTags();
  allCache.value = (await listCards({})).items;
  // 若存在未分类卡片，补充「未分类」科目项
  if (allCache.value.some(c => !c.subject)) {
    const cnt = allCache.value.filter(c => !c.subject).length;
    subjects.value = [...subjects.value.filter(s => s.name !== '未分类'), { name: '未分类', count: cnt }];
  }
}

function toggleSubject(name) {
  const i = subjectSel.value.indexOf(name);
  if (i >= 0) subjectSel.value.splice(i, 1);
  else subjectSel.value.push(name);
}
function toggleTag(name) {
  const i = tagNames.value.indexOf(name);
  if (i >= 0) tagNames.value.splice(i, 1);
  else tagNames.value.push(name);
}

function checkAll() { checkedIds.value = candidates.value.map(c => c.id); }
function checkInvert() {
  const ids = new Set(checkedIds.value);
  checkedIds.value = candidates.value.filter(c => !ids.has(c.id)).map(c => c.id);
}
function checkClear() { checkedIds.value = []; }
function toggleOne(id) {
  const i = checkedIds.value.indexOf(id);
  if (i >= 0) checkedIds.value.splice(i, 1);
  else checkedIds.value.push(id);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function buildDesc() {
  const parts = [];
  if (subjectSel.value.length) parts.push(`科目=${subjectSel.value.join('+')}`);
  if (tagNames.value.length) parts.push(`标签[${logic.value}]=${tagNames.value.join(',')}`);
  if (q.value.trim()) parts.push(`搜索=${q.value.trim()}`);
  if (checkedIds.value.length) parts.push(`手选=${checkedIds.value.length}张`);
  if (!parts.length) parts.push('全部卡片');
  return parts.join('；') + (mode.value === 'incremental' ? '（仅新增）' : '');
}

async function generate() {
  try {
    // 有勾选 → 只导出勾选；无勾选 → 导出全部筛选结果
    const base = checkedIds.value.length
      ? candidates.value.filter(c => checkedIds.value.includes(c.id))
      : candidates.value;

    let cards = base;
    if (mode.value === 'incremental' && lastExport.value?.exportedAt) {
      cards = cards.filter(c => (c.updatedAt || 0) > (lastExport.value.exportedAt || 0));
    }

    if (!cards.length) {
      return toast(mode.value === 'incremental' ? '上次导出后没有新增或修改' : '没有符合条件的卡片', 'error');
    }

    printCards.value = cards;
    scopeDesc.value = buildDesc();
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

    <!-- 筛选范围 -->
    <div class="panel no-print">
      <div class="field-label" style="margin-top:0">科目（可多选，多个科目为并集）</div>
      <div class="row">
        <button v-for="s in subjects" :key="s.name" class="chip"
                :class="{ on: subjectSel.includes(s.name) }" @click="toggleSubject(s.name)">
          {{ s.name }}<span v-if="s.count" class="n">{{ s.count }}</span>
        </button>
        <button v-if="subjectSel.length" class="chip" @click="subjectSel = []">清除科目</button>
      </div>

      <div class="field-label">标签（可多选）</div>
      <div class="row">
        <button v-for="t in allTags" :key="t.name" class="chip"
                :class="{ on: tagNames.includes(t.name) }" @click="toggleTag(t.name)">
          {{ t.name }}<span class="n">{{ t.count }}</span>
        </button>
        <select v-if="tagNames.length" v-model="logic" class="input" style="width:auto">
          <option value="AND">交集 AND</option>
          <option value="OR">并集 OR</option>
          <option value="NOT">差集 NOT</option>
        </select>
      </div>

      <div class="row" style="margin-bottom:0">
        <input v-model="q" class="input" style="max-width:300px" placeholder="搜索内容定位卡片（可选）" />
        <button class="chip" :class="{ on: mode === 'all' }" @click="mode = 'all'">全部导出</button>
        <button class="chip" :class="{ on: mode === 'incremental' }" @click="mode = 'incremental'"
                :disabled="!lastExport">仅新增卡片</button>
      </div>
      <div v-if="lastExport" class="hint" style="margin-top:6px">
        上次导出：{{ fmtTime(lastExport.exportedAt) }} · {{ lastExport.count }} 张 · {{ lastExport.scope }}
      </div>
    </div>

    <!-- 批量勾选清单 -->
    <div class="panel no-print" style="margin-top:14px">
      <div class="pick-bar">
        <div class="field-label" style="margin:0">卡片勾选清单（{{ checkedCount }} / {{ candidates.length }} 已选）</div>
        <div class="pick-actions">
          <button class="chip" @click="checkAll">全选</button>
          <button class="chip" @click="checkInvert">反选</button>
          <button class="chip" @click="checkClear">清空</button>
        </div>
      </div>
      <div v-if="!candidates.length" class="hint" style="text-align:center;padding:24px 0">
        暂无符合条件的卡片，请调整上方筛选条件。
      </div>
      <div v-else class="pick-list">
        <label v-for="(c, i) in candidates" :key="c.id" class="pick-item"
               :class="{ on: checkedIds.includes(c.id) }">
          <input type="checkbox" :checked="checkedIds.includes(c.id)" @change="toggleOne(c.id)" />
          <span class="pick-no">#{{ i + 1 }}</span>
          <span class="pick-main">
            <span class="pick-head">
              <span class="pick-subj">{{ c.subject || '未分类' }}</span>
              <span v-for="t in c.tags" :key="t" class="tag-pill">{{ t }}</span>
            </span>
            <span class="pick-front">{{ plain(c.front) }}</span>
          </span>
        </label>
      </div>
    </div>

    <!-- 操作 -->
    <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap" class="no-print">
      <button class="btn primary" @click="generate">
        生成 PDF 预览{{ checkedCount ? `（已选 ${checkedCount} 张）` : `（全部 ${candidates.length} 张）` }}
      </button>
      <button class="btn" @click="doCsv">导出 CSV（Anki/Excel 可导入）</button>
    </div>

    <!-- 打印预览（格式保持优美版式不变） -->
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

/* 勾选清单 */
.pick-bar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.pick-actions { display: flex; gap: 6px; }
.pick-list { max-height: 360px; overflow-y: auto; border: 1px solid var(--line); border-radius: 8px; padding: 4px; }
.pick-item {
  display: flex; align-items: flex-start; gap: 10px; padding: 9px 10px; border-radius: 6px;
  cursor: pointer; transition: background .12s;
}
.pick-item:hover { background: var(--code-inline); }
.pick-item.on { background: var(--tag-bg); }
.pick-item input { margin-top: 3px; flex: none; }
.pick-no { flex: none; font-size: 12px; color: var(--ink-2); font-weight: 600; min-width: 34px; }
.pick-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.pick-head { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; }
.pick-subj { font-size: 12px; font-weight: 700; color: var(--accent); }
.pick-front { font-size: 13px; color: var(--ink); word-break: break-all; }

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

@media (max-width: 720px) {
  .export-sheet { padding: 18px 14px; }
  .export-head { flex-direction: column; align-items: flex-start; gap: 8px; }
  .export-head-meta { text-align: left; }
}
</style>
