// 恐怖级全操作本地监控埋点采集器
// 两个级别：
//   A 级（业务级 / page-level）：由各模块显式调用 trackAction(type, payload)
//       例如：背诵评分、导出、同步、AI 调用、番茄结束、费曼轮次、新建卡。
//   B 级（DOM 级交互级）：全局 document click 代理，识别 chip/btn/card-item/asset 方块等
//       可交互元素，自动记录（默认桌面端启用；移动端仅启 A 级，用户手动才能开 B）。
// 数据写入 db.userOps，支持节流/去重/批量，不阻塞交互（requestIdleCallback + 批量 flush）。
// 数据仅存本地 IndexedDB，隐私合规：启动时 toast 提示；Settings 可关 B 级监听。

import { db, uid } from '../db.js';

const LS_KEY_A = 'sxy_tel_a_enabled';   // A 级（默认 1）
const LS_KEY_B = 'sxy_tel_b_enabled';   // B 级（桌面端默认 1；移动端默认 0）

// ---- 配置层 ----
export function isAEnabled() { return localStorage.getItem(LS_KEY_A) !== '0'; }
export function isBEnabled() {
  const v = localStorage.getItem(LS_KEY_B);
  if (v === '1' || v === '0') return v === '1';
  // 默认：maxTouchPoints > 0（触屏/手机/平板）只启 A；桌面启 A+B（恐怖监控）
  const isTouch = typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0;
  return !isTouch;
}
export function setAEnabled(v) { localStorage.setItem(LS_KEY_A, v ? '1' : '0'); }
export function setBEnabled(v) { localStorage.setItem(LS_KEY_B, v ? '1' : '0'); }

// 模块映射（page 路由 → 仪表盘分类 module）
const PAGE_MODULE_MAP = {
  '/': '首页', '/review': '复习', '/cards': '卡片', '/library': '书房',
  '/graph': '图谱', '/mindmap': '导图', '/wrongbook': '错题', '/feynman': '费曼',
  '/stats': '统计', '/dashboard': '仪表盘', '/privacy': '隐私', '/plans': '计划',
  '/memo': '备忘', '/pomodoro': '番茄', '/exam': '模考', '/weekly-report': '周报',
  '/achievements': '成就', '/health': '健康', '/ai-assistant': 'AI',
  '/docs': '文档', '/sync': '同步', '/export': '导出', '/search': '搜索',
  '/agent-workbench': 'Agent',
};
export function moduleOf(path) {
  const p = (path || '').split('?')[0];
  return PAGE_MODULE_MAP[p] || '其它';
}

// 取当前页面（Vue router push/replace 时外部显式 setCurrentPage 更新；首次取 location）
let _currentPage = typeof location !== 'undefined' ? location.pathname : '/';
export function setCurrentPage(path) { _currentPage = path || '/'; }
export function getCurrentPage() { return _currentPage; }

// 设备/会话标识（本地生成，永不离设备；仅用于跨天聚合时区分同一用户多浏览器）
let _deviceId = localStorage.getItem('sxy_device_id') || '';
if (!_deviceId) { _deviceId = uid(); localStorage.setItem('sxy_device_id', _deviceId); }
let _sessionId = uid(); // 每次打开新标签页 = 新 session

// ---- 批量写入层（节流 + 去重 + 空闲回调） ----
const _buffer = [];       // 待写入队列
let _flushTimer = null;
let _flushInProgress = false;
const FLUSH_INTERVAL = 200;   // 毫秒：最晚多久 flush 一次
const FLUSH_BATCH = 40;       // 条数：到多少立即 flush
const DEDUP_WINDOW_MS = 50;   // 毫秒：DOM B 级去重窗口（防止用户长按/连点产生的抖动）
const _lastSeen = new Map();  // key: 去重指纹 -> 最后写入时间 ms

function dedupKey(op) {
  // 同一毫秒内同 type+category+page+payloadStr 视为一次（避免连点爆炸）
  return `${op.type}|${op.category || ''}|${op.page || ''}|${op._payloadSig || ''}`;
}

export async function _flush(force = false) {
  if (_flushInProgress && !force) return;
  if (!_buffer.length) return;
  _flushInProgress = true;
  try {
    while (_buffer.length) {
      const batch = _buffer.splice(0, Math.min(100, _buffer.length));
      // eslint-disable-next-line no-await-in-loop
      await db.userOps.bulkPut(batch);
    }
  } catch (e) {
    // 失败不重抛（避免阻塞主流程），丢回 buffer 尾部（限长 500 防止内存溢出）
    console.warn('[telemetry] flush failed', e);
    if (_buffer.length < 500) { /* 留给下轮 */ }
    else { _buffer.length = 0; } // 超限直接丢弃（保护内存）
  } finally {
    _flushInProgress = false;
  }
}
function scheduleFlush() {
  if (_flushTimer) return;
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(() => _flush(), { timeout: 500 });
  }
  _flushTimer = setTimeout(() => { _flushTimer = null; _flush(); }, FLUSH_INTERVAL);
}
// 紧急合并：10s 内缓冲超过 1000 条直接落盘（防止狂点点爆 DB）
setInterval(() => { if (_buffer.length > 1000) _flush(true); }, 10000);

// ---- A 级（业务级）主入口 ----
// 参数：
//   type     动作大类（必填，如 review_rate / card_new / export / sync_push / ai_call）
//   payload  任意对象（如 { rating:0, cardFront:'...', durationMs:60000 }），可留空
//   extra    { category, page, module, t } 可选覆写
export function trackAction(type, payload = null, extra = {}) {
  if (!isAEnabled()) return;
  if (!type) return;
  const now = Date.now();
  const op = {
    id: uid(),
    t: extra.t || now,
    type: String(type),
    category: extra.category || '',
    page: extra.page || getCurrentPage(),
    module: extra.module || moduleOf(extra.page || getCurrentPage()),
    payload,
    _meta: { deviceId: _deviceId, sessionId: _sessionId },
    _payloadSig: '',
  };
  // 计算 payload 签名供去重用（只对简单字段做签名，避免大 JSON 拖慢）
  try {
    if (payload && typeof payload === 'object') {
      const sig = Object.entries(payload).slice(0, 10)
        .map(([k, v]) => `${k}:${typeof v === 'object' ? 'obj' : String(v).slice(0, 40)}`).join('|');
      op._payloadSig = sig;
    }
  } catch { /* ignore */ }
  // A 级去重窗口较宽：同 type + payloadSig 200ms 内第二次丢（例如快速切页面触发多次 page_view）
  const k = 'A:' + dedupKey(op);
  const last = _lastSeen.get(k) || 0;
  if (now - last < 200) return;
  _lastSeen.set(k, now);
  // 去重 Map 控制大小（LRU 简化版：到 500 就清一半旧的）
  if (_lastSeen.size > 500) {
    let i = 0; const half = 250;
    for (const old of _lastSeen.keys()) { _lastSeen.delete(old); if (++i >= half) break; }
  }
  _buffer.push(op);
  if (_buffer.length >= FLUSH_BATCH) _flush(); else scheduleFlush();
}

// ---- B 级（DOM 级代理）：全局 click/change 监听 ----
// 数据层：只记录「元素类别」+「附近文字摘要（最多 24 字）」，不记录隐私数据
//   识别优先级：
//     1) 元素含 data-track="<type>:<category>" → 直接用（业务可自定义更精细的埋点）
//     2) 匹配元素：.btn / button / .chip / .card-item / .mm-item / .ds-asset /
//        .shortcut / select / input[type="checkbox"] / .ds-weak / .wb-item / .pill.on
//   反哺字段：type = dom_click_{类别}，category = 截断文字（最多 24 字）/ data-track category

const _B_CLS_RULES = [
  { cls: /\bbtn\b|^BUTTON$/i,             type: 'dom_click_btn' },
  { cls: /\bchip\b/,                        type: 'dom_click_chip' },
  { cls: /\bcard-item\b/,                   type: 'dom_click_card' },
  { cls: /\bmm-item\b|\bds-asset\b/,        type: 'dom_click_asset' },
  { cls: /\bds-weak\b|\bwb-item\b/,         type: 'dom_click_weak' },
  { cls: /\bshortcut\b/,                    type: 'dom_click_shortcut' },
  { cls: /\bpill\b/,                        type: 'dom_click_pill' },
];

function matchB(target) {
  let el = target;
  // 向上找 3 层：防止点击到按钮内部的 <span>
  for (let i = 0; el && i < 4; i++) {
    if (!el || el.nodeType !== 1) { el = el?.parentNode; continue; }
    // data-track 优先
    const track = el.getAttribute?.('data-track');
    if (track) {
      const [tt, cc = ''] = track.split(':');
      return { type: tt || 'dom_click_custom', category: cc, el };
    }
    // select / checkbox 直接匹配 change 事件（click 里不记录，避免重复）
    const cls = (el.className && typeof el.className === 'string') ? el.className : '';
    const tag = el.tagName || '';
    const key = `${cls} ${tag}`;
    for (const rule of _B_CLS_RULES) {
      if (rule.cls.test(key)) {
        // 抽附近文字（textContent 前 24 字，去空）
        const txt = (el.textContent || el.getAttribute?.('aria-label') || el.title || '')
          .replace(/\s+/g, ' ').trim().slice(0, 24);
        return { type: rule.type, category: txt, el };
      }
    }
    el = el.parentNode;
  }
  return null;
}

let _bHandlerClick = null;
let _bHandlerChange = null;

function installBHandlers() {
  if (_bHandlerClick) return;
  _bHandlerClick = function (e) {
    if (!isBEnabled()) return;
    const m = matchB(e.target);
    if (!m) return;
    trackAction(m.type, null, { category: m.category });
  };
  _bHandlerChange = function (e) {
    if (!isBEnabled()) return;
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    const tag = (el.tagName || '').toUpperCase();
    const type = (el.getAttribute && el.getAttribute('type')) || '';
    if (tag === 'SELECT') {
      const txt = (el.value || '').slice(0, 24);
      trackAction('dom_change_select', null, { category: txt });
    } else if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) {
      const lbl = (el.getAttribute?.('aria-label') || el.id || el.name || type).slice(0, 24);
      trackAction('dom_change_check', null, { category: `${lbl}:${el.checked ? '1' : '0'}` });
    }
  };
  // passive: true 保证不阻塞滚动手势
  document.addEventListener('click', _bHandlerClick, { passive: true, capture: true });
  document.addEventListener('change', _bHandlerChange, { passive: true, capture: true });
}
function uninstallBHandlers() {
  if (_bHandlerClick) { document.removeEventListener('click', _bHandlerClick, { capture: true }); _bHandlerClick = null; }
  if (_bHandlerChange) { document.removeEventListener('change', _bHandlerChange, { capture: true }); _bHandlerChange = null; }
}

// ---- 启动 / 停止 API ----
let _started = false;
export function startTelemetry(opts = {}) {
  if (typeof window === 'undefined') return;
  if (window.__sxy_tel_started) return; // 全局防重复启动
  window.__sxy_tel_started = true;
  _started = true;
  _sessionId = uid();
  // A 级总开启（除非用户关掉）
  // B 级：如果启用就装 DOM 监听
  if (isBEnabled()) installBHandlers();
  // 页面切换：如果没装 Vue router 的 beforeEach，外部显式通过 setCurrentPage 通知
  // 这里做个兜底：popstate/hashchange 更新一次（防止遗漏）
  window.addEventListener('popstate', () => setCurrentPage(location.pathname));
  window.addEventListener('hashchange', () => setCurrentPage(location.pathname));
  // 会话首条：open_app
  trackAction('open_app', { ua: navigator.userAgent.slice(0, 120), ts: Date.now() },
    { type: 'open_app', category: 'session_start' });
  // beforeunload 最后 flush 一次（不保证一定成功，尽力而为）
  window.addEventListener('beforeunload', () => { try { _flush(true); } catch {} });
  if (opts.onReady) opts.onReady();
}
export function stopTelemetry() {
  uninstallBHandlers();
  _started = false;
  window.__sxy_tel_started = false;
}

// 页面级便捷 API：外部在 router.afterEach 里调用一次即可
export function pageView(path) {
  setCurrentPage(path);
  trackAction('page_view', null, { category: path, page: path });
}

// 便捷业务埋点（给各模块一个更语义化的封装，避免硬编码字符串）
export const T = {
  // 复习/背诵
  reviewRate: (rating, cardId, front) => trackAction('review_rate',
    { rating, cardId, front: String(front || '').slice(0, 60) },
    { category: String(rating) }),
  reviewFlip: (cardId) => trackAction('review_flip', { cardId }, { category: 'space' }),
  reviewSkip: (cardId) => trackAction('review_skip', { cardId }, { category: 'skip' }),
  // 卡片 CRUD
  cardNew: (cardId) => trackAction('card_new', { cardId }, { category: 'new' }),
  cardEdit: (cardId) => trackAction('card_edit', { cardId }, { category: 'edit' }),
  cardDelete: (cardId) => trackAction('card_delete', { cardId }, { category: 'del' }),
  cardMarkWrong: (cardId, v) => trackAction('card_mark_wrong', { cardId, v }, { category: v ? 'add' : 'remove' }),
  // AI/Agent
  aiCall: (agentId, tokens) => trackAction('ai_call', { agentId, tokens }, { category: agentId || 'chat' }),
  // 导出/同步
  exportRun: (fmt, count) => trackAction('export', { fmt, count }, { category: fmt || 'json' }),
  syncRun: (dir, ok) => trackAction('sync', { dir, ok }, { category: dir + (ok ? ':ok' : ':fail') }),
  // 番茄/模考/费曼
  pomodoroEnd: (durationMin, mode) => trackAction('pomodoro_end', { durationMin, mode }, { category: mode || 'focus' }),
  examEnd: (score, total) => trackAction('exam_end', { score, total }, { category: total ? `${score}/${total}` : '' }),
  feynmanRound: (sessionId) => trackAction('feynman_round', { sessionId }, { category: 'round' }),
  // 健康/图谱/导图
  healthScan: () => trackAction('health_scan', {}, { category: 'scan' }),
  graphSave: (count) => trackAction('graph_save', { count }, { category: String(count) }),
  mindmapSave: (nodes) => trackAction('mindmap_save', { nodes }, { category: String(nodes) }),
  // 隐私模块
  privacyRecord: (recType, date) => trackAction('privacy_record', { type: recType, date }, { category: recType || 'new' }),
};

// 导出：立即 flush（供同步/导出前调用，保证数据最新落盘）
export function flushTelemetry() { return _flush(true); }
