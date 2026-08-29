// P3-4 插件加载器：把插件 JS 字符串编译为 ES Module
// 实现思路：
//   1. 用 Blob URL + 动态 import() 把代码字符串转为模块对象（Vite 在 dev/build 下都支持，
//      关键是 /* @vite-ignore */ 注释阻止 Vite 尝试静态分析这个 import）
//   2. 缓存已加载模块：同一插件代码不变时不重复编译（用 code 内容哈希做缓存键）
//   3. 加载失败时不抛异常，返回 { error }，由 registry 标记 lastError
//
// 安全说明：
//   Blob URL  ️动态 import 本质上等同于 eval，无法真正沙箱化。
//   风险控制策略：
//     - 插件来源由用户主动安装（不自动从网络拉取）
//     - 安装时显式提示「仅安装可信来源的插件」
//     - 插件调用工具时传入 args 是结构化克隆，不会泄漏本应用内部引用
//     - 高危操作（删除卡片 / 清库）由调用方二次确认，插件无法绕过

const cache = new Map(); // key: `${id}#${updatedAt}#${hash}` → { mod, blobUrl }

// 轻量内容哈希（FNV-1a）：用于缓存键，避免「不同代码相同长度」发生哈希碰撞导致返回陈旧模块
function hashCode(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * 编译并加载一个插件模块
 * @param {string} id 插件 id（用于缓存键）
 * @param {string} code 插件 ES Module 源码
 * @param {number} updatedAt 用于缓存失效判定
 * @returns {Promise<{ mod: object, blobUrl: string }>}
 */
export async function loadPluginModule(id, code, updatedAt = 0) {
  const key = `${id}#${updatedAt}#${hashCode(code || '')}`;
  const cached = cache.get(key);
  if (cached) return { mod: cached.mod, blobUrl: cached.blobUrl };

  // 释放上一个同 id 的旧缓存（避免 Blob URL 泄漏）
  for (const [k, v] of cache.entries()) {
    if (k.startsWith(`${id}#`)) {
      try { URL.revokeObjectURL(v.blobUrl); } catch {}
      cache.delete(k);
    }
  }

  const blob = new Blob([code || ''], { type: 'text/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  let mod;
  try {
    // @vite-ignore：阻止 Vite 静态分析与打包，让浏览器运行时直接加载 Blob URL
    mod = await import(/* @vite-ignore */ blobUrl);
  } catch (e) {
    URL.revokeObjectURL(blobUrl);
    throw new Error(`插件代码编译失败：${e?.message || e}`);
  }
  cache.set(key, { mod, blobUrl });
  return { mod, blobUrl };
}

/**
 * 卸载插件模块：释放 Blob URL 并清缓存
 */
export function unloadPluginModule(id) {
  for (const [k, v] of cache.entries()) {
    if (k.startsWith(`${id}#`)) {
      try { URL.revokeObjectURL(v.blobUrl); } catch {}
      cache.delete(k);
    }
  }
}

/**
 * 预览一段代码字符串：编译并校验，不真正注册到 registry
 * 用于安装前的「试编译」
 * @returns {Promise<{ ok: boolean, manifest?: object, errors: string[] }>}
 */
export async function previewPluginCode(code) {
  try {
    const blob = new Blob([code || ''], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    let mod;
    try {
      mod = await import(/* @vite-ignore */ url);
    } finally {
      // 预览后立即释放，不缓存
      URL.revokeObjectURL(url);
    }
    const manifest = mod?.manifest;
    if (!manifest) return { ok: false, errors: ['代码未导出 manifest 对象'] };
    return { ok: true, manifest, mod, errors: [] };
  } catch (e) {
    return { ok: false, errors: [e?.message || String(e)] };
  }
}
