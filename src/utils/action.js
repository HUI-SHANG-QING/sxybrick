// src/utils/action.js
// 「点一下就写库」的动作统一包装（round107）。
//
// 为什么要统一：这类动作此前多为裸 `await repo.xxx()`。一旦失败：
//   ① 异常只进全局日志 → 用户看到的是**「点了没反应」**，于是反复点击
//      （幂等操作是白点；打卡、建卡、删除这类还可能重复提交或半成功）；
//   ② 失败后**后续语句照样按旧代码顺序执行**（成功才该有的 toast、列表刷新），
//      界面状态与实际数据就此分叉（例如卡片没删掉但列表已把它移除）。
// 包装后语义变成：**失败必定有可见提示；成功才走后续逻辑**。
import { toast } from './toast.js';
import { t } from '../i18n/index.js';

/**
 * @param {() => any} fn 实际动作（写库 / 网络请求）
 * @param {object} [opts]
 * @param {string} [opts.failKey] i18n 键（文案需含 {msg}）；缺省用 common.actionFailed
 * @param {string} [opts.failText] 文案兜底（字典尚未加该键时用）
 * @param {() => any} [opts.then] 成功后的后续动作（成功提示 / 刷新列表）——失败时不会执行
 * @param {boolean} [opts.silent] 不弹提示（仅用于已有更精细反馈的场景）
 * @returns {Promise<{ok: boolean, value?: any, error?: any}>} 调用方需要分支时看 ok
 */
export async function runAction(fn, opts = {}) {
  let value;
  try {
    value = await fn();
  } catch (e) {
    const msg = String(e?.message || e || '');
    if (!opts.silent) {
      const text = opts.failKey
        ? t(opts.failKey, opts.failText || t('common.actionFailed', '操作失败：{msg}'), { msg })
        : t('common.actionFailed', '操作失败：{msg}', { msg });
      toast(text, 'error');
    }
    // 控制台留痕便于排查（不重复弹窗）
    try { console.warn('[action] failed:', e); } catch { /* ignore */ }
    return { ok: false, error: e };
  }
  // 成功后的后续动作（成功提示 / 刷新列表）放在 try **之外**，理由有二：
  //   ① 数据其实**已经写成功**，此时失败若报「操作失败」会让用户以为没写进去 —— 信息必须准确；
  //   ② 后续失败此前是完全静默的（裸 await），这里改成 warning 级提示 + 明确措辞，既不吓人也不隐瞒。
  if (opts.then) {
    try {
      await opts.then(value);
    } catch (e) {
      try { toast(t('common.refreshFailed', '操作已完成，但界面刷新失败：{msg}', { msg: String(e?.message || e) }), 'warning'); } catch { /* 提示失败不掩盖原错误 */ }
      try { console.warn('[action] then failed:', e); } catch { /* ignore */ }
    }
  }
  return { ok: true, value };
}
