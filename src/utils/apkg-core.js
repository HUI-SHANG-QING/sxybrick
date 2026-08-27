// Anki .apkg 解析纯函数层（apkg-core）
// 与 sql.js / jszip 的 IO 完全分离，Node 可直接单测（N9 模式）。
// Anki 数据约定：
//   notes.flds  字段用 \x1f（0x1f）分隔
//   col.models  各 model 定义 flds(字段) + tmpls(模板 qfmt=正面 / afmt=背面)
//   模板用 {{字段名}} 占位符（cloze 型为 {{cloze:字段名}} 之类）

const FIELD_SEP = '\x1f';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Anki tags 空格分隔 → 数组（限 16 个，与 SxyBrick 一致）
export function parseTags(tags) {
  return String(tags || '').trim().split(/\s+/).filter(Boolean).slice(0, 16);
}

// 清洗 Anki 的 HTML 为纯文本（<br>/<div> → 换行，去标签，解常见实体）
export function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<div[^>]*>/gi, '\n')
    .replace(/<\/(div|p|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// 渲染 Anki 模板：把 {{字段名}} / {{cloze:字段名}} 等占位符替换为字段值
export function renderAnkiTemplate(tpl, fields) {
  let out = String(tpl || '');
  for (const f of fields || []) {
    if (!f || f.name == null) continue;
    out = out.split(new RegExp(`\\{\\{[^{}]*${escapeRegExp(String(f.name))}[^{}]*\\}\\}`, 'g')).join(f.value ?? '');
  }
  return out;
}

// 解析 col.models JSON → { [modelId]: { fields:[name], qfmt, afmt } }
export function parseModels(modelsJson) {
  let models;
  try { models = JSON.parse(modelsJson || '{}'); } catch { models = {}; }
  const out = {};
  for (const [id, m] of Object.entries(models || {})) {
    if (!m) continue;
    const flds = (m.flds || []).slice().sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0)).map(f => f.name);
    const tmpl = (m.tmpls || [])[0] || {};
    out[String(id)] = { fields: flds, qfmt: tmpl.qfmt || '', afmt: tmpl.afmt || '' };
  }
  return out;
}

// 单条 note → 卡片（front/back）：优先用模板渲染，失败/无模板降级为「第 1 字段=正面，其余=背面」
export function noteToCard(flds, model) {
  const values = String(flds || '').split(FIELD_SEP);
  const fields = (model?.fields || []).map((name, i) => ({ name, value: values[i] ?? '' }));
  let front = '', back = '';
  if (model?.qfmt && model?.afmt) {
    try {
      front = stripHtml(renderAnkiTemplate(model.qfmt, fields));
      back = stripHtml(renderAnkiTemplate(model.afmt, fields));
    } catch { front = ''; back = ''; }
  }
  if (!front && !back) {
    front = values[0] || '';
    back = values.slice(1).filter(v => v != null && v !== '').join('\n');
  }
  return { front: (front || '').trim(), back: (back || '').trim() };
}

// 聚合：rows（[id, mid, flds, tags]）+ models → 卡片数组（跳过空正面）
export function buildCardsFromRows(rows, models) {
  const cards = [];
  for (const row of rows || []) {
    if (!row) continue;
    const [, mid, flds, tags] = row;
    const model = models[String(mid)];
    const { front, back } = noteToCard(flds, model);
    if (!front) continue;
    cards.push({ front, back, tags: parseTags(tags) });
  }
  return cards;
}
