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
const FILENAME = 'sxybrick-backup.json';

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
    throw new Error(msg);
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
 * @param {string} description 描述（可选）
 * @returns {Promise<{gistId, htmlUrl}>}
 */
export async function createGistBackup(token, backupPayload, description = 'SxyBrick 卡片库云备份') {
  const body = {
    description,
    public: false, // secret gist，仅自己可见
    files: { [FILENAME]: { content: JSON.stringify(backupPayload) } },
  };
  const r = await gh('/gists', token, 'POST', body);
  return { gistId: r.id, htmlUrl: r.html_url };
}

/**
 * 更新现有 Gist 备份（PATCH，覆盖 file content）。
 * @param {string} token
 * @param {string} gistId
 * @param {object} backupPayload
 * @returns {Promise<{htmlUrl, updatedAt}>}
 */
export async function updateGistBackup(token, gistId, backupPayload) {
  if (!gistId) throw new Error('缺少 gistId');
  const body = {
    files: { [FILENAME]: { content: JSON.stringify(backupPayload) } },
  };
  const r = await gh(`/gists/${gistId}`, token, 'PATCH', body);
  return { htmlUrl: r.html_url, updatedAt: r.updated_at };
}

/**
 * 拉取 Gist 备份内容（GET，解析为 JSON 对象）。
 * @param {string} token
 * @param {string} gistId
 * @returns {Promise<object>} backupPayload
 */
export async function fetchGistBackup(token, gistId) {
  if (!gistId) throw new Error('缺少 gistId');
  const r = await gh(`/gists/${gistId}`, token);
  const f = r.files?.[FILENAME];
  if (!f) throw new Error(`Gist 中未找到文件 ${FILENAME}`);
  const content = f.content || '';
  if (!content.trim()) throw new Error('Gist 内容为空');
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
