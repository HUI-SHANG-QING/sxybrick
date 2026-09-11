# SxyBrick 深度代码审计报告 — Round 41

> **审计日期**：2026-09-15
> **代码基线**：git HEAD `5ae2542`（自 round40 基线 `a5cb4a2` 起 2 次提交）
> **测试状态**：976/976 全部通过（新增 3 个回归测试），耗时 ~44.5s
> **上轮报告**：`docs/AUDIT-2026-09-15-round40-deep.md`

---

## 一、上轮缺陷修复状态核验

### 全部修复 ✅

| 上轮编号 | 问题 | 修复方式 | 验证 |
|---|---|---|---|
| NEW-01 | wordStudyLog id=`t-${date}`，双设备同日 id 冲突 | id 改为 `t-${date}-${deviceId}`，deviceId 存 db.meta（白名单不同步）；读取按 date 索引求和 | word-repo.js:648-684 ✅ |
| NEW-02 | notifications 已读状态用 update 但 idOnly 不更新 | merge 策略改 updatedAt；markRead/markAllRead bump updatedAt | proactive.js:84,91, sync-manifest.js:162 ✅ |
| NEW-03 | notifications 删除/清空/超量清理不写墓碑 | 三处删除路径全包事务+写墓碑 kind='notification' | proactive.js:61-66,96-102,104-108 ✅ |
| NEW-04 | notifications 已读设计语义矛盾 | 决策：全局已读（一处已读处处已读），merge 改 updatedAt | sync-manifest.js:155-156 ✅ |
| NEW-05 | mergeRows 平局重复 JSON.stringify | 平局分支只序列化一次复用 | sync-manifest.js:551-556 ✅ |
| NEW-06 | tombKindTable 未防 kind 缺失 | 新增自动化测试：扫描所有源码 `.js` 文件中正则匹配 `kind: 'xxx'`，断言每个都在派生映射中 | tests/sync-manifest.test.mjs ✅ |
| NEW-07 | docs/exams fieldTs 字段列表硬编码两处 | 提为 `DOC_EDITABLE_FIELDS` / `EXAM_EDITABLE_FIELDS` 常量，create/update 共用 | repo.js:1707-1708,1723,1736,1943,1963 ✅ |

### 修复质量评价

- **wordStudyLog 分片设计正确**：deviceId 存 db.meta 且 meta 同步是白名单制（只同步 goal/examAt/schedMeta），deviceId 不会泄露到对端；旧格式行 `t-${date}` 仍带 date 字段，按 date 索引查询自然兼容；UUID v4 前 12 hex = 48 位随机，碰撞概率 ~1/281 万亿，可忽略。
- **notifications 全局已读语义统一**：产品决策明确（全局已读），所有写路径（创建带 updatedAt、markRead bump、markAllRead bump、删除写墓碑）一致。旧数据无 updatedAt 时 mergeRows 有 `updatedAt ?? createdAt ?? 0` 保护，回退到 createdAt LWW，无回归。
- **墓碑 kind 防手滑测试是亮点**：自动扫描源码正则提取所有 `kind: 'xxx'` 墓碑写入，断言都在 tombKindTable() 派生映射中。这把"人工 checklist"变成了"CI 强制检查"，新增表忘登记会直接测试失败。

---

## 二、本轮新发现

### 无新引入的严重缺陷。

逐项检查了新代码的边界条件：

1. **localDeviceId 并发安全**：`_deviceIdCache` 模块级缓存，首次调用时 get→miss→生成→put→cache。如果两个 recordWordStudyTime 并发调用，可能都走 miss 分支生成不同 id，但 db.meta.put 是幂等的（后写覆盖先写），最终两个并发事务可能用不同 id 写两行——概率极低且后果仅是多一行同设备记录，下次读取按 date 求和无影响。
2. **notifications markAllRead 的 bulkPut**：从 toArray() 取完整行后 spread + 改 read/updatedAt，整行覆盖式 put。如果另一设备在 markAllRead 期间推送了新通知，bulkPut 不会覆盖新行（因为 unread 查询不包含新行），正确。
3. **wordStudyTimeToday 的索引查询**：`where('date').equals(todayStr())`，db.js 确认 `wordStudyLog: 'id, date'` 有 date 索引，O(匹配数) 而非全表扫描。
4. **DOC_EDITABLE_FIELDS 常量**：Object.fromEntries 初始化 fieldTs，create 和 update 共用，新增字段只需改一处。

---

## 三、历史遗留问题追踪

经过 round32→round41 共 10 轮审计，以下问题已全部闭环：

| 轮次 | 问题数 | 状态 |
|---|---|---|
| round32 | 10 缺陷 + 8 优化 + 8 扩展 | 全部修复 |
| round33-37 | 多轮审计修复 | 全部修复 |
| round38（本项目第一轮审计） | 5 缺陷 + 5 优化 + 6 扩展 | 全部修复 |
| round39 | 4 新缺陷 + 5 遗留 | 全部修复 |
| round40 | 3 新观察（P3） | 全部修复 |
| **round41** | **0 个新缺陷** | **✅** |

当前代码库没有已知的 P1/P2 级缺陷。剩余的 P3 级可维护性建议（如 OPT-03 pruneTombstones 加 deletedAt 索引、EXT-05 clockSkew 持久化）不影响正确性，可按排期处理。

---

## 四、优先级汇总

| 编号 | 优先级 | 位置 | 说明 |
|---|---|---|---|
| — | — | — | **无新发现的缺陷** |

历史 P3 级建议（不紧急，排期处理）：
- pruneTombstones 全表 toArray，可加 deletedAt 索引优化
- clockSkew 偏移估计可持久化渐进校准
- idOnly 表更新路径可加自动化测试校验

---

## 五、审计结论

**这是一轮"干净的"审计。** 上轮指出的 7 个问题（含 2 个 P1）全部修复，修复质量高（注释清晰、测试覆盖、边界处理到位），未发现新引入的缺陷。测试从 973 增至 976。

特别是墓碑 kind 防手滑测试——自动扫描源码断言所有墓碑 kind 都在映射表中——把长期存在的"枚举漂移"系统性风险从"靠人记"变成了"靠 CI 拦"，这是工程素养的体现。

**当前代码库状态：成熟、稳定、无已知 P1/P2 缺陷。** 如果是毕设项目，现在的代码质量和测试覆盖已经远超本科毕设要求。

---

*审计完成时间：2026-09-15 | 审计基线：5ae2542 | 测试：976/976 pass*
