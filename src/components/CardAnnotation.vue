<script setup>
// 卡片批注面板（背诵时记录复习心得）。
//
// 设计边界（务必保持）：
//   · 只读写 cardAnnots 表，**绝不触碰卡片正/背面**；
//   · 本组件不参与 .flip-scene 内部布局 —— 由父级（Review.vue）放在卡片**旁边/下方**，
//     卡片尺寸零变化（避免重排跳动）；
//   · 所有点击 @click.stop，杜绝事件冒泡去触发卡片翻转/评分；
//   · 加载失败只提示、不抛错，**绝不阻塞背诵主流程**；
//   · 异步加载带 requestId，切换卡片即作废在途请求，杜绝「A 卡批注显示在 B 卡上」。
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue';
import { t } from '../i18n/index.js';
import { toast } from '../utils/toast.js';
import { confirmDialog } from '../utils/confirm.js';
import MarkdownRenderer from './MarkdownRenderer.vue';
import {
  listAnnots, addAnnot, deleteAnnot, normalizeAnnotContent, formatAnnotTs, ANNOT_MAX_CHARS,
} from '../annot-repo.js';

const props = defineProps({
  /** 当前卡片 id；空串表示无卡片 */
  cardId: { type: String, default: '' },
  /** 面板是否展开（收起时保留组件实例，草稿不丢） */
  open: { type: Boolean, default: false },
});
const emit = defineEmits(['close', 'count']);

const annots = ref([]);
const loading = ref(false);
const draft = ref('');
const saving = ref(false);
const fsOpen = ref(false);
const listEl = ref(null);

// 防竞态：每次加载自增，回调只认自己那一次的结果
let reqSeq = 0;

const canSave = computed(() => !!normalizeAnnotContent(draft.value) && !saving.value);

/** 复习上下文文案（快照缺失时不显示，不报错） */
function ctxText(a) {
  if (a?.reviewCount == null) return '';
  return t('views.review.annotCtxN', undefined, { n: Number(a.reviewCount) + 1 });
}

/**
 * 加载批注。失败只 toast 一次轻提示，不改任何主流程状态。
 * 关键：用 reqSeq 快照判定，切卡后迟到的响应一律丢弃。
 */
async function load() {
  const id = String(props.cardId || '');
  const mySeq = ++reqSeq;
  if (!id) { annots.value = []; return; }
  loading.value = true;
  try {
    const rows = await listAnnots(id);
    if (mySeq !== reqSeq) return;            // 已切卡 → 丢弃
    annots.value = rows;
    emit('count', rows.length);
  } catch {
    if (mySeq === reqSeq) {
      annots.value = [];
      toast(t('views.review.annotLoadFail'), 'error');
    }
  } finally {
    if (mySeq === reqSeq) loading.value = false;
  }
}

/** 保存新批注：空内容不允许保存；保存中禁用按钮防重复提交 */
async function save() {
  const text = normalizeAnnotContent(draft.value);
  if (!text) { toast(t('views.review.annotEmptyWarn'), 'info'); return; }
  if (saving.value) return;
  const id = String(props.cardId || '');
  if (!id) return;
  saving.value = true;
  try {
    const row = await addAnnot(id, text);
    // ⚠️ 只有「仍停在同一张卡」时才动 UI 状态。
    //   初版把 `draft.value = ''` 写在这个 if **外面** —— 若保存期间用户切了卡并在新卡上
    //   重新输入，迟到的回调会把**新输入的草稿**一并清掉（静默数据丢失）。
    //   2026-10-01 审计发现并修正。
    if (String(props.cardId) === id) {
      // 新批注 createdAt 最新 → 直接置顶（与「倒序」语义一致），无需整表重载
      annots.value = [row, ...annots.value];
      emit('count', annots.value.length);
      draft.value = '';
      await nextTick();
      if (listEl.value) listEl.value.scrollTop = 0;
    }
  } catch (e) {
    const msg = e?.message === 'ANN_EMPTY'
      ? t('views.review.annotEmptyWarn')
      : String(e?.message || e);
    toast(t('views.review.annotSaveFail', undefined, { msg }), 'error');
  } finally {
    saving.value = false;
  }
}

/** 删除：物理删行 + 墓碑（跨设备删除才有效）+ 二次确认；失败不影响复习 */
async function remove(a) {
  if (!a?.id) return;
  const id = String(props.cardId || '');
  if (!(await confirmDialog(t('views.review.annotDeleteConfirm')))) return;
  try {
    const ok = await deleteAnnot(a.id);
    // 二次确认期间可能已切卡：只有仍停在同一张卡时才动列表/角标/提示，
    // 否则会在用户已经离开的那张卡之外弹出「已删除」，造成困惑（数据本身已正确删除）。
    if (ok && String(props.cardId) === id) {
      annots.value = annots.value.filter((x) => x.id !== a.id);
      emit('count', annots.value.length);
      toast(t('views.review.annotDeleted'), 'success');
    }
  } catch {
    toast(t('views.review.annotSaveFail', undefined, { msg: 'delete' }), 'error');
  }
}

// ---- 键盘：Esc 收起 ----
// 只在展开时注册文档监听（收起即摘除，绝不留全局钩子）。
// ⚠️ FlipCard 的「内容全屏」也用 Esc（捕获阶段）——若它的浮层正开着，
//    Esc 优先归全屏，本文不处理，避免一次按键关掉两层。
function onDocKey(e) {
  if (e.key !== 'Escape') return;
  if (!props.open) return;
  // 有更高优先级的浮层开着时**让位**，避免"一次 Esc 关掉两层"：
  //   ① 卡片内容全屏（FlipCard 的捕获监听会先处理，这里再兜一道）
  //   ② Element Plus 模态框（确认删除对话框自带 closeOnPressEscape）——
  //      2026-10-01 审计发现：不加这一条时，用户按 Esc 取消删除会连带收起批注面板。
  if (typeof document !== 'undefined') {
    if (document.querySelector('.content-fs-overlay')) return;
    if (document.querySelector('.el-overlay, .el-message-box__wrapper')) return;
  }
  if (fsOpen.value) { fsOpen.value = false; return; }   // 全屏时先退全屏
  emit('close');
}
// 展开/收起：挂摘 Esc 监听 + 展开时惰性加载（只有展开才请求，不每次渲染都全量拉）。
// 合并为**单个** watcher：同源多 watcher 的执行顺序无保证，早前版本拆成两个曾让
// 「Esc 监听已挂但数据未载入」出现瞬时不一致。
watch(() => props.open, (v) => {
  if (typeof document !== 'undefined') {
    if (v) document.addEventListener('keydown', onDocKey);
    else { document.removeEventListener('keydown', onDocKey); fsOpen.value = false; }
  }
  if (v) load();
}, { immediate: true });

// 切换卡片：清空当前批注状态（防串数据）+ 作废在途请求 + 清草稿。
// 面板保持展开状态由父级决定，这里只负责数据不串。
watch(() => props.cardId, () => {
  reqSeq++;                 // 作废在途请求
  annots.value = [];
  draft.value = '';
  loading.value = false;
  emit('count', 0);
  if (props.open) load();   // 展开态下切卡 → 立即加载新卡批注
});

onBeforeUnmount(() => {
  reqSeq++;
  if (typeof document !== 'undefined') document.removeEventListener('keydown', onDocKey);
});

defineExpose({ reload: load });
</script>

<template>
  <aside
    v-show="open"
    id="card-annot-panel"
    class="annot-panel"
    role="region"
    :aria-label="t('views.review.annotTitle')"
    @click.stop
  >
    <header class="annot-head">
      <span class="annot-title">{{ t('views.review.annotTitle') }}</span>
      <span v-if="annots.length" class="annot-badge">{{ annots.length }}</span>
      <span class="annot-spacer"></span>
      <button
        class="annot-icon-btn"
        :aria-label="t('views.review.annotFullscreen')"
        :title="t('views.review.annotFullscreen')"
        @click.stop="fsOpen = true"
      >⛶</button>
      <button
        class="annot-icon-btn"
        :aria-label="t('views.review.annotClose')"
        :title="t('views.review.annotClose')"
        @click.stop="emit('close')"
      >✕</button>
    </header>

    <div class="annot-input">
      <textarea
        v-model="draft"
        class="annot-textarea"
        rows="2"
        :maxlength="ANNOT_MAX_CHARS"
        :placeholder="t('views.review.annotPlaceholder')"
        @click.stop
      ></textarea>
      <div class="annot-input-foot">
        <span class="annot-tip">{{ t('views.review.annotTsTip') }}</span>
        <button
          class="btn small primary"
          :disabled="!canSave"
          @click.stop="save"
        >{{ saving ? t('views.review.annotSaving') : t('views.review.annotSave') }}</button>
      </div>
    </div>

    <div ref="listEl" class="annot-list">
      <div v-if="loading" class="annot-hint">{{ t('views.review.annotLoading') }}</div>
      <div v-else-if="!annots.length" class="annot-hint annot-empty">
        {{ t('views.review.annotEmpty') }}
      </div>
      <article v-for="a in annots" :key="a.id" class="annot-item">
        <div class="annot-meta">
          <time class="annot-ts">{{ formatAnnotTs(a.createdAt) }}</time>
          <span v-if="ctxText(a)" class="annot-ctx">{{ ctxText(a) }}</span>
          <span class="annot-spacer"></span>
          <button class="annot-del" @click.stop="remove(a)">{{ t('views.review.annotDelete') }}</button>
        </div>
        <div class="annot-body"><MarkdownRenderer :content="a.content" /></div>
      </article>
    </div>
  </aside>

  <!-- 批注全屏层（与卡片内容全屏同构：只在需要时 Teleport，避免影响页面布局） -->
  <Teleport to="body">
    <div v-if="fsOpen" class="annot-fs-overlay" @click.self="fsOpen = false">
      <div class="annot-fs-panel" @click.stop>
        <header class="annot-head">
          <span class="annot-title">{{ t('views.review.annotTitle') }}</span>
          <span class="annot-spacer"></span>
          <button class="annot-icon-btn" @click.stop="fsOpen = false">✕</button>
        </header>
        <div class="annot-list annot-fs-list">
          <div v-if="!annots.length" class="annot-hint annot-empty">{{ t('views.review.annotEmpty') }}</div>
          <article v-for="a in annots" :key="a.id" class="annot-item">
            <div class="annot-meta">
              <time class="annot-ts">{{ formatAnnotTs(a.createdAt) }}</time>
              <span v-if="ctxText(a)" class="annot-ctx">{{ ctxText(a) }}</span>
            </div>
            <div class="annot-body"><MarkdownRenderer :content="a.content" /></div>
          </article>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 面板本体：由父级 flex 决定横向位置（右侧/下方），这里只管内部结构与「不抢眼」。
   高度由父级 stretch 拉齐卡片高度，内容溢出走内部滚动 —— 绝不把卡片撑高。 */
.annot-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;                 /* flex 内滚动的前提 */
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  font-size: 13px;               /* 比卡片正文略小 —— 不做视觉主角 */
  /* 宽度**由本组件自管**（不依赖父级 scoped 去选中子组件内部元素——本组件是多根 Fragment，
     父级 scoped 选择器根本选不中它）。比例：面板 30% / 卡片 70% ⇒ 面板约为卡片宽度的 43%，
     满足「不超过卡片宽度 50%、也不能太小」。 */
  flex: 0 0 auto;
  width: clamp(220px, 30%, 340px);
}
.annot-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  flex: 0 0 auto;
}
.annot-title { font-weight: 500; color: var(--ink-2); }
.annot-badge {
  font-size: 11px; line-height: 1;
  padding: 2px 6px; border-radius: 8px;
  background: var(--code-inline); color: var(--ink-2);
}
.annot-spacer { flex: 1 1 auto; }
.annot-icon-btn {
  border: 1px solid transparent; background: transparent;
  color: var(--ink-2); cursor: pointer; border-radius: 6px;
  padding: 2px 6px; font-size: 13px; line-height: 1.4;
}
.annot-icon-btn:hover { border-color: var(--line); }

.annot-input {
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  flex: 0 0 auto;
}
.annot-textarea {
  width: 100%; box-sizing: border-box;
  resize: vertical; min-height: 48px; max-height: 120px;
  padding: 6px 8px; border-radius: 6px;
  border: 1px solid var(--line); background: var(--bg, var(--panel));
  color: var(--ink); font: inherit;
}
.annot-input-foot {
  display: flex; align-items: center; gap: 8px; margin-top: 6px;
}
.annot-tip { font-size: 11px; color: var(--ink-3, var(--ink-2)); opacity: .8; }

.annot-list { flex: 1 1 auto; overflow-y: auto; padding: 8px 10px; min-height: 0; }
.annot-hint { color: var(--ink-2); opacity: .85; padding: 10px 2px; }
.annot-empty { text-align: center; }
.annot-item { padding: 8px 0; border-bottom: 1px dashed var(--line); }
.annot-item:last-child { border-bottom: none; }
.annot-meta { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.annot-ts { font-size: 11px; color: var(--ink-2); opacity: .9; font-variant-numeric: tabular-nums; }
.annot-ctx { font-size: 11px; color: var(--ink-2); opacity: .75; }
.annot-del {
  border: none; background: transparent; cursor: pointer;
  font-size: 11px; color: var(--ink-2); opacity: .7; padding: 0 2px;
}
.annot-del:hover { color: var(--red, #c0392b); opacity: 1; }
.annot-body { font-size: 13px; line-height: 1.6; color: var(--ink); word-break: break-word; }

/* 全屏层：只覆盖自身，z-index 压在导航之下、与卡片全屏同层 */
.annot-fs-overlay {
  position: fixed; inset: 0; z-index: 999;
  background: rgba(0, 0, 0, .45);
  display: flex; align-items: center; justify-content: center;
  padding: 4vh 4vw;
}
.annot-fs-panel {
  width: 100%; max-width: 900px; max-height: 92vh;
  display: flex; flex-direction: column;
  background: var(--panel); border-radius: var(--radius);
  overflow: hidden;
}
.annot-fs-list { max-height: none; }

/* 窄屏：不做右侧并排（会挤压卡片），改由父级切为卡片下方整宽展开。
   这里只解除宽度约束 + 限高，保证「卡片与操作按钮优先可见可用」。 */
@media (max-width: 720px) {
  .annot-panel { width: 100%; max-height: 45vh; }
}
</style>
