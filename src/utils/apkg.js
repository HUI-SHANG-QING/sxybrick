// src/utils/apkg.js —— Anki .apkg 二进制解析（IO 编排层）
// 依赖 jszip（解压 zip）+ sql.js（解析 SQLite collection.anki2）。
// 纯函数逻辑在 apkg-core.js；本文件仅浏览器端（Vite 构建）使用，不参与 Node 单测。
// .apkg = zip{ collection.anki2(SQLite) + 媒体文件 }；notes 表存字段(\x1f 分隔)、col 表存模板 JSON。

import JSZip from 'jszip';
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { parseModels, buildCardsFromRows } from './apkg-core.js';

// sql.js 引擎懒加载（只初始化一次，wasm 用 Vite ?url 打包为静态资源）
let _sqlPromise = null;
function getSQL() {
  if (!_sqlPromise) {
    _sqlPromise = initSqlJs({ locateFile: () => wasmUrl });
  }
  return _sqlPromise;
}

function readScalar(db, sql) {
  try { return db.exec(sql)?.[0]?.values?.[0]?.[0] ?? null; } catch { return null; }
}
function readRows(db, sql) {
  try { return db.exec(sql)?.[0]?.values ?? []; } catch { return []; }
}

/**
 * 解析 .apkg 文件为 SxyBrick 卡片数组。
 * @param {ArrayBuffer} arrayBuffer apkg 文件内容
 * @returns {Promise<{ cards: Array<{front, back, tags}>, count: number }>}
 */
export async function parseApkg(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const colFile = zip.file('collection.anki2') || zip.file('collection.anki21');
  if (!colFile) throw new Error('不是有效的 .apkg：缺少 collection.anki2');
  const bytes = await colFile.async('uint8array');

  const SQL = await getSQL();
  const db = new SQL.Database(bytes);
  try {
    const modelsJson = readScalar(db, 'SELECT models FROM col');
    const models = parseModels(modelsJson);
    const rows = readRows(db, 'SELECT id, mid, flds, tags FROM notes');
    const cards = buildCardsFromRows(rows, models);
    return { cards, count: cards.length };
  } finally {
    db.close();
  }
}
