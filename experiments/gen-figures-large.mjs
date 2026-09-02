// experiments/gen-figures-large.mjs —— 方向 A 论文【大规模实验版】图表生成
// 读取 experiments/results-large.json（主实验）与 results-integrity.json（诚信审计实验），
// 输出 paper/figures/*.png（SVG → sharp 光栅化），IEEE 风格、全英文标注、单色打印可读。
// 运行：node experiments/gen-figures-large.mjs
import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, '..', 'paper', 'figures');
const R = JSON.parse(readFileSync(join(__dir, 'results-large.json'), 'utf8'));
let A = null;
try { A = JSON.parse(readFileSync(join(__dir, 'results-integrity.json'), 'utf8')); } catch { /* 审计结果缺失时跳过相关图 */ }

const C = {
  axis: '#1a1a1a', grid: '#e2e2e2', diag: '#999999',
  sm2: '#7f7f7f', fsrsD: '#1f77b4', fsrsT: '#ff7f0e',
  fixed: '#d62728', feedback: '#2ca02c', target: '#1a1a1a',
  accent: '#1f77b4', warn: '#9467bd', purple: '#9467bd',
};
const FONT = 'Arial, Helvetica, sans-serif';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function render(name, svg) {
  mkdirSync(OUT, { recursive: true });
  const p = join(OUT, name + '.png');
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(p);
  return p;
}
function makePlot({ w, h, ml = 78, mr = 26, mt = 44, mb = 56, xmin, xmax, ymin, ymax }) {
  const pw = w - ml - mr, ph = h - mt - mb;
  return { w, h, ml, mt, pw, ph, xmin, xmax, ymin, ymax, X: x => ml + ((x - xmin) / (xmax - xmin)) * pw, Y: y => mt + (1 - (y - ymin) / (ymax - ymin)) * ph };
}
const ticks = (min, max, n) => Array.from({ length: n + 1 }, (_, i) => min + ((max - min) / n) * i);
function axis(p, { xticks, yticks, xfmt = v => v, yfmt = v => v, xLabel, yLabel }) {
  const y0 = p.mt + p.ph;
  let s = '';
  s += `<line x1="${p.ml}" y1="${y0}" x2="${p.ml + p.pw}" y2="${y0}" stroke="${C.axis}" stroke-width="1.4"/>`;
  s += `<line x1="${p.ml}" y1="${y0}" x2="${p.ml}" y2="${p.mt}" stroke="${C.axis}" stroke-width="1.4"/>`;
  for (const t of xticks) {
    const x = p.X(t);
    s += `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y0 + 5}" stroke="${C.axis}" stroke-width="1"/>`;
    s += `<text x="${x}" y="${y0 + 20}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="middle">${xfmt(t)}</text>`;
  }
  for (const t of yticks) {
    const y = p.Y(t);
    s += `<line x1="${p.ml}" y1="${y}" x2="${p.ml - 5}" y2="${y}" stroke="${C.axis}" stroke-width="1"/>`;
    s += `<line x1="${p.ml}" y1="${y}" x2="${p.ml + p.pw}" y2="${y}" stroke="${C.grid}" stroke-width="1"/>`;
    s += `<text x="${p.ml - 9}" y="${y + 4}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="end">${yfmt(t)}</text>`;
  }
  if (xLabel) s += `<text x="${p.ml + p.pw / 2}" y="${p.h - 12}" font-family="${FONT}" font-size="13" fill="${C.axis}" text-anchor="middle">${xLabel}</text>`;
  if (yLabel) s += `<text x="18" y="${p.mt + p.ph / 2}" font-family="${FONT}" font-size="13" fill="${C.axis}" text-anchor="middle" transform="rotate(-90 18 ${p.mt + p.ph / 2})">${yLabel}</text>`;
  return s;
}
function polyline(pts, color, width = 2.2, dash = null) {
  const d = pts.map((pt, i) => (i ? 'L' : 'M') + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1)).join(' ');
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}
const circles = (pts, color, r = 4) => pts.map(pt => `<circle cx="${pt[0].toFixed(1)}" cy="${pt[1].toFixed(1)}" r="${r}" fill="${color}"/>`).join('');
function band(upper, lower, color, opacity = 0.18) {
  const up = upper.map((pt, i) => (i ? 'L' : 'M') + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1)).join(' ');
  const dn = lower.slice().reverse().map(pt => 'L' + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1)).join(' ');
  return `<path d="${up} ${dn} Z" fill="${color}" fill-opacity="${opacity}" stroke="none"/>`;
}
function errbar(x, y, lo, hi, color) {
  return `<line x1="${x}" y1="${lo}" x2="${x}" y2="${hi}" stroke="${color}" stroke-width="1.6"/>`
    + `<line x1="${x - 7}" y1="${hi}" x2="${x + 7}" y2="${hi}" stroke="${color}" stroke-width="1.6"/>`
    + `<line x1="${x - 7}" y1="${lo}" x2="${x + 7}" y2="${lo}" stroke="${color}" stroke-width="1.6"/>`;
}
function legend(items, x, y) {
  let s = '', cx = x;
  for (const it of items) {
    s += `<rect x="${cx}" y="${y}" width="14" height="14" rx="2" fill="${it.color}"/>`;
    s += `<text x="${cx + 19}" y="${y + 12}" font-family="${FONT}" font-size="12.5" fill="${C.axis}">${esc(it.label)}</text>`;
    cx += 19 + String(it.label).length * 6.4 + 22;
  }
  return s;
}
const svgWrap = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#ffffff"/>${body}</svg>`;

// ============================================================
// Fig 1：系统架构（沿用）
// ============================================================
function fig1() {
  const w = 1500, h = 880;
  const box = (x, y, bw, bh, fill, stroke, title, sub) => `
    <rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/>
    <text x="${x + bw / 2}" y="${y + 34}" font-family="${FONT}" font-size="16" font-weight="bold" fill="#111" text-anchor="middle">${esc(title)}</text>
    ${sub ? `<text x="${x + bw / 2}" y="${y + 56}" font-family="${FONT}" font-size="12" fill="#444" text-anchor="middle">${esc(sub)}</text>` : ''}`;
  const arrow = (x1, y1, x2, y2, label, lx, ly) => {
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, px = -uy, py = ux, ah = 11, aw = 7;
    const bx = x2 - ux * ah, by = y2 - uy * ah;
    return `<line x1="${x1}" y1="${y1}" x2="${bx}" y2="${by}" stroke="#333" stroke-width="2"/>
      <polygon points="${x2},${y2} ${bx + px * aw},${by + py * aw} ${bx - px * aw},${by - py * aw}" fill="#333"/>
      ${label ? `<text x="${lx}" y="${ly}" font-family="${FONT}" font-size="12.5" fill="#222" text-anchor="middle">${esc(label)}</text>` : ''}`;
  };
  let s = '';
  s += box(70, 90, 320, 110, '#eef3fb', '#1f77b4', 'Review History', 'ratings (0/1/2) + timestamps, stored locally');
  s += box(590, 90, 320, 110, '#eaf4ec', '#2ca02c', 'FSRS-4.5 Scheduler', 'power-law memory model, 19 trainable weights');
  s += box(1110, 90, 320, 110, '#fdf1e7', '#ff7f0e', 'Learner', 'recall outcome sampled from ground-truth model');
  s += arrow(390, 145, 590, 145, 'review events', 490, 133);
  s += arrow(910, 145, 1110, 145, 'scheduled interval', 1010, 133);
  s += arrow(1270, 200, 1270, 300, '', 0, 0);
  s += arrow(1270, 300, 230, 300, 'feedback (new ratings)', 750, 288);
  s += arrow(230, 300, 230, 200, '', 0, 0);
  s += box(70, 360, 320, 110, '#fdf1e7', '#ff7f0e', 'Finite-Difference Trainer', 'log-loss objective, central-difference gradients');
  s += box(590, 360, 320, 110, '#f1eefb', '#9467bd', 'Calibration Backtest', 'ECE / Brier / bias on predicted vs. actual recall');
  s += box(1110, 360, 320, 110, '#eef3fb', '#1f77b4', 'Adaptive Retention', 'per-subject target from mastery level');
  s += arrow(230, 300, 230, 360, 'history', 170, 330);
  s += arrow(750, 300, 750, 360, 'history', 690, 330);
  s += arrow(230, 360, 230, 200, 'personalized weights', 170, 268);
  s += arrow(750, 360, 750, 200, 'desired retention', 690, 268);
  s += arrow(1270, 360, 1270, 200, 'per-subject target', 1210, 268);
  s += arrow(1270, 300, 1270, 360, 'mastery level', 1290, 335);
  s += box(70, 560, 1360, 130, '#f7f7f7', '#999999', 'Integrity & Reproducibility Layer', '');
  s += `<text x="${w / 2}" y="600" font-family="${FONT}" font-size="14" fill="#333" text-anchor="middle">deterministic LCG seeds | fixed time base | scheduler fuzz disabled (w17 = 0) | held-out split | negative controls | gain sweep | per-learner distributions</text>`;
  s += `<text x="${w / 2}" y="628" font-family="${FONT}" font-size="12.5" fill="#666" text-anchor="middle">All computation is local (offline / privacy-preserving); no server round-trip required.</text>`;
  s += `<text x="${w / 2}" y="656" font-family="${FONT}" font-size="12.5" fill="#666" text-anchor="middle">Scripts: experiments/run-large.mjs (main) and experiments/run-integrity.mjs (self-audit).</text>`;
  return svgWrap(w, h, s);
}

// ============================================================
// Fig 2：R1b 记忆一致性校准（双面板：matched / mismatched）
// ============================================================
function fig2() {
  const w = 1320, h = 700;
  const gap = 70, pad = 92, bw = (w - pad * 2 - gap) / 2, ph = h - 96 - 96;
  const y0 = 96;
  const panel = (ox, title, pooled, stat) => {
    const X = v => ox + v * bw;
    const Y = v => y0 + ph - v * ph;
    let s = `<text x="${ox + bw / 2}" y="42" font-family="${FONT}" font-size="15" font-weight="bold" fill="#111" text-anchor="middle">${esc(title)}</text>`;
    for (const t of ticks(0, 1, 5)) {
      const y = Y(t);
      s += `<line x1="${ox}" y1="${y}" x2="${ox + bw}" y2="${y}" stroke="${C.grid}"/>`;
      s += `<text x="${ox - 8}" y="${y + 4}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="end">${t.toFixed(1)}</text>`;
      const x = X(t);
      s += `<text x="${x}" y="${y0 + ph + 20}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="middle">${t.toFixed(1)}</text>`;
    }
    s += `<line x1="${ox}" y1="${y0 + ph}" x2="${ox + bw}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
    s += `<line x1="${ox}" y1="${y0}" x2="${ox}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
    s += polyline([[X(0), Y(0)], [X(1), Y(1)]], C.diag, 1.4, '6 4');
    const maxN = Math.max(...pooled.map(b => b.n));
    for (const b of pooled) {
      const r = 3 + 12 * Math.sqrt(b.n / maxN);
      s += `<circle cx="${X(b.predMean)}" cy="${Y(b.actualRate)}" r="${r.toFixed(1)}" fill="${C.accent}" fill-opacity="0.5" stroke="${C.accent}" stroke-width="1.2"/>`;
    }
    s += `<text x="${ox + bw / 2}" y="${y0 + ph + 42}" font-family="${FONT}" font-size="13" fill="${C.axis}" text-anchor="middle">Predicted recall probability</text>`;
    s += `<text x="${ox + bw - 4}" y="${y0 + 18}" font-family="${FONT}" font-size="12.5" fill="#333" text-anchor="end">ECE = ${stat.ece.mean} (macro ${stat.macroEce.mean})</text>`;
    s += `<text x="${ox + bw - 4}" y="${y0 + 36}" font-family="${FONT}" font-size="12.5" fill="#333" text-anchor="end">Brier = ${stat.brier.mean}   bias = ${stat.bias.mean}</text>`;
    return s;
  };
  let s = svgWrap(w, h, '');
  s = svgWrap(w, h,
    `<text x="${w / 2}" y="70" font-family="${FONT}" font-size="12.5" fill="#555" text-anchor="middle">Reliability diagram, memory-consistent synthetic learners (n = ${R.R1b.mismatched.n.mean} pooled predictions per condition). Bubble area proportional to bin size.</text>`
    + panel(pad, '(a) Matched: ground truth = evaluation weights', R.R1b.matched.pooledBuckets, R.R1b.matched)
    + panel(pad + bw + gap, '(b) Mismatched: per-learner truth jitter 0.7-1.3x', R.R1b.mismatched.pooledBuckets, R.R1b.mismatched));
  return s;
}

// ============================================================
// Fig 3：R2 训练收敛（5 seed 均值±sd）+ R2b 样本外
// ============================================================
function fig3() {
  const traces = R.R2.perSeed.map(r => r.trace);
  const L = Math.min(...traces.map(t => t.length));
  const pts = [];
  for (let i = 0; i < L; i++) {
    const vals = traces.map(t => t[i].loss).filter(v => v != null);
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, vals.length - 1));
    pts.push({ iter: traces[0][i].iter, mean: m, sd });
  }
  const w = 1320, h = 700;
  const gap = 70, pad = 92, bw = (w - pad * 2 - gap) / 2, ph = h - 96 - 96, y0 = 96;
  const ymin = Math.min(...pts.map(p => p.mean - p.sd)) - 0.004;
  const ymax = Math.max(...pts.map(p => p.mean + p.sd)) + 0.004;
  const X = v => pad + (v / (L - 1)) * bw;
  const Y = v => y0 + ph - ((v - ymin) / (ymax - ymin)) * ph;
  let sA = `<text x="${pad + bw / 2}" y="42" font-family="${FONT}" font-size="15" font-weight="bold" fill="#111" text-anchor="middle">(a) Finite-difference training convergence</text>`;
  for (const t of ticks(ymin, ymax, 5)) {
    const y = Y(t);
    sA += `<line x1="${pad}" y1="${y}" x2="${pad + bw}" y2="${y}" stroke="${C.grid}"/>`;
    sA += `<text x="${pad - 8}" y="${y + 4}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="end">${t.toFixed(3)}</text>`;
  }
  for (const t of ticks(0, L - 1, 6)) {
    const x = X(t);
    sA += `<text x="${x}" y="${y0 + ph + 20}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="middle">${Math.round(t)}</text>`;
  }
  sA += `<line x1="${pad}" y1="${y0 + ph}" x2="${pad + bw}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  sA += `<line x1="${pad}" y1="${y0}" x2="${pad}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  sA += band(pts.map(p => [X(p.iter), Y(p.mean + p.sd)]), pts.map(p => [X(p.iter), Y(p.mean - p.sd)]), C.accent);
  sA += polyline(pts.map(p => [X(p.iter), Y(p.mean)]), C.accent, 2.6);
  sA += `<text x="${pad + bw / 2}" y="${y0 + ph + 42}" font-family="${FONT}" font-size="13" fill="${C.axis}" text-anchor="middle">Iteration (mean of ${R.R2.design.seeds} independent histories, shaded = +/-1 SD)</text>`;
  sA += `<text x="${pad + bw - 4}" y="${y0 + 18}" font-family="${FONT}" font-size="12.5" fill="#333" text-anchor="end">log-loss ${R.R2.before.mean} to ${R.R2.after.mean} (improvement ${R.R2.improvement.mean})</text>`;

  // 面板 B：样本内 vs 样本外
  const x1 = pad + bw + gap;
  const groups = [
    { label: 'in-sample', trained: R.R2b.train.trained.mean, def: R.R2b.train.default.mean },
    { label: 'held-out', trained: R.R2b.test.trained.mean, def: R.R2b.test.default.mean },
  ];
  const gmax = Math.max(...groups.flatMap(g => [g.trained, g.def])) * 1.12;
  const Y2 = v => y0 + ph - (v / gmax) * ph;
  let sB = `<text x="${x1 + bw / 2}" y="42" font-family="${FONT}" font-size="15" font-weight="bold" fill="#111" text-anchor="middle">(b) Trained vs. default weights</text>`;
  for (const t of ticks(0, gmax, 5)) {
    const y = Y2(t);
    sB += `<line x1="${x1}" y1="${y}" x2="${x1 + bw}" y2="${y}" stroke="${C.grid}"/>`;
    sB += `<text x="${x1 - 8}" y="${y + 4}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="end">${t.toFixed(2)}</text>`;
  }
  sB += `<line x1="${x1}" y1="${y0 + ph}" x2="${x1 + bw}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  sB += `<line x1="${x1}" y1="${y0}" x2="${x1}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  const slot = bw / groups.length;
  groups.forEach((g, i) => {
    const cx = x1 + slot * i + slot * 0.5;
    const bwv = slot * 0.26;
    sB += `<rect x="${cx - bwv - 6}" y="${Y2(g.def)}" width="${bwv}" height="${y0 + ph - Y2(g.def)}" fill="${C.sm2}" stroke="#333" stroke-width="0.8"/>`;
    sB += `<rect x="${cx + 6}" y="${Y2(g.trained)}" width="${bwv}" height="${y0 + ph - Y2(g.trained)}" fill="${C.accent}" stroke="#333" stroke-width="0.8"/>`;
    sB += `<text x="${cx - bwv / 2 - 6}" y="${Y2(g.def) - 6}" font-family="${FONT}" font-size="12" fill="#111" text-anchor="middle">${g.def.toFixed(4)}</text>`;
    sB += `<text x="${cx + bwv / 2 + 6}" y="${Y2(g.trained) - 6}" font-family="${FONT}" font-size="12" fill="#111" text-anchor="middle">${g.trained.toFixed(4)}</text>`;
    sB += `<text x="${cx}" y="${y0 + ph + 20}" font-family="${FONT}" font-size="12.5" fill="#333" text-anchor="middle">${g.label}</text>`;
  });
  sB += legend([{ label: 'default weights', color: C.sm2 }, { label: 'trained weights', color: C.accent }], x1 + 10, y0 + 12);
  sB += `<text x="${x1 + bw / 2}" y="${y0 + ph + 42}" font-family="${FONT}" font-size="13" fill="${C.axis}" text-anchor="middle">Log-loss (lower is better); held-out = reviews 15-20 per card</text>`;
  return svgWrap(w, h, sA + sB);
}

// ============================================================
// Fig 4：R3 调度器对比（带 95% CI 误差棒）
// ============================================================
function fig4() {
  const w = 1320, h = 700;
  const gap = 70, pad = 96, bw = (w - pad * 2 - gap) / 2, ph = h - 96 - 96, y0 = 96;
  const bars = (ox, title, items, ymax, fmt, yLabel, target) => {
    const Y = v => y0 + ph - (v / ymax) * ph;
    let s = `<text x="${ox + bw / 2}" y="42" font-family="${FONT}" font-size="15" font-weight="bold" fill="#111" text-anchor="middle">${esc(title)}</text>`;
    for (const t of ticks(0, ymax, 5)) {
      const y = Y(t);
      s += `<line x1="${ox}" y1="${y}" x2="${ox + bw}" y2="${y}" stroke="${C.grid}"/>`;
      s += `<text x="${ox - 8}" y="${y + 4}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="end">${fmt(t)}</text>`;
    }
    s += `<line x1="${ox}" y1="${y0 + ph}" x2="${ox + bw}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
    s += `<line x1="${ox}" y1="${y0}" x2="${ox}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
    if (target != null) {
      const ty = Y(target);
      s += `<line x1="${ox}" y1="${ty}" x2="${ox + bw}" y2="${ty}" stroke="${C.target}" stroke-width="1.3" stroke-dasharray="6 4"/>`;
      s += `<text x="${ox + 6}" y="${ty - 6}" font-family="${FONT}" font-size="11" fill="${C.target}">target ${target}</text>`;
    }
    const slot = bw / items.length;
    items.forEach((b, i) => {
      const cx = ox + slot * i + slot * 0.5, bwd = slot * 0.5;
      const top = Y(b.value);
      s += `<rect x="${cx - bwd / 2}" y="${top}" width="${bwd}" height="${y0 + ph - top}" fill="${b.color}" stroke="#333" stroke-width="0.8"/>`;
      s += errbar(cx, top, Y(b.ci[1]), Y(b.ci[0]), '#111');
      s += `<text x="${cx}" y="${Y(b.ci[1]) - 12}" font-family="${FONT}" font-size="13" font-weight="bold" fill="#111" text-anchor="middle">${fmt(b.value)}</text>`;
      s += `<text x="${cx}" y="${y0 + ph + 20}" font-family="${FONT}" font-size="12" fill="#333" text-anchor="middle">${esc(b.label)}</text>`;
    });
    s += `<text x="${ox + bw / 2}" y="${y0 + ph + 42}" font-family="${FONT}" font-size="13" fill="${C.axis}" text-anchor="middle">${esc(yLabel)}</text>`;
    return s;
  };
  const rev = [
    { label: 'SM-2', value: R.R3.reviews.sm2.mean, ci: R.R3.reviews.sm2.ci95, color: C.sm2 },
    { label: 'FSRS default', value: R.R3.reviews.fsrsDefault.mean, ci: R.R3.reviews.fsrsDefault.ci95, color: C.fsrsD },
    { label: 'FSRS trained', value: R.R3.reviews.fsrsTrained.mean, ci: R.R3.reviews.fsrsTrained.ci95, color: C.fsrsT },
  ];
  const ret = [
    { label: 'SM-2', value: R.R3.retention.sm2.mean, ci: R.R3.retention.sm2.ci95, color: C.sm2 },
    { label: 'FSRS default', value: R.R3.retention.fsrsDefault.mean, ci: R.R3.retention.fsrsDefault.ci95, color: C.fsrsD },
    { label: 'FSRS trained', value: R.R3.retention.fsrsTrained.mean, ci: R.R3.retention.fsrsTrained.ci95, color: C.fsrsT },
  ];
  const ymaxR = Math.ceil(Math.max(...rev.map(b => b.ci[1])) / 500) * 500;
  let s = bars(pad, '(a) Total reviews over 180 days', rev, ymaxR, v => String(Math.round(v)), 'Reviews (bars = mean, whiskers = 95% bootstrap CI)');
  s += bars(pad + bw + gap, '(b) Mean snapshot retention', ret, 1.0, v => v.toFixed(3), 'Retention (bars = mean, whiskers = 95% bootstrap CI)', 0.9);
  s += `<text x="${w / 2}" y="74" font-family="${FONT}" font-size="12.5" fill="#555" text-anchor="middle">${R.R3.design.learners} learners x ${R.R3.design.cardsPerLearner} cards x ${R.R3.design.horizonDays} days; error bars are bootstrap CIs across learners.</text>`;
  return svgWrap(w, h, s);
}

// ============================================================
// Fig 5：逐学习者分布（诚实性图：不是每个人都赢）
// ============================================================
function fig5() {
  const vals = R.R3.perLearner.map(p => p.savingsDefaultPct);
  const w = 1320, h = 700;
  const gap = 70, pad = 92, bw = (w - pad * 2 - gap) / 2, ph = h - 96 - 96, y0 = 96;
  const lo = -60, hi = 60, step = 6;
  const hist = new Map();
  for (const v of vals) {
    const b = Math.max(lo, Math.min(hi - step, Math.floor(v / step) * step));
    hist.set(b, (hist.get(b) || 0) + 1);
  }
  const maxC = Math.max(...hist.values());
  const X = v => pad + ((v - lo) / (hi - lo)) * bw;
  const Y = v => y0 + ph - (v / maxC) * ph;
  let sA = `<text x="${pad + bw / 2}" y="42" font-family="${FONT}" font-size="15" font-weight="bold" fill="#111" text-anchor="middle">(a) Per-learner review savings vs. SM-2</text>`;
  for (const t of ticks(0, maxC, 5)) {
    const y = Y(t);
    sA += `<line x1="${pad}" y1="${y}" x2="${pad + bw}" y2="${y}" stroke="${C.grid}"/>`;
    sA += `<text x="${pad - 8}" y="${y + 4}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="end">${Math.round(t)}</text>`;
  }
  sA += `<line x1="${pad}" y1="${y0 + ph}" x2="${pad + bw}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  sA += `<line x1="${pad}" y1="${y0}" x2="${pad}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  for (const [b, c] of [...hist.entries()].sort((a, b2) => a[0] - b2[0])) {
    sA += `<rect x="${X(b) + 1}" y="${Y(c)}" width="${(step / (hi - lo)) * bw - 2}" height="${y0 + ph - Y(c)}" fill="${b < 0 ? C.fixed : C.accent}" fill-opacity="0.8" stroke="#333" stroke-width="0.6"/>`;
  }
  const zeroX = X(0);
  sA += `<line x1="${zeroX}" y1="${y0}" x2="${zeroX}" y2="${y0 + ph}" stroke="#111" stroke-width="1.6" stroke-dasharray="5 4"/>`;
  sA += `<text x="${zeroX + 6}" y="${y0 + 14}" font-family="${FONT}" font-size="11.5" fill="#111">0 (no saving)</text>`;
  for (const t of ticks(lo, hi, 10)) {
    sA += `<text x="${X(t)}" y="${y0 + ph + 20}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="middle">${Math.round(t)}</text>`;
  }
  sA += `<text x="${pad + bw / 2}" y="${y0 + ph + 42}" font-family="${FONT}" font-size="13" fill="${C.axis}" text-anchor="middle">Savings (%) per learner; red = FSRS worse than SM-2</text>`;

  // 面板 B：排序后的逐学习者节省（楼梯图）
  const sorted = [...vals].sort((a, b) => a - b);
  const x1 = pad + bw + gap;
  const Yb = v => y0 + ph - ((v - -60) / 120) * ph;
  let sB = `<text x="${x1 + bw / 2}" y="42" font-family="${FONT}" font-size="15" font-weight="bold" fill="#111" text-anchor="middle">(b) Sorted per-learner effect (no averaging)</text>`;
  for (const t of ticks(-60, 60, 6)) {
    const y = Yb(t);
    sB += `<line x1="${x1}" y1="${y}" x2="${x1 + bw}" y2="${y}" stroke="${C.grid}"/>`;
    sB += `<text x="${x1 - 8}" y="${y + 4}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="end">${Math.round(t)}</text>`;
  }
  sB += `<line x1="${x1}" y1="${y0 + ph}" x2="${x1 + bw}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  sB += `<line x1="${x1}" y1="${y0}" x2="${x1}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  const pts = sorted.map((v, i) => [x1 + (i / (sorted.length - 1)) * bw, Yb(Math.max(-60, Math.min(60, v)))]);
  const negIdx = sorted.findIndex(v => v >= 0);
  sB += polyline(pts.slice(0, negIdx < 0 ? sorted.length : negIdx), C.fixed, 2.6);
  if (negIdx > 0) sB += polyline(pts.slice(Math.max(0, negIdx - 1)), C.accent, 2.6);
  sB += `<line x1="${x1}" y1="${Yb(0)}" x2="${x1 + bw}" y2="${Yb(0)}" stroke="#111" stroke-width="1.4" stroke-dasharray="5 4"/>`;
  const worse = sorted.filter(v => v < 0).length;
  sB += `<text x="${x1 + bw - 4}" y="${y0 + 18}" font-family="${FONT}" font-size="12.5" fill="#333" text-anchor="end">FSRS worse on ${worse}/${sorted.length} learners (${(worse / sorted.length * 100).toFixed(1)}%)</text>`;
  sB += `<text x="${x1 + bw - 4}" y="${y0 + 36}" font-family="${FONT}" font-size="12.5" fill="#333" text-anchor="end">median = ${sorted[Math.floor(sorted.length / 2)].toFixed(2)}%, mean = ${R.R3.savingsPct.defaultVsSm2.mean}%</text>`;
  sB += `<text x="${x1 + bw / 2}" y="${y0 + ph + 42}" font-family="${FONT}" font-size="13" fill="${C.axis}" text-anchor="middle">Learners ordered by savings (clipped to +/-60%)</text>`;
  return svgWrap(w, h, sA + sB);
}

// ============================================================
// Fig 6：SM-2 基线敏感性（rating→q 映射）
// ============================================================
function fig6() {
  const maps = ['generous', 'neutral', 'harsh'];
  const res = R.R3b.results;
  const w = 1320, h = 700;
  const gap = 70, pad = 96, bw = (w - pad * 2 - gap) / 2, ph = h - 96 - 96, y0 = 96;
  const X = (i) => pad + (i / (maps.length - 1)) * bw;
  const ymax = Math.max(...maps.map(m => res[m].fsrsRetention.ci95[1]), 1.0) + 0.005;
  const Y = v => y0 + ph - (v / ymax) * ph;
  let sA = `<text x="${pad + bw / 2}" y="42" font-family="${FONT}" font-size="15" font-weight="bold" fill="#111" text-anchor="middle">(a) Mean retention, by SM-2 grading convention</text>`;
  for (const t of ticks(0.86, ymax, 5)) {
    const y = Y(t);
    sA += `<line x1="${pad}" y1="${y}" x2="${pad + bw}" y2="${y}" stroke="${C.grid}"/>`;
    sA += `<text x="${pad - 8}" y="${y + 4}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="end">${t.toFixed(3)}</text>`;
  }
  sA += `<line x1="${pad}" y1="${y0 + ph}" x2="${pad + bw}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  sA += `<line x1="${pad}" y1="${y0}" x2="${pad}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  const series = [
    { key: 'sm2', label: 'SM-2', color: C.sm2, get: m => res[m].sm2Retention },
    { key: 'fsrs', label: 'FSRS default', color: C.fsrsD, get: m => res[m].fsrsRetention },
  ];
  for (const se of series) {
    const pts = maps.map((m, i) => [X(i), Y(se.get(m).mean)]);
    sA += polyline(pts, se.color, 2.6, se.key === 'sm2' ? null : null);
    sA += circles(pts, se.color, 5);
    maps.forEach((m, i) => {
      sA += errbar(X(i), Y(se.get(m).mean), Y(se.get(m).ci95[0]), Y(se.get(m).ci95[1]), se.color);
    });
  }
  maps.forEach((m, i) => {
    sA += `<text x="${X(i)}" y="${y0 + ph + 20}" font-family="${FONT}" font-size="12" fill="#333" text-anchor="middle">${esc(m)}</text>`;
  });
  sA += legend([{ label: 'SM-2', color: C.sm2 }, { label: 'FSRS default', color: C.fsrsD }], pad + 10, y0 + 12);
  sA += `<text x="${pad + bw / 2}" y="${y0 + ph + 42}" font-family="${FONT}" font-size="13" fill="${C.axis}" text-anchor="middle">q(again, hard/fuzzy, good/recalled) mapping convention</text>`;

  // 面板 B：节省率
  const x1 = pad + bw + gap;
  const ymaxB = Math.max(...maps.map(m => res[m].savingsPct.ci95[1])) + 2;
  const Yb = v => y0 + ph - (v / ymaxB) * ph;
  let sB = `<text x="${x1 + bw / 2}" y="42" font-family="${FONT}" font-size="15" font-weight="bold" fill="#111" text-anchor="middle">(b) Review savings of FSRS over SM-2</text>`;
  for (const t of ticks(0, ymaxB, 5)) {
    const y = Yb(t);
    sB += `<line x1="${x1}" y1="${y}" x2="${x1 + bw}" y2="${y}" stroke="${C.grid}"/>`;
    sB += `<text x="${x1 - 8}" y="${y + 4}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="end">${t.toFixed(1)}</text>`;
  }
  sB += `<line x1="${x1}" y1="${y0 + ph}" x2="${x1 + bw}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  sB += `<line x1="${x1}" y1="${y0}" x2="${x1}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  const slot = bw / maps.length;
  maps.forEach((m, i) => {
    const cx = x1 + slot * i + slot * 0.5, bwd = slot * 0.42;
    const top = Yb(Math.max(0, res[m].savingsPct.mean));
    sB += `<rect x="${cx - bwd / 2}" y="${top}" width="${bwd}" height="${y0 + ph - top}" fill="${C.fsrsD}" stroke="#333" stroke-width="0.8"/>`;
    sB += errbar(cx, top, Yb(res[m].savingsPct.ci95[0]), Yb(res[m].savingsPct.ci95[1]), '#111');
    sB += `<text x="${cx}" y="${Yb(res[m].savingsPct.ci95[1]) - 10}" font-family="${FONT}" font-size="12.5" font-weight="bold" fill="#111" text-anchor="middle">${res[m].savingsPct.mean}%</text>`;
    sB += `<text x="${cx}" y="${y0 + ph + 20}" font-family="${FONT}" font-size="12" fill="#333" text-anchor="middle">${esc(m)}</text>`;
  });
  sB += `<text x="${x1 + bw / 2}" y="${y0 + ph + 42}" font-family="${FONT}" font-size="13" fill="${C.axis}" text-anchor="middle">Savings (%) with 95% bootstrap CI across ${R.R3b.design.learners} learners</text>`;
  return svgWrap(w, h, sA + sB);
}

// ============================================================
// Fig 7：R4 校准反馈（漂移强度 × 策略）
// ============================================================
function fig7() {
  const drifts = ['mild', 'moderate', 'severe'];
  const res = R.R4.results;
  const w = 1320, h = 700;
  const gap = 70, pad = 96, bw = (w - pad * 2 - gap) / 2, ph = h - 96 - 96, y0 = 96;
  const X = v => pad + (v / R.R4.design.horizonDays) * bw;
  const Yb = v => y0 + ph - ((v + 0.01) / 0.09) * ph;
  let sA = `<text x="${pad + bw / 2}" y="42" font-family="${FONT}" font-size="15" font-weight="bold" fill="#111" text-anchor="middle">(a) Calibration bias over time (feedback on)</text>`;
  for (const t of ticks(-0.01, 0.08, 5)) {
    const y = Yb(t);
    sA += `<line x1="${pad}" y1="${y}" x2="${pad + bw}" y2="${y}" stroke="${C.grid}"/>`;
    sA += `<text x="${pad - 8}" y="${y + 4}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="end">${t.toFixed(2)}</text>`;
  }
  sA += `<line x1="${pad}" y1="${y0 + ph}" x2="${pad + bw}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  sA += `<line x1="${pad}" y1="${y0}" x2="${pad}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  sA += `<line x1="${pad}" y1="${Yb(0)}" x2="${pad + bw}" y2="${Yb(0)}" stroke="#111" stroke-width="1.2" stroke-dasharray="5 4"/>`;
  const colors = { mild: '#2ca02c', moderate: '#ff7f0e', severe: '#d62728' };
  for (const d of drifts) {
    const tr = res[d].trace;
    sA += polyline(tr.map(t => [X(t.day), Yb(Math.max(-0.01, Math.min(0.08, t.biasMean)))]), colors[d], 2.4);
    sA += circles(tr.map(t => [X(t.day), Yb(Math.max(-0.01, Math.min(0.08, t.biasMean)))]), colors[d], 3.5);
  }
  sA += legend(drifts.map(d => ({ label: d + ' drift', color: colors[d] })), pad + 10, y0 + 12);
  sA += `<text x="${pad + bw / 2}" y="${y0 + ph + 42}" font-family="${FONT}" font-size="13" fill="${C.axis}" text-anchor="middle">Day (mean bias across ${R.R4.design.learners} learners)</text>`;

  const x1 = pad + bw + gap;
  const Yr = v => y0 + ph - (v / 1.0) * ph;
  let sB = `<text x="${x1 + bw / 2}" y="42" font-family="${FONT}" font-size="15" font-weight="bold" fill="#111" text-anchor="middle">(b) Retention: fixed vs. feedback</text>`;
  for (const t of ticks(0.7, 1.0, 5)) {
    const y = Yr(t);
    sB += `<line x1="${x1}" y1="${y}" x2="${x1 + bw}" y2="${y}" stroke="${C.grid}"/>`;
    sB += `<text x="${x1 - 8}" y="${y + 4}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="end">${t.toFixed(2)}</text>`;
  }
  sB += `<line x1="${x1}" y1="${y0 + ph}" x2="${x1 + bw}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  sB += `<line x1="${x1}" y1="${y0}" x2="${x1}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  sB += `<line x1="${x1}" y1="${Yr(0.9)}" x2="${x1 + bw}" y2="${Yr(0.9)}" stroke="#111" stroke-width="1.3" stroke-dasharray="6 4"/>`;
  sB += `<text x="${x1 + 6}" y="${Yr(0.9) - 6}" font-family="${FONT}" font-size="11" fill="#111">target 0.90</text>`;
  const slot = bw / drifts.length;
  drifts.forEach((d, i) => {
    const cx = x1 + slot * i + slot * 0.5, bwd = slot * 0.24;
    const f = res[d].fixed.retention, b = res[d].feedback.retention;
    sB += `<rect x="${cx - bwd - 4}" y="${Yr(f.mean)}" width="${bwd}" height="${y0 + ph - Yr(f.mean)}" fill="${C.fixed}" stroke="#333" stroke-width="0.8"/>`;
    sB += `<rect x="${cx + 4}" y="${Yr(b.mean)}" width="${bwd}" height="${y0 + ph - Yr(b.mean)}" fill="${C.feedback}" stroke="#333" stroke-width="0.8"/>`;
    sB += errbar(cx - bwd / 2 - 4, Yr(f.mean), Yr(f.ci95[0]), Yr(f.ci95[1]), '#111');
    sB += errbar(cx + bwd / 2 + 4, Yr(b.mean), Yr(b.ci95[0]), Yr(b.ci95[1]), '#111');
    sB += `<text x="${cx}" y="${Yr(Math.max(f.ci95[1], b.ci95[1])) - 10}" font-family="${FONT}" font-size="12" fill="#111" text-anchor="middle">+${res[d].retentionGain.meanDiff.toFixed(4)}</text>`;
    sB += `<text x="${cx}" y="${y0 + ph + 20}" font-family="${FONT}" font-size="12" fill="#333" text-anchor="middle">${esc(d)}</text>`;
  });
  sB += legend([{ label: 'fixed 0.90', color: C.fixed }, { label: 'feedback', color: C.feedback }], x1 + 10, y0 + 12);
  sB += `<text x="${x1 + bw / 2}" y="${y0 + ph + 42}" font-family="${FONT}" font-size="13" fill="${C.axis}" text-anchor="middle">Mean retention with 95% bootstrap CI (gain = ${R.R4.design.gain})</text>`;
  return svgWrap(w, h, sA + sB);
}

// ============================================================
// Fig 8：反馈增益敏感性（审计图）
// ============================================================
function fig8() {
  if (!A) return null;
  const drifts = ['mild', 'moderate', 'severe'];
  const gains = [0.25, 0.5, 1.0, 2.0];
  const w = 1200, h = 700;
  const pad = 96, ph = h - 96 - 96, bw = w - pad * 2, y0 = 96;
  const X = v => pad + ((v - 0.2) / 2.1) * bw;
  const ymax = 0.06;
  const Y = v => y0 + ph - (v / ymax) * ph;
  let s = `<text x="${w / 2}" y="42" font-family="${FONT}" font-size="15" font-weight="bold" fill="#111" text-anchor="middle">Sensitivity of the feedback effect to controller gain</text>`;
  for (const t of ticks(0, ymax, 6)) {
    const y = Y(t);
    s += `<line x1="${pad}" y1="${y}" x2="${pad + bw}" y2="${y}" stroke="${C.grid}"/>`;
    s += `<text x="${pad - 8}" y="${y + 4}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="end">${t.toFixed(3)}</text>`;
  }
  s += `<line x1="${pad}" y1="${y0 + ph}" x2="${pad + bw}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  s += `<line x1="${pad}" y1="${y0}" x2="${pad}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  const colors = { mild: '#2ca02c', moderate: '#ff7f0e', severe: '#d62728' };
  for (const d of drifts) {
    const pts = gains.map(g => [X(g), Y(A.A2.results[d].variants[`gain${g}`].vsFixed.meanDiff)]);
    s += polyline(pts, colors[d], 2.6);
    s += circles(pts, colors[d], 5);
  }
  // 标出产品默认 gain=0.5
  s += `<line x1="${X(0.5)}" y1="${y0}" x2="${X(0.5)}" y2="${y0 + ph}" stroke="${C.warn}" stroke-width="1.8" stroke-dasharray="6 4"/>`;
  s += `<text x="${X(0.5) + 8}" y="${y0 + 16}" font-family="${FONT}" font-size="12" fill="${C.warn}">product default gain = 0.5</text>`;
  for (const g of gains) s += `<text x="${X(g)}" y="${y0 + ph + 20}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="middle">${g}</text>`;
  s += legend(drifts.map(d => ({ label: d + ' drift', color: colors[d] })), pad + 10, y0 + ph - 26);
  s += `<text x="${w / 2}" y="${y0 + ph + 44}" font-family="${FONT}" font-size="13" fill="${C.axis}" text-anchor="middle">Controller gain gamma (retention improvement over fixed 0.90)</text>`;
  s += `<text x="${w / 2}" y="${h - 14}" font-family="${FONT}" font-size="12" fill="#555" text-anchor="middle">The reported R4 result used gamma = 1.0; at the shipped default 0.5 the effect is roughly half.</text>`;
  return svgWrap(w, h, s);
}

// ============================================================
// Fig 9：自适应保持率
// ============================================================
function fig9() {
  const curve = R.R5.curve, subs = R.R5.subjects;
  const w = 1320, h = 700;
  const gap = 70, pad = 96, bw = (w - pad * 2 - gap) / 2, ph = h - 96 - 96, y0 = 96;
  const p = makePlot({ w: 0, h: 0, xmin: 0, xmax: 100, ymin: 0.78, ymax: 0.96 });
  const X = v => pad + (v / 100) * bw;
  const Y = v => y0 + ph - ((v - 0.78) / 0.18) * ph;
  let sA = `<text x="${pad + bw / 2}" y="42" font-family="${FONT}" font-size="15" font-weight="bold" fill="#111" text-anchor="middle">(a) Adaptive target retention vs. mastery</text>`;
  for (const t of ticks(0.78, 0.96, 6)) {
    const y = Y(t);
    sA += `<line x1="${pad}" y1="${y}" x2="${pad + bw}" y2="${y}" stroke="${C.grid}"/>`;
    sA += `<text x="${pad - 8}" y="${y + 4}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="end">${t.toFixed(2)}</text>`;
  }
  sA += `<line x1="${pad}" y1="${y0 + ph}" x2="${pad + bw}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  sA += `<line x1="${pad}" y1="${y0}" x2="${pad}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  sA += polyline(curve.map(c => [X(c.mastery), Y(c.retention)]), C.accent, 2.8);
  for (const su of subs) {
    sA += `<circle cx="${X(su.mastery)}" cy="${Y(su.retention)}" r="5.5" fill="${C.fsrsT}" stroke="#333" stroke-width="0.8"/>`;
  }
  for (const t of ticks(0, 100, 5)) sA += `<text x="${X(t)}" y="${y0 + ph + 20}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="middle">${Math.round(t)}</text>`;
  sA += `<text x="${pad + bw / 2}" y="${y0 + ph + 42}" font-family="${FONT}" font-size="13" fill="${C.axis}" text-anchor="middle">Mastery (%)</text>`;
  sA += `<line x1="${pad}" y1="${Y(0.9)}" x2="${pad + bw}" y2="${Y(0.9)}" stroke="#111" stroke-width="1.2" stroke-dasharray="6 4"/>`;
  sA += `<text x="${pad + 6}" y="${Y(0.9) - 6}" font-family="${FONT}" font-size="11" fill="#111">fixed baseline 0.90</text>`;

  const x1 = pad + bw + gap;
  const sorted = [...subs].sort((a, b) => b.relFrequency - a.relFrequency);
  const Yf = (i) => y0 + 26 + i * ((ph - 40) / sorted.length);
  let sB = `<text x="${x1 + bw / 2}" y="42" font-family="${FONT}" font-size="15" font-weight="bold" fill="#111" text-anchor="middle">(b) Relative review frequency vs. fixed 0.90</text>`;
  const fmax = Math.max(...sorted.map(s => s.relFrequency));
  const barX = x1 + 190;
  const barW = bw - 210;
  sorted.forEach((su, i) => {
    const y = Yf(i);
    const len = (su.relFrequency / fmax) * barW;
    sB += `<text x="${x1 + 4}" y="${y + 12}" font-family="${FONT}" font-size="12" fill="#333">${esc(su.subject)} (M=${su.mastery})</text>`;
    sB += `<rect x="${barX}" y="${y}" width="${Math.max(2, len)}" height="18" fill="${su.relFrequency > 1 ? C.fixed : C.accent}" stroke="#333" stroke-width="0.6"/>`;
    sB += `<text x="${barX + Math.max(2, len) + 6}" y="${y + 14}" font-family="${FONT}" font-size="12" fill="#111">${su.relFrequency}x</text>`;
  });
  sB += `<line x1="${barX + (1 / fmax) * barW}" y1="${y0 + 10}" x2="${barX + (1 / fmax) * barW}" y2="${y0 + ph}" stroke="#111" stroke-width="1.3" stroke-dasharray="5 4"/>`;
  sB += `<text x="${barX + (1 / fmax) * barW + 6}" y="${y0 + ph - 4}" font-family="${FONT}" font-size="11" fill="#111">1.0x = fixed 0.90</text>`;
  sB += `<text x="${x1 + bw / 2}" y="${y0 + ph + 42}" font-family="${FONT}" font-size="13" fill="${C.axis}" text-anchor="middle">Review frequency R*/(1-R*) normalised to the fixed-0.90 schedule</text>`;
  return svgWrap(w, h, sA + sB);
}

// ============================================================
// Fig 10：同族 vs 异族真值（外部效度）
// ============================================================
function fig10() {
  const w = 1200, h = 700;
  const pad = 96, bw = w - pad * 2, ph = h - 96 - 110, y0 = 96;
  const groups = [
    { label: 'same-family truth\n(power-law FSRS)', v: R.R3.savingsPct.defaultVsSm2, color: C.fsrsD },
    { label: 'out-of-family truth\n(exponential forgetting)', v: R.R6.savingsPct.defaultVsSm2, color: C.fsrsT },
  ];
  const ymax = Math.max(...groups.map(g => g.v.ci95[1])) * 1.35 + 2;
  const Y = v => y0 + ph - (v / ymax) * ph;
  let s = `<text x="${w / 2}" y="42" font-family="${FONT}" font-size="15" font-weight="bold" fill="#111" text-anchor="middle">External validity: does the advantage survive a different ground-truth family?</text>`;
  for (const t of ticks(0, ymax, 5)) {
    const y = Y(t);
    s += `<line x1="${pad}" y1="${y}" x2="${pad + bw}" y2="${y}" stroke="${C.grid}"/>`;
    s += `<text x="${pad - 8}" y="${y + 4}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="end">${t.toFixed(1)}</text>`;
  }
  s += `<line x1="${pad}" y1="${y0 + ph}" x2="${pad + bw}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  s += `<line x1="${pad}" y1="${y0}" x2="${pad}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  const slot = bw / groups.length;
  groups.forEach((g, i) => {
    const cx = pad + slot * i + slot * 0.5, bwd = slot * 0.4;
    const top = Y(Math.max(0, g.v.mean));
    s += `<rect x="${cx - bwd / 2}" y="${top}" width="${bwd}" height="${y0 + ph - top}" fill="${g.color}" stroke="#333" stroke-width="0.8"/>`;
    s += errbar(cx, top, Y(g.v.ci95[0]), Y(g.v.ci95[1]), '#111');
    s += `<text x="${cx}" y="${Y(g.v.ci95[1]) - 12}" font-family="${FONT}" font-size="14" font-weight="bold" fill="#111" text-anchor="middle">${g.v.mean}%</text>`;
    g.label.split('\n').forEach((line, li) => {
      s += `<text x="${cx}" y="${y0 + ph + 26 + li * 16}" font-family="${FONT}" font-size="12.5" fill="#333" text-anchor="middle">${esc(line)}</text>`;
    });
  });
  s += `<text x="${w / 2}" y="${h - 26}" font-family="${FONT}" font-size="13" fill="${C.axis}" text-anchor="middle">Review savings of FSRS (default weights) over SM-2, with 95% bootstrap CI</text>`;
  s += `<text x="${w / 2}" y="${h - 8}" font-family="${FONT}" font-size="12" fill="#555" text-anchor="middle">Same-family: ${R.R3.design.learners} learners. Out-of-family: ${R.R6.design.learners} learners, R = 0.9^(t/S) with multiplicative stability growth.</text>`;
  return svgWrap(w, h, s);
}

// ============================================================
// Fig 11：负对照 —— 校准指标判别力
// ============================================================
function fig11() {
  if (!A) return null;
  const nc = A.A1.a1b_negativeControl;
  const factors = A.A1.factors;
  const w = 1200, h = 700;
  const pad = 96, bw = w - pad * 2, ph = h - 96 - 96, y0 = 96;
  const X = v => pad + ((Math.log(v) - Math.log(0.4)) / (Math.log(2.2) - Math.log(0.4))) * bw;
  const Y = v => y0 + ph - (v / 0.28) * ph;
  let s = `<text x="${w / 2}" y="42" font-family="${FONT}" font-size="15" font-weight="bold" fill="#111" text-anchor="middle">Negative control: do the calibration metrics detect a deliberately mismatched model?</text>`;
  for (const t of ticks(0, 0.28, 7)) {
    const y = Y(t);
    s += `<line x1="${pad}" y1="${y}" x2="${pad + bw}" y2="${y}" stroke="${C.grid}"/>`;
    s += `<text x="${pad - 8}" y="${y + 4}" font-family="${FONT}" font-size="12" fill="${C.axis}" text-anchor="end">${t.toFixed(2)}</text>`;
  }
  s += `<line x1="${pad}" y1="${y0 + ph}" x2="${pad + bw}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  s += `<line x1="${pad}" y1="${y0}" x2="${pad}" y2="${y0 + ph}" stroke="${C.axis}" stroke-width="1.4"/>`;
  s += `<line x1="${X(1)}" y1="${y0}" x2="${X(1)}" y2="${y0 + ph}" stroke="#111" stroke-width="1.4" stroke-dasharray="5 4"/>`;
  s += `<text x="${X(1) + 6}" y="${y0 + 16}" font-family="${FONT}" font-size="12" fill="#111">matched (factor = 1.0)</text>`;
  const series = [
    { key: 'ece', label: 'ECE', color: C.accent },
    { key: 'brier', label: 'Brier', color: C.fsrsT },
  ];
  for (const se of series) {
    const pts = factors.map(f => [X(f), Y(Math.min(0.28, nc['x' + f][se.key].mean))]);
    s += polyline(pts, se.color, 2.6);
    s += circles(pts, se.color, 4.5);
  }
  const biasPts = factors.map(f => [X(f), Y(Math.min(0.28, Math.abs(nc['x' + f].bias.mean)))]);
  s += polyline(biasPts, C.fixed, 2.2, '6 4');
  s += legend([{ label: 'ECE', color: C.accent }, { label: 'Brier', color: C.fsrsT }, { label: '|bias|', color: C.fixed }], pad + 10, y0 + ph - 26);
  for (const f of factors) s += `<text x="${X(f)}" y="${y0 + ph + 20}" font-family="${FONT}" font-size="11" fill="${C.axis}" text-anchor="middle">${f}</text>`;
  s += `<text x="${w / 2}" y="${y0 + ph + 44}" font-family="${FONT}" font-size="13" fill="${C.axis}" text-anchor="middle">Evaluation-weight multiplier applied to the data-generating weights (log scale)</text>`;
  s += `<text x="${w / 2}" y="${h - 12}" font-family="${FONT}" font-size="12" fill="#555" text-anchor="middle">Metrics are minimal at the matched point and rise monotonically with mismatch, i.e. they are not vacuous.</text>`;
  return svgWrap(w, h, s);
}

// ============================================================
async function main() {
  const jobs = [
    ['fig1_architecture', fig1()],
    ['fig2_calibration', fig2()],
    ['fig3_training', fig3()],
    ['fig4_schedulers', fig4()],
    ['fig5_distribution', fig5()],
    ['fig6_sm2_sensitivity', fig6()],
    ['fig7_feedback', fig7()],
    ['fig8_gain_sensitivity', fig8()],
    ['fig9_adaptive', fig9()],
    ['fig10_external_validity', fig10()],
    ['fig11_negative_control', fig11()],
  ];
  for (const [name, svg] of jobs) {
    if (!svg) { console.log('skip', name, '(audit results missing)'); continue; }
    const p = await render(name, svg);
    console.log('wrote', p);
  }
}
main();
