// src/plugins/package.js
// 插件包（plugin package）的序列化 / 解析与文件导入导出。
//
// 定位：这是「Agent 工具市场」的最小落地形态——插件以单个 .json 文件
// 分发（含 manifest + 完整源码），用户从任何渠道拿到包文件即可一键导入。
// 未来若上线云端市场，只需在导入前增加「来源校验 / 签名验签」环节，
// 本文件的包格式保持向后兼容。
//
// 包格式：
// {
//   "format": "sxybrick-plugin",
//   "version": 1,
//   "manifest": { name, version, description, author, tools, hooks },
//   "code": "export const manifest = {...}; export async function ..."
// }

import { validateManifest } from './manifest.js';
import { installPlugin } from './registry.js';

export const PLUGIN_PACKAGE_FORMAT = 'sxybrick-plugin';
export const PLUGIN_PACKAGE_VERSION = 1;

/**
 * 序列化插件包（纯函数）：db 行 → 可分发的包对象
 * @param {object} row db.plugins 行（含 tools/hooks/code 等）
 * @returns {object} 插件包对象
 */
export function serializePluginPackage(row) {
  return {
    format: PLUGIN_PACKAGE_FORMAT,
    version: PLUGIN_PACKAGE_VERSION,
    manifest: {
      name: row.id,
      version: row.version,
      description: row.description || '',
      author: row.author || '',
      tools: row.tools || [],
      hooks: row.hooks || {},
    },
    code: row.code || '',
  };
}

/**
 * 解析并校验插件包文本（纯函数）。
 * @param {string} text 插件包 JSON 文本
 * @returns {{ ok: boolean, pkg?: object, errors: string[] }}
 */
export function parsePluginPackage(text) {
  const errors = [];
  let pkg;
  try {
    pkg = JSON.parse(text || '');
  } catch (e) {
    return { ok: false, errors: ['不是合法 JSON：' + (e?.message || e)] };
  }
  if (!pkg || typeof pkg !== 'object') { errors.push('包必须是对象'); return { ok: false, errors }; }
  if (pkg.format !== PLUGIN_PACKAGE_FORMAT) {
    errors.push(`不支持的包格式：${pkg.format}（期望 ${PLUGIN_PACKAGE_FORMAT}）`);
  }
  if (pkg.version !== PLUGIN_PACKAGE_VERSION) {
    errors.push(`不支持的包版本：${pkg.version}（期望 ${PLUGIN_PACKAGE_VERSION}）`);
  }
  const vm = validateManifest(pkg.manifest);
  if (!vm.ok) { errors.push('manifest 校验失败：' + vm.errors.join('；')); }
  if (typeof pkg.code !== 'string' || !pkg.code.trim()) {
    errors.push('包缺少插件代码（code 字段）');
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, pkg, errors: [] };
}

/**
 * 下载插件包为 .json 文件（IO 编排）
 * @param {object} row db.plugins 行
 */
export function downloadPluginPackage(row) {
  const pkg = serializePluginPackage(row);
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sxybrick-plugin-${row.id}-v${row.version}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 从文件导入插件包（IO 编排）：读文件 → 解析校验 → 交给 installPlugin
 * @param {File} file .json 插件包文件
 * @returns {Promise<{ id: string, version: string }>}
 */
export async function importPluginPackageFile(file) {
  const text = await file.text();
  const r = parsePluginPackage(text);
  if (!r.ok) throw new Error(r.errors.join('；'));
  return await installPlugin(r.pkg.code, {
    author: r.pkg.manifest.author,
    description: r.pkg.manifest.description,
  });
}
