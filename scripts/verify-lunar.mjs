// 全量交叉验证：自研 lunar.js vs lunar-javascript（2000-2040 逐日）
import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ref = JSON.parse(readFileSync('C:/Users/ASUS/.workbuddy/binaries/node/workspace/lunar-ref.json', 'utf8'));
const { getLunar } = await import('../src/utils/lunar.js');

let bad = 0, total = 0;
const samples = [];
for (const [key, r] of Object.entries(ref)) {
  total++;
  const [y, m, d] = key.split('-').map(Number);
  const mine = getLunar(new Date(y, m - 1, d));
  const mineMonth = mine.isLeap ? -Math.abs(mine.month) : mine.month;
  if (mineMonth !== r.month || mine.day !== r.day || mine.ganzhiYear !== r.ganzhi || mine.zodiac !== r.zodiac) {
    bad++;
    if (samples.length < 10) {
      samples.push({ key, mine: `${mineMonth}/${mine.day} ${mine.ganzhiYear}${mine.zodiac}`, ref: `${r.month}/${r.day} ${r.ganzhi}${r.zodiac}` });
    }
  }
}
console.log(`total=${total} mismatched=${bad}`);
if (bad) {
  for (const s of samples) console.log(JSON.stringify(s));
  process.exit(1);
}
// 打印几个抽样（含今天）供展示
for (const k of ['2026-08-28', '2026-02-17', '2024-02-10', '2025-01-29', '2020-01-25', '2000-02-05']) {
  const r = ref[k];
  console.log(`${k} → ${r.month}/${r.day} ${r.ganzhi}${r.zodiac} ${r.monthCn}月${r.dayCn}`);
}
console.log('ALL MATCH ✓');
