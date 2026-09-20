// tests/round126-image-clarity.test.mjs —— round126：修复「上传的图片在预览/灯箱里不如原图清晰」
//
// 用户反馈（原话）：
//   「怎么上传的图片的清晰度没有我上传的画质一样清楚，尤其是卡片预览的图片，
//     清晰度明显不如我上传的原画质超清，4k图片」
//
// 排查结论（CDP 真机量化，逐项隔离）：
//   ✅ 存储端**无压缩**：CardModal.insertImage → images.putImage(id, file, file.type)
//      原样存 Blob；实测 3840×2160 的图存进 IndexedDB 后 naturalWidth 仍是 3840。
//      （img-compress.js 只服务 AI 多模态，不进卡片图片链路；sync 打包是 base64 原样搬运。）
//   ✅ 常显无 3D 上下文：round122 已让 .flip-scene/.flip-inner 静止态 flat。
//   ❌ **真凶**：`.img-lb-img { will-change: transform }` —— 常驻 will-change 会把图片
//      提升为**合成层**，Chrome 在 DPR>1 屏上以**较低分辨率**光栅化它 → 灯箱里看大图发糊。
//      真机 A/B（同一次会话、同一张 4K 图、同一显示尺寸，只切换 will-change）：
//         will-change: auto      → 截图锐度 4.727
//         will-change: transform → 截图锐度 3.955      ⇒ 修复后锐 +19.5%
//      （锐度 = PNG 解码后逐像素 |2c - l - r| 的平均值，见 E:/tmp/audit126/sharpness.mjs。
//       注意：**不能用 canvas drawImage 后测锐度** —— 那测的是解码位图，与屏幕光栅化无关，
//       两种 will-change 的值会一模一样（这正是本项目此前用 chromaMax 测文字抗锯齿时
//       漏掉图片问题的原因）。必须以「屏幕截图像素」为准。）
//
// 修法：与 round122 处理 3D 上下文**完全同构** ——「静止关、交互开」。
//   灯箱静止看图（用户 99% 的时间）走 will-change: auto（清晰）；
//   拖拽平移 / 滚轮缩放期间由 .is-busy 临时开启（保 transform 动画流畅）。
//
// 另外两处排查后**有意不动**，理由记录在此防止后人「顺手修」：
//   · progress 主题给 .card-item/.panel/.card-3d 的 will-change: transform + preserve-3d
//     —— 那是该主题的「3D 鼠标跟踪倾斜」核心特性；且 round122 已把翻转卡
//     （.flip-scene .card-item）显式排除。动它会破坏主题交互，收益不成比例。
//   · 预览层左右留白 clamp(16px,7vw,140px) —— 它是为**正文行宽**设计的。曾试过用负边距
//     把图片撑宽，但图片的真实容器是 .flip-scene（已在留白之内），外层 .preview-body
//     还有 overflow-x:auto，撑宽会引入横向滚动条。实测图片宽度 964px 无变化 → 方案无效，
//     已放弃。用户要「看清 4K 细节」的正道是点图进灯箱（本轮已修好）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MDR = readFileSync(new URL('../src/components/MarkdownRenderer.vue', import.meta.url), 'utf8');
const CODE = MDR.replace(/\/\*[\s\S]*?\*\//g, '');   // 剥注释，防把警告文案里的属性名当声明

test('灯箱图片静止态不得常驻 will-change（会被低分辨率光栅化 → 看大图发糊）', () => {
  // .img-lb-img 基础块里必须是 auto
  const block = CODE.slice(CODE.indexOf('.img-lb-img {'), CODE.indexOf('.img-lb-img.is-busy'));
  assert.ok(block.length > 0, '应能找到 .img-lb-img 规则块与 .is-busy 规则');
  assert.match(block, /will-change:\s*auto/,
    '.img-lb-img 静止态必须是 will-change: auto（常驻 transform 会让图片被低分辨率光栅化）');
  assert.ok(!/will-change:\s*transform/.test(block),
    '.img-lb-img 基础块不得出现 will-change: transform');

  // 必须存在交互期规则来接管
  assert.match(CODE, /\.img-lb-img\.is-busy \{\s*will-change:\s*transform;?\s*\}/,
    '拖拽/缩放期必须有 .img-lb-img.is-busy { will-change: transform } 接管（保动画流畅）');
});

test('灯箱「静止关、交互开」的开关必须真的接上（否则要么糊、要么掉帧）', () => {
  // 状态字段
  assert.match(CODE, /busy:\s*false/, 'lb 状态里应有 busy 字段');
  assert.match(CODE, /function markBusy\(/, '应有 markBusy() 统一开关函数');
  assert.match(CODE, /clearTimeout\(lbBusyTimer\)[\s\S]{0,200}?lbBusyTimer = setTimeout\(\(\) => \{ lb\.value\.busy = false; \}/,
    'markBusy 应带延时复位（避免尾帧立刻掉回低质量造成闪变）');

  // 三条交互路径都要标 busy
  assert.match(CODE, /function setZoom\(z, cx, cy\) \{\s*markBusy\(\);/,
    'setZoom（滚轮缩放）应标 busy');
  assert.match(CODE, /function onDown\(e\) \{[\s\S]{0,300}?markBusy\(/,
    'onDown（开始拖拽）应标 busy');
  assert.match(CODE, /function onMove\(e\) \{[\s\S]{0,200}?markBusy\(/,
    'onMove（拖拽中）应续期 busy');

  // 模板绑定
  assert.match(MDR, /class="img-lb-img"\s*\n\s*:class="\{ 'is-busy': lb\.busy \}"/,
    '模板里的 img 应绑定 :class="{ \'is-busy\': lb.busy }"');

  // 定时器清理，避免卸载后回调写已销毁组件的响应式状态
  assert.match(CODE, /onBeforeUnmount\(\(\) => \{[\s\S]{0,200}?clearTimeout\(lbBusyTimer\)/,
    'onBeforeUnmount 应清理 lbBusyTimer');
});

test('图片存储链路不得引入压缩（原图必须原样入库）', () => {
  const IMAGES = readFileSync(new URL('../src/images.js', import.meta.url), 'utf8');
  const putBlock = IMAGES.slice(IMAGES.indexOf('export async function putImage'), IMAGES.indexOf('export function base64ToBlob'));
  assert.ok(putBlock.length > 0, '应能定位 putImage');
  // 存的是入参 blob 本身，不得做任何转码
  assert.match(putBlock, /db\.images\.put\(\{\s*id,\s*blob,\s*mime/, 'putImage 应原样存 blob');
  assert.ok(!/toDataURL|toBlob|canvas|drawImage|quality/.test(putBlock),
    'putImage 不得对图片做 canvas 转码 / 压缩（会直接损失画质）');

  const MODAL = readFileSync(new URL('../src/components/CardModal.vue', import.meta.url), 'utf8');
  assert.match(MODAL, /await putImage\(id, file, file\.type\)/,
    'CardModal 插入图片应把原始 File 直接交给 putImage，不得先压缩');
});

test('翻转动画期的 3D 上下文仍按 round122 管理（不得回退）', () => {
  // 本条是 round122 的镜像守卫：本轮改的是灯箱，不得顺手把 FlipCard 的时序号改坏
  const FLIP = readFileSync(new URL('../src/components/FlipCard.vue', import.meta.url), 'utf8');
  assert.match(FLIP, /const flip3d = ref\(false\)/, 'FlipCard 仍应有 flip3d 开关');
  assert.match(FLIP, /\.flip-inner \{[\s\S]{0,900}?transform-style:\s*flat/, '.flip-inner 静止态仍应 flat');
});
