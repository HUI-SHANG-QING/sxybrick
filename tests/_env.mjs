// 测试环境最小垫片：在任何业务模块 import 之前注入 localStorage / fetch，
// 避免 dexie / embedding 在 Node 下因缺少浏览器全局而报错。
globalThis.localStorage ||= {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.fetch ||= async () => ({ ok: false, json: async () => ({}) });

// 词库分片预载：src/services/word-enrich.js 在前端走 Vite 的 import.meta.glob 惰性加载，
// 而 Node 侧（本环境）没有 glob，故在这里**同步预载全部分片**，让依赖词库的测试
// 保持原有的同步查询语义（enrichWordMaterials / hasLocalEntry 等）。
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestShardPayload } from '../src/services/word-enrich.js';
try {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'word-enrich-shards');
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.json')) ingestShardPayload(JSON.parse(readFileSync(join(dir, f), 'utf8')));
  }
} catch { /* 尚未拆分（无分片目录）时忽略：主文件若内嵌 entries 已由模块自身兜底 */ }
