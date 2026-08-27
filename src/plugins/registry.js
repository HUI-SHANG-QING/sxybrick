// P3-4 插件注册中心 + 工具调用桥接 + 事件钩子分发
// 职责：
//   1. listPlugins()：列出 db.plugins 中所有插件（含启用状态、上次错误）
//   2. installPlugin(code)：预编译 → 校验 manifest → 写入 db.plugins
//   3. togglePlugin(id, enabled)：启用 / 禁用插件
//   4. uninstallPlugin(id)：卸载并释放 Blob URL
//   5. invokeTool(pluginId, toolName, args)：调用插件工具（带超时与错误捕获）
//   6. triggerHook(event, ...args)：向所有已启用插件分发事件钩子
//
// 与 MCP 协议的桥接：
//   本 registry 的 invokeTool 接口与 MCP server 的 tools/call 一致（pluginId, toolName, args），
//   未来若接入真正的 MCP server，只需在 invokeTool 之前加一层「远程 MCP 路由」即可：
//     if (pluginId.startsWith('mcp:')) return await callMcpServer(pluginId.slice(4), toolName, args);
//   当前实现的本地插件层可作为「MCP 兼容的本地兜底」

import { db } from '../db.js';
import { validateManifest, validateModuleExports } from './manifest.js';
import { loadPluginModule, unloadPluginModule, previewPluginCode } from './loader.js';

const TOOL_TIMEOUT_MS = 8000; // 工具调用超时：8s，避免插件死循环卡死 UI

// 已加载的插件实例缓存（仅 enabled 插件）：id → { mod, manifest, blobUrl }
const instances = new Map();

/**
 * 列出所有插件（不加载模块，仅元数据）
 */
export async function listPlugins() {
  return await db.plugins.orderBy('installedAt').reverse().toArray();
}

/**
 * 安装插件：预编译 → 校验 → 写入 db.plugins
 * @param {string} code 插件 ES Module 源码
 * @param {object} meta 可选覆盖元数据（author / description）
 * @returns {Promise<{ id: string, version: string }>}
 */
export async function installPlugin(code, meta = {}) {
  if (!code || typeof code !== 'string') throw new Error('插件代码不能为空');
  const preview = await previewPluginCode(code);
  if (!preview.ok) throw new Error(preview.errors.join('；'));
  const m = preview.manifest;
  const v = validateManifest(m);
  if (!v.ok) throw new Error('manifest 校验失败：' + v.errors.join('；'));
  // 校验模块导出与 manifest 一致
  const ev = validateModuleExports(preview.mod, m);
  if (!ev.ok) throw new Error('模块导出校验失败：' + ev.errors.join('；'));

  // 覆盖元数据（允许用户在安装时补充作者/说明）
  const finalManifest = {
    ...m,
    author: meta.author || m.author || '',
    description: meta.description || m.description || '',
  };

  const now = Date.now();
  const existing = await db.plugins.get(m.name);
  const row = {
    id: m.name,
    version: m.version,
    description: finalManifest.description,
    author: finalManifest.author,
    tools: m.tools || [],
    hooks: m.hooks || {},
    code,
    enabled: existing?.enabled ?? 1, // 重装时保留原启用状态；新装默认启用
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
    lastError: null,
  };
  await db.plugins.put(row);
  return { id: row.id, version: row.version };
}

/**
 * 启用 / 禁用插件
 */
export async function togglePlugin(id, enabled) {
  const row = await db.plugins.get(id);
  if (!row) throw new Error('插件不存在');
  await db.plugins.update(id, { enabled: enabled ? 1 : 0 });
  if (!enabled) {
    unloadPluginModule(id);
    instances.delete(id);
  }
}

/**
 * 卸载插件：从 db 删除 + 释放 Blob URL + 清实例缓存
 */
export async function uninstallPlugin(id) {
  await db.plugins.delete(id);
  unloadPluginModule(id);
  instances.delete(id);
}

/**
 * 调用插件工具
 * @param {string} pluginId 插件 id（db.plugins 主键）
 * @param {string} toolName 工具名（必须与 manifest.tools[].name 一致）
 * @param {object} args 调用参数（结构化克隆传入，不泄漏本应用内部引用）
 * @returns {Promise<any>} 工具返回值
 */
export async function invokeTool(pluginId, toolName, args = {}) {
  const inst = await ensureLoaded(pluginId);
  if (!inst) throw new Error(`插件未启用或加载失败：${pluginId}`);
  const { mod, manifest } = inst;
  // 校验工具存在
  const toolDef = (manifest.tools || []).find(t => t.name === toolName);
  if (!toolDef) throw new Error(`插件 ${pluginId} 没有工具 ${toolName}`);
  const fn = mod[toolName];
  if (typeof fn !== 'function') throw new Error(`插件 ${pluginId} 未导出工具函数 ${toolName}`);
  // 带超时调用：避免插件死循环
  const result = await Promise.race([
    Promise.resolve().then(() => fn(structuredClone(args))),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`工具 ${toolName} 执行超时（${TOOL_TIMEOUT_MS}ms）`)), TOOL_TIMEOUT_MS)),
  ]);
  // 清除上次错误
  await db.plugins.update(pluginId, { lastError: null }).catch(() => {});
  return result;
}

/**
 * 列出指定插件的所有工具定义（用于 UI 展示）
 */
export async function listTools(pluginId) {
  const row = await db.plugins.get(pluginId);
  return row?.tools || [];
}

/**
 * 触发事件钩子：向所有已启用插件分发
 * 任意插件抛错不影响其他插件；错误记入该插件 lastError
 * @param {string} event 事件名（见 SUPPORTED_HOOKS）
 * @param {...any} args 钩子参数（结构化克隆传入）
 */
export async function triggerHook(event, ...args) {
  const rows = await db.plugins.where('enabled').equals(1).toArray();
  const tasks = [];
  for (const row of rows) {
    const fnName = row.hooks?.[event];
    if (!fnName) continue;
    tasks.push((async () => {
      try {
        const inst = await ensureLoaded(row.id);
        if (!inst) return;
        const fn = inst.mod[fnName];
        if (typeof fn !== 'function') return;
        await fn(...structuredClone(args));
      } catch (e) {
        await db.plugins.update(row.id, { lastError: `[${event}] ${e?.message || e}` }).catch(() => {});
      }
    })());
  }
  await Promise.all(tasks);
}

/**
 * 确保插件模块已加载（仅 enabled 才加载）
 */
async function ensureLoaded(id) {
  if (instances.has(id)) return instances.get(id);
  const row = await db.plugins.get(id);
  if (!row || !row.enabled) return null;
  try {
    const { mod, blobUrl } = await loadPluginModule(id, row.code, row.updatedAt);
    const manifest = mod?.manifest || {
      name: row.id, version: row.version, tools: row.tools, hooks: row.hooks,
    };
    const inst = { mod, manifest, blobUrl };
    instances.set(id, inst);
    return inst;
  } catch (e) {
    await db.plugins.update(id, { lastError: `加载失败：${e?.message || e}` }).catch(() => {});
    return null;
  }
}

/**
 * 应用启动时预热所有 enabled 插件（异步、不阻塞）
 * 在 main.js 调用一次
 */
export async function warmupPlugins() {
  try {
    const rows = await db.plugins.where('enabled').equals(1).toArray();
    await Promise.all(rows.map(r => ensureLoaded(r.id)));
  } catch (e) {
    console.warn('[plugins] 预热失败（不阻断启动）:', e?.message || e);
  }
}
