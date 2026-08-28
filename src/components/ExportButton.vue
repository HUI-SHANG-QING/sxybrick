<template>
  <el-dropdown trigger="click" @command="onPick">
    <el-button :size="size" :type="type" plain>
      📥 {{ label }}<span v-if="count != null"> ({{ count }})</span>
    </el-button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item
          v-for="f in formats"
          :key="f.key"
          :disabled="f.disabled"
          :command="f.key"
        >
          <span class="fmt-label">{{ f.label }}</span>
          <span class="fmt-hint">{{ f.hint }}</span>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup>
import { ElMessage } from 'element-plus';
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
  /** Element Plus 按钮类型 */
  type: { type: String, default: 'primary' },
  /** Element Plus 按钮尺寸 */
  size: { type: String, default: 'small' },
  /** 数据条目数（用于按钮徽标） */
  count: { type: Number, default: null },
});

function blobOf(text, mime) {
  if (typeof Blob === 'undefined') {
    ElMessage.error('当前环境不支持下载');
    return null;
  }
  return new Blob([text], { type: `${mime};charset=utf-8` });
}

async function onPick(key) {
  const f = props.formats.find(x => x.key === key);
  if (!f) return;
  if (f.disabled) return;
  if (!props.data || (Array.isArray(props.data) && props.data.length === 0)) {
    ElMessage.warning('没有可导出的数据');
    return;
  }
  let text = '';
  try {
    text = await f.build(props.data);
  } catch (e) {
    ElMessage.error(`导出 ${f.label} 失败：${e?.message || e}`);
    return;
  }
  const blob = blobOf(text, f.mime || 'text/plain');
  if (!blob) return;
  const fn = f.filename || defaultFilename(props.filenamePrefix, f.ext || 'txt');
  triggerDownload(blob, fn);
  ElMessage.success(`已下载 ${fn}`);
}
</script>

<style scoped>
.fmt-label { font-weight: 600; }
.fmt-hint  { margin-left: 8px; color: #888; font-size: 12px; }
:deep(.el-dropdown-menu__item) { padding: 8px 14px; min-width: 180px; }
</style>
