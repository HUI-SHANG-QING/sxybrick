# Direction A Paper — Personalized FSRS with Finite-Difference Training and Calibration Feedback

This folder contains the complete manuscript, reproducible figures, and an independent academic-integrity audit for the Direction A paper.

## Files

| File | Description |
|------|-------------|
| `paper-direction-a-ieee.md` | English Markdown manuscript for reading/review (all sections, tables, figures). |
| `paper-direction-a-ieee-zh.md` | 中文 Markdown 阅读版（内容与英文版一一对应，含全部章节、表格、图表）。 |
| `paper-direction-a-ieee.tex` | IEEEtran conference LaTeX source (English), submittable after compilation. |
| `ACADEMIC-INTEGRITY-AUDIT.md` | 学术诚信与风险审查报告（A1–A8 八项自检结论，独立重实现交叉验证）。 |
| `figures/fig1_architecture.png` | Fig. 1 — system architecture. |
| `figures/fig2_calibration.png` | Fig. 2 — R1b memory-consistent calibration reliability diagram. |
| `figures/fig3_training.png` | Fig. 3 — R2 finite-difference training convergence (+R2b). |
| `figures/fig4_schedulers.png` | Fig. 4 — R3 SM-2 vs. FSRS comparison (with 95% CIs). |
| `figures/fig5_distribution.png` | Fig. 5 — R3 per-learner savings distribution (honest full distribution). |
| `figures/fig6_sm2_sensitivity.png` | Fig. 6 — R3b SM-2 mapping sensitivity. |
| `figures/fig7_feedback.png` | Fig. 7 — R4 calibration feedback under distribution shift. |
| `figures/fig8_gain_sensitivity.png` | Fig. 8 — A2 feedback-gain sensitivity. |
| `figures/fig9_adaptive.png` | Fig. 9 — R5 adaptive retention curve. |
| `figures/fig10_external_validity.png` | Fig. 10 — R6 out-of-family ground truth. |
| `figures/fig11_negative_control.png` | Fig. 11 — A1b negative control. |

## How to Regenerate the Experiments and Figures

All numbers and charts are produced from the project source code, with fixed seeds, so results are deterministic.

```bash
cd new_card
node experiments/run-large.mjs       # writes experiments/results-large.json (main, ~114s)
node experiments/run-integrity.mjs   # writes experiments/results-integrity.json (audit)
node experiments/gen-figures-large.mjs  # reads both JSON files and writes paper/figures/*.png
```

Running `node experiments/run-large.mjs` twice produces byte-identical summary statistics (verified 10/10 in audit A3).

## How to Compile the LaTeX Manuscript

Requirements: a TeX Live / MiKTeX installation with `IEEEtran.cls`.

```bash
cd new_card/paper
pdflatex paper-direction-a-ieee.tex
pdflatex paper-direction-a-ieee.tex  # second pass for references/figure numbers
```

No separate BibTeX run is needed because references are provided in the `thebibliography` environment.

## Venue / Format

- **Discipline:** AI in Education / Educational Technology / Learning Sciences.
- **Suggested venues:** IEEE Transactions on Learning Technologies (TLT); IEEE ICALT; ACM/L@S; EDM.
- **Format:** IEEEtran conference/double-column; academic English; equations and figures prepared for print (high-resolution PNGs, vector-derived from SVG).

## Data Provenance

All data are synthetic. The ground-truth memory model is a deterministic FSRS-family simulator with per-learner weight jitter (stratified over $[0.7, 1.3]$). No real learner data are used, and no external dataset is downloaded. The experiment scripts are the single source of truth for every number, table, and chart in the paper. An independent audit (`experiments/run-integrity.mjs`) re-implements the core computations from scratch and cross-checks the main script.
