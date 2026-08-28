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
  // —— 2026-08-26 新增：琥珀主题（1:1 复刻 localhost:3000 + 专属暖光动效）——
  { id: 'amber', name: '琥珀', desc: '暖光琥珀 · 简洁扁平 · 流光按钮', icon: '🔥' },
  // —— 2026-08-28 新增：progress 主题（1:1 复刻 Progress AI 全套：暖琥珀配色 + 3D 倾斜 + gradient-text + dot-grid + ambient-layer）——
  { id: 'progress', name: 'Progress', desc: '暖琥珀 3D · 鼠标跟踪 · Inter 字体 · 流光按钮', icon: '✨' },
  // —— 2026-08-26 新增：国风主题（真水墨山水画交互 · 致敬宋元名家）——
  { id: 'guofeng', name: '国风', desc: '水墨山水 · 飞鸟涟漪 · 朱印题款', icon: '🏔️' },
];

// 配色模式（全局通用，适用于每一种风格）
export const MODES = [
  { id: 'light', name: '白天' },
  { id: 'dark', name: '夜间' },
  { id: 'eye', name: '护眼' },
];

const VALID_STYLES = [...STYLES.map(s => s.id), 'custom']; // custom = 个人主题生成器（色相自定义）
const VALID_MODES = MODES.map(m => m.id);

export const useThemeStore = defineStore('theme', {
  state: () => ({
    style: VALID_STYLES.includes(localStorage.getItem('sxy_style')) ? localStorage.getItem('sxy_style') : 'classic',
    mode: VALID_MODES.includes(localStorage.getItem('sxy_mode')) ? localStorage.getItem('sxy_mode') : 'light',
    customHue: Number(localStorage.getItem('sxy_custom_hue')) || 220,
  }),
  getters: {
    styleLabel: (s) => STYLES.find(x => x.id === s.style)?.name || (s.style === 'custom' ? '自定义' : '经典'),
    modeLabel: (s) => MODES.find(m => m.id === s.mode)?.name || '白天',
  },
  actions: {
    setStyle(v) { if (!VALID_STYLES.includes(v)) return; this.style = v; localStorage.setItem('sxy_style', v); this.apply(); },
    setMode(v) { if (!VALID_MODES.includes(v)) return; this.mode = v; localStorage.setItem('sxy_mode', v); this.apply(); },
    setCustomHue(h) {
      this.customHue = Math.max(0, Math.min(360, Math.round(Number(h) || 220)));
      localStorage.setItem('sxy_custom_hue', String(this.customHue));
      this.apply();
    },
    apply() {
      const root = document.documentElement;
      // 速赢区：主题切换过渡动画 —— 仅在"切换"时启用 0.32s 颜色淡入（初次加载跳过，避免 FOUC 闪烁）
      const isSwitch = root.hasAttribute('data-style');
      if (isSwitch) root.classList.add('theme-switching');
      root.setAttribute('data-style', this.style);
      root.setAttribute('data-theme', this.mode);
      // 个人主题：由色相生成强调色族（随配色模式微调亮度/饱和度），写入 CSS 变量供 [data-style='custom'] 消费
      if (this.style === 'custom') {
        const h = this.customHue;
        const dark = this.mode === 'dark';
        const eye = this.mode === 'eye';
        root.style.setProperty('--cust-accent', dark ? `hsl(${h} 78% 62%)` : eye ? `hsl(${h} 42% 38%)` : `hsl(${h} 72% 45%)`);
        root.style.setProperty('--cust-soft', dark ? `hsl(${h} 55% 20%)` : eye ? `hsl(${h} 40% 90%)` : `hsl(${h} 80% 95%)`);
        root.style.setProperty('--cust-tag-bg', dark ? `hsl(${h} 50% 24%)` : eye ? `hsl(${h} 38% 88%)` : `hsl(${h} 85% 93%)`);
      } else {
        root.style.removeProperty('--cust-accent');
        root.style.removeProperty('--cust-soft');
        root.style.removeProperty('--cust-tag-bg');
      }
      if (isSwitch) {
        clearTimeout(this._switchTimer);
        this._switchTimer = setTimeout(() => root.classList.remove('theme-switching'), 340);
      }
    },
  },
});
