// 从中枢拉取全量数据包并做结构校验（node sync-hub/pull-hub.mjs <hubUrl> <token> [输出文件]）
import { writeFileSync } from 'node:fs';

const B = process.argv[2] || 'http://localhost:18080';
const TOKEN = process.argv[3];
const OUT = process.argv[4] || `hub-export-${new Date().toISOString().slice(0, 10)}.json`;
if (!TOKEN) { console.error('用法: node sync-hub/pull-hub.mjs <hubUrl> <token> [输出文件]'); process.exit(1); }

const res = await fetch(`${B}/backup`, { headers: { 'x-sync-token': TOKEN } });
if (!res.ok) { console.error('GET 失败:', res.status, await res.text()); process.exit(1); }
const bk = await res.json();

const problems = [];
if (bk.app !== 'sxybrick') problems.push('app 字段错误');
if (bk.version !== 3) problems.push('version 应为 3');
const TABLES = ['cards', 'reviews', 'images', 'tombstones', 'aiChats', 'aiMemories', 'memos', 'plans', 'graphEdges', 'docs', 'pomoSessions'];
for (const t of TABLES) if (!Array.isArray(bk[t])) problems.push(`${t} 缺失`);
const req = ['id', 'front', 'back', 'subject', 'tags', 'type', 'ease', 'level', 'intervalDays', 'dueAt', 'createdAt', 'updatedAt'];
let missing = 0;
for (const c of (bk.cards || []).slice(0, 10)) for (const f of req) if (c[f] === undefined) missing++;
if (missing) problems.push(`卡片必填字段缺失 ${missing}`);
if (!bk.streakMeta || typeof bk.streakMeta.goal !== 'number') problems.push('streakMeta 缺失');

writeFileSync(OUT, JSON.stringify(bk));
const counts = TABLES.map(t => `${t}=${bk[t].length}`).join(' ');
console.log('结构问题:', problems.length ? problems.join('; ') : '无');
console.log('数据量:', counts, `goal=${bk.streakMeta?.goal}`);
console.log(`已保存到 ${OUT}（${Math.round(JSON.stringify(bk).length / 1024)} KB）`);