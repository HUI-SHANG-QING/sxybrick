// 本文件由 repo.js 物理拆分而来（方案 A：**只搬移、不改任何逻辑**）。
// 业务域：剪枝 / 隐私 / 图谱边 / 番茄 / 操作日志（仅依赖 cards，单向）
// 依赖方向：本文件 → ./cards.js → db.js|srs.js|...（单向；**禁止反向 import 以免成环**）
// 5 个模块级缓存变量（_schedCache/_dashSnap/_dashLoading/_failCountCache/_failCountForced）
// 与其读写函数同处 cards.js —— 缓存绝不分裂。

// 数据访问层：把原版 Express 后端的业务逻辑，改写成对本地 IndexedDB 的读写
import { db, uid } from '../db.js';
import { RETRIEVAL_STRENGTH_OPTIONS } from '../srs.js';
// P3-4 插件事件钩子：业务动作后向已启用插件分发（fire-and-forget，不阻塞也不抛错）
// 静态导入无循环依赖：plugins/registry 只依赖 db.js 与 agent/registry.js，不依赖 repo.js
// P1-3 检索强度分级选项：供 Review.vue 等 UI 直接渲染选择器
export { RETRIEVAL_STRENGTH_OPTIONS };
// D3.1 笔记解析纯函数（双向链接 + 标签抽取 + 归一化）
// P1-18 统一格式化（日期补零 / 字节）收口到 format.js，消除全局重复实现
import { pad2 } from '../utils/format.js';
// 审计 D7：日期 key 统一走 time.dateKey（补零 yyyy-MM-dd），与 word/streak 同源，
// 否则 repo 本地一份 localDateStr 独立实现会在未来格式演进时跨表整日错位。
import { dateKeyToTs } from '../utils/time.js';
import { kindOf } from '../sync-manifest.js';
// 向量行 id 的确定性形态与前缀匹配（agent/embedding-key.js 无任何依赖，静态导入不成环）
// N9 纯函数层：校验/过滤/排序/统计逻辑抽至 repo-core.js（Node 可单测），repo.js 只做 IO 编排
import { DEFAULT_SUBJECTS, validateCard as _validateCard, gradeCard as _gradeCard, WRONG_REASON_MAP as _WRONG_REASON_MAP, WRONG_REASONS as _WRONG_REASONS, wrongReasonToCode as _wrongReasonToCode, formatDue as _formatDue, selectZombieIds, groupUserOps, realReviews } from '../repo-core.js';
export { DEFAULT_SUBJECTS };

export async function repairBrokenDueAt({ force = false } = {}) {
  const FLAG = 'sxy_heal_broken_dueat_v1';
  if (!force) {
    try { if (localStorage.getItem(FLAG)) return 0; } catch { /* 隐私模式忽略 */ }
  }
  let fixed = 0;
  const heal = async (table) => {
    const broken = await table.filter(c => {
      const d = c.dueAt;
      return d !== undefined && (d === null || Number.isNaN(d));
    }).toArray();
    if (!broken.length) return;
    await table.bulkPut(broken.map(c => ({ ...c, dueAt: 0 })));
    fixed += broken.length;
  };
  await heal(db.cards);
  await heal(db.wordCards);
  if (!force) { try { localStorage.setItem(FLAG, '1'); } catch { /* 忽略 */ } }
  if (fixed) console.info(`[repo] 修复 ${fixed} 张损坏 dueAt(NaN/null) 卡片为「立即到期」（自愈）`);
  return fixed;
}

/**
 * userOps（全操作埋点）保留期清理：只保留最近 keepDays 天（默认 365），更老的删除并写墓碑。
 * 为什么必须写墓碑：userOps 走 idOnly 合并（absence ≠ deletion）——若只在本机 bulkDelete，
 * 中枢/对端仍持有的旧副本会在下次拉取时把清掉的行「复活」回来（也解释了此前该表只增不减）。
 * 墓碑（kind='userOp'）随同步/备份传播，让对端与中枢一并清掉。
 * 每次最多清 MAX_PER_RUN 条：首跑若积压多年可分成数次（启动/导入时各清一批），
 * 避免单次超大事务 + 墓碑风暴。
 * @param {{keepDays?:number}} opts
 * @returns {Promise<number>} 本次清理行数
 */
export async function pruneUserOps({ keepDays = 365 } = {}) {
  const cutoff = Date.now() - keepDays * 86400000;
  const MAX_PER_RUN = 10000;
  const ids = await db.userOps.where('t').below(cutoff).limit(MAX_PER_RUN).primaryKeys();
  if (!ids.length) return 0;
  const nowTs = now();
  await db.transaction('rw', db.userOps, db.tombstones, async () => {
    await db.userOps.bulkDelete(ids);
    await db.tombstones.bulkPut(ids.map(id => ({ id, kind: 'userOp', deletedAt: nowTs })));
  });
  return ids.length;
}

// round34 M3：墓碑表（tombstones）永不清理——每次增量备份全量随包发送，
// 删除越多包越大、同步/导入越慢。补一个 TTL/GC：删除时间超过最大离线窗口的墓碑，
// 且本地对应行确实已不存在（避免误删仍在等待传播的删除），定期清除。
// 保留 30 天窗口给所有设备完成同步；超期且本地无残留行即可安全 GC。
// round38 ④：墓碑 kind → 表名映射改为从同步清单自动派生（tombKindTable），
// 杜绝手写清单漂移导致某些 kind（如 groupLink/pomo/memory/privacy）的墓碑永不 GC。
export async function pruneTombstones({ maxAgeDays = 30, maxPerRun = 5000 } = {}) {
  const cutoff = Date.now() - maxAgeDays * 86400000;
  const all = await db.tombstones.toArray();
  const candidates = all.filter(t => (t.deletedAt || 0) < cutoff).slice(0, maxPerRun);
  if (!candidates.length) return 0;
  // 按 kind 分组后 bulkGet 存在性判定（避免逐条 get 的 N 次查询）
  const byTable = new Map();
  for (const t of candidates) {
    const table = TOMB_KIND_TABLE[kindOf(t)];
    if (!table || t.id == null) continue;
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table).push(t);
  }
  const skip = new Set(); // 本地对应行仍存在 → 删除尚未生效，墓碑不能删（否则复活）
  for (const [table, rows] of byTable) {
    let present = [];
    try {
      present = (await db[table].bulkGet(rows.map(r => r.id))).filter(Boolean).map(r => r.id);
    } catch { /* 缺表则视为可清 */ }
    for (const r of rows) if (present.includes(r.id)) skip.add(r.id);
  }
  const ids = candidates.map(t => t.id).filter(id => !skip.has(id));
  if (!ids.length) return 0;
  await db.tombstones.bulkDelete(ids);
  return ids.length;
}

// round34 M4：aiUsage 随每次 AI 调用无上限增长 → 本地膨胀，按日期裁剪。
// round38：aiUsage 已并入同步表（v33）→ 走 idOnly 合并，absence ≠ deletion；
// 裁剪必须写墓碑（kind='aiUsage'），否则中枢/对端旧副本下次拉取会把清掉的行复活。
// round34 M4：aiUsage 随每次 AI 调用无上限增长 → 本地膨胀，按日期裁剪。
// round38：aiUsage 已并入同步表（v33）→ 走 idOnly 合并，absence ≠ deletion；
// 裁剪必须写墓碑（kind='aiUsage'），否则中枢/对端旧副本下次拉取会把清掉的行复活。
export async function pruneAiUsage({ keepDays = 90, maxPerRun = 10000 } = {}) {
  const cutoff = Date.now() - keepDays * 86400000;
  const ids = await db.aiUsage.where('t').below(cutoff).limit(maxPerRun).primaryKeys();
  if (!ids.length) return 0;
  const nowTs = now();
  await db.transaction('rw', db.aiUsage, db.tombstones, async () => {
    await db.aiUsage.bulkDelete(ids);
    await db.tombstones.bulkPut(ids.map(id => ({ id, kind: 'aiUsage', deletedAt: nowTs })));
  });
  return ids.length;
}

// round34 M4：privacyRecords（EXCLUDED_FROM_SYNC，隐私监控本地落库）无上限增长。
// 按 updatedAt/date 裁剪；本地表不参与同步，直接 bulkDelete。
// round34 M4：privacyRecords（EXCLUDED_FROM_SYNC，隐私监控本地落库）无上限增长。
// 按 updatedAt/date 裁剪；本地表不参与同步，直接 bulkDelete。
export async function prunePrivacyRecords({ keepDays = 180, maxPerRun = 10000 } = {}) {
  const cutoff = Date.now() - keepDays * 86400000;
  const rows = await db.privacyRecords.toArray();
  const ids = [];
  for (const r of rows) {
    if (ids.length >= maxPerRun) break;
    // round76：'YYYY-MM-DD' 一律按本地零点解析（裸 new Date 会当 UTC 零点，东八区差 8 小时）
    const ts = r.updatedAt || dateKeyToTs(r.date) || 0;
    if (ts && ts < cutoff) ids.push(r.id);
  }
  if (!ids.length) return 0;
  await db.privacyRecords.bulkDelete(ids);
  return ids.length;
}

// 手动标记 / 取消标记错题
// ---------- 知识图谱关系（可持久化、随数据包同步） ----------
export async function listGraphEdges() {
  return db.graphEdges.toArray();
}
export async function createGraphEdge(payload) {
  const from = String(payload?.from || '').trim();
  const to = String(payload?.to || '').trim();
  if (!from || !to) throw new Error('关系的两端不能为空');
  const label = String(payload?.label || '相关').trim();
  const subject = String(payload?.subject || '').trim();
  // R10 修复：边存卡片 id 直连，避免文本匹配静默覆盖（两卡文本相同时旧逻辑会覆盖）
  // from/to 仍保留（兼容遗留数据 + 图谱节点显示用 label）；fromCardId/toCardId 为稳定连接键
  const fromCardId = payload?.fromCardId ? String(payload.fromCardId) : '';
  const toCardId = payload?.toCardId ? String(payload.toCardId) : '';
  // Phase 6.6：资料边（资料 → 卡片「涵盖」）用 docId 标识来源资料 + type 区分
  const docId = String(payload?.docId || '');
  const type = String(payload?.type || '');
  // 去重优先级：docId（资料边）> cardId（卡片边）> label（遗留兼容）
  // round26 H-2：卡片边走 fromCardId 索引范围查询（每卡出边量小），
  // docId/遗留 label 边保留 filter 全表扫（调用频次低，全表边数千以内可接受）。
  let exists = null;
  if (docId) {
    exists = await db.graphEdges.filter(e => e.docId === docId && e.to === to && (e.label || '相关') === label).first();
  } else if (fromCardId && toCardId) {
    exists = await db.graphEdges
      .where('fromCardId').equals(fromCardId)
      .and(e => e.toCardId === toCardId && (e.label || '相关') === label)
      .first();
  } else {
    exists = await db.graphEdges.filter(e => e.from === from && e.to === to && (e.label || '相关') === label).first();
  }
  if (exists) return null;
  const t = now();
  const e = {
    id: uid(), from, to, fromCardId, toCardId,
    label,
    subject,
    docId,
    type,
    createdAt: t, updatedAt: t,
  };
  await db.graphEdges.put(e);
  return e;
}
export async function deleteGraphEdge(id) {
  // round15 P2：delete + 墓碑同事务（防墓碑写失败导致对端回灌已删边）
  await db.transaction('rw', db.graphEdges, db.tombstones, async () => {
    await db.graphEdges.delete(id);
    await db.tombstones.put({ id, kind: 'graphEdge', deletedAt: now() }); // 墓碑：跨设备同步删除
  });
}

// ---------- AI 文档（可持久化、随数据包同步） ----------
export async function addPomoSession(payload) {
  const t = now();
  const roundId = payload?.roundId ? String(payload.roundId) : null;
  // round30（P1-4）：roundId 作主键（提供时）→ DB 层真正幂等。
  // 旧实现 id=uid()、roundId 只是非唯一索引字段，put 不会去重；双标签页并发（localStorage
  // 去重在「读改写」非原子窗口被击穿）可各插一行，导致番茄数/成就虚高。
  // 现在同 roundId 的二次 put 直接覆盖（原地更新），绝不复写两条；无 roundId 时退化为 uid（向后兼容）。
  const s = {
    id: roundId || uid(),
    startedAt: payload?.startedAt || t,
    duration: Number(payload?.duration) || 0, // 分钟
    tag: String(payload?.tag || '').trim().slice(0, 30),
    partial: payload?.partial ? 1 : 0,
    createdAt: t,
  };
  if (roundId) s.roundId = roundId;
  await db.pomoSessions.put(s);
  return s;
}
export function isPomoCountable(p) {
  return !p || !p.partial;
}

export async function countPomoToday() {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  // H-3：原实现先把今日全部行 toArray() 再内存 .filter(partial) —— partial 行多时
  // 整批拉回内存。改为 .and() 在索引游标上过滤 + count()，全程流式不物化。
  return db.pomoSessions.where('startedAt').aboveOrEqual(dayStart.getTime())
    .and((p) => isPomoCountable(p))
    .count();
}

// ---------- 思维导图（可持久化、随数据包同步；借鉴 Progress AI 的本地化实现） ----------
// 树结构：{ id, label, children: [...] }，根节点在 root 字段
// 1) 僵尸卡 ID 集合（90 天到期且从未复习）
export async function zombieCardIds() {
  // 判定核心已抽至 repo-core.selectZombieIds（N9）
  const [cards, reviewed] = await Promise.all([
    db.cards.toArray(),
    db.reviews.toArray().then(rs => realReviews(rs).map(r => r.cardId)),
  ]);
  return selectZombieIds(cards, reviewed, Date.now());
}

// 2) 埋点写入（同步到 telemetry A 级），返回立即 flush 的 Promise
import { trackAction, flushTelemetry } from '../utils/telemetry.js';
import { now, plain, TOMB_KIND_TABLE } from './shared.js';
export async function recordUserOp(type, payload = null, extra = {}) {
  trackAction(type, payload, extra);
  return flushTelemetry();
}

// 3) 查询 userOps + 分组聚合（仪表盘数据层核心）
// opts:
//   from: ms (inclusive, nullable)
//   to:   ms (inclusive, nullable)
//   groupBy: 'day' | 'hour' | 'module' | 'type' | 'category' | 'dayHour' | null(全量返回数组)
// 返回：groupBy=null → 原始数组；否则 Map(key → count) 或 数组（day/hour 有序）
// 3) 查询 userOps + 分组聚合（仪表盘数据层核心）
// opts:
//   from: ms (inclusive, nullable)
//   to:   ms (inclusive, nullable)
//   groupBy: 'day' | 'hour' | 'module' | 'type' | 'category' | 'dayHour' | null(全量返回数组)
// 返回：groupBy=null → 原始数组；否则 Map(key → count) 或 数组（day/hour 有序）
export async function queryUserOps(opts = {}) {
  const { from = 0, to = Date.now(), groupBy = null, excludeTypes = null } = opts;
  const tIdx = db.userOps.where('t');
  // 审计 D9：无 from 时原实现全表 toArray + 内存过滤（埋点十万行场景徒增物化）。
  // 统一用 't' 索引范围，只物化 [0, to] 区间。
  const arr = from > 0
    ? await tIdx.between(from, to, true, true).toArray()
    : await tIdx.belowOrEqual(to).toArray();
  // 审计 P2-6（round34）：支持类型排除——热力图合并 reviews+wordReviews 时，
  // userOps 的 review_rate 与 reviews 行是同一动作的两次记录，需排除防双计。
  const filtered = excludeTypes?.length ? arr.filter(o => !excludeTypes.includes(o.type)) : arr;
  if (!groupBy) return filtered;
  // 分组聚合核心已抽至 repo-core.groupUserOps（N9）
  return groupUserOps(filtered, groupBy);
}

// 4) 最佳 / 最坏拍档（A/B/C/D 四类 + 近期/长期 + 正/反 共 16 种组合）
// kind:
//   A = 最高频学习科目（/最冷门）
//   B = 最高频 Agent 工具调（/最少）
//   C = 最常共现知识点 pair（/最少）
//   D = 最活跃单份资产（/最不活跃僵尸单份）
// rangeDays: 7 = 近期, 90 = 长期
// worst: false=最佳, true=最坏
// 卡片展示名：空卡面用语言中立的 '—' 占位。
// 数据层不能产出中文占位符（旧实现写死 '（空卡）'）—— 它不经过 i18n，英文界面下会露馅。
// 5) 隐私数据 CRUD（B 档超级详尽结构化）
export async function savePrivacyRecord(record) {
  const nowTs = Date.now();
  let payload;
  if (record?.id) {
    const old = await db.privacyRecords.get(record.id);
    payload = plain({
      ...(old || {}),
      ...record,
      updatedAt: nowTs,
    });
  } else {
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const today = new Date();
    const dateKey = record?.date || `${today.getFullYear()}-${pad2(today.getMonth()+1)}-${pad2(today.getDate())}`;
    payload = plain({
      id,
      date: dateKey,
      startTime: record?.startTime ?? nowTs,
      endTime: record?.endTime ?? nowTs,
      type: record?.type || 'other',
      subType: record?.subType || '',
      location: record?.location || '',
      people: Array.isArray(record?.people) ? record.people : [],
      mood: Number(record?.mood) || 3,
      energy: Number(record?.energy) || 3,
      focus: Number(record?.focus) || 3,
      pleasure: Number(record?.pleasure) || 3,
      stress: Number(record?.stress) || 3,
      painIndex: Number(record?.painIndex) || 0,
      painParts: Array.isArray(record?.painParts) ? record.painParts : [],
      sleepBlock: record?.sleepBlock || null,
      eatBlock: record?.eatBlock || null,
      moveBlock: record?.moveBlock || null,
      learnBlock: record?.learnBlock || null,
      workBlock: record?.workBlock || null,
      screenBlock: record?.screenBlock || null,
      financeBlock: record?.financeBlock || null,
      mental: record?.mental || '',
      // 审计：以下5个 UI 字段在新建分支漏存——编辑靠 ...record 透传能存，新建却丢
      anxiety: Number(record?.anxiety) || 3,
      depression: Number(record?.depression) || 3,
      confidence: Number(record?.confidence) || 3,
      stressSource: record?.stressSource || '',
      exciteBlock: record?.exciteBlock || null,
      customTags: Array.isArray(record?.customTags) ? record.customTags : [],
      customKV: record?.customKV || {},
      createdAt: nowTs,
      updatedAt: nowTs,
    });
  }
  await db.privacyRecords.put(payload);
  return payload;
}
export async function listPrivacyRecords({ fromDate, toDate, type, limit = 500 } = {}) {
  // 审计 D2（limit 先于过滤会静默漏数）：原实现 `orderBy(updatedAt).limit(limit)` 先截断、
  // 再按 date/type 内存过滤——只要「最近 limit 条」里含被过滤掉的记录，更早的匹配行
  // 就永远不会返回（即使命中总量远超 limit）。date 已建索引（db.js v14）。改为一条
  // 索引范围查询定位匹配行，再在结果内 limit，保证「返回条数=min(命中,limit)」而非更少。
  let arr;
  const hasRange = !!fromDate || !!toDate;
  if (hasRange) {
    const from = fromDate || '0';
    const to = toDate || '\uffff';
    arr = await db.privacyRecords.where('date').between(from, to).toArray();
    if (type) arr = arr.filter(r => r.type === type);
    arr.sort((a, b) => (b.updatedAt - a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return arr.slice(0, limit);
  }
  arr = await db.privacyRecords.orderBy('updatedAt').reverse().toArray();
  if (type) arr = arr.filter(r => r.type === type);
  return arr.slice(0, limit);
}
export async function getPrivacyRecord(id) { return (await db.privacyRecords.get(id)) || null; }
export async function deletePrivacyRecord(id) {
  // round15 P2：delete + 墓碑同事务（隐私表默认不入同步，但 opt-in 后墓碑必须可靠）
  await db.transaction('rw', db.privacyRecords, db.tombstones, async () => {
    await db.privacyRecords.delete(id);
    await db.tombstones.put({ id, kind: 'privacy', deletedAt: Date.now() });
  });
}

// 6) 隐私人物画像报告（启发式本地算法 + 可选 AI 增强）
// 返回 { physical, behavioral, mental, prediction } 四大块文字
// 6) 隐私人物画像报告（启发式本地算法 + 可选 AI 增强）
// 返回 { physical, behavioral, mental, prediction } 四大块文字
export async function privacyPersonaReport({ rangeDays = 7, includeUserOps = true } = {}) {
  const since = Date.now() - rangeDays * 24 * 3600 * 1000;
  const records = (await db.privacyRecords.toArray()).filter(r => (r.updatedAt || 0) >= since);
  const N = records.length;
  const lines = [];
  lines.push(`【画像周期】近 ${rangeDays} 天，共 ${N} 条隐私记录。${includeUserOps ? '已叠加系统真实操作埋点。' : ''}`);

  // 物理画像：睡眠趋势 / 能量潮汐 / 饮食风险 / 疼痛高发
  const sleepHrs = records.map(r => r.sleepBlock?.hours).filter(v => Number.isFinite(v));
  const avgSleep = sleepHrs.length ? sleepHrs.reduce((a,b)=>a+b,0)/sleepHrs.length : null;
  const mood = records.map(r => Number(r.mood)||0).filter(v=>v>0);
  const avgMood = mood.length ? mood.reduce((a,b)=>a+b,0)/mood.length : null;
  const energy = records.map(r => Number(r.energy)||0).filter(v=>v>0);
  const avgEnergy = energy.length ? energy.reduce((a,b)=>a+b,0)/energy.length : null;
  const stress = records.map(r => Number(r.stress)||0).filter(v=>v>0);
  const avgStress = stress.length ? stress.reduce((a,b)=>a+b,0)/stress.length : null;

  const physical = [];
  if (avgSleep !== null) physical.push(`平均睡眠 ${avgSleep.toFixed(1)}h${avgSleep < 6.5 ? ' ⚠ 偏少，长期缺觉会显著削弱记忆巩固与判断力。' : avgSleep > 8.5 ? '，睡眠充足，是学习效率的基础。' : '，在健康区间。'}`);
  const caffMg = records.reduce((s,r)=>s + (Number(r.eatBlock?.caffeineMg)||0), 0);
  if (caffMg > 0) physical.push(`周期咖啡因摄入 ${Math.round(caffMg)}mg${caffMg / rangeDays > 300 ? ' ⚠ 日均超 300mg，会影响深睡结构，建议减半。' : '。'}`);
  const painScores = records.map(r => Number(r.painIndex)||0).filter(v=>v>0);
  if (painScores.length) {
    const allParts = new Map();
    for (const r of records) for (const p of (r.painParts||[])) allParts.set(p,(allParts.get(p)||0)+1);
    const topPart = [...allParts.entries()].sort((a,b)=>b[1]-a[1])[0];
    physical.push(`躯体疼痛发作 ${painScores.length} 天，高发部位：${topPart ? topPart[0] : '无'}，建议安排放松或就医。`);
  }
  if (!physical.length) physical.push('（周期内暂无完整睡眠/饮食指标，建议在隐私模块补录。）');

  // 行为画像：科目强弱 / 注意力黄金时段 / 休息缺口（融合 userOps）
  const behavioral = [];
  if (includeUserOps) {
    const ops = await db.userOps.where('t').above(since - 1).toArray();
    const reviews = ops.filter(o => o.type === 'review_rate');
    if (reviews.length) {
      const hrs = new Map();
      for (const o of reviews) { const h = new Date(o.t).getHours(); hrs.set(h,(hrs.get(h)||0)+1); }
      const topH = [...hrs.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([h,c])=>`${String(h).padStart(2,'0')}点(${c}次)`).join('、');
      behavioral.push(`复习时段热力峰值：${topH}。建议把最难的知识点安排在黄金时段。`);
    } else { behavioral.push('周期内暂无复习记录，难以锁定注意力黄金时段。'); }
    // 连续高强度：看日期序列是否出现 7 天全勤但 avgEnergy < 3
    const daySet = new Set(ops.map(o=>new Date(o.t).toDateString()));
    if (daySet.size >= rangeDays * 0.8 && avgEnergy !== null && avgEnergy < 3) {
      behavioral.push('⚠ 出现连续高强度周期但能量分偏低，存在疲劳缺口。建议明天安排一次主动休息。');
    }
  } else {
    behavioral.push('（未融合系统操作，打开 includeUserOps 可得更准确行为画像。）');
  }

  // 情绪/精神画像：高频情绪词 + 压力趋势
  const mental = [];
  if (avgMood !== null) mental.push(`平均心情：${avgMood.toFixed(1)} / 5 ${avgMood>=4?'（非常棒，继续保持）':avgMood<=2.5?'⚠ 偏低，建议安排社交/运动/复盘支持':'（稳定）'}`);
  if (avgStress !== null) mental.push(`平均压力：${avgStress.toFixed(1)} / 5 ${avgStress>=4?'⚠ 偏高，建议冥想或减少承诺。':avgStress<=2?'（松弛，适合攻坚）':'（适度）'}`);
  // 精神心得词频（去停用词后取前 6 高频 2+ 字词，不依赖第三方库，简化做）
  const mentStr = records.map(r => r.mental || '').join('\n');
  if (mentStr.length > 20) {
    const stop = new Set(['的','了','和','是','我','也','就','在','都','有','这','不','你','他','她','一','个','很','上','下','会','要','去','把','还','没','吗','呢','啊','吧']);
    const grams = new Map();
    for (let i = 0; i < mentStr.length - 1; i++) {
      const s = mentStr.slice(i, i+2);
      if (/[\u4e00-\u9fa5]{2}/.test(s) && !stop.has(s[0]) && !stop.has(s[1])) grams.set(s, (grams.get(s)||0)+1);
    }
    const top = [...grams.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k])=>k);
    if (top.length) mental.push(`精神高频词：${top.join(' · ')}。`);
  }
  if (!mental.length) mental.push('（周期内暂无心情/心得记录，建议在「精神」块补日记。）');

  // 下一步预测 + 调节建议（纯文字报告，不改系统任何参数，完全实验室）
  const pred = [];
  if (avgSleep !== null && avgSleep < 6.5) {
    pred.push('🌙 睡眠预测：若未来 48 小时仍低于 6.5h，次日「记住了」自评率预计下降 15~22%，「没记住」比例上升。建议今晚 23:30 前入睡。');
  }
  if (avgEnergy !== null && avgEnergy < 2.8) {
    pred.push('🔋 能量预测：当前能量分偏低，明日专注深度任务（费曼/模考）的容错空间小。建议先完成 20 分钟轻度整理/标签补全类任务积累状态。');
  }
  if (avgStress !== null && avgStress >= 4) {
    pred.push('🧘 压力预测：压力分持续偏高，接下来 3 天遗忘曲线更陡，薄弱卡复习失败率上升。建议插入 1 场 25 分钟番茄+5 分钟冥想缓冲。');
  }
  if (caffMg / rangeDays > 300) {
    pred.push('☕ 咖啡因预测：高咖啡因 + 睡眠不足的组合会制造「假能量」，真实学习产出反而下降。建议用散步/冷水脸替代下午提神咖啡。');
  }
  if (!pred.length) pred.push('📈 综合预测：周期数据整体健康。继续保持现有节奏的同时，可尝试把复习间隔 +10%（SRS ease 加成），进一步压缩总复习时长。');

  return {
    physical: physical.join('\n'),
    behavioral: behavioral.join('\n'),
    mental: mental.join('\n'),
    prediction: pred.join('\n'),
    stats: { N, rangeDays, avgSleep, avgMood, avgEnergy, avgStress },
  };
}

// ---------- M1 卡组（cardGroups + cardGroupLinks） ----------
// 卡片全局唯一、学习数据不随分组隔离：卡组只是「视图筛选 + 停车标记」，
// 复习动作始终写卡片的全局 SRS 字段。

/** 卡组列表（按 sortOrder, createdAt 排序） */
