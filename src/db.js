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

export function uid() {
  return (crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
}