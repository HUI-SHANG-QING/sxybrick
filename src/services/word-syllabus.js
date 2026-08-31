// 考研大纲词表加载与过滤
// 数据源：src/data/kaoyan-vocab-2027.json
//
// 版权说明：考研英语大纲词汇由教育部考试中心发布，属官方公开出版物，公众可免费使用。
//   本词表对齐官方大纲收录，随版本更新；用户亦可自行增删替换，以官方最新发布版本为准。
//
// 设计要点：
// - 单词查找大小写不敏感、首尾空白容错；
// - 短语/词组（如 "break the ice"）也算命中（数组 contains 判断）；
// - 载入失败给空集合 + 控制台 warn，调用方据此降级（不过滤、允许生成）。

// 注意 `with { type: 'json' }`：Vite/Rollup 与 Node ESM 都要求（Node 缺属性会直接
// 抛 ERR_IMPORT_ATTRIBUTE_MISSING），加上后本模块才能被 node --test 直接覆盖。
import vocabData from '../data/kaoyan-vocab-2027.json' with { type: 'json' };

let _words = null;
let _set = null;

function ensure() {
  if (_set) return _set;
  try {
    _words = Array.isArray(vocabData?.words) ? vocabData.words : [];
    _set = new Set(_words.map((w) => String(w).trim().toLowerCase()));
  } catch (e) {
    console.warn('[word-syllabus] load failed:', e);
    _words = [];
    _set = new Set();
  }
  return _set;
}

/** 元信息（标题/版本/disclaimer） */
export function getSyllabusMeta() {
  return vocabData?.meta || {
    title: '考研英语大纲词汇',
    version: 'v1.0',
    disclaimer: '考研英语大纲词汇由教育部考试中心发布，属官方出版物，公众可免费使用。',
  };
}

/** 词表总词数 */
export function syllabusSize() {
  ensure();
  return _words.length;
}

/** 取全部词（按字母排序的副本；用于查看页/导出） */
export function listSyllabus() {
  ensure();
  return [..._words].sort();
}

/** 是否在大纲内（单词 / 短语均算；不区分大小写） */
export function isInSyllabus(text) {
  if (!text) return false;
  ensure();
  const norm = String(text).trim().toLowerCase();
  if (!norm) return false;
  // 单词精确命中
  if (_set.has(norm)) return true;
  // 短语：拆首词 + 全串匹配
  const first = norm.split(/\s+/)[0];
  if (first && _set.has(first)) {
    // 再确认短语完整形态是否也在数组里
    return _words.some((w) => String(w).trim().toLowerCase() === norm);
  }
  return false;
}

/**
 * 过滤出大纲内单词（用于批量校验）
 * @param {string[]} words
 * @returns {{hit:string[], miss:string[]}}
 */
export function filterBySyllabus(words) {
  ensure();
  const hit = [];
  const miss = [];
  for (const w of words || []) {
    if (isInSyllabus(w)) hit.push(w);
    else miss.push(w);
  }
  return { hit, miss };
}

/** 导出词表为 Markdown / 纯文本 / CSV — 给用户下载用 */
export function exportSyllabus(format = 'md') {
  const list = listSyllabus();
  const meta = getSyllabusMeta();
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'md') {
    return `# ${meta.title}\n\n> ${meta.disclaimer}\n> 共 ${list.length} 词 · 导出 ${stamp}\n\n` +
      list.map((w, i) => `${i + 1}. ${w}`).join('\n');
  }
  if (format === 'csv') {
    return 'index,word\n' + list.map((w, i) => `${i + 1},"${w}"`).join('\n');
  }
  // txt
  return `${meta.title}\n${meta.disclaimer}\n共 ${list.length} 词 · 导出 ${stamp}\n\n` +
    list.map((w, i) => `${i + 1}. ${w}`).join('\n');
}