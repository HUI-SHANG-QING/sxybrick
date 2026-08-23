<script setup>
// 虚拟滚动列表：仅渲染视口内可见项，支持动态高度、平滑滚动、快速定位
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { degraded } from '../utils/perf.js';

const props = defineProps({
  items: { type: Array, default: () => [] },
  estHeight: { type: Number, default: 160 },
  overscan: { type: Number, default: 3 },
});
const emit = defineEmits(['reach-end']);

const viewport = ref(null);
const scrollTop = ref(0);
const viewH = ref(600);
const heights = ref(new Map());
const itemRefs = new Map();

const overscan = computed(() => (degraded.value ? 1 : props.overscan));

const positions = computed(() => {
  const pos = [];
  let top = 0;
  for (const it of props.items) {
    const h = heights.value.get(it.id) || props.estHeight;
    pos.push({ top, h });
    top += h + 12;
  }
  return pos;
});
const totalH = computed(() => {
  const last = positions.value[positions.value.length - 1];
  return last ? last.top + last.h : 0;
});

const range = computed(() => {
  const pos = positions.value;
  const n = props.items.length;
  if (!n) return { start: 0, end: 0 };
  let lo = 0, hi = n - 1, start = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pos[mid].top + pos[mid].h < scrollTop.value) { start = mid; lo = mid + 1; } else hi = mid - 1;
  }
  start = Math.max(0, start - overscan.value);
  let end = start;
  const bottom = scrollTop.value + viewH.value;
  while (end < n && pos[end].top < bottom) end++;
  end = Math.min(n, end + overscan.value);
  return { start, end };
});

const visible = computed(() =>
  props.items.slice(range.value.start, range.value.end).map((it, i) => ({
    item: it, top: positions.value[range.value.start + i].top,
  })));

let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    scrollTop.value = viewport.value?.scrollTop || 0;
    if (viewport.value &&
        viewport.value.scrollTop + viewH.value > viewport.value.scrollHeight - 300) {
      emit('reach-end');
    }
  });
}

let ro = null;
function bindResizeObserver() {
  if (typeof ResizeObserver === 'undefined' || degraded.value) return;
  ro = new ResizeObserver((entries) => {
    let changed = false;
    for (const e of entries) {
      const id = e.target.dataset.vid;
      const h = Math.round(e.contentRect.height);
      if (Math.abs((heights.value.get(id) || props.estHeight) - h) > 2) {
        heights.value.set(id, h);
        changed = true;
      }
    }
    if (changed) heights.value = new Map(heights.value);
  });
}
function setItemRef(el, id) {
  if (el) { itemRefs.set(id, el); el.dataset.vid = id; ro?.observe(el); }
  else { const old = itemRefs.get(id); if (old) ro?.unobserve(old); itemRefs.delete(id); }
}

async function scrollToId(id) {
  const idx = props.items.findIndex(it => it.id === id);
  if (idx < 0) return;
  await nextTick();
  viewport.value?.scrollTo({ top: positions.value[idx].top, behavior: 'smooth' });
}
function scrollToTop() { viewport.value?.scrollTo({ top: 0 }); }

watch(() => props.items, () => { scrollTop.value = viewport.value?.scrollTop || 0; });

onMounted(() => {
  viewH.value = viewport.value?.clientHeight || 600;
  bindResizeObserver();
  window.addEventListener('resize', onScroll);
});
onBeforeUnmount(() => {
  ro?.disconnect();
  window.removeEventListener('resize', onScroll);
});

defineExpose({ scrollToId, scrollToTop });
</script>

<template>
  <div ref="viewport" class="vlist-viewport" @scroll.passive="onScroll">
    <div class="vlist-spacer" :style="{ height: totalH + 'px' }">
      <div
        v-for="{ item, top } in visible"
        :key="item.id"
        :ref="(el) => setItemRef(el, item.id)"
        class="vlist-item"
        :style="{ transform: `translateY(${top}px)` }"
      >
        <slot :item="item"></slot>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vlist-viewport { height: calc(100vh - 320px); min-height: 320px; overflow-y: auto; position: relative; }
.vlist-spacer { position: relative; }
.vlist-item { position: absolute; left: 0; right: 0; }
</style>