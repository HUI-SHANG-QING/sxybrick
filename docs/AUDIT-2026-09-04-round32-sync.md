# SxyBrick 同步功能全面审计报告（Part 3 · round32-sync）

> 审计日期：2026-09-04
> 审计范围：数据导入导出 + 局域网同步 全链路
> 审计方式：端到端实证（真实 Dexie/IndexedDB + 真实 spawn hub 子进程）+ 静态守卫回归
> 结论：**核心同步链路健康，无 P0 缺陷**；发现 1 处 P1 登记遗漏 + 1 处测试层隐蔽 bug，均已修复并补回归测试。

---

## 一、审计目标与方法

本次审计是「三合一任务」的第三部分，目标是对同步功能做**逐项实证验证**，而非只读代码判断。前两轮只做了 `sync-manifest.js` 的纯函数单测，从未验证过「导出 → 导入往返」「增量水位推进」「快照回滚」「墓碑删除传播」「局域网 hub 端到端」这条完整链路是否真的能跑通。

为此新建 `tests/sync-audit.test.mjs`，覆盖 9 个端到端用例，全部走真实执行路径：

| # | 用例 | 验证点 |
|---|------|--------|
| 1 | 全量往返 buildBackup → 清库 → importBackup | 32 张同步表不丢 + 敏感字段 strip + `modeQuestions` 随包往返 |
| 2 | 增量 buildIncrementalBackup | 只带 since 之后变更；墓碑全量；首包放行全 0 时间戳遗留行 |
| 3 | 快照 saveSnapshot → restoreSnapshot | 精确还原 + 新表 `syllabusMeanings` 随快照往返 |
| 4 | 快照 R18-3 旧快照缺键 | 旧快照缺新表键 → 跳过不抹空 |
| 5 | 快照上限 | 超过 MAX_SNAPSHOTS 自动删最旧 |
| 6 | 墓碑删除传播 | A 删卡 → B 导入 → 卡片/复习/图谱边级联删除 |
| 7 | previewImport 只读预览 | 不写库，正确分类 新增/覆盖/重复 |
| 8 | 局域网 syncWithHub 全链路 | 增量上传 → 中枢合并 → 第二设备拉取 → 水位推进 |
| 9 | 局域网增量二次传播 | 首轮同步后新增/修改仍可传播（水位不吞数据） |

---

## 二、发现的问题（按严重度分级）

| 严重度 | 位置 | 缺陷 | 修复 | 状态 |
|--------|------|------|------|------|
| **P1** | `src/sync-status.js`（MODULE_LABELS / MODULE_ORDER_HINT）+ `src/i18n/views/sync.js`（zh/en） | v30 新增 `syllabusMeanings` 表后，同步状态面板的模块标签/排序/双语字典漏登记该表 → 同步面板漏显该表、埋点不可见、i18n 闸门报回归 | 在 `MODULE_LABELS`、`MODULE_ORDER_HINT`、zh/en 字典补齐 `syllabusMeanings` | ✅ 已修复（R18-7） |
| **P2** | `tests/sync-audit.test.mjs:303-304` | `await d.cards.get(id)?.front` 的运算符优先级陷阱：`await` 优先级低于 `?.`，实际解析为 `await (Promise?.front)` → 恒为 `undefined`，断言永假 | 改为 `(await d.cards.get(id))?.front` | ✅ 已修复 |

### P2 详情：`await foo()?.bar` 优先级陷阱

这是一个**测试层**的隐蔽 bug，而非业务缺陷——但它让 test 8 的断言「看起来在测同步、实际测了个恒为 undefined 的表达式」，属于「假绿/假红」类问题，若不揪出来会掩盖真实回归。

```js
// ❌ 错误：await 优先级低于 ?. ，等价于 await (d.cards.get(id)?.front)
assert.equal(await d.cards.get('hub-c1')?.front, 'Q-hub-c1');

// ✅ 正确：先 await 取到行，再可选链取字段
assert.equal((await d.cards.get('hub-c1'))?.front, 'Q-hub-c1');
```

项目里已有一个静态守卫 `tests/await-optional-chain-guard.test.mjs` 专门拦截这个模式（扫描 `src/`、`sync-hub/`、`tests/`），本会话新测试文件恰好在守卫扫描范围内被其捕获——印证了这条守卫存在的价值。修复后守卫测试 2/2 通过。

---

## 三、实证结论（逐项）

### 3.1 数据导入导出 —— 正常

- **全量往返不丢表**：32 张同步表（含 v25 单词模块 4 表 + v30 `syllabusMeanings`）全部随包往返，卡片/复习/备忘/单词/释义/设置落库数逐一核对一致。
- **敏感字段 strip 双侧生效**：导出侧 `wordSettings.llmApiKey`/`llmBase` 不进备份包；导入对端包后本地 Key 保持为空，不回灌不泄露。
- **AI 扩展字段并集保护**：`wordCards.modeQuestions`（13 种背诵模式的 AI 题目/答案，v31 新增）随同步往返，形状较简设备不会整行覆盖丢题。
- **增量语义正确**：`buildIncrementalBackup(since)` 只带 `livenessTs > since` 的行；墓碑始终全量；`since=0` 首包放行全 0 时间戳遗留行（防早期 Anki 批导入漏传）。
- **快照**：精确还原、新表随快照往返、旧快照缺键跳过不抹空（R18-3）、上限自动清理，均符合预期。
- **墓碑删除传播**：删卡 → 级联删复习、图谱边、孤儿图片，语义完整。

### 3.2 局域网同步 —— 正常

- **端到端链路**：真实 `spawn` 启动 `sync-hub/hub.js` 子进程（随机端口 + 隔离 token/data 文件），走完整 `syncWithHub` → 中枢 `merge` → 返回合并包 → `importBackup` → 水位推进。
- **第二设备拉取**：清库模拟第二设备后，能从同一中枢拉回卡片与备忘。
- **增量二次传播**：首轮同步后再新增/修改卡片，第二轮增量能正确上传，第三设备拉取拿到最新内容——证明水位不吞数据。
- **鉴权/数据域/版本校验**：由既有测试 `hub-auth` / `hub-safety` / `hub` 系列覆盖，未重复铺开。

---

## 四、修复内容清单

| 文件 | 改动 |
|------|------|
| `src/sync-status.js` | `MODULE_LABELS` + `MODULE_ORDER_HINT` 补 `syllabusMeanings: '大纲词中文释义'` |
| `src/i18n/views/sync.js` | zh/en 同步表标签补 `syllabusMeanings` |
| `tests/sync-audit.test.mjs` | 新增 9 项端到端同步审计；修正 test 8 两处 `await ...?.` 优先级陷阱 |

---

## 五、测试数据

- **全量 `npm test`**：**840 / 840 通过，0 失败**（基线 831 + 新增 sync-audit 9 项，无回归）。
- **`tests/sync-audit.test.mjs`**：9 / 9 通过。
- **`tests/await-optional-chain-guard.test.mjs`**：2 / 2 通过（含新文件扫描覆盖自检）。

---

## 六、剩余建议（P2，不阻塞本轮）

1. **Gist 云端通道无单测**：`src/utils/gistBackup.js` 是导入导出的第三通道（文件 / 局域网 / Gist），目前无覆盖。它依赖外部 GitHub API，建议后续用桩 fetch 补一条「令牌校验 + 域名校验 + 数据域隔离」的最小单测，与 `word-llm` 记账的桩实证做法一致。
2. **hub 子进程测试的端口随机化**：`withHub` 用 `49000 + random(800)` 随机端口，极端并发下有极小概率撞端口。当前单文件串行无碍，若未来并行跑多份审计文件，建议加端口互斥或改用 `PORT=0`（系统分配空闲端口后回读）。
3. **`syllabusMeanings` 表登记机制**：本次 R18-7 的根因是「新增同步表」需要在 `sync-manifest.js`、`sync-status.js`、`i18n/views/sync.js` 三处同步登记，缺少一处即回归。可考虑加一条静态守卫：`SYNC_TABLES` 的表名集合必须等于 `MODULE_LABELS`/`MODULE_ORDER_HINT`/i18n 字典的键集合，从源头杜绝漏登记。
