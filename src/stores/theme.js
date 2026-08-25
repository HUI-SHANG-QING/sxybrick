import { defineStore } from 'pinia';

// 界面风格（游戏级，布局/交互/场景差异大）
export const STYLES = [
  { id: 'classic', name: '经典', desc: '顶部导航 · 简洁扁平', icon: '☰' },
  { id: 'card', name: '卡牌', desc: '炉石传说 · 卡牌桌游', icon: '🎴' },
  { id: 'moba', name: '王者', desc: '王者荣耀 · MOBA 大厅', icon: '⚔️' },
  { id: 'space', name: '星际', desc: '星际战争 · 太空 HUD', icon: '🛸' },
  { id: 'adventure', name: '冒险', desc: '黑神话 · 冒险场景', icon: '🐒' },
  // —— 2026-08-25 依据「教育类 UI 设计系统」方法论新增（原有 5 风格保持不变）——
  { id: 'focus', name: '专注', desc: '专业现代 · 深蓝聚焦 · WCAG AA', icon: '🎯' },
  { id: 'flat', name: '活力', desc: '高饱和平铺 · 多彩大按钮', icon: '🌈' },
  { id: 'paper', name: '纸墨', desc: '静学纸墨 · 朱印 · 反焦虑', icon: '📜' },
];

// 配色模式（全局通用，适用于每一种风格）
export const MODES = [
  { id: 'light', name: '白天' },
  { id: 'dark', name: '夜间' },
  { id: 'eye', name: '护眼' },
];

const VALID_STYLES = STYLES.map(s => s.id);
const VALID_MODES = MODES.map(m => m.id);

export const useThemeStore = defineStore('theme', {
  state: () => ({
    style: VALID_STYLES.includes(localStorage.getItem('sxy_style')) ? localStorage.getItem('sxy_style') : 'classic',
    mode: VALID_MODES.includes(localStorage.getItem('sxy_mode')) ? localStorage.getItem('sxy_mode') : 'light',
  }),
  getters: {
    styleLabel: (s) => STYLES.find(x => x.id === s.style)?.name || '经典',
    modeLabel: (s) => MODES.find(m => m.id === s.mode)?.name || '白天',
  },
  actions: {
    setStyle(v) { if (!VALID_STYLES.includes(v)) return; this.style = v; localStorage.setItem('sxy_style', v); this.apply(); },
    setMode(v) { if (!VALID_MODES.includes(v)) return; this.mode = v; localStorage.setItem('sxy_mode', v); this.apply(); },
    apply() {
      document.documentElement.setAttribute('data-style', this.style);
      document.documentElement.setAttribute('data-theme', this.mode);
    },
  },
});
