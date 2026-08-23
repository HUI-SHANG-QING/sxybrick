// 把 AI 生成的 icon-hero.jpg 缩放成规范的 512 / 192 PNG，供 PWA manifest 使用
// 用法：node scripts/convert-icon.mjs
import sharp from 'sharp';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, '..', 'public', 'icon-hero.jpg');

for (const size of [512, 192]) {
  await sharp(src).resize(size, size, { fit: 'cover' }).png().toFile(join(__dirname, '..', 'public', `icon-hero-${size}.png`));
  console.log('生成 icon-hero-' + size + '.png');
}