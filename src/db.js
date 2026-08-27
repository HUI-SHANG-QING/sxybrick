// 本地数据库（IndexedDB，浏览器内置，离线可用）
// 与原版 node:sqlite 的差异：id 改用 UUID（全局唯一），保证多设备合并时不冲突
import Dexie from 'dexie';

export const db = new Dexie('sxybrick');

db.version(1).stores({
  cards: 'id, subject, dueAt, updatedAt, createdAt',
  reviews: 'id, cardId, reviewedAt',
  images: 'id',
  tombstones: 'id, deletedAt', // 删除墓碑：记录被删卡片的 id + 删除时间，用于跨设备同步删除
  meta: 'key',                 // 键值：deviceId 等
});

// v2：新增 AI 对话历史表（随数据包一起同步）
db.version(2).stores({
  aiChats: 'id, updatedAt',
});

// v3：新增 Agent 记忆库表（分层记忆：core核心/preference偏好/fact事实）
db.version(3).stores({
  aiMemories: 'id, updatedAt, category',
});

// v4：新增备忘录表（四象限：重要/紧急）
db.version(4).stores({
  memos: 'id, at, updatedAt',
});

// v5：新增学习计划表 + 知识图谱关系表（均随数据包同步）
db.version(5).stores({
  plans: 'id, status, updatedAt',
  graphEdges: 'id, from, to, updatedAt',
});

// v6：新增 AI 文档表 + 番茄专注记录表（均随数据包同步）
db.version(6).stores({
  docs: 'id, type, updatedAt',
  pomoSessions: 'id, startedAt',
});

// v7：新增思维导图 / 每周学习报告 / 成就解锁表（借鉴 Progress AI，均随数据包同步）
db.version(7).stores({
  mindmaps: 'id, updatedAt',
  weeklyReports: 'id, weekStart, updatedAt',
  achievements: 'id, unlockedAt',
});

// v8：新增模考成绩存档表（组卷模考，随数据包同步）
db.version(8).stores({
  exams: 'id, createdAt',
});

// v9：新增向量嵌入表（RAG 检索增强：卡片/文档 chunk 的 embedding 向量）
// sourceType: 'card' | 'doc'；sourceId: 卡片/文档 id；chunkIdx: 分块序号
// vector: Float32Array（或普通数组）；modelSig: 模型签名，模型变更时需重建索引
db.version(9).stores({
  embeddings: 'id, sourceType, sourceId, subject, updatedAt, modelSig',
});

// v10：新增主动智能体通知表（随数据包同步）
// read 用 0/1 整数以支持 IndexedDB 索引（boolean 不可索引）
db.version(10).stores({
  notifications: 'id, read, createdAt',
});

// v11：新增本地错误日志表（#16 错误边界+日志，便于排查看不见的崩溃）
// severity: 'error'|'warn'；ctx: 组件/路由名；stack: 错误堆栈
db.version(11).stores({
  errors: 'id, createdAt, severity',
});

// v12：cards 新增 difficulty 索引（P3-E 渐进式复杂度，便于按难度梯度编排复习）
db.version(12).stores({
  cards: 'id, subject, dueAt, updatedAt, createdAt, difficulty',
});

// v13：新增用户全操作埋点表（恐怖级本地监控，仅存本地加密，供仪表盘分析，可一键同步/导出/清空）
// A 级（业务级）+ B 级（DOM 交互级）统一存此表
//   t:        毫秒时间戳（主索引）
//   type:     动作大类（page_view / review_rate / card_edit / export / sync / ai_call / pomodoro /
//             feynman / memo / plan / health / graph / mindmap / weekly / exam / wrongbook /
//             dom_click_chip / dom_click_btn / dom_click_card / dom_change_select / dom_asset_click 等）
//   category: 细分类（如 review_rate: '0'|'1'|'2'；dom_click_btn: 'save'|'delete' 等）
//   page:     路由页面（/review /cards /health ...）
//   module:   模块（学习/复习/错题/整理/AI/计划/健康/图谱/导图/周报/模考/备忘/同步/导出/书房/成就/仪表盘/隐私）
//   payload:  自由 JSON 对象（任意附加信息，如卡片 front 摘要、背诵评分、AI token 数、导出格式、同步结果）
//   _meta:    内部字段（设备 id、会话 id、是否批量合并等）
db.version(13).stores({
  userOps: 'id, t, type, category, page, module',
});

// v14：新增人生监控（隐私数据）结构化表（物理行为+精神心得，B 档超级详尽版）
// 行为上：睡眠/饮食/运动/学习/工作/屏幕时间/财务等详细块
// 精神上：心得体会 Markdown 富文本
// 自定义：customTags(数组) + customKV(JSON) + 时间段详细
//   id, date(YYYY-MM-DD, 便于按天聚合查询), startTime(ms), endTime(ms),
//   type(主类型: sleep/eat/move/learn/work/screen/social/meditation/commute/housework/medical/shop/finance/other/mental)
//   subType(子类型 2 级), location, people(数组), mood, energy, focus, pleasure, stress, painIndex, painParts(数组)
//   sleepBlock, eatBlock, moveBlock, learnBlock, workBlock, screenBlock, financeBlock
//   mental: Markdown 字符串
//   customTags(数组), customKV(JSON)
//   createdAt, updatedAt: 毫秒
db.version(14).stores({
  privacyRecords: 'id, date, startTime, endTime, type, mood, updatedAt',
});

export function uid() {
  return (crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
}