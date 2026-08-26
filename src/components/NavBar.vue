<script setup>
// 导航栏：5 种「游戏级」风格，各有独立的场景背景、菜单造型、交互与音效
// classic 经典顶栏 / card 炉石卡牌桌游 / moba 王者大厅 / space 星际HUD / adventure 冒险场景
import { ref, computed, onMounted, onBeforeUnmount, defineAsyncComponent } from 'vue';
import { useRouter } from 'vue-router';
import { playBlip } from '../utils/sound.js';
// 3D 角色组件异步加载：three.js（约 600KB）只在 adventure 主题激活时才拉取
// 默认主题/其他主题的首屏 chunk 不再携带 three.js
const ThreeDCharacter = defineAsyncComponent({
  loader: () => import('./ThreeDCharacter.vue'),
  loadingComponent: { template: '<div class="tdc-loading">⏳</div>' },
  delay: 0,
});

const props = defineProps({
  variant: { type: String, default: 'classic' },
  navItems: { type: Array, default: () => [] },
});
const router = useRouter();
const go = (p) => router.push(p);

const isMobile = ref(false);
let mq = null;
function onMq() { isMobile.value = mq?.matches ?? false; }
onMounted(() => { mq = window.matchMedia('(max-width: 720px)'); onMq(); mq.addEventListener('change', onMq); });
onBeforeUnmount(() => mq?.removeEventListener('change', onMq));

// 各风格交互音效
function tapCard(item) { playBlip(320, 0.06, 'triangle', 0.3); setTimeout(() => playBlip(480, 0.06, 'triangle', 0.25), 50); go(item.path); }
function tapMoba(item) { playBlip(660, 0.08, 'sine', 0.22); setTimeout(() => playBlip(880, 0.1, 'sine', 0.2), 70); go(item.path); }
function tapSpace(item) { playBlip(1400, 0.05, 'sawtooth', 0.12); setTimeout(() => playBlip(900, 0.05, 'sawtooth', 0.1), 40); go(item.path); }

// 冒险：点击菜单 → 角色动作 + 场景色调切换
const advHue = ref(200);
const acting = ref(false);
function tapAdventure(item, i) {
  acting.value = true;
  advHue.value = (i * 37 + 20) % 360;
  playBlip(120, 0.1, 'square', 0.3);
  setTimeout(() => playBlip(200, 0.12, 'square', 0.25), 80);
  setTimeout(() => { acting.value = false; go(item.path); }, 350);
}
// 3D 角色被点击：附加音效反馈（角色自身已联动跳跃）
function onCharAction() {
  playBlip(180, 0.08, 'triangle', 0.25);
  setTimeout(() => playBlip(300, 0.1, 'triangle', 0.22), 60);
}

// 新增三风格（2026-08-25）：专注/活力/纸墨 —— 轻量音效反馈
function tapFocus(item) { playBlip(520, 0.04, 'sine', 0.18); }
function tapFlat(item) { playBlip(760, 0.06, 'triangle', 0.2); setTimeout(() => playBlip(1020, 0.06, 'triangle', 0.16), 60); go(item.path); }
function tapPaper(item) { playBlip(180, 0.08, 'sine', 0.14); }
// 国风（2026-08-26）：古琴泛音 —— 点击菜单如拨弦
function tapGuofeng(item) { playBlip(330, 0.18, 'sine', 0.16); setTimeout(() => playBlip(495, 0.22, 'sine', 0.12), 90); go(item.path); }
</script>

<template>
  <!-- 移动端：统一底部 Tab -->
  <nav v-if="isMobile" class="app-nav nav-mobile">
    <router-link v-for="item in navItems.slice(0, 7)" :key="item.path" :to="item.path"><span class="mi">{{ item.icon }}</span>{{ item.label }}</router-link>
  </nav>

  <!-- 经典 -->
  <nav v-else-if="props.variant === 'classic'" class="app-nav nav-classic">
    <span class="brand">SxyBrick</span>
    <router-link v-for="item in navItems" :key="item.path" :to="item.path">{{ item.label }}</router-link>
  </nav>

  <!-- 炉石卡牌：底部卡牌手牌 -->
  <nav v-else-if="props.variant === 'card'" class="app-nav nav-card">
    <div class="card-table">
      <div class="card-deck">🎴</div>
      <div class="card-hand">
        <button v-for="item in navItems" :key="item.path" class="hs-card" @click="tapCard(item)">
          <span class="hs-cost">✦</span>
          <span class="hs-icon">{{ item.icon }}</span>
          <span class="hs-name">{{ item.label }}</span>
        </button>
      </div>
    </div>
  </nav>

  <!-- 王者大厅：左侧英雄选择 -->
  <nav v-else-if="props.variant === 'moba'" class="app-nav nav-moba">
    <div class="moba-lobby">
      <div class="moba-title">⚔ 选择你的英雄</div>
      <div class="moba-heroes">
        <button v-for="item in navItems" :key="item.path" class="moba-hero" @click="tapMoba(item)">
          <span class="mh-avatar">{{ item.icon }}</span>
          <span class="mh-name">{{ item.label }}</span>
        </button>
      </div>
    </div>
  </nav>

  <!-- 星际HUD：雷达 + 指令面板 -->
  <nav v-else-if="props.variant === 'space'" class="app-nav nav-space">
    <div class="space-hud">
      <div class="space-radar"><i></i></div>
      <div class="space-items">
        <button v-for="item in navItems" :key="item.path" class="space-btn" @click="tapSpace(item)">
          <span class="sp-icon">{{ item.icon }}</span><em>{{ item.label }}</em>
        </button>
      </div>
      <div class="space-frame"></div>
    </div>
  </nav>

  <!-- 冒险场景：3D 角色 + 符石菜单（旗舰主题 · 黑神话风） -->
  <nav v-else-if="props.variant === 'adventure'" class="app-nav nav-adventure">
    <div class="adv-scene" :style="{ '--hue': advHue }">
      <div class="adv-moon"></div>
      <div class="adv-mountains"></div>
      <div class="adv-fog"></div>
      <div class="adv-embers">
        <i v-for="n in 8" :key="n" :style="{ '--n': n }"></i>
      </div>
      <div class="adv-character-3d">
        <ThreeDCharacter :hue="advHue" :acting="acting" @action="onCharAction" />
      </div>
      <div class="adv-ground"></div>
      <div class="adv-menu">
        <button v-for="(item, i) in navItems" :key="item.path" class="adv-sigil" @click="tapAdventure(item, i)">
          <span>{{ item.icon }}</span><em>{{ item.label }}</em>
        </button>
      </div>
    </div>
  </nav>

  <!-- 专注：专业现代顶栏（新主题 · 教育设计系统） -->
  <nav v-else-if="props.variant === 'focus'" class="app-nav nav-focus">
    <span class="brand">🎯 SxyBrick</span>
    <router-link v-for="item in navItems" :key="item.path" :to="item.path" @click="tapFocus(item)">{{ item.label }}</router-link>
  </nav>

  <!-- 活力：高饱和度胶囊 Dock（新主题 · 平铺多彩） -->
  <nav v-else-if="props.variant === 'flat'" class="app-nav nav-flat">
    <div class="flat-dock">
      <button v-for="(item, i) in navItems" :key="item.path" class="flat-pill" :style="{ '--i': i }" @click="tapFlat(item)">
        <span class="fp-dot">{{ item.icon }}</span><span class="fp-name">{{ item.label }}</span>
      </button>
    </div>
  </nav>

  <!-- 纸墨：静学顶栏 + 朱印（新主题 · 反焦虑纸墨风） -->
  <nav v-else-if="props.variant === 'paper'" class="app-nav nav-paper">
    <span class="paper-seal">SxyBrick</span>
    <router-link v-for="item in navItems" :key="item.path" :to="item.path" @click="tapPaper(item)"><em>{{ item.label }}</em></router-link>
    <span class="paper-quote">日拱一卒</span>
  </nav>

  <!-- 兜底：未知/旧风格值回退到经典顶栏 -->
  <nav v-else-if="props.variant === 'guofeng'" class="app-nav nav-guofeng">
    <span class="gf-brand">山水</span>
    <router-link v-for="item in navItems" :key="item.path" :to="item.path" @click="tapGuofeng(item)"><em>{{ item.label }}</em></router-link>
    <span class="gf-quote">澄怀观道</span>
  </nav>

  <!-- 兜底：未知/旧风格值回退到经典顶栏 -->
  <nav v-else class="app-nav nav-classic">
    <span class="brand">SxyBrick</span>
    <router-link v-for="item in navItems" :key="item.path" :to="item.path">{{ item.label }}</router-link>
  </nav>
</template>

<style scoped>
.mi { display: inline-block; margin-right: 4px; }

/* 移动端底部 Tab */
.nav-mobile { display: flex; position: fixed; left: 0; right: 0; bottom: 0; height: 56px; background: var(--panel); border-top: 1px solid var(--line); z-index: 60; overflow-x: auto; }
.nav-mobile a { flex: none; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; font-size: 11px; padding: 4px 10px; color: var(--ink-2); text-decoration: none; }
.nav-mobile .mi { font-size: 18px; margin: 0; }

/* 经典 */
.nav-classic { display: flex; align-items: center; gap: 6px; padding: 0 24px; height: 56px; position: sticky; top: 0; z-index: 60; background: var(--panel); border-bottom: 1px solid var(--line); }
.nav-classic .brand { font-weight: 700; font-size: 17px; margin-right: 14px; }
.nav-classic a { color: var(--ink-2); text-decoration: none; padding: 6px 12px; border-radius: 8px; }
.nav-classic a.router-link-active { color: var(--ink); background: var(--code-inline); font-weight: 600; }

/* 炉石卡牌桌游 */
.nav-card { position: fixed; left: 0; right: 0; bottom: 0; z-index: 60; display: flex; justify-content: center; padding: 14px 20px 18px; pointer-events: none; }
.card-table { position: relative; display: flex; align-items: flex-end; gap: 14px; pointer-events: auto; }
.card-deck { position: absolute; right: -70px; bottom: 4px; font-size: 44px; filter: drop-shadow(0 4px 8px rgba(0,0,0,.5)); }
.card-hand { display: flex; gap: -8px; flex-wrap: wrap; justify-content: center; }
.hs-card { position: relative; width: 96px; height: 132px; border-radius: 10px; border: 3px solid #c8a44e; background: linear-gradient(160deg, #4a3620, #2b1f12); color: #f3e5c0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; cursor: pointer; box-shadow: 0 8px 18px rgba(0,0,0,.5); transition: transform .18s, box-shadow .18s; }
.hs-card::after { content: ''; position: absolute; inset: 4px; border: 1px solid #c8a44e55; border-radius: 6px; }
.hs-cost { position: absolute; top: 6px; left: 8px; font-size: 13px; color: #ffd66b; }
.hs-icon { font-size: 34px; }
.hs-name { font-size: 12px; }
.hs-card:hover { transform: translateY(-14px) rotate(-3deg) scale(1.04); box-shadow: 0 18px 28px rgba(0,0,0,.6), 0 0 20px #c8a44e66; }

/* 王者大厅 */
.nav-moba { position: fixed; left: 0; top: 0; bottom: 0; width: 240px; z-index: 60; display: flex; flex-direction: column; justify-content: center; padding: 24px 16px; pointer-events: none; }
.moba-lobby { pointer-events: auto; background: rgba(10, 14, 34, .78); border: 1px solid #d4af3755; border-radius: 14px; padding: 16px; }
.moba-title { color: #f0d27a; font-weight: 700; letter-spacing: 2px; margin-bottom: 12px; font-size: 15px; }
.moba-heroes { display: flex; flex-direction: column; gap: 8px; max-height: 70vh; overflow-y: auto; }
.moba-hero { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px; border: 1px solid #d4af3733; background: rgba(20, 26, 56, .6); color: #e8e2d0; cursor: pointer; transition: .15s; }
.mh-avatar { width: 40px; height: 40px; border-radius: 50%; background: #d4af3711; display: flex; align-items: center; justify-content: center; font-size: 22px; }
.mh-name { font-size: 13px; }
.moba-hero:hover { border-color: #d4af37; background: rgba(212, 175, 55, .12); transform: translateX(4px); }

/* 星际 HUD */
.nav-space { position: fixed; left: 0; right: 0; bottom: 0; z-index: 60; display: flex; justify-content: center; padding: 16px; pointer-events: none; }
.space-hud { position: relative; pointer-events: auto; display: flex; align-items: center; gap: 18px; padding: 12px 18px; }
.space-frame { position: absolute; inset: 0; border: 1px solid #00e5ff44; clip-path: polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px)); }
.space-radar { position: relative; width: 72px; height: 72px; border-radius: 50%; border: 1px solid #00e5ff66; overflow: hidden; background: radial-gradient(circle, #00e5ff11, transparent 70%); }
.space-radar i { position: absolute; left: 50%; top: 50%; width: 50%; height: 50%; transform-origin: 0 0; background: linear-gradient(90deg, #00e5ff66, transparent); animation: sweep 3s linear infinite; }
@keyframes sweep { to { transform: rotate(360deg); } }
.space-items { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.space-btn { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 8px 12px; border: 1px solid #00e5ff55; background: #041220cc; color: #bff4ff; border-radius: 8px; cursor: pointer; transition: .15s; }
.sp-icon { font-size: 20px; }
.space-btn em { font-style: normal; font-size: 11px; }
.space-btn:hover { border-color: #00e5ff; box-shadow: 0 0 14px #00e5ff66; }

/* 冒险场景（旗舰 · 真 3D 角色） */
.nav-adventure { position: fixed; left: 0; right: 0; bottom: 0; z-index: 60; pointer-events: none; }
.adv-scene { position: fixed; left: 0; right: 0; bottom: 0; height: 380px; pointer-events: auto; overflow: hidden; }
.adv-moon { position: absolute; right: 12%; top: 10%; width: 78px; height: 78px; border-radius: 50%; background: radial-gradient(circle, #ffe9b0, #f5c87888); box-shadow: 0 0 50px #f5c87877, 0 0 100px #f5c87844; }
.adv-mountains { position: absolute; left: -5%; right: -5%; bottom: 18%; height: 60%; background: linear-gradient(165deg, hsl(var(--hue), 34%, 24%), hsl(var(--hue), 40%, 14%)); clip-path: polygon(0 100%, 0 45%, 18% 30%, 34% 50%, 52% 26%, 70% 46%, 88% 30%, 100% 48%, 100% 100%); transition: filter .5s; }
.adv-fog { position: absolute; left: 0; right: 0; bottom: 14%; height: 30%; background: linear-gradient(0deg, hsl(var(--hue), 25%, 8%) 0%, transparent 100%); pointer-events: none; }
.adv-embers { position: absolute; left: 0; right: 0; bottom: 0; top: 0; pointer-events: none; }
.adv-embers i { position: absolute; bottom: 5%; left: calc(var(--n) * 12%); width: 3px; height: 3px; border-radius: 50%; background: #ff9944; box-shadow: 0 0 6px #ff7733; opacity: .7; animation: ember-float calc(5s + var(--n) * 0.6s) ease-in infinite; }
@keyframes ember-float {
  0% { transform: translateY(0) scale(1); opacity: 0; }
  20% { opacity: .8; }
  100% { transform: translateY(-260px) translateX(20px) scale(.3); opacity: 0; }
}
.adv-ground { position: absolute; left: 0; right: 0; bottom: 0; height: 18%; background: linear-gradient(hsl(var(--hue), 30%, 12%), hsl(var(--hue), 35%, 6%)); }
.adv-character-3d { position: absolute; left: 50%; bottom: 14%; transform: translateX(-50%); width: 260px; height: 300px; z-index: 2; }
.adv-character-3d :deep(.tdc-canvas) { width: 100%; height: 100%; }
.adv-menu { position: absolute; left: 0; right: 0; bottom: 8px; display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; padding: 0 12px; z-index: 3; }
.adv-sigil { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 6px 10px; border-radius: 999px; border: 1px solid hsl(var(--hue), 50%, 60%); background: rgba(0,0,0,.35); color: #f5f0df; cursor: pointer; transition: .15s; backdrop-filter: blur(4px); }
.adv-sigil span { font-size: 18px; }
.adv-sigil em { font-style: normal; font-size: 11px; }
.adv-sigil:hover { background: hsl(var(--hue), 50%, 45%); box-shadow: 0 0 16px hsl(var(--hue), 60%, 55%); transform: translateY(-2px); }
@media (max-width: 720px) { .adv-scene { height: 280px; } .adv-character-3d { width: 200px; height: 220px; } }

/* ===== 新增三风格导航（2026-08-25，不影响原 5 风格）===== */
/* 专注：专业现代顶栏 */
.nav-focus { display: flex; align-items: center; gap: 2px; padding: 0 20px; height: 58px; position: sticky; top: 0; z-index: 60; background: var(--panel); border-bottom: 1px solid var(--line); box-shadow: 0 1px 2px rgba(16, 24, 40, .04); }
.nav-focus .brand { font-weight: 700; font-size: 16px; margin-right: 16px; letter-spacing: .3px; }
.nav-focus a { color: var(--ink-2); text-decoration: none; padding: 7px 12px; border-radius: 8px; font-size: 14px; }
.nav-focus a:hover { color: var(--ink); background: var(--code-inline); }
.nav-focus a.router-link-active { color: #fff; background: var(--accent); font-weight: 600; }

/* 活力：高饱和胶囊 Dock */
.nav-flat { position: sticky; top: 14px; z-index: 60; display: flex; justify-content: center; padding: 0 16px; pointer-events: none; }
.flat-dock { pointer-events: auto; display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; padding: 10px 12px; border-radius: 999px; background: var(--panel); border: 1px solid var(--line); box-shadow: 0 4px 14px rgba(0,0,0,.08); max-width: 100%; }
.flat-pill { display: flex; align-items: center; gap: 7px; padding: 8px 14px; border-radius: 999px; border: none; background: var(--code-inline); color: var(--ink); cursor: pointer; transition: transform .15s; }
.fp-dot { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: hsl(calc(var(--i) * 38deg) 82% 56%); color: #fff; font-size: 15px; box-shadow: 0 2px 4px rgba(0,0,0,.15); }
.fp-name { font-size: 13px; font-weight: 600; }
.flat-pill:hover { transform: translateY(-3px) scale(1.04); background: #fff3cd55; }

/* 纸墨：静学顶栏 + 朱印 */
.nav-paper { display: flex; align-items: center; gap: 18px; padding: 0 24px; height: 60px; position: sticky; top: 0; z-index: 60; background: var(--panel); border-bottom: 1px solid var(--line); }
.paper-seal { font-family: 'KaiTi', 'STKaiti', '楷体', serif; font-size: 20px; font-weight: 700; color: #fff; background: var(--accent); padding: 4px 12px 6px; border-radius: 5px; box-shadow: 0 2px 6px rgba(139, 33, 33, .35); letter-spacing: 2px; }
.nav-paper a { color: var(--ink-2); text-decoration: none; font-size: 14px; padding: 6px 4px; border-bottom: 2px solid transparent; }
.nav-paper a em { font-style: normal; }
.nav-paper a:hover { color: var(--ink); }
.nav-paper a.router-link-active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.paper-quote { margin-left: auto; font-family: 'KaiTi', 'STKaiti', '楷体', serif; color: var(--ink-2); font-size: 13px; letter-spacing: 3px; }
@media (max-width: 900px) { .paper-quote { display: none; } .nav-paper { gap: 12px; } }

/* 国风：透明顶栏 + 印章品牌 + 毛笔字导航（2026-08-26，叠加在山水画背景上） */
.nav-guofeng { display: flex; align-items: center; gap: 16px; padding: 0 28px; height: 64px; position: sticky; top: 0; z-index: 60; background: rgba(240, 235, 224, 0.55); backdrop-filter: blur(8px); border-bottom: 1px solid rgba(30, 30, 30, 0.12); }
.gf-brand { font-family: 'KaiTi', 'STKaiti', '楷体', 'STSong', '宋体', serif; font-size: 22px; font-weight: 700; color: #fff; background: rgba(168, 49, 42, 0.9); padding: 5px 14px 7px; border-radius: 4px; letter-spacing: 4px; box-shadow: 0 2px 8px rgba(168, 49, 42, 0.3); }
.nav-guofeng a { color: rgba(20, 24, 28, 0.7); text-decoration: none; font-size: 15px; padding: 6px 8px; border-bottom: 2px solid transparent; }
.nav-guofeng a em { font-style: normal; font-family: 'KaiTi', 'STKaiti', '楷体', serif; }
.nav-guofeng a:hover { color: var(--ink); }
.nav-guofeng a.router-link-active { color: rgba(168, 49, 42, 0.95); border-bottom-color: rgba(168, 49, 42, 0.8); font-weight: 600; }
.gf-quote { margin-left: auto; font-family: 'KaiTi', 'STKaiti', '楷体', serif; color: rgba(20, 24, 28, 0.5); font-size: 14px; letter-spacing: 6px; }
@media (max-width: 900px) { .gf-quote { display: none; } .nav-guofeng { gap: 10px; } }

</style>
