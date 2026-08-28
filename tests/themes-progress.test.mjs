// 测试：progress 主题注册 + SxyBrick 主题系统扩展
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 1. STYLES 含 progress
test('STYLES 列表包含 progress 主题', async () => {
  const src = await import('../src/stores/theme.js');
  const styles = src.STYLES;
  const ids = styles.map(s => s.id);
  assert.ok(ids.includes('progress'), `STYLES 应含 progress，实际 = ${ids.join(', ')}`);
  const progress = styles.find(s => s.id === 'progress');
  assert.ok(progress.name && progress.desc, 'progress 必须有 name 和 desc');
  assert.match(progress.desc, /暖|Progress/i);
});

// 2. styles.css 含 progress 段
test('styles.css 含完整 progress 主题段', () => {
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  // 三档主题段落都要有
  assert.match(css, /:root\[data-style=['"]progress['"]\]/, '缺 light 段');
  assert.match(css, /\[data-style=['"]progress['"]\]\[data-theme=['"]dark['"]\]/, '缺 dark 段');
  assert.match(css, /\[data-style=['"]progress['"]\]\[data-theme=['"]eye['"]\]/, '缺 eye 段');

  // 关键变量
  assert.match(css, /--accent: #e07b3c/, '缺 Progress 品牌强调色 #e07b3c');
  assert.match(css, /--bg: #faf8f5/, '缺 Progress 背景 #faf8f5');
  assert.match(css, /--ink: #3d3328/, '缺 Progress 主文本 #3d3328');

  // 关键动效
  assert.match(css, /ambient-layer|app-shell::before|progress-ambient/, '缺 ambient 动效');
  assert.match(css, /gradient-text|progress-gradient/, '缺 gradient-text');
  assert.match(css, /card-3d/, '缺 3D 卡片类');
  assert.match(css, /progress-sheen/, '缺按钮 sheen 流光');
  assert.match(css, /prefers-reduced-motion/, '缺无障碍适配');
});

// 3. STYLES 数量 = 11（10 已有 + progress）
test('STYLES 数量 ≥11 且 progress 在合法集内', async () => {
  const { STYLES } = await import('../src/stores/theme.js');
  assert.ok(STYLES.length >= 11, `STYLES 应 ≥11（实际 ${STYLES.length}）`);
  // 必备主题 id
  const ids = new Set(STYLES.map(s => s.id));
  for (const required of ['classic', 'card', 'moba', 'space', 'adventure', 'focus', 'flat', 'paper', 'amber', 'guofeng', 'progress']) {
    assert.ok(ids.has(required), `缺主题 ${required}`);
  }
});
