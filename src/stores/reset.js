// src/stores/reset.js
// 「清空全部数据」：清空当前实例（real / test）的全部本地数据。
//  - 清空当前 Dexie 实例的所有表（cards / reviews / trash / …）
//  - 清除本地存储中和本应用相关的标记（模式、设备 id、主题、埋点开关等）
// 不做删库级隔离；清空后实例仍可用，下次访问即空库。
// 危险操作，UI 层（ResetAllData.vue）负责强制 ≥3 次确认 + 每次 >3 秒 + 全程 ≥10 秒。
import { db } from '../db.js';
import { deleteFileFromOpfs } from '../utils/opfs.js';

// 仅清除本应用前缀的 localStorage 键，不动其它站点数据
const APP_KEY_PREFIXES = ['sxy', 'sxybrick'];

function isAppKey(k) {
  if (!k) return false;
  return APP_KEY_PREFIXES.some((p) => k === p || k.startsWith(p + '_') || k.startsWith(p + '-'));
}

/**
 * 清空资料库原文件（OPFS / IndexedDB 降级 Blob）。
 *
 * round18 R18-9（P3）：docFiles 是**元数据**表，原文件本体存在 OPFS 根目录
 * （docs-lib.js:46，可达数百 MB）。此前 resetAllData 只清 IndexedDB 表和 localStorage，
 * 元数据没了、原文件却还在 OPFS 里变成无人引用的死数据，配额**一点都没释放**——
 * 用户按「清空全部数据」期待的是回到干净状态，实际磁盘占用原样保留。
 *
 * 必须在清表**之前**读出 opfsPath（清完就没得读了）。
 * 单个文件删除失败不阻断整体清理（记为失败数返回给 UI）。
 * @returns {Promise<{deleted:number, failed:number}>}
 */
async function clearOpfsFiles() {
  const res = { deleted: 0, failed: 0 };
  try {
    if (!db.docFiles) return res;
    const rows = await db.docFiles.toArray();
    for (const r of rows) {
      // storage='idb' 的降级文件存在 docBlobs 表（随 db.tables 一并清空），这里只管 OPFS
      if (r?.storage !== 'opfs' || !r?.opfsPath) continue;
      try {
        await deleteFileFromOpfs(r.opfsPath);
        res.deleted++;
      } catch {
        res.failed++; // 文件可能本就缺失（storage 标记陈旧），不算致命
      }
    }
  } catch {
    // 读表失败（未迁移/无该表）：跳过即可，不阻断清空
  }
  return res;
}

/**
 * 清空当前实例全部数据 + 本地存储 app 标记 + 资料库原文件（OPFS）。
 * @returns {Promise<{tables:number, keys:number, files:number, filesFailed:number}>}
 */
export async function resetAllData() {
  // 0) 先按元数据清 OPFS 原文件（清表后 opfsPath 就查不到了）
  const files = await clearOpfsFiles();

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

  return { tables: db.tables.length, keys, files: files.deleted, filesFailed: files.failed };
}
