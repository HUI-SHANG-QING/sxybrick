<script setup>
// 导航栏：5 种「游戏级」风格，各有独立的场景背景、菜单造型、交互与音效
// classic 经典顶栏 / card 炉石卡牌桌游 / moba 王者大厅 / space 星际HUD / adventure 冒险场景
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { playBlip } from '../utils/sound.js';

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

  <!-- 冒险场景：角色 + 符石菜单 -->
  <nav v-else-if="props.variant === 'adventure'" class="app-nav nav-adventure">
    <div class="adv-scene" :style="{ '--hue': advHue }">
      <div class="adv-moon"></div>
      <div class="adv-mountains"></div>
      <div class="adv-character" :class="{ act: acting }">🐒</div>
      <div class="adv-ground"></div>
      <div class="adv-menu">
        <button v-for="(item, i) in navItems" :key="item.path" class="adv-sigil" @click="tapAdventure(item, i)">
          <span>{{ item.icon }}</span><em>{{ item.label }}</em>
        </button>
      </div>
    </div>
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

/* 冒险场景 */
.nav-adventure { position: fixed; left: 0; right: 0; bottom: 0; z-index: 60; pointer-events: none; }
.adv-scene { position: fixed; left: 0; right: 0; bottom: 0; height: 320px; pointer-events: auto; overflow: hidden; }
.adv-moon { position: absolute; right: 12%; top: 12%; width: 64px; height: 64px; border-radius: 50%; background: radial-gradient(circle, #ffe9b0, #f5c87888); box-shadow: 0 0 40px #f5c87866; }
.adv-mountains { position: absolute; left: -5%; right: -5%; bottom: 18%; height: 55%; background: linear-gradient(165deg, hsl(var(--hue), 34%, 24%), hsl(var(--hue), 40%, 14%)); clip-path: polygon(0 100%, 0 45%, 18% 30%, 34% 50%, 52% 26%, 70% 46%, 88% 30%, 100% 48%, 100% 100%); transition: filter .5s; }
.adv-ground { position: absolute; left: 0; right: 0; bottom: 0; height: 18%; background: linear-gradient(hsl(var(--hue), 30%, 12%), hsl(var(--hue), 35%, 6%)); }
.adv-character { position: absolute; left: 50%; bottom: 16%; transform: translateX(-50%); font-size: 72px; filter: drop-shadow(0 6px 10px rgba(0,0,0,.5)); transition: transform .3s; }
.adv-character.act { animation: adv-jump .35s ease; }
@keyframes adv-jump { 0% { transform: translateX(-50%) translateY(0) scale(1); } 40% { transform: translateX(-50%) translateY(-46px) scale(1.1); } 100% { transform: translateX(-50%) translateY(0) scale(1); } }
.adv-menu { position: absolute; left: 0; right: 0; bottom: 8px; display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; padding: 0 12px; }
.adv-sigil { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 6px 10px; border-radius: 999px; border: 1px solid hsl(var(--hue), 50%, 60%); background: rgba(0,0,0,.35); color: #f5f0df; cursor: pointer; transition: .15s; }
.adv-sigil span { font-size: 18px; }
.adv-sigil em { font-style: normal; font-size: 11px; }
.adv-sigil:hover { background: hsl(var(--hue), 50%, 45%); box-shadow: 0 0 16px hsl(var(--hue), 60%, 55%); }
</style>
