// 测试环境最小垫片：在任何业务模块 import 之前注入 localStorage / fetch，
// 避免 dexie / embedding 在 Node 下因缺少浏览器全局而报错。
globalThis.localStorage ||= {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.fetch ||= async () => ({ ok: false, json: async () => ({}) });
