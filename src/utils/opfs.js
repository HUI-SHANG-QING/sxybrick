// OPFS 存储封装：原文件存浏览器专属大仓库（几百 MB 扫描 PDF 无压力），
// 元数据/解析全文走 IndexedDB（docFiles/docTexts 表）。
// 纯函数层无浏览器依赖（可 Node 单测）；IO 层在非浏览器环境安全降级。
//
// 设计约定：
//   - 原文件「不跨设备同步」——只同步 docFiles 元数据，跨设备可见清单但无原文
//   - 上传统一走 docFiles（元数据）→ OPFS（原文件）→ docTexts（解析全文）→ embeddings（向量）

// ---------- 纯函数层（无浏览器依赖，Node 可测） ----------

// 扩展名 → 解析器 id 路由表
export const PARSER_ROUTES = {
  pdf: 'pdf',
  xlsx: 'sheet', xls: 'sheet', csv: 'sheet',
  docx: 'docx', doc: 'docx',
  txt: 'text', md: 'text', markdown: 'text', tex: 'text',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image',
};

/** 扩展名 → 解析器 id（null = 不支持） */
export function routeParser(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  return PARSER_ROUTES[e] || null;
}

/** 文件名 → 安全 OPFS 相对路径（去 Windows 非法字符/控制字符/空格，防路径穿越） */
export function normalizeOpfsPath(name) {
  const base = String(name || 'unnamed')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '') // 防隐藏文件/相对路径
    .slice(0, 120);
  return base || 'unnamed';
}

/** File/元数据对象 → docFiles 行元数据（不含 OPFS 写入字段，由调用方补 storage/opfsPath） */
export function buildDocMeta(file, opts = {}) {
  const name = String(file?.name || '').trim();
  const dot = name.lastIndexOf('.');
  const ext = (dot >= 0 ? name.slice(dot + 1) : '').toLowerCase();
  return {
    id: opts.id, // 调用方注入（依赖 crypto.randomUUID，测试可控）
    name,
    ext,
    size: Number(file?.size || 0),
    mime: String(file?.type || '').toLowerCase(),
    subject: String(opts.subject || '').trim(),
    status: 'uploading',
    storage: 'opfs',
    createdAt: opts.createdAt ?? Date.now(),
    updatedAt: opts.createdAt ?? Date.now(),
  };
}

// 文档状态机：允许的转换（非法转换抛错）
export const DOC_STATUS_TRANSITIONS = {
  uploading: ['parsing', 'failed'],
  parsing: ['ready', 'failed'],
  ready: ['parsing'], // 重新解析（重试 / 升级 OCR）
  failed: ['parsing'], // 失败后可重试
};

/** 校验状态迁移，非法抛错 */
export function assertDocTransition(from, to) {
  if (!from || from === to) return;
  const allowed = DOC_STATUS_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(`非法状态迁移 ${from} -> ${to}`);
  }
}

/** 解析器名称 → 人类可读标签（UI 用） */
export const PARSER_LABELS = {
  pdf: 'PDF 文本',
  sheet: '表格',
  docx: 'Word 文本',
  text: '纯文本',
  image: '图片（需 OCR）',
};

// ---------- IO 层（浏览器环境；非浏览器安全降级） ----------

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB 分块，内存受控

function opfsSupported() {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
}

/**
 * 能否真正往 OPFS **写**文件。
 *
 * ⚠️ 只检查 navigator.storage.getDirectory 是不够的：
 * FileSystemFileHandle.createWritable() 是非标准 API，Firefox / Safari 拿得到根目录句柄
 * 却没有这个方法，调用时抛 `h.createWritable is not a function`，
 * 上传会以一个完全看不懂的错误失败。这里提前探测，好走 IndexedDB 降级路径并给出人话提示。
 */
export function opfsWritableSupported() {
  if (!opfsSupported()) return false;
  try {
    return typeof FileSystemFileHandle !== 'undefined'
      && typeof FileSystemFileHandle.prototype?.createWritable === 'function';
  } catch {
    return false;
  }
}

/** 获取 OPFS 根目录句柄（非浏览器返回 null） */
export async function getOpfsRoot() {
  if (!opfsSupported()) return null;
  return navigator.storage.getDirectory();
}

/**
 * 分块写入 OPFS：4MB 一块循环 write（大文件内存受控）
 * @returns {Promise<{opfsPath:string,size:number}>}
 */
export async function saveFileToOpfs(opfsPath, file, onProgress) {
  const root = await getOpfsRoot();
  if (!root) throw new Error('当前浏览器不支持 OPFS 存储');
  if (!opfsWritableSupported()) {
    throw new Error('当前浏览器不支持 OPFS 写入（createWritable 缺失，多为 Firefox / Safari）');
  }
  const h = await root.getFileHandle(opfsPath, { create: true });
  const w = await h.createWritable();
  const total = Number(file?.size || 0);
  let written = 0;
  try {
    if (total === 0) {
      await w.write(new Blob([]));
      await w.close();
      onProgress?.(1, 1);
      return { opfsPath, size: 0 };
    }
    for (let off = 0; off < total; off += CHUNK_SIZE) {
      const blob = file.slice(off, Math.min(off + CHUNK_SIZE, total));
      await w.write(blob);
      written += blob.size;
      // 除零防护：空文件 / size 取不到时进度条会变成 NaN%
      onProgress?.(written, total);
    }
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch { /* ignore */ }
    throw e;
  }
  return { opfsPath, size: total };
}

/** 读取 OPFS 文件为 Blob（不存在返回 null） */
export async function readFileFromOpfs(opfsPath) {
  const root = await getOpfsRoot();
  if (!root) return null;
  try {
    const h = await root.getFileHandle(opfsPath);
    return h.getFile();
  } catch {
    return null;
  }
}

/** 删除 OPFS 文件（不存在静默） */
export async function deleteFileFromOpfs(opfsPath) {
  const root = await getOpfsRoot();
  if (!root) return;
  try { await root.removeEntry(opfsPath); } catch { /* 已不存在 */ }
}

/** 存储配额估算（{usage, quota} 或 null） */
export async function statOpfs() {
  if (typeof navigator?.storage?.estimate !== 'function') return null;
  return navigator.storage.estimate();
}

/** 申请持久化存储（避免浏览器回收），返回是否已持久化 */
export async function requestPersist() {
  if (typeof navigator?.storage?.persist !== 'function') return null;
  return navigator.storage.persist();
}
