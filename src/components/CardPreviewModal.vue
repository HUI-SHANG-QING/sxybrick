<script setup>
// 卡片只读预览弹窗（round117）。
//
// 用途：知识图谱 / 思维导图点击节点时**就地查看这张卡写了什么**。
//   此前这两个入口一律 `router.push('/cards?id=…')` —— 那是卡片管理页（编辑态），
//   用户只想看一眼内容，却被带进了编辑器。这里改为弹出**只读预览**，
//   呈现方式与「卡片分组」页展开后的预览一致（正面 / 背面 Markdown 渲染 + 标签）。
//
// 设计取舍：纯只读，不放编辑/保存入口 —— 避免与卡片管理页的职责重叠，
//   也保证"看内容"这件事不会意外改到数据。
import { computed } from 'vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import { t } from '../i18n/index.js';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  card: { type: Object, default: null },
});
const emit = defineEmits(['update:modelValue']);

const close = () => emit('update:modelValue', false);
const tags = computed(() => (Array.isArray(props.card?.tags) ? props.card.tags : []));
const front = computed(() => String(props.card?.front || ''));
const back = computed(() => String(props.card?.back || ''));
</script>

<template>
  <div v-if="modelValue && card" class="modal-mask" @click.self="close">
    <div class="modal cp-modal">
      <div class="cp-head">
        <span class="cp-title">{{ t('components.cardPreview.title') }}</span>
        <span v-if="card.subject" class="cp-subject">{{ card.subject }}</span>
        <span style="flex:1"></span>
        <button class="btn small" @click="close">{{ t('components.cardPreview.close') }}</button>
      </div>
      <div class="cp-body">
        <div class="cp-label">{{ t('components.cardPreview.front') }}</div>
        <div class="cp-block"><MarkdownRenderer :content="front" /></div>
        <div class="cp-label">{{ t('components.cardPreview.back') }}</div>
        <div class="cp-block"><MarkdownRenderer :content="back" /></div>
        <div v-if="tags.length" class="cp-tags">
          <span v-for="tag in tags" :key="tag" class="cp-tag">#{{ tag }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cp-modal { max-width: 720px; }
.cp-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cp-title { font-weight: 600; }
.cp-subject { font-size: 12px; color: var(--ink-2); border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; }
.cp-body { max-height: 62vh; overflow: auto; margin-top: 8px; }
.cp-label { font-size: 12px; color: var(--ink-2); margin: 10px 0 4px; }
.cp-block { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: var(--panel); word-break: break-word; }
.cp-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.cp-tag { font-size: 12px; color: var(--accent); }
</style>
