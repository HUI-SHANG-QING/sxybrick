// tests/card-limit-single-source.test.mjs —— 卡片长度上限「单一来源」闸门（round129 定案）
//
// 背景：卡片正/背面上限原本是 8000，但同一个数字散落在 8 处硬编码 ——
//   写入校验（repo-core）、UI 字数统计（CardModal）、以及 6 条 AI 生成链路的产物截断
//   （genDeck / genCardDeck / genVariants / offlineAI / wrongToCards / WrongBook），
//   genCardDeck 的正面还单独写死 2000。结果「改一处必漏一处」。
// round129 把它收敛到 src/utils/card-limits.js 并提升到 50000，本闸门负责**防再次漂移**。
//
// 断言策略（遵循「断言结构性特征，而不是断言具体值」）：
//   ① 具体值只在**本文件这一处**被钉住（CARD_MAX_CHARS === 50000）——这是唯一的"值断言"，
//      它存在的意义恰恰是"上限变更必须显式改这里并在 review 里被看到"。
//   ② 结构性断言：8 个消费方都必须 import 常量，且不得再对 front/back 用数字字面量截断。
//
// ⚠️ 为什么不能全文件扫 `slice(0, 4位以上数字)`：
//   这些文件里还有**喂给 AI 的提示词预算**（genDeck 20000 / genCardDeck 4000 /
//   offlineAI 4000），它们和卡片存储上限是两码事，全文件扫会误伤。
//   所以本闸门只检查 `front:` / `back:` 赋值行（卡片内容的唯一出口）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CARD_MAX_CHARS, CARD_WARN_CHARS } from '../src/utils/card-limits.js';

const SRC = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/** 所有会决定「卡片正/背面最终内容」的文件 —— 上限变更必须同步它们。 */
const CARD_CONTENT_FILES = [
  'repo-core.js',              // 写入校验（权威）
  'components/CardModal.vue',  // UI 字数统计 + 输入截断
  'utils/genDeck.js',          // AI 组卡
  'utils/genCardDeck.js',      // AI 智能卡组（含离线兜底）
  'utils/genVariants.js',      // 情境变式
  'utils/offlineAI.js',        // 离线生成
  'utils/wrongToCards.js',     // 错题转卡
  'views/WrongBook.vue',       // 错题智能补卡
];

/**
 * 允许保留「数字字面量截断」的**预览**行（不是卡片存储上限）。
 * 它们只是把 front 截短用于列表/去重提示，与上限无关。
 * 用整行 trim 后的内容精确匹配，避免行号漂移导致误报。
 */
const PREVIEW_ALLOWLIST = new Set([
  "dupWith: best.with ? { id: best.with.id, front: String(best.with.front).slice(0, 50) } : null,",
]);

// ---------- ① 上限值被显式钉住（唯一的值断言）----------
test('card-limits：上限为 50000、预警为 45000（round129 扩容后的既定值）', () => {
  assert.equal(CARD_MAX_CHARS, 50000, '卡片上限被改动 —— 若非有意为之请改回；若确要调整，请同步更新本断言与所有文档说明');
  assert.equal(CARD_WARN_CHARS, 45000, '预警阈值应为上限的 90%，不应单独写死');
  // 阈值必须由上限派生（改上限时自动跟随），且小于上限
  assert.equal(CARD_WARN_CHARS, Math.floor(CARD_MAX_CHARS * 0.9));
  assert.ok(CARD_WARN_CHARS < CARD_MAX_CHARS);
});

// ---------- ② 消费方必须引用常量，不得再写死数字 ----------
test('card-limits：8 个卡片内容消费方都 import 常量，且不得用数字字面量截断 front/back', () => {
  const offenders = [];
  const missingImport = [];
  const undeclaredUse = [];

  for (const rel of CARD_CONTENT_FILES) {
    const src = read(`${SRC}/${rel}`);

    // (a) 必须从 card-limits 引入常量
    const imp = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*card-limits\.js['"]/.exec(src);
    if (!imp) {
      missingImport.push(rel);
    } else {
      // (a2) ⭐ 用到的每个 CARD_* 都必须在 import 列表里。
      // 为什么加这条：round129 首次改动时 CardModal.vue 只 import 了 CARD_MAX_CHARS，
      // 却在代码里用了 CARD_WARN_CHARS —— 只查「有没有 import」的断言完全漏检，
      // 会在运行时抛 ReferenceError（正是"修复引入新问题"的典型形态）。
      const imported = new Set(
        imp[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean),
      );
      const body = src.slice(imp.index + imp[0].length); // 只看 import 之后的使用处
      const used = new Set(body.match(/\bCARD_[A-Z0-9_]+\b/g) || []);
      for (const name of used) {
        if (!imported.has(name)) undeclaredUse.push(`${rel}: 使用了 ${name} 但未从 card-limits import`);
      }
    }

    // (b) front/back 赋值行不得用数字字面量做截断
    for (const raw of src.split('\n')) {
      const line = raw.trim();
      // 只看卡片内容的出口：以 front: / back: 开头的赋值
      if (!/^(front|back)\s*:/.test(line)) continue;
      // 取 slice 的第二个参数
      const m = /\.slice\(\s*0\s*,\s*([^)]+?)\s*\)/.exec(line);
      if (!m) continue;
      const bound = m[1].trim();
      if (/^\d+$/.test(bound)) {            // 数字字面量 ⇒ 违规
        if (PREVIEW_ALLOWLIST.has(line)) continue;   // 已知预览点，放行
        offenders.push(`${rel}: ${line}`);
      }
    }
  }

  assert.deepEqual(
    missingImport, [],
    `以下文件决定卡片内容却不 import 单一来源常量（会让上限再次漂移）：\n`
    + missingImport.map((f) => `  ${f}`).join('\n')
    + `\n应改为从 ${'`'}utils/card-limits.js${'`'} 引入 CARD_MAX_CHARS。`,
  );

  assert.deepEqual(
    undeclaredUse, [],
    `以下位置使用了未 import 的常量（运行时会抛 ReferenceError）：\n`
    + undeclaredUse.map((f) => `  ${f}`).join('\n'),
  );

  assert.deepEqual(
    offenders, [],
    `以下 front/back 截断仍在用数字字面量（应改用 CARD_MAX_CHARS）：\n`
    + offenders.map((f) => `  ${f}`).join('\n'),
  );
});

// ---------- ③ UI 层必须把常量接到字数统计上 ----------
test('CardModal：字数上限/预警来自常量，且不再出现 8000/7500 字面量', () => {
  const src = read(`${SRC}/components/CardModal.vue`);
  assert.match(
    src, /const\s+MAX\s*=\s*CARD_MAX_CHARS\s*,\s*WARN\s*=\s*CARD_WARN_CHARS/,
    'CardModal 的 MAX/WARN 必须直接取常量（否则 UI 显示的上限会与校验口径不一致）',
  );
  assert.ok(!/\bconst\s+MAX\s*=\s*\d+/.test(src), 'CardModal 的 MAX 不得再写数字字面量');
  assert.ok(!/\bWARN\s*=\s*\d+/.test(src), 'CardModal 的 WARN 不得再写数字字面量');
});

// ---------- ③b 关于「注释层漂移」为什么**不设闸门**（round131 结论）----------
// round131 曾试加一条闸门：扫注释行，命中「8000 且谈及卡片上限」就报错。
// **已撤销** —— 实测它误报了我们自己写的历史说明注释：
//     // ⚠️ round131：此处原写「MAX_CHARS=8000」，round129 已把卡片上限提到 50000
//   这行恰恰是**正确的**（它在解释"以前是 8000、现在不是了"），却被判违规。
// 根因：判据依赖自然语言语义，而「解释历史的注释」与「过时的注释」在词面上无法区分。
//   ⇒ 教训（与 §14.4c 同源）：**不要为自然语言写断言**。
// 实际问题（word-repo.js 注释里拿 8000 当卡片上限）已在 round131 直接改正，
//   并且**代码层面**的防漂移由上面的第 2 条闸门覆盖（front:/back: 行禁用数字字面量）。
//   这已经足够：真正会改变行为的只有代码，注释错了不会让功能出错。

// ---------- ④ 写入校验必须真正放行到新上限 ----------
test('validateCard：新上限内放行、超出拒绝（按 Unicode 码点计）', async () => {
  const { validateCard } = await import('../src/repo-core.js');
  // 恰好等于上限 ⇒ 放行
  assert.ok(
    validateCard({ front: 'a'.repeat(CARD_MAX_CHARS), back: 'b' }).value,
    `front 恰好 ${CARD_MAX_CHARS} 字应放行`,
  );
  // 超 1 个码点 ⇒ 拒绝
  const over = validateCard({ front: 'a'.repeat(CARD_MAX_CHARS + 1), back: 'b' });
  assert.ok(over.error, '超上限应被拒绝');
  assert.match(over.error, new RegExp(`不能超过 ${CARD_MAX_CHARS} 字`));
  // 中文按码点计（不能因 UTF-8 字节数误伤）
  assert.ok(
    validateCard({ front: '记'.repeat(CARD_MAX_CHARS), back: 'b' }).value,
    '中文字符按码点计，不应因编码长度误伤',
  );
});
