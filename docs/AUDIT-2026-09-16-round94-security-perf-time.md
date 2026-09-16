# 全面审计报告 · 2026-09-16 · 安全 / 资源生命周期 / 性能悬崖 / 时间时区（round94）

- **审计范围**：本轮聚焦**此前未系统审计的维度**（round93 已覆盖数据/同步、算法、业务逻辑）：
  ① 安全面（XSS / 注入 / 密钥泄漏 / hub 鉴权 / 插件沙箱 / prompt 注入）；
  ② 资源生命周期与内存泄漏；③ 数据规模下的性能悬崖；④ 时间 / 时区 / 日期边界。
- **方法**：直接读源码逐个核验（子代理额度受限，本轮由主审全程手工排查 + 脚本取证）。
- **基线 HEAD**：`a065ce9`（round93）。
- **结论**：**未发现 P0/P1**。发现 **1 项值得优先处理的 P2/P3 级一致性缺陷**（公式注入防护不一致）+ **4 项 P3**；
  其余高危面（XSS / 密钥 / hub 鉴权 / 资源泄漏）经实证**均为健壮**。整体工程质量高。

---

## 一、值得优先处理：CSV 公式注入防护「三处缺失」（P2 一致性 · 安全）

**位置**（同一职责的 5 条导出路径，防护不一致）：
| 导出路径 | 是否防公式注入 | 证据 |
|---|---|---|
| `src/utils/exporters.js` `toCSV` → `csvEscape` | ✅ 有 | `sheetCellGuard` 前置 `'` 中和 `[=+\-@\t\r]`（exporters.js:100/108） |
| `src/sync.js` TSV（正/背/科目/标签） | ✅ 有 | sync.js:457 用 `sheetCellGuard` |
| `src/sync.js` Anki 纯文本 | ✅ 有 | sync.js:481-482 用 `sheetCellGuard` |
| **`src/views/Export.vue`** privacy CSV | ❌ **无** | Export.vue:137 `esc = s => String(s).replace(/"/g,'""')` |
| **`src/views/WordExport.vue`** 词表 CSV | ❌ **无** | WordExport.vue:207 `escq` 仅转义 `"` |
| **`src/services/word-syllabus.js`** 大纲 CSV | ❌ **无** | word-syllabus.js:133 `"${w}"` —— 连 `"` 都未转义 |

**成因**：`sheetCellGuard` 只落在 `exporters.js` 与 `sync.js`，三处**手写 CSV 拼装**没有复用统一出口。
**影响（攻击路径）**：单元格值以 `=` / `+` / `-` / `@` 开头时，导出的 CSV 在 **Excel / WPS** 打开会被当公式执行
（`=cmd|'/c calc'!A1` 类）。最现实路径：用户导入一份**他人分享的备份包**（卡片/单词里含恶意 `=…` 文本）→ 再导出 CSV → 本地打开即触发。
self 数据场景危害有限，故定级 P2（安全性）；但防护「应一处一有、处处都有」，缺失即属实现不当。
**附带**：`word-syllabus.js:133` 未转义 `"`，值含引号时 CSV 会错列。
**建议修法**：三处分别改用 `csvEscape`（exporters.js 导出它）或至少前置 `sheetCellGuard`；`word-syllabus` 补 `"` 转义。

---

## 二、P3 · 轻微（边界 / 健壮性 / 体验）

| # | 位置 | 缺陷 | 成因 / 影响 | 实证 |
|---|---|---|---|---|
| P3-1 | `src/agent/analytics.js:43-50` `offload` | **跨线程调用无超时**，且 `_pending.set` 在 `postMessage` 之前（postMessage 抛 DataCloneError 时条目泄漏） | worker 若对某消息**不回**（handler 内 await 悬挂 / 线程被静默回收且未触发 `onerror`），调用方 `await` **永久挂起**，UI 转圈无报错；与 LLM 链路「显式超时」口径不一致 | 已读源码；worker 对 unknown fn / 抛错均有回（worker.js:33/40），故仅「handler 悬挂」这一小概率路径 |
| P3-2 | `src/sync.js:441` | 下载文件名嵌入**用户可控** `${subject}` | subject 含 `/\:*?"<>\|` 时生成非法/怪异文件名；浏览器会剥离路径分隔符，**遍历被缓解** → 仅体验问题 | 已读源码 |
| P3-3 | `src/utils/locale-date.js:37/51/65` | `catch` 兜底用 `d.toISOString()`（**UTC**） | 仅在 `Intl` 抛错（极罕见）时，日期显示会按 UTC 偏移（东八区 0–8 点差一天）；正常路径走 `Intl`（本地），无问题 | 已读源码 |
| P3-4 | `src/utils/locale-date.js:21` `toDate` | `d.getTime() <= 0` 一律判非法 | 时间戳**恰为 epoch 0**（1970-01-01T00:00:00Z）会被显示成 `—`；实际数据不出现，可忽略 | 已读源码 |
| P3-5 | `src/agent/analytics.js:186/288/474`、`graphAuto.js:99`、`repo.js:1210/1247/2114` | 无界 `db.reviews.toArray()` **全表扫描** | 60k 复习记录下单次全扫约 436ms（repo.js:1185 实测注释）；已被 `dashboardSnapshot`（复合键缓存）/`failCountMap` 缓存 + FSRS 训练 offload 到 worker 缓解 → **已知且已缓解**，非新缺陷 | 已读源码 + 注释实证 |

---

## 三、实证为「健壮」的高危面（明确排除，避免误报）

| 维度 | 结论 | 证据 |
|---|---|---|
| **XSS** | ✅ 全部 `v-html` 出口均转义或经 `sanitizeHtml`（DOMPurify） | MarkdownRenderer.vue:115 净化；Cards/Search 走 `highlight`（先转义，search-service.js:69）；WordBook `highlightWord`（转义，WordBook.vue:576）；LibraryFiles **转义 + 净化双重**（LibraryFiles.vue:252/255/260）；`sanitize.js` 配置合理（禁 script/iframe/form，限 URI） |
| **密钥泄漏** | ✅ AI Key 存 localStorage `sxy_ai_config`，**不入 IndexedDB** → 备份/同步天然不含；`wordSettings` strip `llmApiKey`/`llmBase`（sync-manifest.js:149）；无密钥进日志 | grep `apiKey` 全路径核验 |
| **同步 hub 鉴权** | ✅ HMAC 挑战-响应 + `timingSafeEqual` 恒定时间比较 + 限流 + CORS 允许列表（localhost/私有网段/host）；已修「/health 泄露 tokenOk 预言机」；`hub-token.txt`/`hub-data.json` 已 gitignore | auth-core.js:18/69/202-228 |
| **插件沙箱** | ⚠️ 按设计**不沙箱**（Blob URL + `import()` ≈ eval），但加载器**显式文档化**并靠「用户主动安装 + 二次确认 + 结构化克隆 args」控风险 | loader.js:8-14 |
| **eval / new Function** | ✅ 全仓无（唯一动态执行即插件 `import(blobUrl)`，已文档化） | grep 命中 0 |
| **structuredClone** | ✅ 仅集中封装在 `utils/clone.js:15`，无裸调 | grep |
| **资源生命周期** | ✅ `setInterval` 均有 `clearInterval` + 卸载钩子（12 文件逐一核对）；`URL.createObjectURL` 均有 `revokeObjectURL`（Cards.vue:582/606 缓存淘汰、images.js:19/27、LibraryFiles.vue:183/222）；Worker 有 `terminate` | grep setInterval/clearInterval/revoke 交叉核对 |
| **时间 / 日期** | ✅ 权威 `utils/time.js` 正确：`dateKey` 本地补零、`dateKeyToTs` 按**本地零点**解析（避开裸日期串=UTC 的 8 小时坑）并做回环校验；日界计算全走**本地** `setHours(0,0,0,0)`；`graphAuto.js:197` 跨午夜错题聚类已用本地日界（注释即为此坑） | time.js 全文 + 多处核对 |

---

## 四、优先级建议

1. **S1（本报告一）** —— 3 处导出统一走 `csvEscape`/`sheetCellGuard`，小改、明确，建议单独一轮收口。
2. **P3-1** —— 给 `offload` 加超时（与 LLM 链路同款纪律），防 UI 永久挂起。
3. 其余 P3 为体验/边角，可随手感批量处理。

## 五、本轮未改动任何文件（只读审计）
