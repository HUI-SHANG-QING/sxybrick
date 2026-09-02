// src/utils/gistBackup.js
// Gist 云备份（P3·#2）：用 GitHub Gist API 在多设备间同步卡片库。
// 纯前端实现，零后端服务，token + gistId 存 localStorage（用户自担风险）。
//
// 流程：
//   首次：POST /gists 创建（gistId 自动保存）
//   后续：PATCH /gists/{id} 更新（按 updatedAt 时间戳合并）
//   拉取：GET /gists/{id} 读取并 importBackup
//
// 安全提示：
//   - Personal Access Token 仅需 `gist` scope（最小权限）
//   - token 存 localStorage，仅在本机浏览器内使用；不上传到任何第三方服务
//   - 公开 Gist 会暴露你的卡片内容，建议设为 secret（默认）

const API = 'https://api.github.com';
// M3 演示模式：备份文件名按数据域区分（real 原名兼容 | test 独立文件），
// 同一 Gist 账户下两个 scope 各占一个文件，互不覆盖
const FILENAME = 'sxybrick-backup.json';
const TEST_FILENAME = 'sxybrick-backup-test.json';
function fileNameFor(scope) {
  return scope === 'test' ? TEST_FILENAME : FILENAME;
}

async function gh(path, token, method = 'GET', body = null) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : null,
  });
  if (!res.ok) {
    let msg = `GitHub API ${res.status}`;
    try {
      const j = await res.json();
      if (j.message) msg += `: ${j.message}`;
    } catch {}
    // round18 R18-2：带上 HTTP 状态码，调用方据此区分
    //   「404 = 云端还没有备份（可按首次推送处理）」与「5xx/网络错误 = 读不到，禁止盲覆盖」。
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * 验证 token 是否有效（仅请求 /user 端点，最小开销）。
 * @returns {Promise<{login, scopes}>}
 */
export async function verifyToken(token) {
  if (!token) throw new Error('请填写 GitHub Token');
  // /user 不返回 scopes 头部（GitHub 已废弃），用 /gists 的 GET 验证 gist 权限
  const me = await gh('/user', token);
  // 尝试列出一个 gist 验证 gist 权限
  await gh('/gists?per_page=1', token);
  return { login: me.login };
}

/**
 * 创建一个新的 secret Gist，写入备份 JSON。
 * @param {string} token
 * @param {object} backupPayload buildBackup() 返回的对象
 * @param {object} opts { description, scope: 'real'|'test' }
 * @returns {Promise<{gistId, htmlUrl}>}
 */
export async function createGistBackup(token, backupPayload, opts = {}) {
  const description = opts.description || 'SxyBrick 卡片库云备份';
  const fname = fileNameFor(backupPayload?.scope || opts.scope);
  const body = {
    description: backupPayload?.scope === 'test' ? `${description}（演示数据）` : description,
    public: false, // secret gist，仅自己可见
    files: { [fname]: { content: JSON.stringify(backupPayload) } },
  };
  const r = await gh('/gists', token, 'POST', body);
  return { gistId: r.id, htmlUrl: r.html_url };
}

/**
 * 更新现有 Gist 备份（PATCH，覆盖 file content）。
 * @param {string} token
 * @param {string} gistId
 * @param {object} backupPayload
 * @param {object} opts { scope: 'real'|'test' }
 * @returns {Promise<{htmlUrl, updatedAt}>}
 */
export async function updateGistBackup(token, gistId, backupPayload, opts = {}) {
  if (!gistId) throw new Error('缺少 gistId');
  const fname = fileNameFor(backupPayload?.scope || opts.scope);
  const body = {
    files: { [fname]: { content: JSON.stringify(backupPayload) } },
  };
  const r = await gh(`/gists/${gistId}`, token, 'PATCH', body);
  return { htmlUrl: r.html_url, updatedAt: r.updated_at };
}

/**
 * 拉取 Gist 备份内容（GET，解析为 JSON 对象）。
 * @param {string} token
 * @param {string} gistId
 * @param {object} opts { scope: 'real'|'test' }
 * @returns {Promise<object>} backupPayload
 */
export async function fetchGistBackup(token, gistId, opts = {}) {
  if (!gistId) throw new Error('缺少 gistId');
  const r = await gh(`/gists/${gistId}`, token);
  // 优先按 scope 找文件；找不到时回退到另一 scope（兼容手动操作），但包内 scope 由调用方校验
  const wanted = fileNameFor(opts.scope);
  let f = r.files?.[wanted] || r.files?.[FILENAME] || r.files?.[TEST_FILENAME];
  if (!f) {
    // round18 R18-2：与「gist 整个没了（HTTP 404）」同义——云端还没有可合并的备份。
    // 给个可判别的 code，调用方据此按「首次推送」处理，而不是当成致命错误。
    const err = new Error(`Gist 中未找到备份文件（${wanted}）`);
    err.code = 'NO_BACKUP_FILE';
    throw err;
  }
  const content = f.content || '';
  if (!content.trim()) {
    const err = new Error('Gist 内容为空');
    err.code = 'EMPTY_BACKUP';
    throw err;
  }
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error('Gist 内容 JSON 解析失败：' + e.message);
  }
}

/**
 * 列出当前 token 拥有的所有 Gist（用于在 UI 让用户选择/识别）。
 */
export async function listGists(token, max = 30) {
  const r = await gh(`/gists?per_page=${max}`, token);
  return r.map(g => ({ id: g.id, description: g.description || '(无描述)', updatedAt: g.updated_at, htmlUrl: g.html_url }));
}
