# round62 深度审计报告（统计层输入域修复验收 + 凭证/备份/快检安全面）

- 日期：2026-09-15
- HEAD：`401f40d`（并行会话统计层修复，本轮验收）
- 工作树：`docs-suite/` + 并行报告 round53/55/56/60/61 未跟踪

## 一、本轮实货：验收并行会话统计层修复（4 个 P2 + 1 个 P3）

并行会话 `401f40d` 用 **fake-indexeddb 构造畸形/极值数据实证**（不靠读代码猜）挖到统计层 4 个 P2，全部已修 + 10 条回归。我逐条独立验证：

| 编号 | 缺陷 | 大白话 | 修复核验 |
|---|---|---|---|
| R61-1 | `agg.sum += r.rating` 无域校验 | 一条 rating 缺失的脏行 → 全局掌握度 NaN，下游 `NaN \|\| 0` 静默变"掌握度 0%"——**用户明明在学，系统说他完全没掌握** | ✅ 两级过滤：`real`（非 quick + reviewedAt 有限）与 `rated`（real + rating ∈ {0,1,2}）分开，掌握度只遍历 rated |
| R61-2 | 域外评级只进分母不进分子 | 坏评分静默稀释正确率（实测 100% → 67%） | ✅ correct/stable 分母改用 rated |
| R61-3 | 悬空复习行 → 覆盖率 200% | 删掉的卡还"算数"，覆盖率能超 100% | ✅ 分子与 `cardMap`（现存卡）求交，天然 ≤ 100% |
| R61-4 | `reviewedAt: NaN` → 热力图 `"NaN-NaN-NaN"` 脏桶 | 坏时间戳在热力图/小时分布/趋势里生成 NaN 键 | ✅ real 过滤 `Number.isFinite(reviewedAt)` |
| R61-5 | CardInsight 日期 UTC 午夜 vs 本地（P3） | `new Date('2026-12-25')` 走 UTC 午夜，与 repo/plan 本地口径不一致 | ⚠️ 报告记录，**未修**（P3 观察，合理） |

**关键评价**：这套修复的架构意义是确立了**"两级过滤词汇"纪律**——"可用复习行"与"评分可参与计算的行"是两个概念，混用会同时犯"过严漏计今日复习"和"过松让坏评分污染数学"两类错。`dirtyReviews` 计数不静默（与 skippedImages/imageWriteFailed 同纪律），坏数据成了体检信号而非隐藏炸弹。

验证：全量 **1115/1115**（+10 回归）、lint 0、i18n 闸绿。

## 二、新审计域（3 模块，首次深扫）

### hub-auth.js（局域网 Hub 鉴权）

干净。v2 协议 HMAC-SHA256 挑战-响应：**同步密码只作 HMAC 密钥、永不上网**（局域网抓包也拿不到口令）；`crypto.subtle` 不可用（HTTP 非安全上下文）时返回 null 由调用方降级；fetchChallenge 超时 8s + AbortController + finally 清定时器。

### gistBackup.js（GitHub gist 云备份）

干净且是安全面范本：
- token 只存 localStorage、仅 `gist` scope（最小权限）、secret gist、不上传第三方；
- **乐观并发控制**（GIST_CONFLICT：PATCH 前重读 updated_at，变了抛 code + 机器可读字段，文案走视图层 i18n）——设备 A/B 同时推送不会静默覆盖；
- 404（云端无备份→按首次推送）与 5xx（读不到→禁止盲覆盖）严格区分（round18 R18-2）；
- token 不在备份包内（备份只含 IndexedDB 表），resetAllData 按 sxy 前缀清理。

### quickCheck.js（新卡快速校验）

干净。dueAt 索引收窄（不物化全表）、10min~1h 窗口、`quickCheckedAt > reviewedAt` 防重复校验、单次 ≤8 张；写库走**单事务差量 update**（只动 quickCheckedAt/updatedAt/fieldTs，不触碰并发写入的 SRS 字段——round34 B11 差量写的收尾）。

## 三、问题清单

**本轮零新增 P1/P2**。P3 观察仅 1 项（并行会话 R61-5 遗留，未修）：

| 编号 | 问题 | 大白话 | 位置 |
|---|---|---|---|
| N1 | CardInsight 考试日期走 UTC 午夜 | `new Date('YYYY-MM-DD')` 解析为 UTC 零点，而项目别处（repo/plan）用本地零点——考试窗口紧迫度按"本地时间减 8 小时"计算，同一天设置的考试，紧迫度会早 8 小时开始生效 | `CardInsight.vue:103` |

影响：用户设考试日期当天，紧迫度在"前一天下午 16:00"就提前触发（时区 UTC+8 时）。低危（紧迫度是软排序，不改变 FSRS 状态），建议随下次迭代顺手改为本地零点解析。

## 四、根因观察

本轮最深层的结论来自验收过程：**统计层与调度层的防护不对称正在被补齐**。调度器（FSRS/SM-2）历来有输入域护栏（12 种畸形卡 × 3 评分的实证轰炸零 NaN），统计层此前"裸奔"——现在两级过滤 + dirtyReviews 体检信号把这条线也补上了。这类"脏数据必须显式暴露、不能静默吞掉"的纪律（skippedImages → imageWriteFailed → dirtyReviews 一脉相承）是项目数据完整性的方法论主线，值得写进毕设论文。

## 五、验证与前序完整性

- 全量 **1115/1115** · lint 0 · i18n 双闸绿
- `401f40d` 独立验收通过（含 R61-5 未修项确认）
- 历轮修复抽查：lunar / splitTasks / 备份导入 / 共享快照 / 统计域校验 —— 全部健在
- 本轮新增待办：无（N1 观察级）

```echarts
{
  backgroundColor: 'transparent',
  title: { text: 'round62 验收的 401f40d 修复分布（四维）', left: 'center', textStyle: { color: '#1A1B1C', fontSize: 15, fontWeight: 600 } },
  tooltip: { trigger: 'axis', triggerOn: 'click', renderMode: 'richText', confine: true, textStyle: { fontSize: 10, lineHeight: 14 }, padding: [6, 8] },
  legend: { top: 36, itemWidth: 14, itemHeight: 8, textStyle: { color: '#6B7280', fontSize: 11 } },
  grid: { left: 44, right: 20, top: 84, bottom: 32, containLabel: true },
  xAxis: { type: 'category', data: ['算法', '业务逻辑', '数据协同', '数据对象'], axisLabel: { color: '#555', fontSize: 11, hideOverlap: true } },
  yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#555', fontSize: 11 } },
  series: [
    { name: 'P1', type: 'bar', stack: 't', barWidth: 34, itemStyle: { color: '#E56B6F' }, data: [0, 0, 0, 0] },
    { name: 'P2', type: 'bar', stack: 't', itemStyle: { color: '#F2A65A' }, data: [2, 1, 0, 1] },
    { name: 'P3', type: 'bar', stack: 't', itemStyle: { color: '#8BC8EA' }, data: [0, 1, 0, 0] }
  ]
}
```
