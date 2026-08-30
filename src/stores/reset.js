// src/stores/reset.js
// 「清空全部数据」：清空当前实例（real / test）的全部本地数据。
//  - 清空当前 Dexie 实例的所有表（cards / reviews / trash / …）
//  - 清除本地存储中和本应用相关的标记（模式、设备 id、主题、埋点开关等）
// 不做删库级隔离；清空后实例仍可用，下次访问即空库。
// 危险操作，UI 层（ResetAllData.vue）负责强制 ≥3 次确认 + 每次 >3 秒 + 全程 ≥10 秒。
import { db } from '../db.js';

// 仅清除本应用前缀的 localStorage 键，不动其它站点数据
const APP_KEY_PREFIXES = ['sxy', 'sxybrick'];

function isAppKey(k) {
  if (!k) return false;
  return APP_KEY_PREFIXES.some((p) => k === p || k.startsWith(p + '_') || k.startsWith(p + '-'));
}

/**
 * 清空当前实例全部数据 + 本地存储 app 标记。
 * @returns {Promise<{tables:number, keys:number}>}
 */
export async function resetAllData() {
  // 1) 清空所有表（事务内批量 clear，保证原子性）
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });

  // 2) 清除本地存储 app 标记
  let keys = 0;
  if (typeof localStorage !== 'undefined') {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (isAppKey(k)) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
    keys = toRemove.length;
  }

  return { tables: db.tables.length, keys };
}
