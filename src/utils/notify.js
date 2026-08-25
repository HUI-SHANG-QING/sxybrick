// 浏览器通知（页面内提醒）：复习提醒 + 番茄到点提醒
// 说明：PWA 后台推送需要 Service Worker + Push 服务端，本项目为纯静态免费部署，故采用
// 「页面打开时轮询 + Notification API」方案：应用在任一标签页打开即可收到提醒。
export function notifySupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export async function ensureNotifyPermission() {
  if (!notifySupported()) return 'unsupported';
  let p = Notification.permission;
  if (p === 'default') {
    try { p = await Notification.requestPermission(); } catch { p = 'denied'; }
  }
  return p;
}

export function sendNotify(title, body) {
  if (!notifySupported() || Notification.permission !== 'granted') return false;
  try {
    new Notification(title, { body: String(body || ''), tag: 'sxybrick' });
    return true;
  } catch {
    return false;
  }
}