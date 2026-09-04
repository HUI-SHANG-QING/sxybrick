// sync-hub/auth-core.js
// 局域网同步中枢的鉴权协议核心（纯逻辑，可单测）
//
// 2026-08-29 P0 重做：原实现有三个致命问题
//   1) GET /health 免鉴权却返回 tokenOk —— 等价于公开的「口令验证预言机」
//   2) 全响应带 Access-Control-Allow-Origin: * —— 任意恶意网页可跨域穷举口令并读取结果
//   3) 用 `!==` 比较密钥 —— 非恒定时间，存在时序侧信道；且无任何失败限流
//
// 新协议（v2，HMAC 挑战-响应）：
//   - 客户端先 GET /auth/challenge 取一次性随机挑战（限流）
//   - 客户端用同步密码作 HMAC 密钥对规范串签名：HMAC-SHA256(secret, payload)
//   - 规范串绑定 挑战 + 方法 + 路径 + 请求体摘要，杜绝跨端点/跨请求重放
//   - 服务端恒定时间比较签名；挑战一次性、有有效期
//   - 密钥本身永不上网，抓包也拿不到口令
//
// 兼容：仍接受旧式 x-sync-token 明文头（老客户端），但走同样的限流与恒定时间比较。

import { createHmac, timingSafeEqual, randomBytes, createHash } from 'node:crypto';

export const AUTH_VERSION = 2;
/** 挑战有效期（毫秒） */
export const CHALLENGE_TTL_MS = 60_000;
/** 挑战池上限，防止被刷爆内存 */
export const CHALLENGE_MAX = 500;

/** 生成一次性挑战 */
export function createChallenge(now = Date.now()) {
  return {
    v: AUTH_VERSION,
    challenge: randomBytes(24).toString('hex'),
    expiresAt: now + CHALLENGE_TTL_MS,
    ttl: CHALLENGE_TTL_MS,
  };
}

/**
 * 构造待签名的规范串。绑定方法/路径/请求体摘要，
 * 使同一挑战的签名无法被挪用到别的接口或别的请求体。
 * @param {{challenge:string, method:string, path:string, body?:string|Buffer}} p
 */
export function buildSignPayload({ challenge, method, path, body }) {
  const raw = body == null ? '' : (Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
  const bodyHash = createHash('sha256').update(raw, 'utf8').digest('hex');
  return [
    `v${AUTH_VERSION}`,
    challenge,
    String(method || '').toUpperCase(),
    String(path || '/'),
    bodyHash,
  ].join('\n');
}

/** 服务端：计算签名（hex） */
export function signPayload(secret, parts, now) {
  return createHmac('sha256', String(secret || '')).update(buildSignPayload(parts)).digest('hex');
}

/**
 * 恒定时间比较两段等长字符串；长度不等时先做一次自身比较再返回 false，
 * 避免通过「返回快慢」泄露长度信息。
 */
export function safeEqual(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  const ba = Buffer.from(sa, 'utf8');
  const bb = Buffer.from(sb, 'utf8');
  if (ba.length !== bb.length) {
    // 与自身比较，消耗可比对等长时相当的时间
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

// ---------- 挑战池 ----------

/**
 * 一次性挑战池（进程内）。
 * @param {{now?:()=>number}} opts
 */
export function createChallengeStore(opts = {}) {
  const now = opts.now || (() => Date.now());
  /** @type {Map<string, number>} challenge → expiresAt */
  const map = new Map();

  function sweep(t = now()) {
    for (const [k, exp] of map) if (exp <= t) map.delete(k);
  }

  return {
    issue() {
      sweep();
      // 池满时先清理，仍满则淘汰最早的一个（Map 保持插入序）
      if (map.size >= CHALLENGE_MAX) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      const c = createChallenge(now());
      map.set(c.challenge, c.expiresAt);
      return c;
    },
    /** 消费挑战：存在且未过期则删除并返回 true（一次性） */
    consume(challenge) {
      if (!challenge) return false;
      sweep();
      const exp = map.get(String(challenge));
      if (exp === undefined) return false;
      map.delete(String(challenge));
      return exp > now();
    },
    has(challenge) {
      sweep();
      const exp = map.get(String(challenge));
      return exp !== undefined && exp > now();
    },
    get size() { sweep(); return map.size; },
    _clear() { map.clear(); },
  };
}

// ---------- 限流 / 失败锁定 ----------

/**
 * 滑动窗口限流器 + 指数退避锁定。
 * @param {{windowMs?:number, max?:number, baseLockMs?:number, maxLockMs?:number, now?:()=>number}} opts
 */
export function createRateLimiter(opts = {}) {
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max ?? 10;
  const baseLockMs = opts.baseLockMs ?? 1_000;
  const maxLockMs = opts.maxLockMs ?? 15 * 60_000;
  const now = opts.now || (() => Date.now());
  /** @type {Map<string, {hits:number[], fails:number, lockedUntil:number}>} */
  const state = new Map();

  function entryOf(key) {
    let e = state.get(key);
    if (!e) { e = { hits: [], fails: 0, lockedUntil: 0 }; state.set(key, e); }
    return e;
  }

  return {
    /** 读取当前锁定剩余毫秒（0 表示未锁定） */
    lockedFor(key, t = now()) {
      const e = state.get(key);
      if (!e) return 0;
      return e.lockedUntil > t ? e.lockedUntil - t : 0;
    },
    /** 记录一次访问，返回 { allowed, retryAfterMs } */
    hit(key, t = now()) {
      const e = entryOf(key);
      if (e.lockedUntil > t) return { allowed: false, retryAfterMs: e.lockedUntil - t };
      e.hits = e.hits.filter(h => t - h < windowMs);
      e.hits.push(t);
      if (e.hits.length > max) {
        e.fails += 1;
        // 指数退避：1s, 2s, 4s... 上限 15 分钟
        const lock = Math.min(maxLockMs, baseLockMs * 2 ** (e.fails - 1));
        e.lockedUntil = t + lock;
        e.hits = [];
        return { allowed: false, retryAfterMs: lock };
      }
      return { allowed: true, retryAfterMs: 0 };
    },
    /** 鉴权失败：立即计入退避（口令猜测是高危行为，不等窗口填满） */
    fail(key, t = now()) {
      const e = entryOf(key);
      e.fails += 1;
      const lock = Math.min(maxLockMs, baseLockMs * 2 ** (e.fails - 1));
      e.lockedUntil = t + lock;
      e.hits = [];
      return lock;
    },
    /** 鉴权成功：清零失败计数与锁定（正常用户输错一次不该被长期惩罚） */
    reset(key) {
      state.delete(key);
    },
    _state: state,
    _clear() { state.clear(); },
  };
}

/** 归一化客户端 IP（IPv6 映射的 IPv4 统一为 IPv4 形式） */
export function normalizeIp(ip) {
  const s = String(ip || '').trim();
  if (s.startsWith('::ffff:')) return s.slice(7);
  return s || 'unknown';
}

// ---------- CORS 白名单 ----------

/**
 * 判断跨域来源是否被允许。
 * 放开 CORS * 的危害：任意恶意网页可跨域调用 Hub 并读取响应（口令穷举、数据窃取）。
 * 而 Hub 自身就托管了前端，主流程是同源访问，本不需要 CORS。
 * 仅放行：同源、localhost/127.0.0.1（本地 dev 跨端口）、以及环境变量显式配置的白名单。
 *
 * @param {string|undefined} origin 请求 Origin 头（同源请求与非浏览器请求为空）
 * @param {{host?:string, allowList?:string[]}} ctx
 */
export function isOriginAllowed(origin, ctx = {}) {
  if (!origin) return true; // 无 Origin：同源或 curl/非浏览器，不涉及跨域读取
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false; // 非法 Origin
  }
  const hostname = host.split(':')[0];
  // 本地回环（允许任意端口，便于 npm run dev 5173 → hub 18080 的本地调试）
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1') return true;
  // 与请求的 Host 一致 = 同源
  if (ctx.host && host === ctx.host) return true;
  // 显式白名单（HUB_ALLOW_ORIGIN="https://a.example,http://b.example:8080"）
  const list = ctx.allowList || [];
  return list.some(o => String(o).trim() === origin);
}

/**
 * 按 Origin 生成 CORS 响应头；不允许时返回空对象（浏览器会拦截响应读取）。
 */
export function corsHeaders(origin, ctx = {}) {
  if (!isOriginAllowed(origin, ctx)) return {};
  const allowOrigin = origin || '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS,HEAD',
    'Access-Control-Allow-Headers': 'Content-Type, x-sync-token, x-sync-challenge, x-sync-sig',
    'Access-Control-Max-Age': '3600',
    Vary: 'Origin',
  };
}
