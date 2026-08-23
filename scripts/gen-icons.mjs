// 生成 App 图标 PNG（192/512/maskable），纯 Node 内置 zlib，零依赖。
// 复刻 public/icon.svg 的设计：深色圆角底 + 白色卡片 + 蓝色条。
// 用法：node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'public');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([l, t, data, c]);
}
function encodePNG(w, h, px) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) { raw[y * stride] = 0; px.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4); }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  if (x >= x0 + r && x <= x1 - r) return true;
  if (y >= y0 + r && y <= y1 - r) return true;
  const cx = x < x0 + r ? x0 + r : x1 - r;
  const cy = y < y0 + r ? y0 + r : y1 - r;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

const COL = { bg: [22, 32, 44], white: [255, 255, 255], blue: [37, 99, 235], gray1: [203, 213, 225], gray2: [226, 232, 240] };

function build(size) {
  const s = size / 512;
  const E = v => Math.round(v * s);
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, c) => { const i = (y * size + x) * 4; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255; };
  const fill = (x0, y0, x1, y1, r, c) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
      if (inRoundRect(x, y, E(x0), E(y0), E(x1), E(y1), E(r))) set(x, y, c);
  };
  // 元素坐标采用 512 坐标系统
  fill(0, 0, 512, 512, 96, COL.bg);        // 背景
  fill(96, 120, 416, 320, 28, COL.white);  // 白卡
  fill(128, 152, 384, 184, 12, COL.blue);  // 蓝条
  fill(128, 208, 384, 224, 8, COL.gray1);  // 灰线1
  fill(128, 240, 308, 252, 6, COL.gray2);  // 灰线2
  fill(96, 352, 416, 392, 20, COL.blue);   // 蓝按钮
  return px;
}

mkdirSync(OUT, { recursive: true });
for (const size of [512, 192]) {
  const png = encodePNG(size, size, build(size));
  writeFileSync(join(OUT, `icon-${size}.png`), png);
  console.log('生成 icon-' + size + '.png');
}