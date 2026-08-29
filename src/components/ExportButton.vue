<template>
  <el-dropdown trigger="click" @command="onPick">
    <el-button :type="btnType" :size="btnSize" class="eb-trigger">
      <span>📥 {{ label }}<span v-if="count != null"> ({{ count }})</span></span>
    </el-button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item
          v-for="f in formats"
          :key="f.key"
          :command="f.key"
          :disabled="f.disabled"
        >
          <div class="eb-item-inner">
            <span class="fmt-label">{{ f.label }}</span>
            <span v-if="f.hint" class="fmt-hint">{{ f.hint }}</span>
          </div>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup>
import { computed } from 'vue';
import { toast } from '../utils/toast.js';
import {
  triggerDownload,
  defaultFilename,
} from '../utils/exporters.js';

const props = defineProps({
  /** 当前导出数据（数组或边数组） */
  data: { type: [Array, Object], required: true },
  /** 选项数组 [{ key, label, hint?, mime, ext, build?, disabled? }] */
  formats: { type: Array, required: true },
  /** 文件名前缀（不含扩展名） */
  filenamePrefix: { type: String, default: 'export' },
  /** 顶部按钮文案 */
  label: { type: String, default: '导出' },
  /** 按钮类型（primary 高亮，default/text 朴素）——直接映射 el-button type */
  type: { type: String, default: 'primary' },
  /** 按钮尺寸（small 更紧凑）——直接映射 el-button size */
  size: { type: String, default: 'small' },
  /** 数据条目数（用于按钮徽标） */
  count: { type: Number, default: null },
});

// 兼容旧传参：default → EP 无此 type，映射为 default 语义的朴素按钮
const btnType = computed(() => {
  if (props.type === 'default' || props.type === 'text') return 'default';
  return 'primary';
});
const btnSize = computed(() => (props.size === 'small' ? 'small' : 'default'));

function blobOf(text, mime) {
  if (typeof Blob === 'undefined') {
    toast.error('当前环境不支持下载');
    return null;
  }
  return new Blob([text], { type: `${mime};charset=utf-8` });
}

async function onPick(key) {
  const f = props.formats.find(x => x.key === key);
  if (!f || f.disabled) return;
  if (!props.data || (Array.isArray(props.data) && props.data.length === 0)) {
    toast.warning('没有可导出的数据');
    return;
  }
  let text = '';
  try {
    text = await f.build(props.data);
  } catch (e) {
    toast.error(`导出 ${f.label} 失败：${e?.message || e}`);
    return;
  }
  const blob = blobOf(text, f.mime || 'text/plain');
  if (!blob) return;
  const fn = f.filename || defaultFilename(props.filenamePrefix, f.ext || 'txt');
  triggerDownload(blob, fn);
  toast.success(`已下载 ${fn}`);
}
</script>

<style scoped>
/* 触发器按钮与项目 .btn 观感对齐（圆角胶囊） */
.eb-trigger {
  border-radius: 999px;
  font-weight: 500;
}
.eb-item-inner {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-width: 150px;
}
.fmt-label { font-weight: 600; }
.fmt-hint { color: var(--ink-2); font-size: 12px; white-space: nowrap; }
</style>
