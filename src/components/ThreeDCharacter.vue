<script setup>
// ThreeDCharacter.vue —— 真 3D 可交互人物（旗舰冒险主题用）
// 技术栈：Three.js 0.180 + 程序化建模（无外部 GLTF 依赖，离线可用）
// 支持外部 GLTF URL（modelUrl prop 传入则走 GLTFLoader 加载真实模型）
// 交互：拖拽旋转 / 点击触发动作 / 鼠标悬停跟随 / 父级 acting 联动
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { playBlip } from '../utils/sound.js';

const props = defineProps({
  hue: { type: Number, default: 30 },          // 暖色琥珀 30 / 冒险深绿 140
  acting: { type: Boolean, default: false },   // 父级点击菜单触发动作
  modelUrl: { type: String, default: '' },     // 可选 GLTF 模型 URL（无则程序化建模）
  cameraFov: { type: Number, default: 38 },
  enableShadows: { type: Boolean, default: true },
});
const emit = defineEmits(['ready', 'action']);

const canvasEl = ref(null);
const wrapEl = ref(null);
const failed = ref(false);   // WebGL 不可用时回退
let scene, camera, renderer, character, mixer;
let rafId = 0;
let targetRotY = 0, curRotY = 0;
let pointerInside = false, mx = 0, my = 0;
let actionEndAt = 0;
let disposeFn = () => {};

// ---------- 材质：金属装甲 + 琥珀发光宝石 ----------
function buildMaterials(hue) {
  const armorMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(`hsl(${hue}, 28%, 22%)`),
    metalness: 0.78, roughness: 0.38,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(`hsl(${hue}, 70%, 52%)`),
    metalness: 0.55, roughness: 0.28,
    emissive: new THREE.Color(`hsl(${hue}, 85%, 35%)`),
    emissiveIntensity: 0.55,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x141414, metalness: 0.65, roughness: 0.55,
  });
  const cloakMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(`hsl(${hue}, 42%, 18%)`),
    side: THREE.DoubleSide, roughness: 0.85, metalness: 0.1,
  });
  return { armorMat, accentMat, darkMat, cloakMat };
}

// ---------- 角色：低多边形战士（黑神话风） ----------
function buildProceduralCharacter(hue) {
  const g = new THREE.Group();
  const { armorMat, accentMat, darkMat, cloakMat } = buildMaterials(hue);

  // 头盔（拉长 Icosahedron + 顶羽）
  const head = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.36, 1),
    armorMat,
  );
  head.position.y = 1.74;
  head.scale.set(1, 1.15, 1.05);
  const hornL = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.42, 6), accentMat);
  hornL.position.set(-0.22, 2.05, 0); hornL.rotation.z = 0.32;
  const hornR = hornL.clone();
  hornR.position.x = 0.22; hornR.rotation.z = -0.32;

  // 躯干（胶囊 + 胸甲宝石）
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.82, 6, 14), armorMat);
  body.position.y = 1.05;
  const chestGem = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 0), accentMat);
  chestGem.position.set(0, 1.15, 0.36);
  chestGem.rotation.z = Math.PI / 4;

  // 肩甲（球）
  const shoulderGeo = new THREE.IcosahedronGeometry(0.2, 0);
  const shL = new THREE.Mesh(shoulderGeo, armorMat); shL.position.set(-0.55, 1.42, 0);
  const shR = shL.clone(); shR.position.x = 0.55;

  // 手臂（胶囊）+ 前臂
  const armGeo = new THREE.CapsuleGeometry(0.13, 0.55, 4, 8);
  const armL = new THREE.Mesh(armGeo, armorMat);
  armL.position.set(-0.58, 1.02, 0); armL.rotation.z = 0.18;
  const armR = armL.clone();
  armR.position.x = 0.58; armR.rotation.z = -0.18;

  // 武器（长杖 + 顶宝石）
  const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 2.4, 8), darkMat);
  staff.position.set(0.78, 1.25, 0.18); staff.rotation.z = -0.12;
  const staffGem = new THREE.Mesh(new THREE.OctahedronGeometry(0.14, 0), accentMat);
  staffGem.position.set(0.86, 2.5, 0.18);
  // 持武手
  const handR = new THREE.Mesh(new THREE.IcosahedronGeometry(0.11, 0), darkMat);
  handR.position.set(0.78, 1.0, 0.18);

  // 腿（胶囊）
  const legGeo = new THREE.CapsuleGeometry(0.16, 0.62, 4, 8);
  const legL = new THREE.Mesh(legGeo, armorMat); legL.position.set(-0.2, 0.32, 0);
  const legR = legL.clone(); legR.position.x = 0.2;

  // 披风（弧形 Plane + 微细分）
  const cloak = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 1.25, 4, 6),
    cloakMat,
  );
  cloak.position.set(0, 1.05, -0.28);
  cloak.rotation.x = -0.18;

  g.add(head, hornL, hornR, body, chestGem, shL, shR, armL, armR, staff, staffGem, handR, legL, legR, cloak);
  return g;
}

function init() {
  const el = canvasEl.value;
  const wrap = wrapEl.value;
  if (!el || !wrap) return;

  // WebGL 兼容性检测
  try {
    const test = el.getContext('webgl2') || el.getContext('webgl');
    if (!test) { failed.value = true; return; }
  } catch { failed.value = true; return; }

  const w = wrap.clientWidth || 240;
  const h = wrap.clientHeight || 280;

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0a0e0a, 6, 16);

  camera = new THREE.PerspectiveCamera(props.cameraFov, w / h, 0.1, 100);
  camera.position.set(0, 1.5, 5.2);
  camera.lookAt(0, 1.05, 0);

  renderer = new THREE.WebGLRenderer({ canvas: el, alpha: true, antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = props.enableShadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // 灯光：主光（暖月光） + 边缘冷光 + 火炬点光
  const ambient = new THREE.AmbientLight(0x6a6a78, 0.45);
  const key = new THREE.DirectionalLight(0xffe0a8, 1.05);
  key.position.set(2.4, 4.5, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -3; key.shadow.camera.right = 3;
  key.shadow.camera.top = 3; key.shadow.camera.bottom = -3;
  key.shadow.bias = -0.0005;
  const rim = new THREE.DirectionalLight(0x6a8cff, 0.55);
  rim.position.set(-2.4, 2.4, -3);
  const torch = new THREE.PointLight(0xff7733, 0.8, 9, 2);
  torch.position.set(0, 1.2, 3);
  scene.add(ambient, key, rim, torch);

  // 地面圆盘（接阴影）
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(2.4, 48),
    new THREE.MeshStandardMaterial({ color: 0x1a1f1a, roughness: 0.92, transparent: true, opacity: 0.85 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  ground.receiveShadow = true;
  scene.add(ground);

  // 角色：优先 GLTF，否则程序化
  if (props.modelUrl) {
    const loader = new GLTFLoader();
    loader.load(
      props.modelUrl,
      (gltf) => {
        character = gltf.scene;
        character.traverse((o) => {
          if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
        });
        character.scale.setScalar(1.0);
        // 自动居中到地面
        const box = new THREE.Box3().setFromObject(character);
        const size = box.getSize(new THREE.Vector3());
        const offsetY = -box.min.y;
        character.position.y = offsetY;
        // 缩放到目标高度 1.8
        const targetH = 1.8;
        const s = targetH / Math.max(0.001, size.y);
        character.scale.setScalar(s);
        scene.add(character);
        if (gltf.animations && gltf.animations.length) {
          mixer = new THREE.AnimationMixer(character);
          mixer.clipAction(gltf.animations[0]).play();
        }
        emit('ready');
      },
      undefined,
      (err) => {
        // GLTF 加载失败 → 回退程序化建模
        console.warn('[ThreeDCharacter] GLTF 加载失败，回退程序化建模', err);
        character = buildProceduralCharacter(props.hue);
        character.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        scene.add(character);
        emit('ready');
      }
    );
  } else {
    character = buildProceduralCharacter(props.hue);
    character.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(character);
    emit('ready');
  }

  bindInteraction();
  startLoop();

  disposeFn = () => {
    cancelAnimationFrame(rafId);
    renderer?.dispose();
    scene?.traverse((o) => {
      if (o.geometry) o.geometry.dispose?.();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose?.());
        else o.material.dispose?.();
      }
    });
  };
}

// ---------- 交互：拖拽 / 悬停跟随 / 点击触发动作 ----------
let dragging = false, lastPx = 0;
function onPointerDown(e) {
  dragging = true; lastPx = e.clientX;
  if (canvasEl.value) canvasEl.value.setPointerCapture?.(e.pointerId);
}
function onPointerMove(e) {
  const rect = canvasEl.value?.getBoundingClientRect();
  if (rect) {
    mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    my = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    pointerInside = e.target === canvasEl.value;
  }
  if (dragging) {
    const dx = e.clientX - lastPx;
    targetRotY += dx * 0.01;
    lastPx = e.clientX;
  }
}
function onPointerUp() { dragging = false; }
function onClick() {
  triggerAction();
  playBlip(280, 0.08, 'square', 0.22);
  setTimeout(() => playBlip(440, 0.1, 'square', 0.2), 80);
  emit('action');
}
function bindInteraction() {
  const el = canvasEl.value;
  if (!el) return;
  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);
  el.addEventListener('pointerleave', () => { pointerInside = false; });
  el.addEventListener('click', onClick);
}

function triggerAction() { actionEndAt = performance.now() + 620; }

// ---------- 动画循环：待机呼吸 + 头部跟随 + 动作 ----------
const clock = new THREE.Clock();
function startLoop() {
  const tick = () => {
    rafId = requestAnimationFrame(tick);
    const dt = clock.getDelta();
    const t = performance.now() / 1000;

    if (mixer) mixer.update(dt);
    if (character) {
      // 待机：呼吸 + 微微摇摆
      const breath = Math.sin(t * 1.4) * 0.025;
      character.position.y = breath;

      // 头部跟随鼠标
      const head = character.children[0];
      if (head && !dragging && pointerInside) {
        head.rotation.y += (mx * 0.5 - head.rotation.y) * 0.1;
        head.rotation.x += (-my * 0.2 - head.rotation.x) * 0.1;
      }

      // 旋转（拖拽 / 自动微旋）
      curRotY += (targetRotY - curRotY) * 0.08;
      const autoSway = Math.sin(t * 0.4) * 0.05;
      character.rotation.y = curRotY + autoSway;

      // 动作：跳跃 + 武器挥舞
      const remain = actionEndAt - performance.now();
      if (remain > 0) {
        const p = remain / 620; // 1 → 0
        const jump = Math.sin((1 - p) * Math.PI) * 0.45;
        character.position.y += jump;
        // 武器右臂挥舞
        const armR = character.children[7];
        if (armR) armR.rotation.x = Math.sin((1 - p) * Math.PI) * 1.2;
      } else if (character.children[7]) {
        character.children[7].rotation.x *= 0.9;
      }
    }

    renderer?.render(scene, camera);
  };
  tick();
}

function onResize() {
  const wrap = wrapEl.value;
  if (!wrap || !renderer) return;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// 监听 acting prop（父级菜单点击联动）
watch(() => props.acting, (v) => { if (v) triggerAction(); });
// 监听 hue 变化（场景色调切换）—— 重建角色（轻量）
watch(() => props.hue, (h) => {
  if (!scene || !character || props.modelUrl) return;
  scene.remove(character);
  character.traverse((o) => {
    if (o.geometry) o.geometry.dispose?.();
    if (o.material) { Array.isArray(o.material) ? o.material.forEach(m => m.dispose?.()) : o.material.dispose?.(); }
  });
  character = buildProceduralCharacter(h);
  character.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(character);
});

onMounted(() => {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    failed.value = true;  // 无障碍：禁用 3D 动画
    return;
  }
  init();
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  disposeFn();
});
</script>

<template>
  <div ref="wrapEl" class="tdc-wrap">
    <canvas v-if="!failed" ref="canvasEl" class="tdc-canvas"></canvas>
    <div v-else class="tdc-fallback">🐒</div>
  </div>
</template>

<style scoped>
.tdc-wrap { width: 100%; height: 100%; position: relative; }
.tdc-canvas {
  width: 100%; height: 100%; display: block;
  cursor: grab; touch-action: none;
}
.tdc-canvas:active { cursor: grabbing; }
.tdc-fallback {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  font-size: 88px;
  filter: drop-shadow(0 6px 10px rgba(0, 0, 0, .5));
}
</style>
