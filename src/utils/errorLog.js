// 错误日志（#16）：持久化到 IndexedDB，便于排查用户端看不见的崩溃（round38 起跨设备同步）
// 全局 errorHandler / unhandledrejection / ErrorBoundary 都写这里
import { db, uid } from '../db.js';

const MAX_ERRORS = 200; // 最多保留 200 条，超出删最旧的

export async function logError(err, ctx = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  const row = {
    id: uid(),
    createdAt: Date.now(),
    severity: ctx.severity || 'error',
    message: String(e.message || e).slice(0, 500),
    stack: String(e.stack || '').slice(0, 2000),
    ctx: typeof ctx === 'string' ? ctx : JSON.stringify({ component: ctx.component, route: ctx.route, info: ctx.info }).slice(0, 300),
  };
  try {
    await db.errors.put(row);
    // 超量清理：删最旧的（round38：errors 已入同步表，删除必须写墓碑，否则对端复活）
    const count = await db.errors.count();
    if (count > MAX_ERRORS) {
      const stale = await db.errors.orderBy('createdAt').limit(count - MAX_ERRORS).toArray();
      if (stale.length) {
        const nowTs = Date.now();
        await db.transaction('rw', db.errors, db.tombstones, async () => {
          await db.errors.bulkDelete(stale.map(r => r.id));
          await db.tombstones.bulkPut(stale.map(r => ({ id: r.id, kind: 'error', deletedAt: nowTs })));
        });
      }
    }
  } catch { /* 日志自身失败不能拖垮主流程 */ }
  console.error('[errorLog]', row.message, e);
  return row.id;
}

export async function getErrors(limit = 50) {
  return db.errors.orderBy('createdAt').reverse().limit(limit).toArray();
}

export async function clearErrors() {
  // round38：errors 已入同步表，清空必须写墓碑（kind='error'），否则对端旧副本下次拉取复活
  const ids = await db.errors.toCollection().primaryKeys();
  await db.transaction('rw', db.errors, db.tombstones, async () => {
    await db.errors.clear();
    if (ids.length) {
      const nowTs = Date.now();
      await db.tombstones.bulkPut(ids.map(id => ({ id, kind: 'error', deletedAt: nowTs })));
    }
  });
}