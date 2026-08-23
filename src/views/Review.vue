<script setup>
// 背诵页：到期队列 + 翻转卡 + 三档自评 + 下次复习时间 + 强度系数（本地）
import { ref, onMounted } from 'vue';
import FlipCard from '../components/FlipCard.vue';
import CardModal from '../components/CardModal.vue';
import { toast } from '../utils/toast.js';
import { reviewQueue, review } from '../repo.js';

const queue = ref([]);
const idx = ref(0);
const loading = ref(false);
const intensity = ref(1);
const editOpen = ref(false);
const editing = ref(null);
const doneCount = ref(0);

const current = () => queue.value[idx.value] || null;

async function loadQueue() {
  loading.value = true;
  try {
    queue.value = await reviewQueue(100);
    idx.value = 0;
  } catch (e) { toast(e.message, 'error'); }
  finally { loading.value = false; }
}

async function rate(card, rating) {
  try {
    const res = await review(card.id, rating, intensity.value);
    doneCount.value += 1;
    toast(`下次复习：${res.dueText}`, 'success');
    if (rating === 0) queue.value.push({ ...card, ...res });
    idx.value += 1;
  } catch (e) { toast(e.message, 'error'); }
}

function openEdit(card) { editing.value = card; editOpen.value = true; }
function onSaved() {
  // 编辑后刷新当前卡内容
  loadQueue();
}

onMounted(loadQueue);
</script>

<template>
  <div style="max-width:760px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">专注背诵</h2>
      <span class="hint">待背 {{ Math.max(0, queue.length - idx) }} 张 · 已完成 {{ doneCount }}</span>
      <span style="flex:1"></span>
      <label class="hint">复习强度</label>
      <select v-model.number="intensity" class="input" style="width:auto">
        <option :value="1">正常</option>
        <option :value="1.5">考试临近（更频繁）</option>
        <option :value="2">考前冲刺（最高频）</option>
      </select>
    </div>

    <div v-if="loading" class="hint" style="text-align:center;padding:60px">加载中…</div>

    <template v-else-if="current()">
      <FlipCard :card="current()" @rate="rate" @edit="openEdit" />
      <div class="hint" style="text-align:center;margin-top:12px">
        第 {{ idx + 1 }} / {{ queue.length }} 张 · 翻到背面后选择自评结果
      </div>
    </template>

    <div v-else class="empty">
      <h3>当前没有到期的卡片</h3>
      <p class="hint">所有卡片都已安排到未来复习，去「我的卡片」新建或编辑卡片吧。</p>
    </div>

    <CardModal v-model="editOpen" :card="editing" @saved="onSaved" />
  </div>
</template>

<style scoped>
.empty { text-align: center; padding: 80px 0; }
</style>