<script setup>
// 卡片管理页：视图切换、科目/标签筛选、基础+高级搜索、虚拟列表（本地数据）
import { confirmDialog } from '../utils/confirm.js';
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import VirtualList from '../components/VirtualList.vue';
import CardModal from '../components/CardModal.vue';
import FlipCard from '../components/FlipCard.vue';
import EmptyState from '../components/EmptyState.vue';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import ExportButton from '../components/ExportButton.vue';
import { exportCardsToJSON, exportCardsToCSV, exportCardsToMarkdown } from '../utils/exporters.js';
import { db, uid } from '../db.js';
import { toast } from '../utils/toast.js';
import { listCards, getSubjects, getTags, deleteCard, weakCards, setMarked, getReviewSuggestion, getCardHistory, gradeCard, createCard, findNotesLinkingTo, listCardGroups, setCardGroups } from '../repo.js';
import { getGoal, setGoal, getTodayCount, getStreak } from '../utils/streak.js';
import { chatAI, hasAIKey } from '../ai.js';
import { genVariants } from '../utils/genVariants.js';
// P2-3 AI 智能卡组生成：从纯笔记用 LLM 自动拆成 front/back 卡片（与手动分隔的批量建卡并存）
import { genCardDeck } from '../utils/genCardDeck.js';
import { highlight as hlKw } from '../search/search-service.js';
import { getForgetRisk, getAssetHealth } from '../agent/analytics.js';
import { T } from '../utils/telemetry.js';
import { t } from '../i18n/index.js';

const router = useRouter();

/** 卡片列表导出选项：当前筛选条件（filters）会作为 meta 写入 JSON / Markdown 头部，便于溯源 */
const cardsExportFormats = computed(() => {
  const meta = {};
  if (filters.subject) meta.subject = filters.subject;
  if (filters.tags?.length) meta.tags = filters.tags.join(',');
  if (filters.q) meta.query = filters.q;
  if (weakMode.value) meta.filter = 'weak-only';
  return [
    { key: 'md', label: 'Markdown', hint: t('views.cards.exportHintMd'), mime: 'text/markdown', ext: 'md', build: rows => exportCardsToMarkdown(rows, meta) },
    { key: 'csv', label: 'CSV', hint: t('views.cards.exportHintCsv'), mime: 'text/csv', ext: 'csv', build: rows => exportCardsToCSV(rows) },
    { key: 'json', label: 'JSON', hint: t('views.cards.exportHintJson'), mime: 'application/json', ext: 'json', build: rows => exportCardsToJSON(rows, meta) },
  ];
});
const route = useRoute();

const viewMode = ref(localStorage.getItem('sxy_view') || 'scroll');
const sortBy = ref(localStorage.getItem('sxy_card_sort') || 'updated');
const filters = reactive(JSON.parse(localStorage.getItem('sxy_card_filters') || '{"q":"","subject":"","tags":[],"logic":"AND"}'));

const subjects = ref([]);
const allTags = ref([]);
const items = ref([]);
const total = ref(0);
const dueCount = ref(0);
const loading = ref(false);

// E3：非虚拟分支真分页（viewMode='page' 时 v-for 只渲染当页，1 万卡不再一次性建 1 万个 DOM 节点）
const PAGE_SIZE = 50;
const pageNo = ref(1);
const pageCount = computed(() => Math.max(1, Math.ceil(items.value.length / PAGE_SIZE)));
const pagedItems = computed(() => items.value.slice((pageNo.value - 1) * PAGE_SIZE, pageNo.value * PAGE_SIZE));
// 列表变短（过滤/删除）导致页码越界时自动收回到最后一页
watch(pageCount, (c) => { if (pageNo.value > c) pageNo.value = c; });

// ---------- 资产体检跳转支持（?zombie=1 / ?dupGroup=key / ?orphan=1 / ?expandAll=1） ----------
const activeFilterBanner = ref('');   // 顶部提示：当前是从资产体检跳过来的哪一组
// collapsedIds 语义：集合中的 id = 当前卡详情被“收起”（看不见 front+back 全 Markdown）
// expandAllByDefault=true 时 collapsedIds 默认为空→全展开；false 时 collapsedIds 放所有卡 id，用户点开的从集合移除。
const collapsedIds = ref(new Set());
const expandAllByDefault = ref(false);
// 普通模式下用户主动展开过的卡，用于区分“默认隐藏”还是“用户已主动点开”
const normalExpandedIds = ref(new Set());
function showFullDetail(id) {
  if (expandAllByDefault.value) return !collapsedIds.value.has(id);
  // 普通模式：只有用户点过展开的卡才显示详情
  return normalExpandedIds.value.has(id) && !collapsedIds.value.has(id);
}
function toggleExpand(id) {
  if (expandAllByDefault.value) {
    const s = new Set(collapsedIds.value);
    if (s.has(id)) s.delete(id); else s.add(id);
    collapsedIds.value = s;
    return;
  }
  // 普通模式
  const n = new Set(normalExpandedIds.value);
  const c = new Set(collapsedIds.value);
  if (n.has(id)) {
    n.delete(id); c.add(id);
  } else {
    n.add(id); c.delete(id);
  }
  normalExpandedIds.value = n;
  collapsedIds.value = c;
}
function isExpanded(id) {
  if (expandAllByDefault.value) return !collapsedIds.value.has(id);
  return normalExpandedIds.value.has(id);
}

const modalOpen = ref(false);
const editing = ref(null);
// 预览模式：点击卡片体打开 FlipCard 预览层，再决定是否编辑
const previewCard = ref(null);
const linkedNotes = ref([]); // D3.3 关联笔记（反链面板）
const showPreview = ref(false);
const weakMode = ref(localStorage.getItem('sxy_card_weak') === '1');
// M1 批量分组：多选卡片 → 移入/移出卡组（学习数据全局共享，仅动关联表）
const selectMode = ref(false);
const selectedIds = ref(new Set());
const groupList = ref([]);
function toggleSelect(id) {
  const s = new Set(selectedIds.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  selectedIds.value = s;
}
function toggleSelectAll() {
  selectedIds.value = selectedIds.value.size === items.value.length ? new Set() : new Set(items.value.map(c => c.id));
}
function exitSelect() { selectMode.value = false; selectedIds.value = new Set(); }
async function bulkGroup(gid) {
  if (!selectedIds.value.size) return toast(t('views.cards.selectFirst'), 'info');
  const r = await setCardGroups([...selectedIds.value], [gid], []);
  toast(t('views.cards.movedIn', '已移入卡组：{added} 张关联（{skipped} 跳过）', { added: r.added, skipped: r.removed }), 'success');
}
async function bulkRemoveGroup(gid) {
  if (!selectedIds.value.size) return toast(t('views.cards.selectFirst'), 'info');
  const r = await setCardGroups([...selectedIds.value], [], [gid]);
  toast(t('views.cards.movedOut', '已移出卡组：解除 {n} 张关联', { n: r.removed }), 'success');
}
// M2：选中卡片 → 联动分析工作台
function goLinkAnalysis() {
  if (selectedIds.value.size < 2) return toast(t('views.cards.linkNeedTwo'), 'info');
  exitSelect();
  router.push({ path: '/analysis/card-link', query: { cardIds: [...selectedIds.value].join(',') } });
}
const suggestion = ref(null);
const goal = ref(20);
const todayCount = ref(0);
const streak = ref(0);

async function loadStreak() {
  goal.value = await getGoal();
  todayCount.value = await getTodayCount();
  streak.value = await getStreak();
}
async function onGoalChange() { await setGoal(goal.value); await loadStreak(); }

watch(viewMode, v => localStorage.setItem('sxy_view', v));
watch(sortBy, v => localStorage.setItem('sxy_card_sort', v));
function saveCardFilters() { localStorage.setItem('sxy_card_filters', JSON.stringify({ q: filters.q, subject: filters.subject, tags: filters.tags, logic: filters.logic })); }
watch(() => [filters.subject, filters.logic], saveCardFilters);
watch(() => filters.tags, saveCardFilters, { deep: true });

// M4：列表关键词高亮（有搜索词时启用 v-html，highlight 内部先转义防 XSS；无搜索词走普通插值）
function hlFront(item) {
  const txt = plain(item.front).slice(0, 160) || t('views.cards.empty');
  return filters.q ? hlKw(txt, filters.q) : txt;
}
function plain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, t('views.cards.mdCode'))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, t('views.cards.mdImage'))
    .replace(/\$\$?([^$\n]+)\$\$?/g, ' $1 ')
    .replace(/[*_#>`~|-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function typeName(type) { return type === 'cloze' ? t('views.cards.typeCloze') : type === 'choice' ? t('views.cards.typeChoice') : type === 'writing' ? t('views.cards.typeWriting') : ''; }

async function loadMeta() {
  subjects.value = await getSubjects();
  allTags.value = await getTags(filters.subject);
}

async function loadCards() {
  loading.value = true;
  try {
    if (weakMode.value) {
      items.value = await weakCards(100);
      total.value = items.value.length;
      dueCount.value = 0;
      return;
    }
    const data = await listCards({
      q: filters.q, subject: filters.subject,
      tags: filters.tags, logic: filters.logic,
      sortBy: sortBy.value,
    });
    let list = data.items;
    if (filters._untagged) list = list.filter(c => !c.tags || !c.tags.length);
    if (filters._zombieIds && filters._zombieIds.size) {
      list = list.filter(c => filters._zombieIds.has(c.id));
    }
    if (filters._dupIds && filters._dupIds.size) {
      list = list.filter(c => filters._dupIds.has(c.id));
    }
    if (filters._orphanImageIds && filters._orphanImageIds.size) {
      // 孤儿图片不是卡片，空列表；用 activeFilterBanner 说明
      list = [];
    }
    items.value = list;
    total.value = (filters._untagged || filters._zombieIds || filters._dupIds || filters._orphanImageIds)
      ? list.length : data.total;
    dueCount.value = data.dueCount;
  } catch (e) { toast(e.message, 'error'); }
  finally { loading.value = false; }
}

watch(() => [filters.q, filters.subject, filters.logic], loadCards);
watch(() => filters.tags, loadCards, { deep: true });
watch(() => filters.subject, loadMeta);
watch(sortBy, loadCards);

function toggleTag(name) {
  const i = filters.tags.indexOf(name);
  if (i >= 0) filters.tags.splice(i, 1);
  else filters.tags.push(name);
}

function openCreate() { editing.value = null; modalOpen.value = true; }
function openEdit(card) { editing.value = card; modalOpen.value = true; }
// 卡片预览：点击卡片体（非按钮区）打开 FlipCard 预览层
function openPreview(item, e) {
  if (e && e.target.closest('button')) return;
  previewCard.value = item;
  showPreview.value = true;
  if (item?.id) loadLinkedNotes(item.id);
}
function closePreview() { showPreview.value = false; previewCard.value = null; linkedNotes.value = []; }

// D3.3 加载关联笔记：notes 内容里含 [[c<id>]] 的所有笔记
async function loadLinkedNotes(cardId) {
  const list = await findNotesLinkingTo(cardId);
  linkedNotes.value = list.map(n => ({ id: n.id, title: n.title, category: n.category }));
}

// 一键复制 wikilink 文本到剪贴板（D3.3 配 ID 习惯养成）
async function copyLinkAsWiki() {
  const c = previewCard.value;
  if (!c?.id) return;
  const text = `[[c${c.id}]]`;
  try {
    await navigator.clipboard.writeText(text);
    toast(t('views.cards.copied', '已复制 {text} 到剪贴板', { text }), 'success');
  } catch {
    toast(t('views.cards.copyFail'), 'error');
  }
}
function previewEdit() {
  const card = previewCard.value;
  showPreview.value = false;
  if (card) { editing.value = card; modalOpen.value = true; }
}
function toggleWeak() { weakMode.value = !weakMode.value; localStorage.setItem('sxy_card_weak', weakMode.value ? '1' : '0'); loadCards(); }
async function toggleMarked(card) {
  try {
    await setMarked(card.id, !card.marked);
    await loadCards();
    toast(card.marked ? t('views.cards.unmarked') : t('views.cards.marked'), 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// 情境变式生成：AI 为同一知识点生成不同问法/场景的变式卡
const variantBusy = ref(new Set());
async function genVariantsFor(card) {
  if (variantBusy.value.has(card.id)) return;
  variantBusy.value.add(card.id);
  try {
    const created = await genVariants(card, 3);
    toast(t('views.cards.variantsDone', '已生成 {n} 张情境变式卡', { n: created.length }), 'success');
    await loadCards();
  } catch (e) { toast(t('views.cards.variantsFail', '变式生成失败：{msg}', { msg: e.message }), 'error'); }
  finally { variantBusy.value.delete(card.id); }
}

async function remove(card) {
  if (!(await confirmDialog(t('views.cards.confirmDelete', '确定删除这张卡片？\n{front}', { front: plain(card.front).slice(0, 40) })))) return;
  try {
    await deleteCard(card.id);
    try { T.cardDelete(card.id); } catch {}
    await loadCards();
    await loadMeta();
    toast(t('views.cards.deleted'), 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function loadSuggestion() { suggestion.value = await getReviewSuggestion(); }

const historyOpen = ref(false);
const historyData = ref(null);
async function openHistory(card) {
  try { historyData.value = await getCardHistory(card.id); historyOpen.value = true; }
  catch (e) { toast(e.message, 'error'); }
}
function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const diagOpen = ref(false);
const diagCard = ref(null);
const diagText = ref('');
const diagLoading = ref(false);
async function openDiagnose(card) {
  diagCard.value = card; diagOpen.value = true; diagText.value = ''; diagLoading.value = true;
  try {
    const r = await chatAI([
      { role: 'system', content: '你是记忆卡质量诊断专家。点评这张卡：内容是否清晰、正面是否容易触发回忆、答案是否精炼、能否拆成更小知识点、怎么改更好记。用中文简洁回答。' },
      { role: 'user', content: `正面：${card.front}\n背面：${card.back}\n科目：${card.subject || '无'}\n题型：${card.type || 'basic'}` },
    ]);
    diagText.value = r;
  } catch (e) { toast(e.message, 'error'); diagText.value = t('views.cards.diagFail', '（诊断失败：{msg}）', { msg: e.message }); }
  finally { diagLoading.value = false; }
}

async function onSaved() {
  await loadCards();
  await loadMeta();
  await loadSuggestion();
}

let searchTimer = null;
const searchInput = ref(localStorage.getItem('sxy_card_search') || '');
watch(searchInput, v => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { filters.q = v.trim(); }, 300);
  localStorage.setItem('sxy_card_search', v);
});

const highlightId = ref('');

/**
 * 读取 URL 查询参数（搜索结果跳转 / 命令面板跳转 / 科目和标签直链 / 资产体检快捷跳转）：
 *   ?id=xxx      → 自动打开该卡编辑弹窗，并滚动/高亮
 *   ?subject=xxx → 自动筛选该科目
 *   ?tag=xxx     → 自动筛选该标签（可重复出现多个）
 *   ?untagged=1  → 仅显示无标签卡
 *   ?q=xxx       → 自动填充关键词搜索
 *   ?zombie=1    → 从资产体检「僵尸卡」跳转：筛出从未复习的到期 90+ 天卡
 *   ?dupGroup=xx → 从资产体检「重复卡组」跳转：筛出该组内所有重复卡（按 subject+front 开头匹配）
 *   ?orphan=1    → 从资产体检「孤儿图片」跳转：展示无引用图片（卡片列表没内容，顶部会给出图片浏览面板）
 *   ?expandAll=1 → 默认全展开详情（背诵效果页：同时展示正面 + 背面完整 Markdown）
 */
async function applyQueryParams() {
  const id = route.query?.id ? String(route.query.id) : '';
  const subj = route.query?.subject ? String(route.query.subject) : '';
  const tags = Array.isArray(route.query?.tag)
    ? route.query.tag.map(t => String(t).trim()).filter(Boolean)
    : (route.query?.tag ? [String(route.query.tag).trim()] : []);
  const untagged = route.query?.untagged === '1' || route.query?.untagged === true;
  const zombie = route.query?.zombie === '1' || route.query?.zombie === true;
  const dupGroup = route.query?.dupGroup ? String(route.query.dupGroup) : '';
  const orphan = route.query?.orphan === '1' || route.query?.orphan === true;
  const expand = route.query?.expandAll === '1' || route.query?.expandAll === true;
  const qp = route.query?.q ? String(route.query.q).trim() : '';
  let changed = false;
  if (subj && filters.subject !== subj) { filters.subject = subj; changed = true; }
  if (tags.length) {
    const merged = [...new Set([...filters.tags, ...tags])];
    if (merged.length !== filters.tags.length || merged.some((t, i) => t !== filters.tags[i])) {
      filters.tags = merged; changed = true;
    }
  }
  if (untagged) {
    filters.logic = 'NOT';
    filters._untagged = true;
    activeFilterBanner.value = t('views.cards.bannerUntagged');
    changed = true;
  } else if (filters._untagged) {
    delete filters._untagged;
  }
  // 从资产体检跳转：动态取到最新健康结果，按 id/组精确过滤
  let healthCache = null;
  if (zombie || dupGroup || orphan) {
    try { healthCache = await getAssetHealth(); } catch (e) { healthCache = null; }
  }
  if (zombie && healthCache) {
    filters._zombieIds = new Set(healthCache.zombies.map(z => z.id));
    activeFilterBanner.value = t('views.cards.bannerZombie', '🧟 显示「僵尸卡」共 {n} 张（90+ 天未复习且早已到期）。默认全展开详情，方便决定是否清理。', { n: healthCache.zombies.length });
    collapsedIds.value = new Set();
    expandAllByDefault.value = true;
    changed = true;
  } else { filters._zombieIds = null; }
  if (dupGroup && healthCache) {
    // __all__ = 查看全部重复卡组合并；否则按 key 找单个组
    if (dupGroup === '__all__' && healthCache.duplicates.length) {
      const allIds = [];
      let totalDup = 0;
      for (const g of healthCache.duplicates) { allIds.push(...g.cards.map(c => c.id)); totalDup += g.n - 1; }
      filters._dupIds = new Set(allIds);
      activeFilterBanner.value = t('views.cards.bannerDupAll', '♻ 显示「全部重复卡」共 {groups} 组 / {cards} 张（重复冗余 {dup} 张）。默认全展开详情对比后，可回到资产体检合并去重。', { groups: healthCache.duplicates.length, cards: allIds.length, dup: totalDup });
      collapsedIds.value = new Set();
      expandAllByDefault.value = true;
      changed = true;
    } else {
      const group = healthCache.duplicates.find(g => g.key === dupGroup)
        || healthCache.duplicates.find(g => g.front && dupGroup.includes(String(g.front).slice(0, 30)));
      if (group) {
        filters._dupIds = new Set(group.cards.map(c => c.id));
        activeFilterBanner.value = t('views.cards.bannerDupGroup', '♻ 显示「重复卡组」共 {n} 张（正面：{front}…）。默认全展开详情对比后，可回到资产体检合并去重。', { n: group.cards.length, front: String(group.front).slice(0, 40) });
        collapsedIds.value = new Set();
        expandAllByDefault.value = true;
        changed = true;
      } else {
        filters._dupIds = null;
      }
    }
  } else { filters._dupIds = null; }
  if (orphan) {
    filters._orphanImageIds = new Set((healthCache?.orphanImages || []).map(i => i.id));
    activeFilterBanner.value = t('views.cards.bannerOrphan', '🖼 显示「孤儿图片」共 {n} 张（已无卡片引用，可直接清理）。', { n: healthCache?.orphanImages?.length || 0 });
    orphanImages.value = healthCache?.orphanImages || [];
    orphanImagesVisible.value = true;
    changed = true;
  } else { filters._orphanImageIds = null; orphanImagesVisible.value = false; orphanImages.value = []; }

  if (expand) {
    expandAllByDefault.value = true;
    collapsedIds.value = new Set();
  }
  if (qp && filters.q !== qp) { filters.q = qp; searchInput.value = qp; changed = true; }
  if (changed) {
    saveCardFilters();
    await loadCards();
  }
  // 如果指定了 id，在加载完卡列表后自动打开该卡
  if (id) {
    await nextTick();
    let target = items.value.find(c => c.id === id);
    if (!target) {
      // 不在当前筛选结果中：尝试直接从 IndexedDB 查找该卡
      target = await db.cards.get(id);
    }
    if (target) {
      highlightId.value = id;
      editing.value = target;
      modalOpen.value = true;
      setTimeout(() => { highlightId.value = ''; }, 2500);
    }
  }
}

// —— 孤儿图片面板（仅在 ?orphan=1 时显示） ——
const orphanImages = ref([]);
const orphanImagesVisible = ref(false);
async function removeOrphan(id) {
  try {
    await db.images.delete(id);
    _revokeObjUrl(id);
    orphanImages.value = orphanImages.value.filter(i => i.id !== id);
    toast(t('views.cards.orphanDeleted'), 'success');
  } catch (e) { toast(e.message, 'error'); }
}
async function removeAllOrphans() {
  if (!orphanImages.value.length) return;
  if (!(await confirmDialog(t('views.cards.confirmCleanOrphans', '一次性清理 {n} 张孤儿图片？', { n: orphanImages.value.length })))) return;
  try {
    for (const i of orphanImages.value) { await db.images.delete(i.id); _revokeObjUrl(i.id); }
    orphanImages.value = [];
    toast(t('views.cards.orphansCleaned'), 'success');
  } catch (e) { toast(e.message, 'error'); }
}
// 图片对象 URL 缓存：模板里 :src="dataUrlOf(img)" 每次渲染都会重算，
// 不记忆化的话每渲染一轮就泄漏一个 objectURL（Blob 永远不回收）
const _objUrlCache = new Map(); // imgId -> objectURL
function _objUrlOf(img) {
  if (!_objUrlCache.has(img.id)) _objUrlCache.set(img.id, URL.createObjectURL(img.data));
  return _objUrlCache.get(img.id);
}
function _revokeObjUrl(id) {
  const u = _objUrlCache.get(id);
  if (u) { URL.revokeObjectURL(u); _objUrlCache.delete(id); }
}
function dataUrlOf(img) {
  if (!img?.data) return '';
  if (typeof img.data === 'string') return img.data;
  if (img.data instanceof Blob) return _objUrlOf(img);
  if (img.data instanceof ArrayBuffer || ArrayBuffer.isView(img.data)) {
    let binary = ''; const bytes = new Uint8Array(img.data);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return `data:${img.type || 'image/png'};base64,${btoa(binary)}`;
  }
  return '';
}

onMounted(async () => {
  await loadMeta();
  await loadCards();
  try { groupList.value = await listCardGroups(); } catch { groupList.value = []; }
  await Promise.all([loadSuggestion(), loadStreak(), loadSmart(), loadRisk()]);
  await applyQueryParams();
});
// 清理搜索防抖定时器与孤儿图片 objectURL，避免卸载后泄漏
onBeforeUnmount(() => {
  clearTimeout(searchTimer);
  for (const id of [..._objUrlCache.keys()]) _revokeObjUrl(id);
});

// ---- 批量建卡（P0 效率包）：粘贴文本按行拆成卡片 ----
const batchOpen = ref(false);
const batchText = ref('');
const batchSubject = ref('');
const batchBusy = ref(false);
const batchParsed = computed(() => {
  return batchText.value.split('\n').map(line => {
    let front = line.trim();
    let back = '';
    if (!front) return null;
    const m = front.match(/^(.+?)\s*(?:\||→|->|：答[:：]?)\s*(.+)$/);
    if (m && m[2]) { front = m[1].trim(); back = m[2].trim(); }
    return { front, back };
  }).filter(Boolean).slice(0, 200);
});
function openBatch() {
  batchText.value = '';
  batchSubject.value = filters.subject || '';
  batchOpen.value = true;
}
async function importBatch() {
  const cards = batchParsed.value;
  if (!cards.length) { toast(t('views.cards.batchPasteFirst'), 'error'); return; }
  batchBusy.value = true;
  try {
    let n = 0;
    for (const c of cards) {
      const r = await createCard({ front: c.front, back: c.back, subject: batchSubject.value || '', tags: [], type: 'basic' });
      try { T.cardNew(r?.id ?? r); } catch {}
      n++;
    }
    batchOpen.value = false;
    toast(t('views.cards.batchCreated', '已批量创建 {n} 张卡片', { n }), 'success');
    loadCards();
  } catch (e) { toast(e.message, 'error'); }
  finally { batchBusy.value = false; }
}

// ---- P2-3 AI 智能卡组生成：粘贴纯笔记，LLM 自动拆成 front/back 卡片 ----
// 与批量建卡（手动 | 分隔）并存：batchMode='manual' | 'ai'
const batchMode = ref('manual');
const aiDeckCount = ref(8);
const aiDeck = ref([]); // AI 拆出的卡片预览
const aiGenBusy = ref(false);
async function aiGenerateDeck() {
  const text = batchText.value.trim();
  if (!text) { toast(t('views.cards.aiPasteFirst'), 'error'); return; }
  if (text.length < 20) { toast(t('views.cards.aiTooShort'), 'error'); return; }
  aiGenBusy.value = true;
  try {
    const deck = await genCardDeck(text, { count: aiDeckCount.value, subject: batchSubject.value || '未分类' });
    aiDeck.value = deck;
    toast(t('views.cards.aiSplitDone', 'AI 已拆出 {n} 张卡片，预览后可导入', { n: deck.length }), 'success');
  } catch (e) {
    toast(t('views.cards.aiSplitFail', 'AI 拆分失败：{msg}', { msg: e?.message || e }), 'error');
  } finally {
    aiGenBusy.value = false;
  }
}
async function importAiDeck() {
  const deck = aiDeck.value;
  if (!deck.length) { toast(t('views.cards.aiNoCards'), 'error'); return; }
  batchBusy.value = true;
  try {
    let n = 0;
    for (const c of deck) {
      const r = await createCard({
        front: c.front, back: c.back, subject: c.subject || batchSubject.value || '',
        tags: ['AI卡组', ...(c.tags || [])], type: 'basic', difficulty: c.difficulty || 'basic',
        source: 'AI智能卡组生成',
      });
      try { T.cardNew(r?.id ?? r); } catch {}
      n++;
    }
    batchOpen.value = false;
    aiDeck.value = [];
    batchText.value = '';
    toast(t('views.cards.aiImported', '已导入 {n} 张 AI 生成的卡片', { n }), 'success');
    loadCards();
  } catch (e) { toast(e.message, 'error'); }
  finally { batchBusy.value = false; }
}

// ---- 智能卡组（P0 效率包）：把当前筛选组合存成快捷入口 ----
const smartFilters = ref([]);
async function loadSmart() {
  const row = await db.meta.get('smartFilters');
  smartFilters.value = row?.value || [];
}
async function persistSmart() {
  // smartFilters.value 是 Vue 响应式代理数组，直接 put 会触发 IndexedDB 结构化克隆失败
  const plainFilters = JSON.parse(JSON.stringify(smartFilters.value));
  await db.meta.put({ key: 'smartFilters', value: plainFilters, updatedAt: Date.now() });
}
async function saveSmart() {
  const name = prompt(t('views.cards.smartNamePrompt'), filters.subject || t('views.cards.smartDefaultName'));
  if (!name) return;
  smartFilters.value.push({
    id: uid(), name: String(name).slice(0, 12),
    q: filters.q, subject: filters.subject, tags: [...filters.tags], logic: filters.logic,
  });
  await persistSmart();
  toast(t('views.cards.smartSaved'), 'success');
}
function applySmart(f) {
  filters.q = f.q || ''; filters.subject = f.subject || '';
  filters.tags = [...(f.tags || [])]; filters.logic = f.logic || 'AND';
  searchInput.value = f.q || '';
}
async function removeSmart(f) {
  smartFilters.value = smartFilters.value.filter(x => x.id !== f.id);
  await persistSmart();
}

// ---- D1 遗忘预警：3 天内将到期且历史不稳的卡，可一键提前巩固 ----
const riskCards = ref([]);
async function loadRisk() { riskCards.value = await getForgetRisk(5); }
async function rescueCard(r) {
  const card = await db.cards.get(r.id);
  if (!card) return;
  // M1 时间戳铁律：对齐 WrongBook「加入今日复习」口径 —— 调度字段因 reviewedAt 走 SRS 侧同步，
  // 只 put dueAt 的话本端排期变更不进增量包（dueAt 不在 LIVENESS_FIELDS）。不碰 updatedAt（内容侧）。
  await db.cards.put({ ...card, dueAt: Date.now(), reviewedAt: Date.now() });
  toast(t('views.cards.rescued', '已把「{front}…」加入今日复习', { front: r.front.slice(0, 16) }), 'success');
  await loadRisk();
  loadCards();
}
async function rescueAll() {
  let n = 0;
  for (const r of riskCards.value) {
    const card = await db.cards.get(r.id);
    if (!card) continue;
    await db.cards.put({ ...card, dueAt: Date.now(), reviewedAt: Date.now() });
    n++;
  }
  toast(t('views.cards.rescuedAll', '已把 {n} 张高危卡加入今日复习，去「背诵」页巩固', { n }), 'success');
  await loadRisk();
  loadCards();
}
</script>

<template>
  <div>
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">{{ t('views.cards.title') }}</h2>
      <span class="hint">{{ t('views.cards.countHint', '共 {total} 张 · 今日待背 {due}', { total, due: dueCount }) }}</span>
      <span style="flex:1"></span>
      <button v-if="dueCount > 0" class="btn primary" @click="router.push('/review')">{{ t('views.cards.gotoReview', '专注背诵（{n}）→', { n: dueCount }) }}</button>
      <button class="chip" :class="{ on: weakMode }" @click="toggleWeak">{{ t('views.cards.weakSet') }}</button>
      <button class="chip" :class="{ on: selectMode }" @click="selectMode ? exitSelect() : (selectMode = true)" :disabled="!total">{{ t('views.cards.bulkGroupBtn') }}</button>
      <button class="btn" @click="openBatch">{{ t('views.cards.batchCreate') }}</button>
      <ExportButton
        v-if="total > 0"
        :data="items"
        :count="items.length"
        filename-prefix="cards"
        :type="'default'"
        :formats="cardsExportFormats"
      />
      <button class="btn primary" @click="openCreate">{{ t('views.cards.newCard') }}</button>
    </div>

    <div class="streak-bar">
      <span class="hint">{{ t('views.cards.streakToday', '今日复习 {n} / {goal} 张', { n: todayCount, goal }) }}</span>
      <input type="number" v-model.number="goal" class="input" style="width:80px" min="1" @change="onGoalChange" :title="t('views.cards.goalTitle')" />
      <span class="streak-badge" :class="{ lit: streak >= 3, hot: streak >= 7 }">{{ t('views.cards.streakDays', '连续打卡 {n} 天', { n: streak }) }}</span>
    </div>

    <div v-if="riskCards.length" class="suggest-bar" style="border-color:var(--amber)">
      <div class="hint" style="font-weight:600;color:var(--amber)">{{ t('views.cards.riskTitle') }}</div>
      <div v-for="r in riskCards" :key="r.id" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="hint" style="flex:1">[{{ r.subject }}] {{ r.front }}{{ t('views.cards.riskMeta', '（错误率 {fail}% · 风险 {risk}%）', { fail: r.failRate, risk: r.risk }) }}</span>
        <button class="btn small" @click="rescueCard(r)">{{ t('views.cards.rescueBtn') }}</button>
      </div>
      <div><button class="btn small primary" @click="rescueAll">{{ t('views.cards.rescueAllBtn') }}</button></div>
    </div>

    <div v-if="suggestion && suggestion.dueCount > 0" class="suggest-bar">
      <div class="hint" style="font-weight:600;color:var(--ink)">{{ t('views.cards.suggestTitle') }}</div>
      <div class="hint">{{ t('views.cards.suggestDue', '待背 {n} 张', { n: suggestion.dueCount }) }}<span v-if="suggestion.markedCount">{{ t('views.cards.suggestMarked', '· 错题 {n} 张', { n: suggestion.markedCount }) }}</span></div>
      <div v-if="suggestion.dueBySubject.length" class="hint">
        {{ t('views.cards.dueTop') }}<span v-for="(s, i) in suggestion.dueBySubject" :key="s.name">{{ i ? '、' : '' }}{{ s.name }}({{ s.count }})</span>
      </div>
      <div v-if="suggestion.staleSubjects.length" class="hint" style="color:var(--amber)">
        {{ t('views.cards.staleTop') }}<span v-for="(s, i) in suggestion.staleSubjects" :key="s.name">{{ i ? '、' : '' }}{{ s.name }}({{ t('views.cards.staleDays', '{n}天', { n: s.days }) }})</span>
      </div>
    </div>

    <div class="filter-bar">
      <div class="row">
        <span class="hint" style="width:56px">{{ t('views.cards.viewLabel') }}</span>
        <button class="chip" :class="{ on: viewMode === 'scroll' }" @click="viewMode = 'scroll'">{{ t('views.cards.viewScroll') }}</button>
        <button class="chip" :class="{ on: viewMode === 'page' }" @click="viewMode = 'page'">{{ t('views.cards.viewPage') }}</button>
        <select v-model="sortBy" class="input" style="width:auto">
          <option value="updated">{{ t('views.cards.sortUpdated') }}</option>
          <option value="created">{{ t('views.cards.sortCreated') }}</option>
          <option value="due">{{ t('views.cards.sortDue') }}</option>
          <option value="subject">{{ t('views.cards.sortSubject') }}</option>
        </select>
        <span style="flex:1"></span>
        <input v-model="searchInput" class="input" style="max-width:280px" :placeholder="t('views.cards.searchPlaceholder')" />
        <button class="btn small" @click="saveSmart">{{ t('views.cards.saveCombo') }}</button>
      </div>
      <div class="row">
        <span class="hint" style="width:56px">{{ t('views.cards.subjectLabel') }}</span>
        <button class="chip" :class="{ on: !filters.subject }" @click="filters.subject = ''">{{ t('views.cards.allSubjects') }}</button>
        <button v-for="s in subjects" :key="s.name" class="chip" :class="{ on: filters.subject === s.name }"
                @click="filters.subject = filters.subject === s.name ? '' : s.name">
          {{ s.name }}<span class="n">{{ s.count }}</span>
        </button>
      </div>
      <div class="row">
        <span class="hint" style="width:56px">{{ t('views.cards.tagLabel') }}</span>
        <button class="chip" :class="{ on: !filters.tags.length }" @click="filters.tags = []">{{ t('views.cards.all') }}</button>
        <button v-for="t in allTags.slice(0, 20)" :key="t.name" class="chip" :class="{ on: filters.tags.includes(t.name) }"
                @click="toggleTag(t.name)">{{ t.name }}<span class="n">{{ t.count }}</span></button>
        <select v-if="filters.tags.length" v-model="filters.logic" class="input" style="width:auto;margin-left:8px">
          <option value="AND">{{ t('views.cards.logicAnd') }}</option>
          <option value="OR">{{ t('views.cards.logicOr') }}</option>
          <option value="NOT">{{ t('views.cards.logicNot') }}</option>
        </select>
      </div>
      <div v-if="smartFilters.length" class="row" style="margin-top:2px">
        <span class="hint" style="width:56px">{{ t('views.cards.smartLabel') }}</span>
        <span v-for="f in smartFilters" :key="f.id" class="chip" style="cursor:pointer" @click="applySmart(f)">
          ⭐ {{ f.name }}<a @click.stop="removeSmart(f)" style="color:var(--red);margin-left:6px;cursor:pointer">✕</a>
        </span>
      </div>
    </div>

    <!-- 批量建卡弹窗 -->
    <teleport to="body">
      <div v-if="batchOpen" class="modal-mask" @click.self="batchOpen = false">
        <div class="modal">
          <h3 style="margin-top:0">{{ t('views.cards.batchCreate') }}</h3>
          <!-- P2-3 模式切换：手动分隔 vs AI 智能拆分 -->
          <div class="batch-mode-row">
            <button class="chip" :class="{ on: batchMode === 'manual' }" @click="batchMode = 'manual'; aiDeck = []">{{ t('views.cards.modeManual') }}</button>
            <button class="chip" :class="{ on: batchMode === 'ai' }" @click="batchMode = 'ai'">{{ t('views.cards.modeAi') }}</button>
            <span v-if="batchMode === 'ai' && !hasAIKey()" class="hint" style="color:var(--warn)">{{ t('views.cards.noAiKey') }}</span>
          </div>
          <p v-if="batchMode === 'manual'" class="hint" style="margin-top:0">
            {{ t('views.cards.manualHint1') }}<br>
            {{ t('views.cards.manualHint2') }}
          </p>
          <p v-else class="hint" style="margin-top:0">
            {{ t('views.cards.aiHint1') }}<br>
            {{ t('views.cards.aiHint2') }}
          </p>
          <div class="field-label" style="margin-top:12px">{{ t('views.cards.batchSubjectLabel') }}</div>
          <select v-model="batchSubject" class="input">
            <option value="">{{ t('views.cards.notSpecified') }}</option>
            <option v-for="s in subjects" :key="s.name" :value="s.name">{{ s.name }}</option>
          </select>
          <template v-if="batchMode === 'manual'">
            <div class="field-label">{{ t('views.cards.parsedLabel', '内容（已解析 {n} 张）', { n: batchParsed.length }) }}</div>
            <textarea v-model="batchText" class="input" rows="10" :placeholder="t('views.cards.batchPlaceholder')"></textarea>
            <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
              <button class="btn" @click="batchOpen = false">{{ t('views.cards.cancel') }}</button>
              <button class="btn primary" :disabled="batchBusy || !batchParsed.length" @click="importBatch">
                {{ batchBusy ? t('views.cards.importing') : t('views.cards.importN', '导入 {n} 张', { n: batchParsed.length }) }}
              </button>
            </div>
          </template>
          <template v-else>
            <div class="field-label">{{ t('views.cards.aiCountLabel') }}</div>
            <input type="number" min="1" max="30" v-model.number="aiDeckCount" class="input" style="width:120px" />
            <div class="field-label">{{ t('views.cards.aiNoteLabel') }}</div>
            <textarea v-model="batchText" class="input" rows="10" :placeholder="t('views.cards.aiPlaceholder')"></textarea>
            <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:8px">
              <button class="btn" @click="batchOpen = false">{{ t('views.cards.cancel') }}</button>
              <button class="btn" :disabled="aiGenBusy" @click="aiGenerateDeck">{{ aiGenBusy ? t('views.cards.aiSplitting') : t('views.cards.genPreview') }}</button>
              <button class="btn primary" :disabled="batchBusy || !aiDeck.length" @click="importAiDeck">
                {{ batchBusy ? t('views.cards.importing') : t('views.cards.importN', '导入 {n} 张', { n: aiDeck.length }) }}
              </button>
            </div>
            <!-- AI 拆分预览 -->
            <div v-if="aiDeck.length" class="ai-deck-preview">
              <div v-for="(c, i) in aiDeck" :key="i" class="ai-deck-card">
                <div class="ai-deck-front"><span class="ai-deck-tag">{{ c.difficulty }}</span>{{ c.front }}</div>
                <div class="ai-deck-back">{{ c.back }}</div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </teleport>

    <!-- M1 批量分组操作栏 -->
    <div v-if="selectMode" class="bulk-bar">
      <label class="chk"><input type="checkbox" :checked="selectedIds.size === items.length && items.length > 0" @change="toggleSelectAll" /> {{ t('views.cards.selectAll') }}</label>
      <span class="hint">{{ t('views.cards.selectedN', '已选 {n} 张', { n: selectedIds.size }) }}</span>
      <span v-if="!groupList.length" class="hint">{{ t('views.cards.noGroups') }}</span>
      <template v-else>
        <span class="hint">{{ t('views.cards.moveIn') }}</span>
        <button v-for="g in groupList" :key="'a' + g.id" class="chip mini" @click="bulkGroup(g.id)">{{ g.name }}</button>
        <span class="hint">{{ t('views.cards.moveOut') }}</span>
        <button v-for="g in groupList" :key="'r' + g.id" class="chip mini" @click="bulkRemoveGroup(g.id)">{{ g.name }}</button>
      </template>
      <button class="chip mini" :disabled="selectedIds.size < 2" @click="goLinkAnalysis" :title="t('views.cards.linkAnalysisTitle')">{{ t('views.cards.linkAnalysis') }}</button>
      <button class="chip mini" @click="exitSelect">{{ t('views.cards.done') }}</button>
    </div>

    <VirtualList v-if="viewMode === 'scroll'" :items="items">
      <template #default="{ item }">
        <div class="card-item" :class="{ highlight: highlightId === item.id }" @click="openPreview(item, $event)" style="cursor:pointer">
          <label v-if="selectMode" class="chk" @click.stop><input type="checkbox" :checked="selectedIds.has(item.id)" @change="toggleSelect(item.id)" /></label>
          <div class="tags">
            <span class="grade-pill" :class="gradeCard(item).cls">{{ gradeCard(item).label }}</span> <span v-if="item.type && item.type !== 'basic'" class="tag-pill" style="background:var(--blue);color:#fff">{{ typeName(item.type) }}</span> <span v-if="item.subject" class="tag-pill subj">{{ item.subject }}</span>
            <span v-for="t in item.tags" :key="t" class="tag-pill">{{ t }}</span>
            <span v-if="weakMode && item.failCount" class="tag-pill" style="background:var(--red);color:#fff">{{ t('views.cards.forgotN', '答错{n}次', { n: item.failCount }) }}</span>
            <span style="flex:1"></span>
            <button class="chip mini expand-chip" @click.stop="toggleExpand(item.id)" :title="(expandAllByDefault ? (collapsedIds.has(item.id) ? t('views.cards.expandDetailTitle') : t('views.cards.collapseDetailTitle')) : (collapsedIds.has(item.id) ? t('views.cards.collapseDetailTitle') : t('views.cards.expandDetailTitle')))">
              {{ expandAllByDefault ? (collapsedIds.has(item.id) ? t('views.cards.expandDetail') : t('views.cards.collapseDetail')) : (collapsedIds.has(item.id) ? t('views.cards.collapseDetail') : t('views.cards.expandDetail')) }}
            </button>
          </div>
          <div v-if="item.source" class="hint" style="margin-bottom:4px">{{ t('views.cards.sourcePrefix') }}{{ item.source }}</div>
          <!-- 默认：只显示 front preview；expandAll=1 或用户点展开：显示 front + back 完整 Markdown（背诵效果） -->
          <template v-if="showFullDetail(item.id)">
            <div class="detail-block">
              <div class="detail-label">{{ t('views.cards.frontLabel') }}</div>
              <div class="detail-face front"><MarkdownRenderer :content="item.front" /></div>
              <div v-if="item.back" class="detail-label" style="margin-top:8px">{{ t('views.cards.backLabel') }}</div>
              <div v-if="item.back" class="detail-face back"><MarkdownRenderer :content="item.back" /></div>
              <div v-if="item.mnemonic" class="mnemonic-block">{{ t('views.cards.mnemonicPrefix') }}{{ item.mnemonic }}</div>
            </div>
          </template>
          <template v-else>
            <div v-if="filters.q" class="front-preview" v-html="hlFront(item)"></div>
            <div v-else class="front-preview">{{ plain(item.front).slice(0, 160) || t('views.cards.empty') }}</div>
          </template>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;flex-wrap:wrap">
            <button class="btn small" :class="{ danger: item.marked }" @click="toggleMarked(item)">{{ item.marked ? t('views.cards.unmark') : t('views.cards.mark') }}</button> <button class="btn small" @click="openEdit(item)">{{ t('views.cards.edit') }}</button>
            <button class="btn small" @click="genVariantsFor(item)" :disabled="variantBusy.has(item.id)">{{ variantBusy.has(item.id) ? t('views.cards.generating') : t('views.cards.variant') }}</button> <button class="btn small" @click="openDiagnose(item)">{{ t('views.cards.diagnose') }}</button> <button class="btn small" @click="openHistory(item)">{{ t('views.cards.history') }}</button>           <button class="btn small danger" @click="remove(item)">{{ t('views.cards.del') }}</button>
        </div>
      </div>
      <!-- E3：分页条（仅 page 视图且多于一页时显示；scroll 视图走 VirtualList 不在此） -->
      <div v-if="pageCount > 1" class="pager no-print" style="display:flex;align-items:center;justify-content:center;gap:10px;margin:14px 0">
        <button class="chip mini" :disabled="pageNo <= 1" @click="pageNo--">{{ t('views.cards.pagePrev', '上一页') }}</button>
        <span class="hint">{{ pageNo }} / {{ pageCount }} · {{ t('views.cards.totalN', '共 {n} 张', { n: items.length }) }}</span>
        <button class="chip mini" :disabled="pageNo >= pageCount" @click="pageNo++">{{ t('views.cards.pageNext', '下一页') }}</button>
      </div>
    </template>
    </VirtualList>

    <template v-else>
      <div v-for="item in pagedItems" :key="item.id" class="card-item" :class="{ highlight: highlightId === item.id }" @click="openPreview(item, $event)" style="cursor:pointer">
        <label v-if="selectMode" class="chk" @click.stop><input type="checkbox" :checked="selectedIds.has(item.id)" @change="toggleSelect(item.id)" /></label>
        <div class="tags">
          <span class="grade-pill" :class="gradeCard(item).cls">{{ gradeCard(item).label }}</span> <span v-if="item.type && item.type !== 'basic'" class="tag-pill" style="background:var(--blue);color:#fff">{{ typeName(item.type) }}</span> <span v-if="item.subject" class="tag-pill subj">{{ item.subject }}</span>
          <span v-for="t in item.tags" :key="t" class="tag-pill">{{ t }}</span>
          <span v-if="weakMode && item.failCount" class="tag-pill" style="background:var(--red);color:#fff">{{ t('views.cards.forgotN', '答错{n}次', { n: item.failCount }) }}</span>
          <span style="flex:1"></span>
          <button class="chip mini expand-chip" @click.stop="toggleExpand(item.id)">
            {{ expandAllByDefault ? (collapsedIds.has(item.id) ? t('views.cards.expandDetail') : t('views.cards.collapseDetail')) : (collapsedIds.has(item.id) ? t('views.cards.collapseDetail') : t('views.cards.expandDetail')) }}
          </button>
        </div>
        <div v-if="item.source" class="hint" style="margin-bottom:4px">{{ t('views.cards.sourcePrefix') }}{{ item.source }}</div>
        <template v-if="showFullDetail(item.id)">
          <div class="detail-block">
            <div class="detail-label">{{ t('views.cards.frontLabel') }}</div>
            <div class="detail-face front"><MarkdownRenderer :content="item.front" /></div>
            <div v-if="item.back" class="detail-label" style="margin-top:8px">{{ t('views.cards.backLabel') }}</div>
            <div v-if="item.back" class="detail-face back"><MarkdownRenderer :content="item.back" /></div>
            <div v-if="item.mnemonic" class="mnemonic-block">{{ t('views.cards.mnemonicPrefix') }}{{ item.mnemonic }}</div>
          </div>
        </template>
        <template v-else>
          <div v-if="filters.q" class="front-preview" v-html="hlFront(item)"></div>
          <div v-else class="front-preview">{{ plain(item.front).slice(0, 160) || t('views.cards.empty') }}</div>
        </template>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;flex-wrap:wrap">
          <button class="btn small" :class="{ danger: item.marked }" @click="toggleMarked(item)">{{ item.marked ? t('views.cards.unmark') : t('views.cards.mark') }}</button> <button class="btn small" @click="openEdit(item)">{{ t('views.cards.edit') }}</button>
          <button class="btn small" @click="genVariantsFor(item)" :disabled="variantBusy.has(item.id)">{{ variantBusy.has(item.id) ? t('views.cards.generating') : t('views.cards.variant') }}</button> <button class="btn small" @click="openDiagnose(item)">{{ t('views.cards.diagnose') }}</button> <button class="btn small" @click="openHistory(item)">{{ t('views.cards.history') }}</button> <button class="btn small danger" @click="remove(item)">{{ t('views.cards.del') }}</button>
        </div>
      </div>
    </template>

    <!-- 孤儿图片面板（从资产体检跳转 orphan=1 时显示） -->
    <div v-if="orphanImagesVisible" class="panel orphan-panel" style="margin-top:12px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <span class="field-label" style="margin:0">{{ t('views.cards.orphanTitle', '孤儿图片（{n} 张）', { n: orphanImages.length }) }}</span>
        <span class="hint">{{ t('views.cards.orphanHint') }}</span>
        <span style="flex:1"></span>
        <button v-if="orphanImages.length" class="btn small primary" @click="removeAllOrphans">{{ t('views.cards.cleanAll') }}</button>
      </div>
      <div v-if="!orphanImages.length" class="hint">{{ t('views.cards.noOrphan') }}</div>
      <div v-else class="orphan-grid">
        <div v-for="img in orphanImages" :key="img.id" class="orphan-cell">
          <img :src="dataUrlOf(img)" :alt="img.id" loading="lazy" decoding="async" />
          <div class="orphan-meta">
            <span class="hint">{{ new Date(img.createdAt || Date.now()).toLocaleDateString() }}</span>
            <span style="flex:1"></span>
            <button class="btn small danger" @click="removeOrphan(img.id)">{{ t('views.cards.del') }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 资产体检跳转 banner -->
    <div v-if="activeFilterBanner" class="filter-banner" style="margin-top:14px">
      <span>{{ activeFilterBanner }}</span>
      <span style="flex:1"></span>
      <button class="chip" @click="router.push('/health')">{{ t('views.cards.backToHealth') }}</button>
      <button class="chip" @click="activeFilterBanner='';location.search=''">{{ t('views.cards.clearFilter') }}</button>
    </div>

    <EmptyState v-if="!loading && !items.length" :title="t('views.cards.emptyTitle')" :message="t('views.cards.emptyMsg')">
      <button class="btn primary" @click="openCreate">{{ t('views.cards.newFirstCard') }}</button>
    </EmptyState>

    <!-- 卡片预览层：点击卡片体打开，内嵌 FlipCard 翻转预览，编辑按钮才打开 CardModal -->
    <teleport to="body">
      <div v-if="showPreview && previewCard" class="modal-mask preview-mask" @click.self="closePreview">
        <div class="preview-wrap" @click.stop>
          <div class="preview-head">
            <span class="hint" style="font-weight:600;color:var(--ink)">{{ t('views.cards.previewTitle') }}</span>
            <span style="flex:1"></span>
            <button class="btn small primary" @click="previewEdit">{{ t('views.cards.edit') }}</button>
            <button class="btn small" @click="closePreview">{{ t('views.cards.close') }}</button>
          </div>
          <div class="preview-body">
            <FlipCard :card="previewCard" @edit="previewEdit" />
            <!-- D3.3 相关笔记（反链面板）：所有笔记中正文含 [[c<id>]] 的笔记列在此 -->
            <div v-if="linkedNotes.length" class="linked-notes">
              <div class="linked-notes-title">
                <span class="soft-pulse" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent);margin-right:8px"></span>
                {{ t('views.cards.linkedNotes', '关联笔记（{n}）', { n: linkedNotes.length }) }}
              </div>
              <div
                v-for="n in linkedNotes"
                :key="n.id"
                class="linked-notes-item"
                @click="$router.push({ path: '/notes', query: { id: n.id } })"
              >
                <span class="ln-icon">📓</span>
                <span class="ln-title">{{ n.title || t('views.cards.untitled') }}</span>
                <span class="ln-cat" v-if="n.category">📁 {{ n.category }}</span>
              </div>
            </div>
            <!-- D3.3 双链入口：当前卡片的 front 也能在笔记中作为 [[c<id>]] 被引用 -->
            <div class="linked-notes-foot">
              <button class="btn small" @click="copyLinkAsWiki">{{ t('views.cards.copyRef', '📋 复制 [[c{id}]] 引用', { id: previewCard.id }) }}</button>
            </div>
          </div>
        </div>
      </div>
    </teleport>

    <CardModal v-model="modalOpen" :card="editing" @saved="onSaved" />

    <teleport to="body">
      <div v-if="historyOpen" class="modal-mask" @click.self="historyOpen = false">
        <div class="modal">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <h3 style="margin:0">{{ t('views.cards.historyTitle') }}</h3>
            <button class="btn small" @click="historyOpen = false">{{ t('views.cards.close') }}</button>
          </div>
          <div v-if="historyData && historyData.card" class="card-item" style="margin:8px 0">
            <div class="tags">
              <span v-if="historyData.card.subject" class="tag-pill subj">{{ historyData.card.subject }}</span>
              <span v-for="t in historyData.card.tags" :key="t" class="tag-pill">{{ t }}</span>
            </div>
            <div class="front-preview">{{ plain(historyData.card.front).slice(0, 80) || t('views.cards.empty') }}</div>
          </div>
          <EmptyState v-if="historyData && !historyData.history.length" compact icon="🗂️" :title="t('views.cards.noHistoryTitle')" :message="t('views.cards.noHistoryMsg')" />
          <div v-else>
            <div v-for="(h, i) in historyData.history" :key="i" style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px dashed var(--line)">
              <span class="hint">{{ fmtTime(h.reviewedAt) }}</span>
              <span class="hint" :class="'rt-' + h.rating">{{ h.ratingText }}</span>
            </div>
          </div>
        </div>
      </div>
    </teleport>
  <teleport to="body">
      <div v-if="diagOpen" class="modal-mask" @click.self="diagOpen = false">
        <div class="modal">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <h3 style="margin:0">{{ t('views.cards.diagTitle') }}</h3>
            <button class="btn small" @click="diagOpen = false">{{ t('views.cards.close') }}</button>
          </div>
          <div v-if="diagLoading" class="hint" style="text-align:center;padding:30px">{{ t('views.cards.diagLoading') }}</div>
          <div v-else class="diag-text">{{ diagText }}</div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.bulk-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 14px; margin: 16px 0 8px; }
.chk { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
.filter-bar { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 16px; margin: 16px 0; }
.filter-bar .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.filter-bar .row:last-child { margin-bottom: 0; }
.front-preview { color: var(--ink); }
.front-preview :deep(mark) { background: #ffe58f; color: inherit; border-radius: 3px; padding: 0 1px; }
.suggest-bar { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--blue); border-radius: var(--radius); padding: 12px 16px; margin: 12px 0; display: flex; flex-direction: column; gap: 2px; }
.streak-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 12px; }
.streak-badge {
  display: inline-flex; align-items: center;
  background: var(--code-inline); color: var(--ink-2);
  border-radius: 999px; padding: 2px 12px; font-size: 12px; font-weight: 600;
  transition: all .2s ease;
}
.streak-badge.lit { background: #dcfce7; color: var(--green); }
.streak-badge.hot { background: #fef3c7; color: var(--amber); animation: pulse 1.6s ease infinite; }
@keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.06); } }
.rt-0 { color: var(--red); }
.rt-1 { color: var(--amber); }
.rt-2 { color: var(--green); }
.grade-pill { font-size: 11px; border-radius: 6px; padding: 2px 8px; font-weight: 600; }
.g-new { background: #f1f5f9; color: #64748b; }
.g-learning { background: #eef2ff; color: #4338ca; }
.g-good { background: #dcfce7; color: #16a34a; }
.g-master { background: #dbeafe; color: #2563eb; }
.g-weak { background: #fee2e2; color: #dc2626; }
.diag-text { white-space: pre-wrap; line-height: 1.7; color: var(--ink); }

/* 资产体检跳转：高亮、详情展开、banner、孤儿图网格 */
.card-item.highlight { box-shadow: 0 0 0 2px var(--blue), 0 8px 20px rgba(37,99,235,.15); }
.expand-chip { font-size: 11px; padding: 2px 10px; }
.detail-block {
  margin: 6px 0 2px; padding: 10px 12px; border: 1px dashed var(--line); border-radius: 10px;
  background: color-mix(in srgb, var(--code-bg) 50%, transparent);
}
.detail-label { font-size: 11px; color: var(--ink-2); letter-spacing: .5px; margin-bottom: 4px; font-weight: 600; }
.detail-face { padding: 6px 8px; border-radius: 8px; background: var(--panel); }
.detail-face.back { background: color-mix(in srgb, var(--accent) 6%, var(--panel)); }
.mnemonic-block { margin-top: 8px; padding: 6px 10px; background: var(--code-bg); border-radius: 8px; color: var(--ink-2); font-size: 13px; }

.filter-banner {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 10px 14px; border-radius: 10px;
  background: color-mix(in srgb, var(--amber) 10%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--amber) 40%, var(--line));
  color: #78350f; font-size: 13px;
}

.orphan-panel { border-left: 3px solid var(--amber) !important; }
.orphan-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
}
.orphan-cell {
  border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--page-bg);
  display: flex; flex-direction: column;
}
.orphan-cell img {
  width: 100%; height: 140px; object-fit: contain; background: #fff; display: block;
  border-bottom: 1px solid var(--line);
}
.orphan-meta { display: flex; align-items: center; gap: 8px; padding: 6px 8px; }

.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px; }
.field-label { font-size: 13px; font-weight: 600; color: var(--ink-2); }
.chip.mini { font-size: 12px; padding: 2px 10px; }

/* 卡片预览层：fixed 全屏半透明遮罩 + 居中容器 */
.preview-mask { align-items: center; justify-content: center; padding: 20px; }
.preview-wrap {
  width: min(720px, 92vw);
  max-height: 90vh;
  background: var(--panel);
  border-radius: var(--radius);
  border: 1px solid var(--line);
  box-shadow: 0 20px 60px rgba(0,0,0,.18);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.preview-head {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--code-bg);
  flex-shrink: 0;
}
.preview-body {
  padding: 14px 16px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
/* P2-3 AI 智能卡组生成：模式切换行 + 预览卡片 */
.batch-mode-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.ai-deck-preview { margin-top: 12px; max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 8px; background: var(--code-inline); border-radius: 8px; }
.ai-deck-card { border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; background: var(--panel); }
.ai-deck-front { font-weight: 600; font-size: 13px; line-height: 1.5; }
.ai-deck-back { font-size: 12px; color: var(--ink-2); margin-top: 4px; line-height: 1.5; white-space: pre-wrap; }
.ai-deck-tag { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 3px; background: var(--code-inline); color: var(--ink-2); margin-right: 6px; }

/* D3.3 关联笔记面板（卡片预览底部） */
.linked-notes { margin-top: 14px; padding: 10px 12px; background: var(--bg, #fafafb); border: 1px solid var(--line); border-radius: 8px; }
.linked-notes-title { display: flex; align-items: center; font-weight: 600; font-size: 13px; margin-bottom: 8px; color: var(--ink); }
.linked-notes-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; cursor: pointer; transition: background .15s; font-size: 13px; }
.linked-notes-item:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.ln-icon { color: #d4a853; }
.ln-title { flex: 1; font-weight: 500; }
.ln-cat { font-size: 11px; color: var(--ink-2); background: rgba(217, 119, 6, 0.12); color: #b45309; padding: 1px 6px; border-radius: 4px; }
.linked-notes-foot { margin-top: 8px; display: flex; justify-content: flex-end; }
</style>