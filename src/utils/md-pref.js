// src/utils/md-pref.js
// Markdown 渲染开关（全局偏好，跨视图共享，localStorage 持久化）。
//
// 背景（2026-09-13 用户反馈）：AI 问答/费曼/悬浮助手三个对话面此前把模型返回的
// Markdown 源码直接当纯文本塞进气泡（`{{ m.content }}`），标题写成 `## 标题`、
// 列表写成 `- 项`，完全没排版。修复方式 = 接入 MarkdownRenderer；
// 同时保留「看源码」能力（有人需要复制原始 Markdown），由本开关全局切换。
//
// 模块级单例 ref：任一视图切换 → 其余对话面即时同步（不需要各自维护副本）。
import { ref, watch } from 'vue';

const KEY = 'sxy_md_render';

function read() {
  try { return localStorage.getItem(KEY) !== '0'; } catch { return true; }
}

/** 是否开启 Markdown 渲染（默认开） */
export const mdRender = ref(read());

watch(mdRender, (v) => {
  try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* 隐私模式忽略 */ }
});

/** 切换开关（供按钮直接绑） */
export function toggleMdRender() {
  mdRender.value = !mdRender.value;
}
