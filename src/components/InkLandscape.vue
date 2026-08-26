<script setup>
// InkLandscape.vue —— 国风山水水墨画 Canvas 全屏背景（旗舰国风主题用）
// 致敬宋元名家：范宽《溪山行旅图》主峰雄浑 + 黄公望《富春山居图》绵延 + 马远边角留白 + 米芾米点皴
// 纯 Canvas 2D 实现，无外部依赖，离线可用，支持 prefers-reduced-motion
// 交互：① 点击水面 → 涟漪扩散 ② 点击山体 → 云雾升腾 ③ 鼠标移动 → 远近视差 ④ 点击空白 → 飞鸟惊起
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { playBlip } from '../utils/sound.js';

const props = defineProps({
  active: { type: Boolean, default: true },   // 主题未激活时不渲染，懒加载
  reduced: { type: Boolean, default: false }, // 降级：静态山水画，无动画
});

const canvasEl = ref(null);
let ctx = null;
let rafId = 0;
let W = 0, H = 0, DPR = 1;

// 视差：鼠标偏移（归一化 -1~1）
let mx = 0, my = 0, tx = 0, ty = 0;

// 场景元素
let mountains = [];   // 远/中/近三层山
let waterRipples = [];
let clouds = [];      // 点击山体生成的升腾云雾
let birds = [];        // 飞鸟
let mistTimer = 0;     // 环境云雾周期
let birdTimer = 0;
let t0 = 0;

// 印章与题款（固定位置）
let seal = null;
let inscription = null;

// ---------- 山体生成：水墨皴法 ----------
// layer: 0 远山(淡) 1 中山(中) 2 近山(浓)
function genMountain(layer) {
  const baseY = layer === 0 ? H * 0.42 : layer === 1 ? H * 0.55 : H * 0.68;
  const amp = layer === 0 ? H * 0.18 : layer === 1 ? H * 0.22 : H * 0.16;
  const points = [];
  const peaks = 5 + layer * 2;
  for (let i = 0; i <= peaks; i++) {
    const x = (i / peaks) * W;
    // 多频叠加，模拟自然山势
    const y = baseY - Math.abs(Math.sin(i * 1.3 + layer)) * amp
      - Math.random() * amp * 0.25;
    points.push({ x, y });
  }
  return {
    layer,
    points,
    ink: layer === 0 ? 0.12 : layer === 1 ? 0.28 : 0.55, // 墨色浓度
    // 米点皴 / 披麻皴 的肌理点
    texture: genTexture(points, layer),
  };
}

function genTexture(points, layer) {
  const dots = [];
  const count = layer === 0 ? 40 : layer === 1 ? 70 : 100;
  for (let i = 0; i < count; i++) {
    const seg = Math.floor(Math.random() * (points.length - 1));
    const p0 = points[seg], p1 = points[seg + 1];
    const t = Math.random();
    const x = p0.x + (p1.x - p0.x) * t;
    const y = p0.y + (p1.y - p0.y) * t + Math.random() * 30 - 5;
    dots.push({ x, y, r: 1 + Math.random() * 2.5, a: 0.1 + Math.random() * 0.25 });
  }
  return dots;
}

// ---------- 飞鸟（点墨写意）----------
function spawnBird(x, y, startled) {
  const count = startled ? 3 + Math.floor(Math.random() * 3) : 1;
  for (let i = 0; i < count; i++) {
    birds.push({
      x: x + (i - count / 2) * 18,
      y: y + (Math.random() - 0.5) * 20,
      vx: 0.4 + Math.random() * 0.8,
      vy: -0.15 - Math.random() * 0.25,
      wing: Math.random() * Math.PI * 2,
      life: 1,
    });
  }
}

// ---------- 涟漪 ----------
function spawnRipple(x, y) {
  waterRipples.push({ x, y, r: 2, max: 40 + Math.random() * 30, a: 0.5 });
  playBlip(180, 0.12, 'sine', 0.08);
}

// ---------- 云雾（点击山体升腾）----------
function spawnCloud(x, y) {
  for (let i = 0; i < 5; i++) {
    clouds.push({
      x: x + (Math.random() - 0.5) * 40,
      y: y + (Math.random() - 0.5) * 10,
      r: 18 + Math.random() * 22,
      vx: (Math.random() - 0.5) * 0.3,
      vy: -0.2 - Math.random() * 0.3,
      life: 1,
      decay: 0.003 + Math.random() * 0.002,
    });
  }
  playBlip(220, 0.15, 'sine', 0.06);
}

// ---------- 绘制山 ----------
function drawMountain(m, parallax) {
  const off = parallax * (m.layer === 0 ? 18 : m.layer === 1 ? 10 : 4);
  ctx.save();
  ctx.translate(off, 0);
  // 山体填充（水墨晕染：渐变 + 半透明）
  ctx.beginPath();
  ctx.moveTo(m.points[0].x, H);
  for (const p of m.points) ctx.lineTo(p.x, p.y);
  ctx.lineTo(W, H);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, H * 0.4, 0, H);
  const ink = m.ink;
  grad.addColorStop(0, `rgba(20, 24, 28, ${ink})`);
  grad.addColorStop(1, `rgba(20, 24, 28, ${ink * 0.4})`);
  ctx.fillStyle = grad;
  ctx.fill();
  // 山轮廓线（淡墨勾边）
  ctx.beginPath();
  ctx.moveTo(m.points[0].x, m.points[0].y);
  for (const p of m.points) ctx.lineTo(p.x, p.y);
  ctx.strokeStyle = `rgba(20, 24, 28, ${ink * 0.8})`;
  ctx.lineWidth = m.layer === 2 ? 1.4 : 0.8;
  ctx.stroke();
  // 皴法肌理点
  for (const d of m.texture) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(20, 24, 28, ${d.a * ink * 2})`;
    ctx.fill();
  }
  ctx.restore();
}

// ---------- 绘制水 ----------
function drawWater(parallax) {
  const waterTop = H * 0.72;
  // 水面留白 + 极淡墨
  ctx.fillStyle = 'rgba(240, 236, 226, 0.25)';
  ctx.fillRect(0, waterTop, W, H - waterTop);
  // 水纹（横线，远近疏密）
  ctx.strokeStyle = 'rgba(40, 50, 60, 0.12)';
  ctx.lineWidth = 0.6;
  for (let i = 0; i < 12; i++) {
    const y = waterTop + 8 + i * 14 + Math.sin(t0 * 0.001 + i) * 2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= W; x += 20) {
      ctx.lineTo(x, y + Math.sin(x * 0.02 + t0 * 0.001 + i) * 1.2);
    }
    ctx.stroke();
  }
  // 涟漪
  for (const r of waterRipples) {
    ctx.beginPath();
    ctx.ellipse(r.x, r.y, r.r, r.r * 0.4, 0, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(40, 50, 60, ${r.a})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// ---------- 绘制飞鸟（"一"字 / "八"字点墨）----------
function drawBird(b) {
  const wing = Math.sin(b.wing) * 0.5;
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.strokeStyle = `rgba(20, 24, 28, ${b.life * 0.7})`;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  // 左右翼，模拟 "八" 字
  ctx.moveTo(-7, wing * 4);
  ctx.quadraticCurveTo(-3, -3 - wing * 5, 0, 0);
  ctx.quadraticCurveTo(3, -3 - wing * 5, 7, wing * 4);
  ctx.stroke();
  ctx.restore();
}

// ---------- 绘制云雾 ----------
function drawCloud(c) {
  ctx.save();
  ctx.globalAlpha = c.life * 0.5;
  const grad = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r);
  grad.addColorStop(0, 'rgba(245, 240, 228, 0.7)');
  grad.addColorStop(1, 'rgba(245, 240, 228, 0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ---------- 绘制环境雾（山间岚气）----------
function drawAmbientMist() {
  ctx.save();
  for (let i = 0; i < 3; i++) {
    const y = H * (0.45 + i * 0.08) + Math.sin(t0 * 0.0003 + i) * 8;
    const grad = ctx.createLinearGradient(0, y - 20, 0, y + 20);
    grad.addColorStop(0, 'rgba(245, 240, 228, 0)');
    grad.addColorStop(0.5, `rgba(245, 240, 228, ${0.18 - i * 0.04})`);
    grad.addColorStop(1, 'rgba(245, 240, 228, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, y - 20, W, 40);
  }
  ctx.restore();
}

// ---------- 印章 + 题款 ----------
function drawSealInscription() {
  if (!seal) {
    seal = { x: W - 90, y: H - 110, size: 44 };
    inscription = { x: W - 150, y: H - 180, lines: ['山', '水', '清', '音'] };
  }
  // 题款（竖排楷书）
  ctx.save();
  ctx.fillStyle = 'rgba(30, 30, 30, 0.5)';
  ctx.font = '16px "KaiTi", "STKaiti", "楷体", serif';
  ctx.textAlign = 'center';
  for (let i = 0; i < inscription.lines.length; i++) {
    ctx.fillText(inscription.lines[i], inscription.x + i * 22, inscription.y);
  }
  ctx.restore();
  // 朱印（方章，留白字）
  ctx.save();
  ctx.fillStyle = 'rgba(168, 49, 42, 0.85)';
  ctx.fillRect(seal.x, seal.y, seal.size, seal.size);
  ctx.fillStyle = 'rgba(245, 240, 228, 0.95)';
  ctx.font = 'bold 14px "KaiTi", "STKaiti", "楷体", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('墨', seal.x + seal.size / 2, seal.y + seal.size / 2 - 9);
  ctx.fillText('韵', seal.x + seal.size / 2, seal.y + seal.size / 2 + 9);
  ctx.restore();
}

// ---------- 主循环 ----------
function frame(now) {
  if (!ctx) return;
  t0 = now;
  // 视差缓动
  tx += (mx - tx) * 0.05;
  ty += (my - ty) * 0.05;

  ctx.clearRect(0, 0, W, H);
  // 宣纸底色
  ctx.fillStyle = '#f0ebe0';
  ctx.fillRect(0, 0, W, H);
  // 宣纸纹理（极淡噪点，仅一次可预渲染，此处简化）
  // 环境雾
  drawAmbientMist();
  // 山（远→近）
  for (const m of mountains) drawMountain(m, tx);
  // 水
  drawWater(tx);
  // 云雾
  for (let i = clouds.length - 1; i >= 0; i--) {
    const c = clouds[i];
    c.x += c.vx; c.y += c.vy; c.r += 0.3; c.life -= c.decay;
    if (c.life <= 0) clouds.splice(i, 1);
    else drawCloud(c);
  }
  // 涟漪更新
  for (let i = waterRipples.length - 1; i >= 0; i--) {
    const r = waterRipples[i];
    r.r += 1.2; r.a -= 0.008;
    if (r.a <= 0 || r.r > r.max) waterRipples.splice(i, 1);
  }
  // 飞鸟
  for (let i = birds.length - 1; i >= 0; i--) {
    const b = birds[i];
    b.x += b.vx; b.y += b.vy; b.wing += 0.25; b.life -= 0.004;
    if (b.life <= 0 || b.x > W + 20) birds.splice(i, 1);
    else drawBird(b);
  }
  // 环境飞鸟（间歇飞过）
  birdTimer += 16;
  if (birdTimer > 8000 + Math.random() * 6000) {
    birdTimer = 0;
    spawnBird(W * 0.2 + Math.random() * W * 0.3, H * 0.25 + Math.random() * 60, false);
  }
  // 印章题款
  drawSealInscription();

  rafId = requestAnimationFrame(frame);
}

// ---------- 静态渲染（降级模式）----------
function renderStatic() {
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#f0ebe0';
  ctx.fillRect(0, 0, W, H);
  drawAmbientMist();
  for (const m of mountains) drawMountain(m, 0);
  drawWater(0);
  drawSealInscription();
}

// ---------- 交互 ----------
function onMove(e) {
  const r = canvasEl.value.getBoundingClientRect();
  mx = ((e.clientX - r.left) / r.width - 0.5) * 2;
  my = ((e.clientY - r.top) / r.height - 0.5) * 2;
}
function onDown(e) {
  if (props.reduced) return;
  const r = canvasEl.value.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const waterTop = H * 0.72;
  if (y > waterTop) {
    // 水面：涟漪
    spawnRipple(x, y);
  } else if (y > H * 0.42) {
    // 山体：云雾升腾
    spawnCloud(x, y);
  } else {
    // 天空：惊起飞鸟
    spawnBird(x, y, true);
    playBlip(420, 0.1, 'triangle', 0.1);
  }
}

// ---------- 尺寸 ----------
function resize() {
  if (!canvasEl.value) return;
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvasEl.value.width = W * DPR;
  canvasEl.value.height = H * DPR;
  canvasEl.value.style.width = W + 'px';
  canvasEl.value.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  // 重新生成山（尺寸变化）
  mountains = [genMountain(0), genMountain(1), genMountain(2)];
  seal = null; // 重置印章位置
  if (props.reduced) renderStatic();
}

let resizeTimer = null;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resize, 200);
}

onMounted(() => {
  if (!props.active) return;
  ctx = canvasEl.value.getContext('2d');
  resize();
  if (props.reduced) {
    renderStatic();
  } else {
    rafId = requestAnimationFrame(frame);
  }
  window.addEventListener('resize', onResize);
  canvasEl.value.addEventListener('pointermove', onMove);
  canvasEl.value.addEventListener('pointerdown', onDown);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
  window.removeEventListener('resize', onResize);
  canvasEl.value?.removeEventListener('pointermove', onMove);
  canvasEl.value?.removeEventListener('pointerdown', onDown);
});

watch(() => props.active, (v) => {
  if (v && ctx) {
    if (props.reduced) renderStatic();
    else if (!rafId) rafId = requestAnimationFrame(frame);
  } else {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
});
</script>

<template>
  <canvas v-if="active" ref="canvasEl" class="ink-landscape" aria-hidden="true"></canvas>
</template>

<style scoped>
.ink-landscape {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: auto;
  cursor: crosshair;
  background: #f0ebe0;
}
</style>
