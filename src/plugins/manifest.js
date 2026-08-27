// P3-4 插件清单 schema 校验（与 MCP 协议工具定义兼容）
// 插件以 ES Module 字符串形式存 db.plugins，运行时通过 Blob URL 动态 import。
// 模块须导出 manifest 对象 + 与 manifest.tools 同名的异步函数。
//
// manifest schema：
//   name:        string  插件唯一标识（与 db.plugins 主键一致），^[a-z0-9-]{2,40}$
//   version:     string  语义化版本（如 1.0.0）
//   description: string  可读说明（≤ 200 字符）
//   author:      string  作者（≤ 60 字符，选填）
//   tools:       Array<{ name, description, inputSchema }>  工具定义（MCP 兼容）
//   hooks:       { [eventName]: functionName }  事件钩子（选填）
//
// MCP 兼容性：tools[].inputSchema 用 JSON Schema 描述参数，
//   未来可通过 MCP HTTP/SSE 桥接到真正的 MCP server，本机制作为「本地插件层」先落地。

const NAME_RE = /^[a-z0-9-]{2,40}$/;

/**
 * 校验插件 manifest 对象是否合法
 * @param {object} m manifest
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object') { errors.push('manifest 必须是对象'); return { ok: false, errors }; }
  if (!m.name || typeof m.name !== 'string' || !NAME_RE.test(m.name)) {
    errors.push('name 必须为小写字母/数字/连字符，2-40 字符');
  }
  if (!m.version || typeof m.version !== 'string') {
    errors.push('version 必须为字符串（如 1.0.0）');
  }
  if (m.description != null && (typeof m.description !== 'string' || m.description.length > 200)) {
    errors.push('description 必须为字符串且 ≤ 200 字符');
  }
  if (m.author != null && (typeof m.author !== 'string' || m.author.length > 60)) {
    errors.push('author 必须为字符串且 ≤ 60 字符');
  }
  if (m.tools != null) {
    if (!Array.isArray(m.tools)) {
      errors.push('tools 必须为数组');
    } else {
      const seen = new Set();
      for (let i = 0; i < m.tools.length; i++) {
        const t = m.tools[i];
        if (!t || typeof t !== 'object') { errors.push(`tools[${i}] 必须是对象`); continue; }
        if (!t.name || typeof t.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/.test(t.name)) {
          errors.push(`tools[${i}].name 必须为合法标识符（字母开头，≤ 41 字符）`);
          continue;
        }
        if (seen.has(t.name)) { errors.push(`tools[${i}].name 重复：${t.name}`); continue; }
        seen.add(t.name);
        if (t.description != null && typeof t.description !== 'string') {
          errors.push(`tools[${i}].description 必须为字符串`);
        }
        if (t.inputSchema != null && (typeof t.inputSchema !== 'object')) {
          errors.push(`tools[${i}].inputSchema 必须为对象（JSON Schema）`);
        }
      }
    }
  }
  if (m.hooks != null && typeof m.hooks !== 'object') {
    errors.push('hooks 必须为对象');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 校验插件模块导出与 manifest 是否一致：每个 tools[].name 必须有同名导出函数
 * @param {object} mod import() 返回的模块对象
 * @param {object} m manifest
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateModuleExports(mod, m) {
  const errors = [];
  if (!mod || typeof mod !== 'object') { errors.push('模块导入失败或非对象'); return { ok: false, errors }; }
  if (!mod.manifest) { errors.push('模块未导出 manifest'); }
  if (m.tools && Array.isArray(m.tools)) {
    for (const t of m.tools) {
      if (typeof mod[t.name] !== 'function') {
        errors.push(`模块未导出工具函数：${t.name}`);
      }
    }
  }
  if (m.hooks && typeof m.hooks === 'object') {
    for (const [evt, fnName] of Object.entries(m.hooks)) {
      if (typeof mod[fnName] !== 'function') {
        errors.push(`hooks.${evt} 指向的函数未导出：${fnName}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 列出插件支持的事件钩子名（用于文档展示）
 */
export const SUPPORTED_HOOKS = {
  onCardSaved: '卡片保存后',
  onCardDeleted: '卡片删除后',
  onReviewRated: '复习评分后',
  onExamFinished: '模考结束后',
  onSyncCompleted: '同步完成后',
};
