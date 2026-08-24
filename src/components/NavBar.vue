<script setup>
// 导航栏组件：根据「风格」渲染完全不同的导航布局与交互
// classic 顶部栏 / compass 罗盘环形 / revolver 左轮手枪 / cartoon 卡通角色 / puzzle 解密线索 / scifi 左侧轨道
// 移动端（<=720px）统一回退到底部 Tab，保证多端可用。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { playCartoon, playRevolver, playMystery } from '../utils/sound.js';

const props = defineProps({
  variant: { type: String, default: 'classic' },
  navItems: { type: Array, default: () => [] },
});
const router = useRouter();
const go = (p) => router.push(p);

const PRIMARY = ['/', '/review', '/stats', '/ai', '/agent', '/sync'];
const primary = computed(() => props.navItems.filter(i => PRIMARY.includes(i.path)));
const secondary = computed(() => props.navItems.filter(i => !PRIMARY.includes(i.path)));

// 移动端响应式
const isMobile = ref(false);
let mq = null;
function onMq() { isMobile.value = mq?.matches ?? false; }
onMounted(() => { mq = window.matchMedia('(max-width: 720px)'); onMq(); mq.addEventListener('change', onMq); });
onBeforeUnmount(() => mq?.removeEventListener('change', onMq));

// 环形定位（罗盘/左轮）
function ring(i, n, r) {
  const a = (i / n) * 2 * Math.PI - Math.PI / 2;
  return { '--x': `${(Math.cos(a) * r).toFixed(1)}px`, '--y': `${(Math.sin(a) * r).toFixed(1)}px` };
}

// 左轮手枪
const spin = ref(0);
const shooting = ref(false);
const showMore = ref(false);
function shoot() {
  if (shooting.value) return;
  shooting.value = true;
  playRevolver();
  spin.value += 720;
  setTimeout(() => {
    shooting.value = false;
    const t = primary.value[Math.floor(Math.random() * primary.value.length)];
    if (t) go(t.path);
  }, 700);
}
function hitChamber(item) { playRevolver(); go(item.path); }

// 卡通
function tapCartoon(item, i) { playCartoon(i); go(item.path); }

// 解密
function tapPuzzle(item) { playMystery(); go(item.path); }
</script>

<template>
  <!-- 移动端：统一底部 Tab -->
  <nav v-if="isMobile" class="app-nav nav-mobile">
    <router-link v-for="item in navItems.slice(0, 7)" :key="item.path" :to="item.path"><span class="mi">{{ item.icon }}</span>{{ item.label }}</router-link>
  </nav>

  <!-- 经典：顶部横栏 -->
  <nav v-else-if="props.variant === 'classic'" class="app-nav nav-classic">
    <span class="brand">SxyBrick</span>
    <router-link v-for="item in navItems" :key="item.path" :to="item.path">{{ item.label }}</router-link>
  </nav>

  <!-- 罗盘：环形径向 -->
  <nav v-else-if="props.variant === 'compass'" class="app-nav nav-compass">
    <span class="brand">SxyBrick</span>
    <router-link v-for="(item, i) in navItems" :key="item.path" :to="item.path" :style="ring(i, navItems.length, 158)"><span class="mi">{{ item.icon }}</span>{{ item.label }}</router-link>
  </nav>

  <!-- 左轮手枪：转轮 6 孔位 + 扳机 -->
  <nav v-else-if="props.variant === 'revolver'" class="app-nav nav-revolver">
    <div class="rv-stage">
      <div class="rv-cylinder" :style="{ transform: `rotate(${spin}deg)` }">
        <button v-for="(item, i) in primary" :key="item.path" class="rv-chamber" :style="ring(i, 6, 118)" @click="hitChamber(item)">
          <span class="mi">{{ item.icon }}</span><em>{{ item.label }}</em>
        </button>
        <div class="rv-axle"></div>
      </div>
      <div class="rv-controls">
        <button class="rv-trigger" :disabled="shooting" @click="shoot">{{ shooting ? '转轮中…' : '🔫 开一枪' }}</button>
        <button class="rv-more" @click="showMore = !showMore">更多</button>
      </div>
      <div v-if="showMore" class="rv-more-menu">
        <router-link v-for="item in secondary" :key="item.path" :to="item.path">{{ item.label }}</router-link>
      </div>
    </div>
  </nav>

  <!-- 卡通萌系：角色头像 + 点击弹跳 + 音效 -->
  <nav v-else-if="props.variant === 'cartoon'" class="app-nav nav-cartoon">
    <span class="brand">SxyBrick</span>
    <button v-for="(item, i) in navItems" :key="item.path" class="ct-char" @click="tapCartoon(item, i)">
      <span class="ct-avatar">{{ item.icon }}</span>
      <span class="ct-name">{{ item.label }}</span>
    </button>
  </nav>

  <!-- 解密游戏：线索卡菜单 -->
  <nav v-else-if="props.variant === 'puzzle'" class="app-nav nav-puzzle">
    <span class="brand">SxyBrick · 解密档案</span>
    <div class="pz-grid">
      <button v-for="item in navItems" :key="item.path" class="pz-card" @click="tapPuzzle(item)">
        <span class="pz-num">{{ String(navItems.indexOf(item) + 1).padStart(2, '0') }}</span>
        <span class="pz-label">{{ item.label }}</span>
        <span class="pz-mark">?</span>
      </button>
    </div>
  </nav>

  <!-- 科幻：左侧垂直轨道 -->
  <nav v-else-if="props.variant === 'scifi'" class="app-nav nav-scifi">
    <span class="brand">Sxy</span>
    <router-link v-for="item in navItems" :key="item.path" :to="item.path"><span class="mi">{{ item.icon }}</span>{{ item.label }}</router-link>
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
.nav-classic .brand { font-weight: 700; font-size: 17px; margin-right: 14px; white-space: nowrap; }
.nav-classic a { color: var(--ink-2); text-decoration: none; padding: 6px 12px; border-radius: 8px; white-space: nowrap; }
.nav-classic a.router-link-active { color: var(--ink); background: var(--code-inline); font-weight: 600; }

/* 罗盘 */
.nav-compass { position: relative; justify-content: center; height: 400px; display: flex; background: transparent; }
.nav-compass::before { content: ''; position: absolute; left: 50%; top: 50%; width: 316px; height: 316px; transform: translate(-50%, -50%); border-radius: 50%; border: 1px dashed var(--line); }
.nav-compass .brand { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 74px; height: 74px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: var(--accent); color: #fff; font-weight: 700; z-index: 2; }
.nav-compass a { position: absolute; left: 50%; top: 50%; transform: translate(calc(-50% + var(--x)), calc(-50% + var(--y))); color: var(--ink-2); text-decoration: none; border-radius: 999px; padding: 5px 12px; }
.nav-compass a.router-link-active { background: var(--accent); color: #fff; font-weight: 600; }

/* 左轮手枪 */
.nav-revolver { position: relative; display: flex; justify-content: center; padding: 20px 0 16px; background: transparent; }
.rv-stage { text-align: center; }
.rv-cylinder { position: relative; width: 300px; height: 300px; margin: 0 auto; transition: transform .7s cubic-bezier(.3, 1.2, .4, 1); }
.rv-cylinder::before { content: ''; position: absolute; inset: 18px; border-radius: 50%; border: 6px solid #4b5563; background: radial-gradient(circle at 50% 50%, #1f2937, #111827); box-shadow: inset 0 0 20px rgba(0,0,0,.6), 0 6px 20px rgba(0,0,0,.3); }
.rv-axle { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 40px; height: 40px; border-radius: 50%; background: #9ca3af; box-shadow: inset 0 0 6px #374151; z-index: 2; }
.rv-chamber { position: absolute; left: 50%; top: 50%; transform: translate(calc(-50% + var(--x)), calc(-50% + var(--y))); width: 58px; height: 58px; border-radius: 50%; background: #e5e7eb; border: 3px solid #6b7280; display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: pointer; z-index: 3; transition: transform .2s, box-shadow .2s; }
.rv-chamber .mi { font-size: 18px; margin: 0; }
.rv-chamber em { font-style: normal; font-size: 10px; color: #374151; }
.rv-chamber:hover { box-shadow: 0 0 0 3px var(--accent); }
.rv-controls { display: flex; gap: 10px; justify-content: center; margin-top: 14px; }
.rv-trigger { background: var(--accent); color: #fff; border: none; border-radius: 12px; padding: 10px 22px; font-size: 15px; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
.rv-trigger:disabled { opacity: .6; cursor: wait; }
.rv-more { background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 12px; padding: 10px 18px; cursor: pointer; }
.rv-more-menu { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; max-width: 520px; margin: 12px auto 0; }
.rv-more-menu a { color: var(--ink-2); text-decoration: none; padding: 5px 12px; border: 1px solid var(--line); border-radius: 999px; font-size: 13px; }

/* 卡通萌系 */
.nav-cartoon { display: flex; align-items: center; gap: 4px; padding: 8px 16px; flex-wrap: wrap; position: sticky; top: 0; z-index: 60; background: var(--panel); border-bottom: 1px solid var(--line); }
.nav-cartoon .brand { font-weight: 700; margin-right: 8px; }
.ct-char { display: flex; flex-direction: column; align-items: center; gap: 2px; background: none; border: none; cursor: pointer; padding: 4px 8px; border-radius: 12px; }
.ct-avatar { font-size: 26px; width: 44px; height: 44px; line-height: 44px; border-radius: 50%; background: var(--code-inline); transition: transform .18s; }
.ct-name { font-size: 11px; color: var(--ink-2); }
.ct-char:active .ct-avatar { transform: scale(1.35) rotate(-8deg); }
.ct-char.router-link-active .ct-avatar, .ct-char:hover .ct-avatar { background: var(--accent); }
.ct-char:hover .ct-name { color: var(--ink); }

/* 解密游戏 */
.nav-puzzle { display: block; position: sticky; top: 0; z-index: 60; background: var(--panel); border-bottom: 1px solid var(--line); padding: 10px 16px; }
.nav-puzzle .brand { font-weight: 700; letter-spacing: 2px; }
.pz-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.pz-card { position: relative; display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px dashed var(--line); background: var(--code-bg); border-radius: 8px; cursor: pointer; font: inherit; color: var(--ink); }
.pz-num { font-family: monospace; font-size: 12px; color: var(--accent); }
.pz-mark { margin-left: auto; color: var(--ink-2); font-weight: 700; }
.pz-card:hover { border-style: solid; border-color: var(--accent); }
.pz-card:hover .pz-mark { color: var(--accent); }

/* 科幻：左侧轨道 */
.nav-scifi { position: fixed; left: 0; top: 0; bottom: 0; width: 88px; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 16px 0; background: var(--panel); border-right: 1px solid var(--line); z-index: 60; }
.nav-scifi .brand { font-size: 13px; writing-mode: vertical-rl; margin-bottom: 10px; color: var(--accent); font-weight: 700; }
.nav-scifi a { display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 11px; color: var(--ink-2); text-decoration: none; padding: 6px 4px; width: 100%; text-align: center; }
.nav-scifi .mi { font-size: 20px; margin: 0; }
.nav-scifi a.router-link-active { color: var(--accent); background: var(--code-inline); }
</style>
