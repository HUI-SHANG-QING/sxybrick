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

export function uid() {
  return (crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
}