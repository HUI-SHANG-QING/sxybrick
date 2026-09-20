<script setup>
// 翻转卡：支持三种题型
//   basic  正反面：点击翻转
//   cloze  填空：正面把 {{答案}} 挖空，翻转后显示答案
//   choice 选择：正面点选项作答，翻转后判对错
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import MarkdownRenderer from './MarkdownRenderer.vue';
import { speak, mdToSpeech } from '../utils/tts.js';
import { WRONG_REASONS, wrongReasonToCode } from '../repo.js';
import { T } from '../utils/telemetry.js';

const props = defineProps({ card: { type: Object, required: true } });
const emit = defineEmits(['rate', 'edit']);

const flipped = ref(false);
const picked = ref(null);
const hintReveal = ref(false);
// 3D 渲染上下文开关（清晰度关键，2026-09-18 定案）
// —— 为什么需要它：`.flip-inner` 上的 `transform-style: preserve-3d`（配合 `.flip-scene`
//    的 `perspective`）会建立 3D 渲染上下文，而 Chrome 在 3D 上下文中**关闭 LCD 次像素
//    抗锯齿**，改用灰度抗锯齿 → 文字笔画变细、边缘发虚，观感就是「蒙了一层雾」。
//    实测：静止态灰度抗锯齿 chromaMax≈22；去掉 3D 上下文后恢复到 ≈179（次像素）。
// —— 为什么不能长期 flat：翻转动画本身依赖 `preserve-3d` 做真正的 3D 旋转。
// —— 方案：**仅在翻转过渡期间**开启 3D，动画一结束立刻回到 flat。
//    静止态（用户 99.9% 的时间都在看静止的卡）因此始终走次像素抗锯齿，文字锐利。
//    正反面的显隐由模板上的 `visibility`（`.flip-inner.flipped .flip-front{visibility:hidden}`）
//    负责，不依赖 backface-visibility 的背面剔除，所以 flat 详情态不会出现正反面双影（已实测确认）。
const flip3d = ref(false);
let flip3dTimer = null;
// 本次复习难度评分（0易/1中/2难）：默认取卡片固有难度的映射值
const DIFF_DEFAULT = { basic: 0, applied: 1, challenge: 2 };
const difficulty = ref(DIFF_DEFAULT[props.card.difficulty] ?? (Number.isFinite(Number(props.card.difficulty)) ? Number(props.card.difficulty) : 1));
const wrongReason = ref(wrongReasonToCode(props.card.wrongReason));
const customWrong = ref('');
const showCustomWrong = ref(false);
// 默写题型（C7）：输入作答，逐字匹配判定
const writingAnswer = ref('');
const writingChecked = ref(false);
const writingCorrect = ref(false);
watch(() => props.card.id, () => {
  flipped.value = false; picked.value = null; hintReveal.value = false;
  difficulty.value = DIFF_DEFAULT[props.card.difficulty] ?? (Number.isFinite(Number(props.card.difficulty)) ? Number(props.card.difficulty) : 1);
  wrongReason.value = wrongReasonToCode(props.card.wrongReason);
  customWrong.value = '';
  showCustomWrong.value = false;
  writingAnswer.value = '';
  writingChecked.value = false;
  writingCorrect.value = false;
});

const type = computed(() => {
  const t = props.card.type || 'basic';
  // 难度梯度：basic 卡在 level>=4（巩固期）自动升级为默写模式（自由回忆）
  // 认知科学：再认(level 0-1) → 线索回忆(level 2-3 自动展示首字+字数) → 自由回忆(level 4+ 默写)
  if (t === 'basic' && (props.card.level ?? 0) >= 4) return 'writing';
  return t;
});
const autoWriting = computed(() => (!props.card.type || props.card.type === 'basic') && (props.card.level ?? 0) >= 4);
// 线索回忆层（level 2-3 的 basic 卡）：自动展示"首字+字数"提示，强迫主动提取
// 不暴露完整答案，只给最小线索，降低再认依赖、提升回忆难度
const autoClue = computed(() =>
  (!props.card.type || props.card.type === 'basic') &&
  !autoWriting.value &&
  (props.card.level ?? 0) >= 2 && (props.card.level ?? 0) <= 3,
);
const clueHint = computed(() => {
  if (!autoClue.value) return '';
  // 清洗 markdown/标点后取首字 + 字数
  const back = String(props.card.back || '')
    .replace(/[#*`_[\]()!~>-]/g, '')
    .replace(/\s+/g, '')
    .trim();
  if (!back) return '';
  const first = back[0] || '';
  return `首字「${first}」· 共 ${back.length} 字`;
});
const typeText = computed(() => {
  if (autoWriting.value) return '默写（巩固）';
  if (autoClue.value) return '线索回忆';
  return type.value === 'cloze' ? '填空' : type.value === 'choice' ? '选择' : type.value === 'writing' ? '默写' : '正反面';
});
const hintText = computed(() => mdToSpeech(props.card.back).slice(0, 40) || '（无提示）');

// 默写判定：忽略空格/标点/大小写后逐字比对
function normalizeWriting(s) {
  return String(s || '').toLowerCase().replace(/[\s，。、；：,.;:!?！？'"“”‘’()（）[\]【】]/g, '');
}
function checkWriting() {
  const user = normalizeWriting(writingAnswer.value);
  const want = normalizeWriting(props.card.back);
  writingChecked.value = true;
  writingCorrect.value = !!user && user === want;
  if (writingCorrect.value) {
    doRate(2, false); // 默写全对：直接按「记住了」评判并进入下一张
  } else {
    flipped.value = true; // 展示标准答案，由用户自行评级
  }
}

// 填空：{{答案}} → 挖空下划线
const maskedFront = computed(() =>
  type.value === 'cloze'
    ? String(props.card.front || '').replace(/\{\{([^}]+)\}\}/g, '＿＿＿')
    : props.card.front);

// 填空：翻转后答案加粗显示
const clozeReveal = computed(() =>
  String(props.card.front || '').replace(/\{\{([^}]+)\}\}/g, '**$1**'));

// 选择：解析 back 里的选项（A~D）与答案行
const choiceData = computed(() => {
  if (type.value !== 'choice') return null;
  const options = [];
  let answer = '';
  for (const line of String(props.card.back || '').split('\n')) {
    const m = line.match(/^\s*([A-Da-d])[.、．)）]\s*(.+)/);
    if (m) options.push({ key: m[1].toUpperCase(), text: m[2].trim() });
    const am = line.match(/答案\s*[:：]\s*([A-Da-d])/);
    if (am) answer = am[1].toUpperCase();
  }
  return { options, answer };
});

const isCorrect = computed(() => !!picked.value && picked.value === choiceData.value?.answer);

function showBack() {
  if (!flipped.value) {
    flipped.value = true;
    try { T.reviewFlip(props.card?.id); } catch { /* 埋点失败不阻塞业务 */ }
  }
}
function showFront() { flipped.value = false; }
function pick(key) { if (picked.value) return; picked.value = key; flipped.value = true; }

// 翻转过渡期间短暂开启 3D 渲染上下文（见 flip3d 注释）。
// 时长 = 过渡 550ms + 余量；与 .flip-inner 的 transition 时长保持一致的思路。
const FLIP_3D_MS = 600;
watch(flipped, () => {
  flip3d.value = true;
  clearTimeout(flip3dTimer);
  flip3dTimer = setTimeout(() => { flip3d.value = false; }, FLIP_3D_MS);
});
function doRate(rating, guessed = false) {
  emit('rate', props.card, rating, guessed, { difficulty: difficulty.value, wrongReason: wrongReason.value });
}
function setDifficulty(d) { difficulty.value = d; }
function setWrongReason(r) {
  if (r === '__custom__') { showCustomWrong.value = !showCustomWrong.value; return; }
  wrongReason.value = wrongReason.value === r ? '' : r;
}
function applyCustomWrong() {
  const v = customWrong.value.trim();
  if (v) wrongReason.value = v;
  customWrong.value = '';
  showCustomWrong.value = false;
}

// ---- 正反面内容全屏放大（文字+图片整体缩放/拖拽） ----
// 与 MarkdownRenderer 的图片灯箱互补：那个只管单张图，这个管整面内容。
const contentFs = ref({ open: false, side: 'front', zoom: 1, x: 0, y: 0 });
const fsStage = ref(null);
let fsDrag = null;
let pinch = null;

function openContentFs(side) {
  contentFs.value.open = true;
  contentFs.value.side = side;
  contentFs.value.zoom = 1;
  contentFs.value.x = 0;
  contentFs.value.y = 0;
  document.addEventListener('keydown', onFsKey, true);
}
function closeContentFs() {
  if (!contentFs.value.open) return;
  contentFs.value.open = false;
  document.removeEventListener('keydown', onFsKey, true);
}
// 路由切换 / 组件卸载时关闭内容全屏浮层。
// 否则用户在卡片全屏状态下点导航切换页面，浮层会跟着留在新页面上层遮挡界面
// （内容全屏层是 fixed 全屏，组件被复用时不会自动消失）。
const route = useRoute();
watch(() => route.fullPath, () => { if (contentFs.value.open) closeContentFs(); });
onBeforeUnmount(() => { if (contentFs.value.open) closeContentFs(); });

function onFsKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeContentFs(); }
}
function fsSetZoom(z, cx, cy) {
  const nz = Math.min(5, Math.max(0.5, z));
  const el = fsStage.value;
  const S = el?.clientWidth ?? 0;
  const Sh = el?.clientHeight ?? 0;
  if (cx == null || cy == null) { cx = S / 2; cy = Sh / 2; }
  // ⚠ transform-origin 是 center center，且舞台用 flex 居中内容 —— 缩放不动点必须按
  // 「相对舞台中心」的偏移计算（d = 锚点 - 舞台中心）。旧实现按左上角原点算（直接用 cx），
  // 与 center 原点差半个舞台尺寸 → 滚轮缩放整体漂移、不居中（2026-09-14 修复）。
  const k = nz / contentFs.value.zoom;
  const dx = cx - S / 2;
  const dy = cy - Sh / 2;
  contentFs.value.x = dx - (dx - contentFs.value.x) * k;
  contentFs.value.y = dy - (dy - contentFs.value.y) * k;
  contentFs.value.zoom = nz;
}
function fsOnWheel(e) {
  if (!contentFs.value.open) return;
  e.preventDefault();
  // 居中缩放（浏览器式）：始终以舞台中心为锚点，不跟随光标 → 放大后内容保持居中
  fsSetZoom(contentFs.value.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
}
function fsOnPointerDown(e) {
  if (e.pointerType === 'touch') return; // 触屏走 touchstart
  fsDrag = { x: e.clientX - contentFs.value.x, y: e.clientY - contentFs.value.y };
  fsStage.value?.setPointerCapture(e.pointerId);
}
function fsOnPointerMove(e) {
  if (!fsDrag) return;
  contentFs.value.x = e.clientX - fsDrag.x;
  contentFs.value.y = e.clientY - fsDrag.y;
}
function fsOnPointerUp() { fsDrag = null; }
function fsOnDoubleClick(e) {
  const r = fsStage.value?.getBoundingClientRect();
  const cx = r ? e.clientX - r.left : null;
  const cy = r ? e.clientY - r.top : null;
  fsSetZoom(contentFs.value.zoom > 1.01 ? 1 : 2, cx, cy);
}
// 触屏双指捏合缩放
function fsTouchStart(e) {
  if (e.touches.length === 2) {
    const [a, b] = e.touches;
    pinch = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom: contentFs.value.zoom };
  } else if (e.touches.length === 1) {
    fsDrag = { x: e.touches[0].clientX - contentFs.value.x, y: e.touches[0].clientY - contentFs.value.y };
  }
}
function fsTouchMove(e) {
  if (e.touches.length === 2 && pinch) {
    e.preventDefault();
    const [a, b] = e.touches;
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const r = fsStage.value?.getBoundingClientRect();
    const cx = r ? (a.clientX + b.clientX) / 2 - r.left : null;
    const cy = r ? (a.clientY + b.clientY) / 2 - r.top : null;
    fsSetZoom(pinch.zoom * (d / pinch.dist), cx, cy);
  } else if (e.touches.length === 1 && fsDrag) {
    contentFs.value.x = e.touches[0].clientX - fsDrag.x;
    contentFs.value.y = e.touches[0].clientY - fsDrag.y;
  }
}
function fsTouchEnd() { pinch = null; fsDrag = null; }

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onFsKey, true);
  clearTimeout(flip3dTimer);
});

// 暴露给父级（键盘快捷键：空格翻面 / 1·2·3 评级）
defineExpose({ flipped, showBack, doRate });
</script>

<template>
  <div class="flip-scene" :class="{ 'flip-3d': flip3d }">
    <!-- 翻转 3D 舞台：限制最大高度，正面/背面内容过长时内滚，保证底部操作区不被挤出视窗 -->
    <div class="flip-inner" :class="{ flipped, 'flip-3d': flip3d }">
      <!-- 正面 -->
      <div class="flip-face flip-front card-item" @click="type !== 'choice' && showBack()">
        <button class="fs-btn" title="全屏查看正面" @click.stop="openContentFs('front')">⛶ 全屏</button>
        <div class="face-scroll">
          <div class="tags">
            <span class="tag-pill subj">{{ typeText }}</span>
            <span v-if="card.subject" class="tag-pill subj">{{ card.subject }}</span>
            <span v-for="tag in card.tags" :key="tag" class="tag-pill">{{ tag }}</span>
          </div>

          <template v-if="type === 'choice'">
            <MarkdownRenderer :content="card.front" />
            <div class="options">
              <button v-for="o in choiceData.options" :key="o.key" class="opt" @click.stop="pick(o.key)">
                <b>{{ o.key }}.</b> <span>{{ o.text }}</span>
              </button>
            </div>
            <button class="btn small" @click.stop="speak(card.front)" style="margin-top:10px">朗读题干</button>
            <div class="hint" style="margin-top:10px">点击一个选项作答</div>
          </template>

          <template v-else>
            <MarkdownRenderer :content="maskedFront" />
            <template v-if="type === 'writing'">
              <div v-if="autoWriting" class="hint" style="margin-top:4px;color:var(--green)">巩固期 · 默写模式（自由回忆，检验真实掌握度）</div>
              <div style="display:flex;gap:8px;margin-top:12px" @click.stop>
                <input v-model="writingAnswer" class="input" style="flex:1" placeholder="默写你的答案…" @keydown.enter="checkWriting" />
                <button class="btn small primary" @click="checkWriting">提交</button>
              </div>
              <div v-if="writingChecked && !writingCorrect" class="hint" style="color:var(--red);margin-top:8px">与标准答案不完全一致，翻看答案后自评</div>
            </template>
            <template v-else>
              <div v-if="autoClue && clueHint" class="hint" style="margin-top:8px;color:var(--blue)">🧠 线索回忆 · {{ clueHint }}（先主动提取，再翻面对照）</div>
              <div style="display:flex;gap:8px;margin-top:12px;align-items:center" @click.stop>
                <button class="btn small" @click="speak(maskedFront)">朗读</button>
                <button class="btn small" @click="hintReveal = !hintReveal">{{ hintReveal ? '收起提示' : '看提示' }}</button>
              </div>
              <div v-if="hintReveal" class="hint" style="margin-top:8px">提示：{{ hintText }}</div>
              <div v-else-if="!autoClue" class="hint" style="margin-top:10px">点击卡片任意区域翻看答案</div>
            </template>
          </template>
        </div>
      </div>

      <!-- 背面：顶部固定操作按钮（看回问题/朗读/编辑），主体内容独立滚动 -->
      <div class="flip-face flip-back card-item">
        <div class="back-top">
          <button class="btn small" @click="showFront">看回问题</button>
          <button class="btn small" @click="speak(card.back)">朗读答案</button>
          <button class="btn small" @click.stop="emit('edit', card)">编辑这张卡</button>
          <button class="btn small" @click.stop="openContentFs('back')">⛶ 全屏</button>
        </div>
        <div class="back-body face-scroll">
          <template v-if="type === 'choice'">
            <MarkdownRenderer :content="card.front" />
            <div class="options">
              <div v-for="o in choiceData.options" :key="o.key" class="opt"
                   :class="{ correct: o.key === choiceData.answer, wrong: picked === o.key && o.key !== choiceData.answer }">
                <b>{{ o.key }}.</b> <span>{{ o.text }}</span>
                <span v-if="o.key === choiceData.answer" class="mark">✓</span>
              </div>
            </div>
            <div v-if="isCorrect" class="hint" style="color:var(--green);margin-top:8px">答对了</div>
            <div v-else class="hint" style="color:var(--red);margin-top:8px">正确答案是 {{ choiceData.answer }}</div>
          </template>

          <template v-else-if="type === 'cloze'">
            <MarkdownRenderer :content="clozeReveal" />
            <div v-if="card.back" class="hint" style="margin-top:10px;border-top:1px dashed var(--line);padding-top:10px">{{ card.back }}</div>
          </template>

          <template v-else>
            <MarkdownRenderer :content="card.back" />
          </template>

          <div v-if="card.mnemonic" class="mnemonic">助记：{{ card.mnemonic }}</div>
          <div v-if="type === 'writing' && writingChecked && !writingCorrect" class="hint" style="margin-top:8px;color:var(--amber)">你的作答：「{{ writingAnswer }}」与标准答案有差异，请对照后自评</div>
        </div>
      </div>
    </div>

    <!-- 操作区（难度/错因 + 三档自评）：位于翻转舞台外部独立块，始终可见；翻面后淡入 -->
    <transition name="fade">
      <div v-if="flipped" class="flip-controls" @click.stop>
        <div class="meta-row">
          <div class="meta-group">
            <span class="meta-label">难度</span>
            <button v-for="d in [{v:0,t:'易'},{v:1,t:'中'},{v:2,t:'难'}]" :key="d.v" class="chip mini" :class="{ on: difficulty === d.v }" @click="setDifficulty(d.v)">{{ d.t }}</button>
          </div>
          <div class="meta-group">
            <span class="meta-label">错因</span>
            <button v-for="r in WRONG_REASONS" :key="r.code" class="chip mini" :class="{ on: wrongReason === r.code }" @click="setWrongReason(r.code)">{{ r.label }}</button>
            <button class="chip mini" :class="{ on: showCustomWrong }" @click="setWrongReason('__custom__')">自定义</button>
            <template v-if="showCustomWrong">
              <input v-model="customWrong" class="input" style="width:130px" placeholder="自定义错因（20字内）" maxlength="20" @keydown.enter="applyCustomWrong" />
              <button class="chip mini" @click="applyCustomWrong">确定</button>
            </template>
          </div>
        </div>
        <div class="rate-row">
          <button class="btn rate bad" @click="doRate(0)">没记住</button>
          <button class="btn rate mid" @click="doRate(1)">还模糊</button>
          <button class="btn rate guess" @click="doRate(2, true)">蒙对</button>
          <button class="btn rate good" @click="doRate(2)">记住了</button>
        </div>
      </div>
    </transition>

    <!-- 正反面内容全屏放大层（文字+图片整体缩放/拖拽/捏合） -->
    <Teleport to="body">
      <div v-if="contentFs.open" class="content-fs-overlay" @click.self="closeContentFs">
        <div class="content-fs-bar">
          <span class="content-fs-label">{{ contentFs.side === 'front' ? '正面' : '背面' }}</span>
          <span class="content-fs-zoom">{{ Math.round(contentFs.zoom * 100) }}%</span>
          <button class="btn small" @click="fsSetZoom(contentFs.zoom > 1.01 ? 1 : 2)">复位</button>
          <button class="btn small" @click="closeContentFs">✕ 关闭 (ESC)</button>
        </div>
        <div
          ref="fsStage"
          class="content-fs-stage"
          @wheel="fsOnWheel"
          @pointerdown="fsOnPointerDown"
          @pointermove="fsOnPointerMove"
          @pointerup="fsOnPointerUp"
          @pointercancel="fsOnPointerUp"
          @dblclick="fsOnDoubleClick"
          @touchstart="fsTouchStart"
          @touchmove="fsTouchMove"
          @touchend="fsTouchEnd"
        >
          <div class="content-fs-inner" :style="{ transform: `translate(${contentFs.x}px, ${contentFs.y}px) scale(${contentFs.zoom})` }">
            <MarkdownRenderer v-if="contentFs.side === 'front'" :content="maskedFront" />
            <MarkdownRenderer v-else-if="type === 'choice'" :content="card.front" />
            <MarkdownRenderer v-else-if="type === 'cloze'" :content="clozeReveal" />
            <MarkdownRenderer v-else :content="card.back" />
            <div v-if="contentFs.side === 'back' && type === 'cloze' && card.back" class="hint" style="margin-top:10px">{{ card.back }}</div>
            <div v-if="contentFs.side === 'back' && card.mnemonic" class="mnemonic">助记：{{ card.mnemonic }}</div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 翻转舞台：限定最大高度，避免长答案把底部操作条+快捷键提示挤出视窗 */
.flip-scene {
  /* 清晰度关键（2026-09-18）：
     `perspective` 同样会建立 3D 渲染上下文、关闭 LCD 次像素抗锯齿（实测：单独存在就让
     文字 chromaMax 从 179 掉到 22）。所以静止态**不设** perspective，只在翻转动画期间
     由 .flip-3d 临时开启 —— 翻转的立体感完全保留，静止阅读时文字走次像素抗锯齿。 */
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.flip-scene.flip-3d { perspective: 1400px; }
.flip-inner {
  /* ⚠️ 不要删掉这个 relative：正面右上角的「⛶ 全屏」按钮（.fs-btn）是 absolute，
     它的定位基准就是这里（.flip-face 是 static，不会形成定位上下文）。
     一旦改成 static，按钮会飘到 flip-scene 之外（2026-09-14 审计提示）。 */
  position: relative;
  /* 清晰度关键（2026-09-18）：
     `preserve-3d` 会让 Chrome 建立 3D 渲染上下文并**关闭 LCD 次像素抗锯齿**，
     文字笔画因此变细发虚（用户反馈「像蒙了一层雾」）。
     实测：带 3D 上下文时文字边缘彩色分量 chromaMax≈22（灰度抗锯齿）；
     去掉后 ≈179（次像素抗锯齿），锐度恢复。
     所以静止态一律 flat，只有翻转过渡的那 600ms 由 .flip-3d 临时开启（见 script 中 flip3d）。
     正反面显隐由下面的 visibility 规则负责，不依赖 backface 剔除，flat 下不会双影。 */
  transform-style: flat;
  transition: transform .55s cubic-bezier(.2, .7, .3, 1);
  /* 舞台高度取正/反面最大高度，但不超过视窗预留值（vh-顶栏-底部操作条-提示条） */
  max-height: min(72vh, 780px);
  min-height: 280px;
}
/* 仅翻转动画期间启用 3D 渲染上下文（动画结束即移除，见 script 中 FLIP_3D_MS） */
.flip-inner.flip-3d { transform-style: preserve-3d; }
.flip-inner.flipped { transform: rotateY(180deg); }

/* 正反面叠放：用 grid 让两面占据**同一个单元格**（grid-area: 1/1），
   从而 .flip-inner 的高度 = max(正面, 背面) 内容高；超过 max-height 则各自内滚。
   （2026-09-20 round124 合并：此处原有一条更早的 `.flip-face{position:absolute;inset:0}`
   定义，其 position/inset 早已被本块的 `position: static` 覆盖 → 是死代码且极易误导
   （后人往旧块加属性会以为生效）。现已合并为单块。别再拆成两块。） */
.flip-face {
  position: static;
  grid-area: 1 / 1;
  max-height: min(72vh, 780px);
  min-height: 280px;
  display: flex;
  flex-direction: column;
  /* ⚠️⚠️ 必须是 visible，不能是 hidden（2026-09-20 定案，反面"翻面一秒后消失"的真因）：
     本组件用 grid 叠放两面，并靠 `visibility` 显隐（见下面 .flip-inner.flipped 那两条），
     **不依赖背面剔除** —— 所以 backface-visibility 在这里没有正面作用，只有副作用。
     副作用怎么产生的：静止态 .flip-inner 是 flat（transform-style: flat，为保文字锐利），
     此时父级的 rotateY(180deg) 与子级 .flip-back 自身的 rotateY(180deg) 会**在扁平上下文里
     相加成 360°** → 反面把"背"朝向观察者 → backface-visibility: hidden 把它整面剔除 →
     反面连同顶部按钮条一起消失，只剩 .flip-inner 自己的底色（用户反馈「只显示一秒钟就不见了」，
     正好对应 .flip-3d 的 600ms 自动关闭：动画期间是 preserve-3d 所以两面各自独立旋转、可见）。
     修复：两侧都设为 visible。实测反面可命中（elementFromPoint 落在 .flip-back 内），
     文字方向正确（保持子级 180°，净 360°，不会镜像）；正面/反面显隐仍由 visibility 控制，无双影。 */
  backface-visibility: visible;
  -webkit-backface-visibility: visible;
  min-width: 0;
  overflow: hidden;
}
.flip-back { transform: rotateY(180deg); }

/* 正面整面可点：正面 body 也需要滚动 */
.flip-front .face-scroll {
  overflow-y: auto;
  overflow-x: hidden;
  flex: 1;
  padding: 0 2px;
}

/* 背面结构：back-top 固定在顶部，back-body 内滚 */
.back-top {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
  flex-shrink: 0;
}
.back-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 2px;
}

.flip-inner { display: grid; }
.flip-inner.flipped .flip-front { visibility: hidden; }
.flip-inner:not(.flipped) .flip-back { visibility: hidden; }

/* ⚠️⚠️ 挡住`.card-item:hover` 的位移，必须**按面区分**（2026-09-20 round127 定案，修正 round125 的错）

   背景：翻转卡的两面都带 `.card-item` class（模板 `flip-face flip-front/back card-item`），
   于是会吃到「全局 `.card-item:hover{transform:translateY(-2px)}`（styles.css:117）」
   以及各主题的 `:root[data-style='x'] .card-item:hover{...}`。但它们**不是列表卡片**：
   两面靠 grid 完全重叠，并共享父级 `.flip-inner.flipped{rotateY(180deg)}` 的翻面 transform。
   在 flat 上下文里父子 transform 相加 → 多出来的位移会和翻面叠加 → 观感错位。

   ❌ round125 的写法（**错的，已造成更严重的新 bug**，仅作反面教材，切勿照抄/复活）：
      `.flip-scene .flip-face.card-item:hover` → `transform: none`
   它想「把位移归零」，但 `transform` 是**单值属性** —— 归零的同时把 `.flip-back`
   自己的 `transform: rotateY(180deg)` **也一起清掉了**。
   而背面之所以能正常显示，正是靠「父级 180° + 自身 180° = 净 360°」。
   自身那 180° 一没，净剩父级的 180° → **整块内容变成镜像**：
   文字左右反读、`.back-top` 里的按钮顺序倒过来（「看回问题」跑到最右）、图片也镜像。
   真机取证（CSS.getMatchedStylesForNode，hover 态，按优先级低→高）：
     [5] .card-item:hover                            → translateY(-2px)
     [7] .flip-back[data-v-…]                        → rotateY(180deg)      ← 命根子
     [8] .flip-scene .flip-face.card-item[data-v-…]:hover → none            ← round125，赢
   computed=“none”，第一颗按钮 x 从 118 → 1186（横向翻转 1147px）。
   且因为它对**所有主题**生效（那条 .card-item:hover 是全局基础规则），
   连原本只有轻微 2px 错位的默认/经典主题也一起变成整块镜像 —— 比修之前更糟。

   ✅ 正确写法：**按面分别写回各自应有的 transform**，既消灭主题位移，又不碰 rotateY。
      - 正面：本来没有 transform → 写 `none`
      - 背面：必须保住 `rotateY(180deg)` → **原样写回**
   加 `!important` 是为了压过 `:root[data-style=x]` 系主题规则（它们 `:root` 计入特异性，
   详见 styles.css:116 注释）；已验证仅靠特异性在同一次匹配里压不住 round125 那条旧规则。

   ⚠️ 改动此规则前务必先读这段：**「归零 transform」和「保住 rotateY」是一对矛盾**，
   `transform` 单值属性无法只清一半。任何后续「加个 hover 效果」的想法，
   都要先确认不会覆盖掉 `.flip-back` 的 rotateY，否则又会镜像。
   hover 的边框/阴影（颜色类）反馈不受影响，仍然保留。 */
.flip-scene .flip-front.card-item:hover { transform: none; }
.flip-scene .flip-back.card-item:hover { transform: rotateY(180deg); }


.options { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.opt {
  text-align: left; border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px;
  background: var(--panel); cursor: pointer; display: flex; gap: 8px; align-items: flex-start;
  font: inherit; color: var(--ink); width: 100%;
}
.opt:hover { border-color: var(--blue); }
.opt.correct { border-color: var(--green); background: rgba(22, 163, 74, .08); cursor: default; }
.opt.wrong { border-color: var(--red); background: rgba(220, 38, 38, .08); }
.mark { color: var(--green); font-weight: 700; }

/* 操作区：独立块，不参与翻转，翻面后才显示 */
.flip-controls {
  margin-top: 4px;
  padding: 10px 4px 2px;
  border-top: 1px dashed var(--line);
  background: linear-gradient(to bottom, rgba(255,255,255,0), var(--page-bg) 40%);
}
.rate-row { display: flex; gap: 10px; justify-content: flex-end; margin-top: 12px; flex-wrap: wrap; }
.rate { border-radius: 8px; font-weight: 600; }
.rate.bad { color: var(--red); border-color: #fca5a5; }
.rate.mid { color: var(--amber); border-color: #fcd34d; }
.rate.good { color: var(--green); border-color: #86efac; }
.rate.guess { color: var(--blue); border-color: #93c5fd; }
.mnemonic { margin-top: 12px; padding: 8px 12px; background: var(--code-bg); border-radius: 8px; font-size: 13px; color: var(--ink-2); }

.meta-row { display: flex; gap: 14px; flex-wrap: wrap; }
.meta-group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.meta-label { font-size: 12px; color: var(--ink-2); }
.chip.mini { font-size: 12px; padding: 2px 10px; }

/* 图片大屏显示：横屏横显、竖屏竖显，自适应容器，最大化利用可用空间 */
.face-scroll :deep(img), .face-scroll img {
  max-width: 100%;
  max-height: 60vh;
  width: auto;
  height: auto;
  object-fit: contain;
  display: block;
  margin: 8px auto;
  border-radius: 8px;
}

/* 滚动条美化 */
.face-scroll::-webkit-scrollbar { width: 6px; }
.face-scroll::-webkit-scrollbar-thumb { background: var(--line); border-radius: 3px; }

/* 移动端/平板：收紧卡片内边距，按钮自动换行 */
@media (max-width: 720px) {
  .flip-face.card-item { padding: 12px 14px; }
  .flip-inner { min-height: 320px; max-height: 62vh; }
  .flip-face { min-height: 320px; max-height: 62vh; }
  .face-scroll :deep(img), .face-scroll img { max-height: 50vh; }
  .rate-row { justify-content: stretch; gap: 8px; }
  .rate-row .btn { flex: 1 1 44%; }
  .meta-row { gap: 8px; }
  .back-top { flex-wrap: wrap; }
}

/* 全屏放大按钮（正面右上角）
   定位基准 = .flip-inner（它必须是 position: relative，见该规则处的警告） */
.fs-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 5;
  font-size: 12px;
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  color: var(--ink-2);
  cursor: pointer;
  opacity: 0.7;
  transition: opacity .15s;
}
.fs-btn:hover { opacity: 1; }

/* 正反面内容全屏放大层
   ⚠️ 颜色必须全部走主题变量：这里原来写死 rgba(0,0,0,.92) 黑底 + #fff/#e8e8e8 白字，
   在白天/护眼主题下全屏就是一块突兀的黑板（2026-09-14 用户反馈）。 */
.content-fs-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: var(--bg, #f5f6f8);
  display: flex;
  flex-direction: column;
}
.content-fs-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  background: var(--panel, #fff);
  border-bottom: 1px solid var(--line, #e3e8ee);
  color: var(--ink, #16202c);
  flex-shrink: 0;
}
.content-fs-label { font-size: 14px; font-weight: 600; }
.content-fs-zoom { font-size: 13px; color: var(--ink-2, #5b6b7d); font-variant-numeric: tabular-nums; }
.content-fs-bar .btn { background: var(--panel, #fff); color: var(--ink, #16202c); border-color: var(--line, #e3e8ee); }
.content-fs-stage {
  flex: 1;
  overflow: hidden;
  position: relative;
  cursor: grab;
  touch-action: none;
  display: flex;
  align-items: center;
  justify-content: center;
}
.content-fs-stage:active { cursor: grabbing; }
.content-fs-inner {
  transform-origin: center center;
  color: var(--ink, #16202c);
  max-width: 90vw;
  padding: 24px;
  box-sizing: border-box;
}
.content-fs-inner :deep(img) { max-width: 100%; border-radius: 8px; display: block; margin: 8px auto; }
.content-fs-inner :deep(p), .content-fs-inner :deep(li) { color: var(--ink, #16202c); line-height: 1.8; }
.content-fs-inner :deep(h1), .content-fs-inner :deep(h2), .content-fs-inner :deep(h3) { color: var(--ink, #16202c); }
.content-fs-inner :deep(code) { background: var(--code-inline, #eef2f6); color: var(--ink, #16202c); padding: 1px 4px; border-radius: 4px; }
.content-fs-inner :deep(pre) { background: var(--code-bg, #f6f8fa); border-radius: 8px; padding: 12px; overflow: auto; }
.content-fs-inner :deep(table) { color: var(--ink, #16202c); border-collapse: collapse; }
.content-fs-inner :deep(td), .content-fs-inner :deep(th) { border: 1px solid var(--line, #e3e8ee); padding: 6px 10px; }
</style>