<script setup>
// P3·11 人生隐私数据超级监控（B 档超级详尽结构化）
// 物理：sleep / eat / move / learn / work / screen / finance / social / meditation / commute / housework / medical / shop / other
// 精神：mental（富文本心得体会 + 高频情绪词）
// 元信息：时间段(startTime/endTime 自动预填当前段)、地点/人物、心情/能量/专注/愉悦/压力/疼痛(含部位)
// 自定义：customTags(标签输入框) + customKV(key-value 多组)
// 额外：人物画像报告（本地启发式 + AI 增强按钮）、列表浏览/编辑/删除、搜索/标签/类型/日期范围
import { confirmDialog } from '../utils/confirm.js';
import { ref, computed, onMounted, reactive, defineComponent, h } from 'vue';
import { useRouter } from 'vue-router';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import {
  savePrivacyRecord, listPrivacyRecords, getPrivacyRecord, deletePrivacyRecord,
  privacyPersonaReport, recordUserOp,
} from '../repo.js';
import { T } from '../utils/telemetry.js';
import { toast } from '../utils/toast.js';
import { hasAIKey, chatAI } from '../ai.js';

// 注册局部组件 <score-slider>：1-5 滑块 + 左右 2 文字
const ScoreSlider = defineComponent({
  name: 'ScoreSlider',
  props: { modelValue: { type: Number, default: 3 }, low: { type: String, default: '低' }, high: { type: String, default: '高' } },
  emits: ['update:modelValue'],
  setup(props, ctx) {
    return () => h('div', { class: 'slider-box' }, [
      h('input', {
        type: 'range', min: 1, max: 5, step: 1,
        value: props.modelValue,
        style: { width: '100%' },
        onInput: (e) => {
          const x = Number(e.target.value);
          ctx.emit('update:modelValue', x);
        },
      }),
      h('div', { class: 'slider-labels' }, [
        h('span', {}, `${props.low}（1）`),
        h('span', {}, `${props.high}（5）`),
      ]),
    ]);
  },
});

const router = useRouter();
const pad = n => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
const nowHHMM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const tsFromYMDHM = (date, hhmm) => {
  if (!date) return 0;
  const [y, m, d] = date.split('-').map(Number);
  const [hh = 0, mm = 0] = (hhmm || '00:00').split(':').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, hh, mm).getTime();
};
const hmFromTs = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// 类型 + 子类型枚举（B 档超级详尽版）
const TYPE_OPTIONS = [
  { id: 'sleep',      label: '😴 睡眠', sub: ['整晚','午睡','小憩','补觉','失眠片段'] },
  { id: 'eat',        label: '🍽️ 饮食', sub: ['早餐','午餐','晚餐','加餐','宵夜','饮水','咖啡因','酒精','补品'] },
  { id: 'move',       label: '🏃 运动', sub: ['有氧','力量','拉伸','瑜伽','球类','户外徒步','通勤运动','康复训练'] },
  { id: 'learn',      label: '📖 学习', sub: ['复习卡片','费曼讲解','模考','阅读','网课','写作','专题练习','错题复盘'] },
  { id: 'work',       label: '💼 工作', sub: ['会议','深度工作','杂务','沟通','文档','代码','汇报','复盘'] },
  { id: 'screen',     label: '📱 屏幕', sub: ['手机','电脑','电视','短视频','社交平台','游戏','摸鱼浏览'] },
  { id: 'social',     label: '👥 社交', sub: ['家人','朋友','同事','聚会','1v1 深聊','网络社交','线下活动'] },
  { id: 'meditation', label: '🧘 冥想', sub: ['正念','呼吸','观想','放松','白噪音','祈祷'] },
  { id: 'commute',    label: '🚗 通勤', sub: ['步行','骑车','公交','地铁','自驾','打车','长途旅行'] },
  { id: 'housework',  label: '🧹 家务', sub: ['做饭','清洁','整理','购物','维修','照护家人','衣物','园艺'] },
  { id: 'medical',    label: '🏥 医疗', sub: ['体检','就医','复诊','吃药','手术','牙齿','眼科','理疗'] },
  { id: 'shop',       label: '🛒 消费', sub: ['日用品','服装','电子','餐饮','学习用品','娱乐','冲动消费'] },
  { id: 'finance',    label: '💰 财务', sub: ['收入','支出','储蓄','投资','还款','意外花销','捐赠'] },
  { id: 'excrete',    label: '🚽 排泄', sub: ['小便','大便','腹泻','便秘','尿频','夜尿'] },
  { id: 'other',      label: '🛈 其它', sub: ['娱乐','休息躺平','洗澡','碎片时间'] },
  { id: 'mental',     label: '🧠 精神/心得', sub: ['每日总结','情绪记录','灵感','感恩','反思','计划展望','梦境笔记'] },
];
const typeLabel = (k) => TYPE_OPTIONS.find(t => t.id === k)?.label || k;
const subLabelOf = (typeKey, subKey) => {
  const t = TYPE_OPTIONS.find(x => x.id === typeKey);
  if (!t) return subKey || '';
  return (t.sub.includes(subKey) ? subKey : subKey) || '';
};

// Bristol 大便形状量表 1-7（锦衣卫级监控专用）
const BRISTOL_SCALE = [
  { v: 1, label: '1 · 硬球状（严重便秘）' },
  { v: 2, label: '2 · 块状（便秘）' },
  { v: 3, label: '3 · 干裂香肠（轻度便秘）' },
  { v: 4, label: '4 · 正常光滑香肠（理想）' },
  { v: 5, label: '5 · 软块状（纤维不足）' },
  { v: 6, label: '6 · 糊状（轻度腹泻）' },
  { v: 7, label: '7 · 水样（严重腹泻）' },
];

// —— 超级结构化的块定义 ——
const emptyForm = () => ({
  id: '',
  date: todayISO(),
  startTime: nowHHMM(),
  endTime: nowHHMM(),
  type: 'learn',
  subType: '复习卡片',
  location: '',
  people: [],
  mood: 3, energy: 3, focus: 3, pleasure: 3, stress: 3,
  painIndex: 0,
  painParts: [],
  // 锦衣卫级情绪/精神字段
  anxiety: 3, depression: 3, confidence: 3, stressSource: '',
  // 专用详细块（只有当 type 命中时才展开）
  sleepBlock: null,  // { hours, quality:1-5, wakeCount, lightMinutes, deepMinutes, remMinutes, interruptions, snore, bedTime, wakeTime, napMinutes, sleepLatency }
  eatBlock: null,    // { calories, protein_g, carbs_g, fat_g, water_ml, caffeineMg, alcohol_ml, meals: [{name,kcal,portion}], mealCount, sugar_g, salt_g, fiber_g, notes }
  moveBlock: null,   // { kind, minutes, heartRateAvg, heartRateMax, steps, distanceKm, calories, hrZone: [z1,z2,z3,z4,z5], notes }
  learnBlock: null,  // { subject, topic, source, minutes, focusEfficiency, goals:[''], outcomes:[''], cards_reviewed, cards_new, cards_mastered, aiCalls, interruptions, interruptReasons:[], deepFocusMinutes, notes }
  workBlock: null,   // { project, role, minutes, deepMinutes, meetings, decisions:[''], deliverables:[''], satisfaction, notes }
  screenBlock: null, // { device, totalMin, appMinutes:[{app,min}], blueLightReduced, eyeBreak, notes }
  financeBlock: null,// { currency, income, expense, delta, account, category, notes }
  excreteBlock: null,// { urineCount, bowelCount, stoolForm:1-7, bloodUrine, bloodStool, notes }
  // 其它：mental 用全局字段 mental, customTags, customKV
  mental: '',
  customTags: [],
  customKV: [],
});

const form = reactive(emptyForm());
const editingId = ref('');
const saving = ref(false);
const tab = ref('form');   // 'form' | 'list' | 'report'

// people / tags / painParts 输入
const peopleInput = ref('');
const tagInput = ref('');
const painInput = ref('');
const learnInterruptInput = ref('');
function addPeople() {
  const v = peopleInput.value.trim();
  if (!v) return;
  if (!form.people.includes(v)) form.people.push(v);
  peopleInput.value = '';
}
function removePeople(p) { const i = form.people.indexOf(p); if (i >= 0) form.people.splice(i, 1); }
function addTag() {
  const v = tagInput.value.trim();
  if (!v) return;
  if (!form.customTags.includes(v)) form.customTags.push(v);
  tagInput.value = '';
}
function removeTag(t) { const i = form.customTags.indexOf(t); if (i >= 0) form.customTags.splice(i, 1); }
function addPain() {
  const v = painInput.value.trim();
  if (!v) return;
  if (!form.painParts.includes(v)) form.painParts.push(v);
  painInput.value = '';
}
function removePain(p) { const i = form.painParts.indexOf(p); if (i >= 0) form.painParts.splice(i, 1); }

// KV 管理
function addKV() { form.customKV.push({ k: '', v: '' }); }
function removeKV(idx) { form.customKV.splice(idx, 1); }

// 类型切换时：初始化对应 Block 结构（保持原值如果已存在）
function ensureBlocksForType() {
  const t = form.type;
  if (t === 'sleep' && !form.sleepBlock) {
    form.sleepBlock = { hours: 7, quality: 3, wakeCount: 0, lightMinutes: 240, deepMinutes: 90, remMinutes: 90, interruptions: '', snore: 0, bedTime: '23:00', wakeTime: '07:00', napMinutes: 0, sleepLatency: 0 };
  }
  if (t === 'eat' && !form.eatBlock) {
    form.eatBlock = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, water_ml: 1500, caffeineMg: 0, alcohol_ml: 0, meals: [], mealCount: 0, sugar_g: 0, salt_g: 0, fiber_g: 0, notes: '' };
  }
  if (t === 'move' && !form.moveBlock) {
    form.moveBlock = { kind: '有氧', minutes: 0, heartRateAvg: 0, heartRateMax: 0, steps: 0, distanceKm: 0, calories: 0, hrZone: [0,0,0,0,0], notes: '' };
  }
  if (t === 'learn' && !form.learnBlock) {
    form.learnBlock = { subject: '', topic: '', source: '', minutes: 0, focusEfficiency: 3, goals: [], outcomes: [], cards_reviewed: 0, cards_new: 0, cards_mastered: 0, aiCalls: 0, interruptions: 0, interruptReasons: [], deepFocusMinutes: 0, notes: '' };
  }
  if (t === 'work' && !form.workBlock) {
    form.workBlock = { project: '', role: '', minutes: 0, deepMinutes: 0, meetings: 0, decisions: [], deliverables: [], satisfaction: 3, notes: '' };
  }
  if (t === 'screen' && !form.screenBlock) {
    form.screenBlock = { device: '手机', totalMin: 0, appMinutes: [], blueLightReduced: 0, eyeBreak: 0, notes: '' };
  }
  if (t === 'finance' && !form.financeBlock) {
    form.financeBlock = { currency: 'CNY', income: 0, expense: 0, delta: 0, account: '', category: '', notes: '' };
  }
  // 排泄块：当 type='excrete' 或 'other' 时展开
  if ((t === 'excrete' || t === 'other') && !form.excreteBlock) {
    form.excreteBlock = { urineCount: 0, bowelCount: 0, stoolForm: 4, bloodUrine: false, bloodStool: false, notes: '' };
  }
}
// meals / appMinutes / goals / outcomes / decisions / deliverables 单行数组辅助
function addMeal() { form.eatBlock.meals.push({ name: '', kcal: 0, portion: '中碗' }); }
function delMeal(i) { form.eatBlock.meals.splice(i, 1); }
function addAppMin() { form.screenBlock.appMinutes.push({ app: '', min: 0 }); }
function delAppMin(i) { form.screenBlock.appMinutes.splice(i, 1); }
function addStringArrItem(arrKey, parentBlock) { if (!parentBlock[arrKey]) parentBlock[arrKey] = []; parentBlock[arrKey].push(''); }
function delStringArrItem(arrKey, parentBlock, idx) { parentBlock[arrKey].splice(idx, 1); }
// learnBlock.interruptReasons chip 模式输入
function addLearnInterrupt() {
  const v = learnInterruptInput.value.trim();
  if (!v) return;
  if (!form.learnBlock.interruptReasons.includes(v)) form.learnBlock.interruptReasons.push(v);
  learnInterruptInput.value = '';
}
function delLearnInterrupt(i) { form.learnBlock.interruptReasons.splice(i, 1); }

// —— 保存 / 清空 / 加载 ——
function resetForm() { Object.assign(form, emptyForm()); editingId.value = ''; }
async function saveCurrent() {
  saving.value = true;
  try {
    ensureBlocksForType();
    const payload = {
      id: editingId.value || undefined,
      date: form.date,
      startTime: tsFromYMDHM(form.date, form.startTime),
      endTime:   tsFromYMDHM(form.date, form.endTime),
      type: form.type, subType: form.subType,
      location: form.location,
      people: [...form.people],
      mood: Number(form.mood), energy: Number(form.energy), focus: Number(form.focus),
      pleasure: Number(form.pleasure), stress: Number(form.stress),
      painIndex: Number(form.painIndex), painParts: [...form.painParts],
      // 锦衣卫级情绪/精神字段
      anxiety: Number(form.anxiety), depression: Number(form.depression),
      confidence: Number(form.confidence), stressSource: form.stressSource || '',
      sleepBlock: form.type === 'sleep' ? form.sleepBlock : null,
      eatBlock:   form.type === 'eat'   ? form.eatBlock   : null,
      moveBlock:  form.type === 'move'  ? form.moveBlock  : null,
      learnBlock: form.type === 'learn' ? form.learnBlock : null,
      workBlock:  form.type === 'work'  ? form.workBlock  : null,
      screenBlock:form.type === 'screen'? form.screenBlock: null,
      financeBlock: form.type === 'finance' ? form.financeBlock : null,
      excreteBlock: (form.type === 'excrete' || form.type === 'other') ? form.excreteBlock : null,
      mental: form.mental || '',
      customTags: [...form.customTags],
      customKV: form.customKV.filter(x => x.k).reduce((o, x) => ({ ...o, [x.k]: x.v }), {}),
    };
    const r = await savePrivacyRecord(payload);
    T.privacyRecord(r.type, r.date);
    toast(editingId.value ? `已更新「${typeLabel(r.type)} · ${r.subType || ''}」` : `已记录「${typeLabel(r.type)} · ${r.subType || ''}」`, 'success');
    resetForm();
    refreshList();
  } catch (e) { toast('保存失败：' + e.message, 'error'); }
  finally { saving.value = false; }
}
async function editRec(id) {
  const r = await getPrivacyRecord(id);
  if (!r) { toast('记录不存在', 'warn'); return; }
  editingId.value = id;
  form.date = r.date || todayISO();
  form.startTime = hmFromTs(r.startTime);
  form.endTime = hmFromTs(r.endTime);
  form.type = r.type || 'other';
  form.subType = r.subType || '';
  form.location = r.location || '';
  form.people = Array.isArray(r.people) ? [...r.people] : [];
  form.mood = Number(r.mood) || 3;
  form.energy = Number(r.energy) || 3;
  form.focus = Number(r.focus) || 3;
  form.pleasure = Number(r.pleasure) || 3;
  form.stress = Number(r.stress) || 3;
  form.painIndex = Number(r.painIndex) || 0;
  form.painParts = Array.isArray(r.painParts) ? [...r.painParts] : [];
  // 锦衣卫级情绪/精神字段
  form.anxiety = Number(r.anxiety) || 3;
  form.depression = Number(r.depression) || 3;
  form.confidence = Number(r.confidence) || 3;
  form.stressSource = r.stressSource || '';
  form.sleepBlock = r.sleepBlock || null;
  form.eatBlock = r.eatBlock || null;
  form.moveBlock = r.moveBlock || null;
  form.learnBlock = r.learnBlock || null;
  form.workBlock = r.workBlock || null;
  form.screenBlock = r.screenBlock || null;
  form.financeBlock = r.financeBlock || null;
  form.excreteBlock = r.excreteBlock || null;
  form.mental = r.mental || '';
  form.customTags = Array.isArray(r.customTags) ? [...r.customTags] : [];
  // customKV: 对象形式存库 → 转为 KV 数组编辑
  form.customKV = Object.entries(r.customKV || {}).map(([k, v]) => ({ k, v }));
  ensureBlocksForType();
  tab.value = 'form';
  toast(`已载入 ${r.date} ${typeLabel(r.type)} 记录，可编辑后保存。`, 'info');
}
async function delRec(id) {
  if (!(await confirmDialog('确定删除这条人生记录？此删除会通过同步链传播到其他设备。'))) return;
  await deletePrivacyRecord(id);
  toast('已删除', 'success');
  refreshList();
}

// —— 列表筛选 ——
const list = ref([]);
const listBusy = ref(false);
const qFrom = ref('');
const qTo = ref('');
const qType = ref('');
const qTag = ref('');
async function refreshList() {
  listBusy.value = true;
  try {
    let arr = await listPrivacyRecords({ limit: 2000 });
    if (qFrom.value) arr = arr.filter(r => (r.date || '') >= qFrom.value);
    if (qTo.value)   arr = arr.filter(r => (r.date || '') <= qTo.value);
    if (qType.value) arr = arr.filter(r => r.type === qType.value);
    if (qTag.value) {
      const t = qTag.value.trim();
      arr = arr.filter(r => (r.customTags || []).includes(t));
    }
    list.value = arr;
  } catch (e) { toast('列表加载失败：' + e.message, 'error'); }
  finally { listBusy.value = false; }
}
const previewRec = ref(null);
function openPreview(r) { previewRec.value = r; }

// —— 人物画像报告（纯启发式本地算法 + 可选 AI 增强）——
const reportRange = ref(7);
const reportBusy = ref(false);
const aiBusy = ref(false);
const persona = ref(null);
async function loadPersona() {
  reportBusy.value = true; persona.value = null;
  try {
    persona.value = await privacyPersonaReport({ rangeDays: reportRange.value, includeUserOps: true });
  } catch (e) { toast('画像加载失败：' + e.message, 'error'); }
  finally { reportBusy.value = false; }
}
async function aiEnhanceReport() {
  if (!persona.value) return toast('请先生成一份本地报告再做 AI 增强', 'warn');
  if (!hasAIKey()) return toast('当前未配置 AI 密钥，无法使用 AI 增强。请在 AI 助手页面设置 API Key。', 'warn');
  aiBusy.value = true;
  try {
    const prompt = `你是一位「数字生命画像分析师」。用户系统已生成以下 4 段结构化画像（近 ${persona.value.stats.rangeDays} 天，共 ${persona.value.stats.N} 条个人行为/精神记录）：
【物理画像】\n${persona.value.physical}\n
【行为画像(融合系统操作埋点)】\n${persona.value.behavioral}\n
【精神画像】\n${persona.value.mental}\n
【下一步预测/调节建议(纯文字实验室版)】\n${persona.value.prediction}\n
【统计摘要】N=${persona.value.stats.N} avgSleep=${persona.value.stats.avgSleep} avgMood=${persona.value.stats.avgMood} avgEnergy=${persona.value.stats.avgEnergy} avgStress=${persona.value.stats.avgStress}\n
请在不修改任何系统设置的前提下，输出一份「更有洞察力的增强版调节报告」：
- 用 3 段总结用户的「真实人物肖像」（数字资产画像），
- 给出 7 条"下一步 24 小时"的具体可执行调节建议（不要真的改系统，只输出文字），
- 给出 3 条对下周学习 / 作息 / 社交 / 财务的预测性趋势判断（仅作参考，不承诺准确）。
中文，语气温暖、专业、可执行。`;
    const resp = await chatAI(prompt);
    persona.value.aiEnhanced = resp || '';
    toast('AI 增强报告已生成（仅文字输出，未动系统任何设置）', 'success');
    T.aiCall('privacy_persona_enhance', 0);
  } catch (e) { toast('AI 增强失败：' + e.message, 'error'); }
  finally { aiBusy.value = false; }
}
function copyReport() {
  if (!persona.value) return;
  const txt = `【SxyBrick 隐私数字画像报告 · 近 ${persona.value.stats.rangeDays} 天】\n\n===== 物理画像 =====\n${persona.value.physical}\n\n===== 行为画像 =====\n${persona.value.behavioral}\n\n===== 精神画像 =====\n${persona.value.mental}\n\n===== 预测/调节建议(实验室文字版) =====\n${persona.value.prediction}${persona.value.aiEnhanced ? `\n\n===== AI 增强版调节报告 =====\n${persona.value.aiEnhanced}` : ''}`;
  navigator.clipboard.writeText(txt).then(() => toast('报告已复制到剪贴板', 'success')).catch(() => toast('复制失败，请手动复制', 'warn'));
}

// —— 一天时间段快捷预填（8 个典型片段）
const QUICK_SLOTS = [
  { key: 'morning',   label: '🌅 清晨时段',    start: '07:00', end: '09:00', recommend: 'eat/早餐' },
  { key: 'morningStudy',label:'📚 上午学习',   start: '09:00', end: '12:00', recommend: 'learn/复习卡片' },
  { key: 'noon',      label: '🌤️ 午间',         start: '12:00', end: '13:30', recommend: 'eat/午餐 + sleep/小憩' },
  { key: 'afternoon', label: '💼 下午工作',     start: '13:30', end: '18:00', recommend: 'work/深度工作' },
  { key: 'evening',   label: '🏃 晚间运动',     start: '18:00', end: '19:30', recommend: 'move/有氧' },
  { key: 'dinner',    label: '🍽️ 晚餐',         start: '19:30', end: '20:30', recommend: 'eat/晚餐' },
  { key: 'night',     label: '🌙 夜学习/复盘',   start: '20:30', end: '22:30', recommend: 'learn/错题复盘 + mental/每日总结' },
  { key: 'nightSleep',label: '😴 睡眠',          start: '23:00', end: '07:00', recommend: 'sleep/整晚' },
];
function applySlot(slot) {
  form.startTime = slot.start;
  if (slot.end < slot.start) {
    // 跨午夜：日期不变只填时间段，具体跨天由用户自选（避免误改 date）
    form.endTime = slot.end;
  } else form.endTime = slot.end;
  // 推荐 type/subType：如果 subType 在枚举则直接用
  const [t, s] = (slot.recommend || '').split('/');
  if (t) {
    const opt = TYPE_OPTIONS.find(o => o.id === t);
    if (opt) { form.type = t; ensureBlocksForType(); if (s) form.subType = opt.sub.includes(s) ? s : (form.subType || s); }
  }
  toast(`已填时间段：${slot.start} ~ ${slot.end}`, 'success');
}

// —— 快速填"现在 1 小时"按钮
function fillNow1h() {
  form.date = todayISO();
  form.startTime = nowHHMM();
  const d = new Date(Date.now() + 3600000);
  form.endTime = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

onMounted(() => { refreshList(); });

// 列表分组（按日期）
const listGrouped = computed(() => {
  const g = new Map();
  for (const r of list.value) {
    if (!g.has(r.date)) g.set(r.date, []);
    g.get(r.date).push(r);
  }
  return [...g.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([d, rows]) => ({
    date: d,
    rows: rows.slice().sort((a, b) => (a.startTime || 0) - (b.startTime || 0)),
  }));
});

// 一些辅助计算
const totalRecordsToday = computed(() => list.value.filter(r => r.date === todayISO()).length);
const allTags = computed(() => {
  const s = new Set();
  for (const r of list.value) for (const t of r.customTags || []) s.add(t);
  return [...s];
});

// 当前类型选中的枚举对象
const currentTypeOpt = computed(() => TYPE_OPTIONS.find(t => t.id === form.type));
const currentSubOpts = computed(() => currentTypeOpt.value ? currentTypeOpt.value.sub : []);

function fmtRange(ts1, ts2) {
  if (!ts1 || !ts2) return '';
  let mins = Math.round((ts2 - ts1) / 60000);
  if (mins < 0) mins += 24 * 60; // 跨午夜按 +1 天算
  if (mins < 60) return `${mins} 分钟`;
  return `${(mins / 60).toFixed(1)} 小时`;
}

// 快捷：1-5 评分条
function ScoreRow({ label, model, modelKey, max = 5, low, high }) {}
</script>

<template>
  <div class="pv-root">
    <header class="pv-head">
      <div>
        <h2 style="margin:0">🧾 人生隐私数据 · 超级监控（B档详尽版）</h2>
        <p class="hint" style="margin:4px 0 0">
          把你每一天的物理行为 + 精神心得按"时间段 · 结构化块"详细录入，从 1 天 → 1 周 → 1 月 → 1 年，
          刻画真实的人物数字肖像。所有记录都在本地 IndexedDB，可跨设备同步、可导出 JSON+CSV、可一键清空。
        </p>
      </div>
      <div class="tab-row">
        <button class="chip" :class="{ on: tab === 'form' }" @click="tab = 'form'">📝 记录</button>
        <button class="chip" :class="{ on: tab === 'list' }" @click="tab = 'list'; refreshList()">
          📚 列表<span class="chip-n">{{ list.length }}</span>
        </button>
        <button class="chip" :class="{ on: tab === 'report' }" @click="tab = 'report'; loadPersona()">🔮 画像报告</button>
        <button class="btn small" @click="router.push('/export')">📤 导出 JSON+CSV</button>
      </div>
    </header>

    <!-- ====== 记录表单 ====== -->
    <div v-if="tab === 'form'" class="panel">
      <div class="row" style="justify-content:space-between">
        <div class="row" style="margin-bottom:0">
          <span class="field-label" style="margin:0">今天共记录</span>
          <b style="color:var(--accent)">{{ totalRecordsToday }} 段</b>
          <button class="chip" @click="fillNow1h">⏱ 填入 现在 + 1 小时</button>
        </div>
        <div class="row" style="margin-bottom:0">
          <button v-if="editingId" class="chip" @click="resetForm()">🔁 清空 / 新建</button>
          <button class="btn primary" :disabled="saving" @click="saveCurrent">
            {{ saving ? '保存中…' : (editingId ? '✓ 更新记录' : '💾 记录这一段') }}
          </button>
        </div>
      </div>

      <!-- 8 个典型时间段快捷预填 -->
      <div class="slot-bar">
        <div class="field-label" style="margin:0 8px 0 0">快速时间段</div>
        <button v-for="s in QUICK_SLOTS" :key="s.key" class="slot-chip" @click="applySlot(s)">
          {{ s.label }}<em>{{ s.start }}-{{ s.end }}</em>
        </button>
      </div>

      <!-- 基础：日期 / 时间 / 类型 / 子类型 / 地点 / 人物 -->
      <section class="sec">
        <h4 class="sec-h">🗓 基础元信息</h4>
        <div class="grid3">
          <label class="inp">
            <span>日期</span>
            <input type="date" class="input" v-model="form.date" />
          </label>
          <label class="inp">
            <span>开始时间</span>
            <input type="time" class="input" v-model="form.startTime" />
          </label>
          <label class="inp">
            <span>结束时间</span>
            <input type="time" class="input" v-model="form.endTime" />
          </label>
          <label class="inp span2">
            <span>主类型</span>
            <select class="input" v-model="form.type" @change="ensureBlocksForType()">
              <option v-for="t in TYPE_OPTIONS" :key="t.id" :value="t.id">{{ t.label }}</option>
            </select>
          </label>
          <label class="inp">
            <span>子类型</span>
            <select v-if="currentSubOpts.length" class="input" v-model="form.subType">
              <option v-for="s in currentSubOpts" :key="s" :value="s">{{ s }}</option>
            </select>
            <input v-else class="input" v-model="form.subType" placeholder="自填子类型" />
          </label>
          <label class="inp span2">
            <span>地点</span>
            <input class="input" v-model="form.location" placeholder="例：家 / 公司 / 图书馆 / 地铁" />
          </label>
          <label class="inp span3">
            <span>相关人物（回车添加）</span>
            <div class="tag-input-row">
              <input class="input" v-model="peopleInput" @keydown.enter.prevent="addPeople" placeholder="例：妈妈 / 同学A / 导师" />
              <button class="chip" @click="addPeople">+ 人物</button>
            </div>
            <div class="tag-list" v-if="form.people.length">
              <span v-for="p in form.people" :key="p" class="tag-pill" @click="removePeople(p)">👤 {{ p }} ×</span>
            </div>
          </label>
        </div>
      </section>

      <!-- 情绪 6 维 -->
      <section class="sec">
        <h4 class="sec-h">🌈 精神物理 6 维评分</h4>
        <div class="grid6">
          <div class="score-card"><div class="sc-head">心情 mood</div><score-slider v-model="form.mood" :low="'低落'" :high="'兴奋'" /><div class="sc-v">{{ form.mood }} / 5</div></div>
          <div class="score-card"><div class="sc-head">能量 energy</div><score-slider v-model="form.energy" :low="'倦怠'" :high="'满血'" /><div class="sc-v">{{ form.energy }} / 5</div></div>
          <div class="score-card"><div class="sc-head">专注 focus</div><score-slider v-model="form.focus" :low="'涣散'" :high="'心流'" /><div class="sc-v">{{ form.focus }} / 5</div></div>
          <div class="score-card"><div class="sc-head">愉悦 pleasure</div><score-slider v-model="form.pleasure" :low="'压抑'" :high="'狂喜'" /><div class="sc-v">{{ form.pleasure }} / 5</div></div>
          <div class="score-card"><div class="sc-head">压力 stress</div><score-slider v-model="form.stress" :low="'松弛'" :high="'过载'" /><div class="sc-v">{{ form.stress }} / 5</div></div>
          <div class="score-card">
            <div class="sc-head">疼痛 pain</div>
            <input type="range" min="0" max="10" step="1" v-model.number="form.painIndex" />
            <div class="sc-v">疼痛指数 {{ form.painIndex }} / 10</div>
            <div class="tag-input-row" style="margin-top:4px">
              <input class="input" v-model="painInput" @keydown.enter.prevent="addPain" placeholder="例：肩颈 / 腰部 / 左膝" />
              <button class="chip" @click="addPain">+ 部位</button>
            </div>
            <div class="tag-list" v-if="form.painParts.length">
              <span v-for="p in form.painParts" :key="p" class="tag-pill" @click="removePain(p)">💊 {{ p }} ×</span>
            </div>
          </div>
        </div>
      </section>

      <!-- 锦衣卫级情绪/精神扩展 -->
      <section class="sec">
        <h4 class="sec-h">🎭 情绪 / 精神深度评估（锦衣卫级）</h4>
        <div class="grid6">
          <div class="score-card"><div class="sc-head">焦虑 anxiety</div><score-slider v-model="form.anxiety" :low="'平静'" :high="'惊恐'" /><div class="sc-v">{{ form.anxiety }} / 5</div></div>
          <div class="score-card"><div class="sc-head">抑郁 depression</div><score-slider v-model="form.depression" :low="'开朗'" :high="'沉郁'" /><div class="sc-v">{{ form.depression }} / 5</div></div>
          <div class="score-card"><div class="sc-head">自信 confidence</div><score-slider v-model="form.confidence" :low="'自弃'" :high="'笃定'" /><div class="sc-v">{{ form.confidence }} / 5</div></div>
          <div class="score-card" style="grid-column:span 2">
            <div class="sc-head">压力源 stressSource</div>
            <input class="input" v-model="form.stressSource" placeholder="例：考试 / 人际 / 经济 / 健康" />
            <div class="sc-v">文字描述</div>
          </div>
        </div>
      </section>

      <!-- 专用块：按 type 条件渲染 -->
      <section v-if="form.type === 'sleep' && form.sleepBlock" class="sec">
        <h4 class="sec-h">😴 睡眠专属指标</h4>
        <div class="grid4">
          <label class="inp"><span>时长 (小时)</span><input type="number" step="0.1" min="0" max="24" class="input" v-model.number="form.sleepBlock.hours" /></label>
          <label class="inp"><span>入睡时间</span><input type="time" class="input" v-model="form.sleepBlock.bedTime" /></label>
          <label class="inp"><span>起床时间</span><input type="time" class="input" v-model="form.sleepBlock.wakeTime" /></label>
          <label class="inp"><span>入睡 latency (分)</span><input type="number" min="0" class="input" v-model.number="form.sleepBlock.sleepLatency" placeholder="躺下到睡着" /></label>
          <label class="inp"><span>午休时长 (分)</span><input type="number" min="0" class="input" v-model.number="form.sleepBlock.napMinutes" /></label>
          <label class="inp"><span>质量 (1~5)</span><input type="range" min="1" max="5" v-model.number="form.sleepBlock.quality" /><div class="sc-v" style="text-align:center">{{ form.sleepBlock.quality }}</div></label>
          <label class="inp"><span>夜醒次数</span><input type="number" min="0" class="input" v-model.number="form.sleepBlock.wakeCount" /></label>
          <label class="inp"><span>浅睡(分钟)</span><input type="number" min="0" class="input" v-model.number="form.sleepBlock.lightMinutes" /></label>
          <label class="inp"><span>深睡(分钟)</span><input type="number" min="0" class="input" v-model.number="form.sleepBlock.deepMinutes" /></label>
          <label class="inp"><span>REM(分钟)</span><input type="number" min="0" class="input" v-model.number="form.sleepBlock.remMinutes" /></label>
          <label class="inp"><span>打鼾 (0-10)</span><input type="range" min="0" max="10" v-model.number="form.sleepBlock.snore" /><div class="sc-v" style="text-align:center">{{ form.sleepBlock.snore }}</div></label>
          <label class="inp"><span>干扰因素</span><input class="input" v-model="form.sleepBlock.interruptions" placeholder="例：噪音 / 咖啡因 / 小孩哭闹" /></label>
        </div>
      </section>

      <section v-if="form.type === 'eat' && form.eatBlock" class="sec">
        <h4 class="sec-h">🍽️ 饮食 / 营养</h4>
        <div class="grid4">
          <label class="inp"><span>总热量 (kcal)</span><input type="number" min="0" class="input" v-model.number="form.eatBlock.calories" /></label>
          <label class="inp"><span>用餐次数</span><input type="number" min="0" class="input" v-model.number="form.eatBlock.mealCount" /></label>
          <label class="inp"><span>蛋白质 (g)</span><input type="number" min="0" class="input" v-model.number="form.eatBlock.protein_g" /></label>
          <label class="inp"><span>碳水 (g)</span><input type="number" min="0" class="input" v-model.number="form.eatBlock.carbs_g" /></label>
          <label class="inp"><span>脂肪 (g)</span><input type="number" min="0" class="input" v-model.number="form.eatBlock.fat_g" /></label>
          <label class="inp"><span>糖分 (g)</span><input type="number" min="0" step="0.1" class="input" v-model.number="form.eatBlock.sugar_g" /></label>
          <label class="inp"><span>盐分 (g)</span><input type="number" min="0" step="0.1" class="input" v-model.number="form.eatBlock.salt_g" /></label>
          <label class="inp"><span>纤维 (g)</span><input type="number" min="0" step="0.1" class="input" v-model.number="form.eatBlock.fiber_g" /></label>
          <label class="inp"><span>饮水 (ml)</span><input type="number" min="0" class="input" v-model.number="form.eatBlock.water_ml" /></label>
          <label class="inp"><span>咖啡因 (mg)</span><input type="number" min="0" class="input" v-model.number="form.eatBlock.caffeineMg" /></label>
          <label class="inp span2"><span>酒精 (ml)</span><input type="number" min="0" class="input" v-model.number="form.eatBlock.alcohol_ml" /></label>
          <label class="inp span4"><span>备注</span><input class="input" v-model="form.eatBlock.notes" placeholder="例：外食偏油，蔬菜偏少" /></label>
        </div>
        <div class="tbl" style="margin-top:10px">
          <div class="tbl-head" style="grid-template-columns: 1fr 100px 110px 80px"><span>餐次名称</span><span>估计 kcal</span><span>份量</span><span></span></div>
          <div v-for="(m, i) in form.eatBlock.meals" :key="i" class="tbl-row" style="grid-template-columns: 1fr 100px 110px 80px">
            <input class="input" v-model="m.name" placeholder="例：午餐·鸡腿饭" />
            <input class="input" type="number" min="0" v-model.number="m.kcal" />
            <select class="input" v-model="m.portion">
              <option v-for="p in ['小碗','中碗','大碗','小份','中份','大份','两口','一盘']" :key="p" :value="p">{{ p }}</option>
            </select>
            <button class="chip" @click="delMeal(i)">删除</button>
          </div>
          <button class="chip" @click="addMeal">+ 餐次</button>
        </div>
      </section>

      <section v-if="form.type === 'move' && form.moveBlock" class="sec">
        <h4 class="sec-h">🏃 运动 / 体能</h4>
        <div class="grid4">
          <label class="inp"><span>类型</span>
            <select class="input" v-model="form.moveBlock.kind">
              <option v-for="k in ['有氧','力量','拉伸','瑜伽','球类','户外徒步','通勤运动','康复训练']" :key="k" :value="k">{{ k }}</option>
            </select>
          </label>
          <label class="inp"><span>时长 (分钟)</span><input type="number" min="0" class="input" v-model.number="form.moveBlock.minutes" /></label>
          <label class="inp"><span>平均心率</span><input type="number" min="0" class="input" v-model.number="form.moveBlock.heartRateAvg" /></label>
          <label class="inp"><span>最高心率</span><input type="number" min="0" class="input" v-model.number="form.moveBlock.heartRateMax" /></label>
          <label class="inp"><span>步数</span><input type="number" min="0" class="input" v-model.number="form.moveBlock.steps" /></label>
          <label class="inp"><span>距离 (km)</span><input type="number" step="0.1" min="0" class="input" v-model.number="form.moveBlock.distanceKm" /></label>
          <label class="inp"><span>消耗 kcal</span><input type="number" min="0" class="input" v-model.number="form.moveBlock.calories" /></label>
          <label class="inp span4"><span>心率分区 Z1-Z5（分钟，可留空）</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <input v-for="n in 5" :key="n" type="number" min="0" class="input" style="width:60px" v-model.number="form.moveBlock.hrZone[n-1]" :placeholder="`Z${n}`" />
            </div>
          </label>
          <label class="inp span4"><span>备注</span><input class="input" v-model="form.moveBlock.notes" /></label>
        </div>
      </section>

      <section v-if="form.type === 'learn' && form.learnBlock" class="sec">
        <h4 class="sec-h">📖 学习（深度联动卡片系统）</h4>
        <div class="grid4">
          <label class="inp"><span>科目</span><input class="input" v-model="form.learnBlock.subject" /></label>
          <label class="inp"><span>专题 / 知识点</span><input class="input" v-model="form.learnBlock.topic" /></label>
          <label class="inp"><span>材料来源</span><input class="input" v-model="form.learnBlock.source" placeholder="课本 / MOOC / 教程 / SxyBrick" /></label>
          <label class="inp"><span>时长 (分钟)</span><input type="number" min="0" class="input" v-model.number="form.learnBlock.minutes" /></label>
          <label class="inp"><span>深度专注 (分)</span><input type="number" min="0" class="input" v-model.number="form.learnBlock.deepFocusMinutes" /></label>
          <label class="inp"><span>专注效率 (1-5)</span><input type="range" min="1" max="5" v-model.number="form.learnBlock.focusEfficiency" /><div class="sc-v" style="text-align:center">{{ form.learnBlock.focusEfficiency }}</div></label>
          <label class="inp"><span>打断次数</span><input type="number" min="0" class="input" v-model.number="form.learnBlock.interruptions" /></label>
          <label class="inp"><span>复习卡片数</span><input type="number" min="0" class="input" v-model.number="form.learnBlock.cards_reviewed" /></label>
          <label class="inp"><span>新卡数</span><input type="number" min="0" class="input" v-model.number="form.learnBlock.cards_new" /></label>
          <label class="inp"><span>掌握卡片</span><input type="number" min="0" class="input" v-model.number="form.learnBlock.cards_mastered" /></label>
          <label class="inp"><span>AI 调用次</span><input type="number" min="0" class="input" v-model.number="form.learnBlock.aiCalls" /></label>
          <label class="inp span4"><span>打断原因（回车添加，chip 模式）</span>
            <div class="tag-input-row">
              <input class="input" v-model="learnInterruptInput" @keydown.enter.prevent="addLearnInterrupt" placeholder="例：手机消息 / 同学问问题 / 突发会议" />
              <button class="chip" @click="addLearnInterrupt">+ 原因</button>
            </div>
            <div class="tag-list" v-if="form.learnBlock.interruptReasons.length">
              <span v-for="(r, i) in form.learnBlock.interruptReasons" :key="i" class="tag-pill" @click="delLearnInterrupt(i)">⚠ {{ r }} ×</span>
            </div>
          </label>
        </div>
        <div class="pair-rows">
          <div class="pair-col">
            <div class="field-label">目标</div>
            <div v-for="(_, i) in form.learnBlock.goals" :key="'g'+i" class="tag-input-row">
              <input class="input" v-model="form.learnBlock.goals[i]" />
              <button class="chip" @click="delStringArrItem('goals', form.learnBlock, i)">-</button>
            </div>
            <button class="chip" @click="addStringArrItem('goals', form.learnBlock)">+ 目标</button>
          </div>
          <div class="pair-col">
            <div class="field-label">成果 / 产出</div>
            <div v-for="(_, i) in form.learnBlock.outcomes" :key="'o'+i" class="tag-input-row">
              <input class="input" v-model="form.learnBlock.outcomes[i]" />
              <button class="chip" @click="delStringArrItem('outcomes', form.learnBlock, i)">-</button>
            </div>
            <button class="chip" @click="addStringArrItem('outcomes', form.learnBlock)">+ 成果</button>
          </div>
        </div>
        <label class="inp span4" style="margin-top:10px"><span>备注</span><input class="input" v-model="form.learnBlock.notes" /></label>
      </section>

      <section v-if="form.type === 'work' && form.workBlock" class="sec">
        <h4 class="sec-h">💼 工作</h4>
        <div class="grid4">
          <label class="inp"><span>项目</span><input class="input" v-model="form.workBlock.project" /></label>
          <label class="inp"><span>角色</span><input class="input" v-model="form.workBlock.role" /></label>
          <label class="inp"><span>总时长 (分)</span><input type="number" min="0" class="input" v-model.number="form.workBlock.minutes" /></label>
          <label class="inp"><span>深度 (分)</span><input type="number" min="0" class="input" v-model.number="form.workBlock.deepMinutes" /></label>
          <label class="inp"><span>会议数</span><input type="number" min="0" class="input" v-model.number="form.workBlock.meetings" /></label>
          <label class="inp"><span>满意度 (1-5)</span><input type="range" min="1" max="5" v-model.number="form.workBlock.satisfaction" /><div class="sc-v" style="text-align:center">{{ form.workBlock.satisfaction }}</div></label>
        </div>
        <div class="pair-rows">
          <div class="pair-col">
            <div class="field-label">关键决策</div>
            <div v-for="(_, i) in form.workBlock.decisions" :key="'wd'+i" class="tag-input-row">
              <input class="input" v-model="form.workBlock.decisions[i]" />
              <button class="chip" @click="delStringArrItem('decisions', form.workBlock, i)">-</button>
            </div>
            <button class="chip" @click="addStringArrItem('decisions', form.workBlock)">+ 决策</button>
          </div>
          <div class="pair-col">
            <div class="field-label">交付物</div>
            <div v-for="(_, i) in form.workBlock.deliverables" :key="'wv'+i" class="tag-input-row">
              <input class="input" v-model="form.workBlock.deliverables[i]" />
              <button class="chip" @click="delStringArrItem('deliverables', form.workBlock, i)">-</button>
            </div>
            <button class="chip" @click="addStringArrItem('deliverables', form.workBlock)">+ 交付</button>
          </div>
        </div>
        <label class="inp span4" style="margin-top:10px"><span>备注</span><input class="input" v-model="form.workBlock.notes" /></label>
      </section>

      <section v-if="form.type === 'screen' && form.screenBlock" class="sec">
        <h4 class="sec-h">📱 屏幕时间</h4>
        <div class="grid4">
          <label class="inp"><span>设备</span>
            <select class="input" v-model="form.screenBlock.device">
              <option v-for="k in ['手机','电脑','平板','电视','游戏机','其它']" :key="k" :value="k">{{ k }}</option>
            </select>
          </label>
          <label class="inp"><span>总时长 (分)</span><input type="number" min="0" class="input" v-model.number="form.screenBlock.totalMin" /></label>
          <label class="inp"><span>蓝光减免(0-10)</span><input type="range" min="0" max="10" v-model.number="form.screenBlock.blueLightReduced" /><div class="sc-v" style="text-align:center">{{ form.screenBlock.blueLightReduced }}</div></label>
          <label class="inp"><span>护眼次</span><input type="number" min="0" class="input" v-model.number="form.screenBlock.eyeBreak" /></label>
        </div>
        <div class="tbl" style="margin-top:10px">
          <div class="tbl-head"><span>App / 用途</span><span>分钟</span><span></span></div>
          <div v-for="(a, i) in form.screenBlock.appMinutes" :key="i" class="tbl-row">
            <input class="input" v-model="a.app" placeholder="例：Bilibili / 微信 / IDE" />
            <input class="input" type="number" min="0" v-model.number="a.min" />
            <button class="chip" @click="delAppMin(i)">删除</button>
          </div>
          <button class="chip" @click="addAppMin">+ App 明细</button>
        </div>
        <label class="inp span4" style="margin-top:10px"><span>备注</span><input class="input" v-model="form.screenBlock.notes" /></label>
      </section>

      <section v-if="form.type === 'finance' && form.financeBlock" class="sec">
        <h4 class="sec-h">💰 财务</h4>
        <div class="grid4">
          <label class="inp"><span>币种</span><input class="input" v-model="form.financeBlock.currency" /></label>
          <label class="inp"><span>收入</span><input type="number" class="input" v-model.number="form.financeBlock.income" /></label>
          <label class="inp"><span>支出</span><input type="number" class="input" v-model.number="form.financeBlock.expense" /></label>
          <label class="inp"><span>净变动</span><input type="number" class="input" v-model.number="form.financeBlock.delta" /></label>
          <label class="inp"><span>账户</span><input class="input" v-model="form.financeBlock.account" placeholder="银行卡 / 支付宝 / 现金" /></label>
          <label class="inp span3"><span>分类</span><input class="input" v-model="form.financeBlock.category" placeholder="房租 / 餐饮 / 投资 / 捐赠" /></label>
          <label class="inp span4"><span>备注</span><input class="input" v-model="form.financeBlock.notes" /></label>
        </div>
      </section>

      <section v-if="(form.type === 'excrete' || form.type === 'other') && form.excreteBlock" class="sec">
        <h4 class="sec-h">🚽 排泄监控（锦衣卫级 · Bristol 量表）</h4>
        <div class="grid4">
          <label class="inp"><span>小便次数</span><input type="number" min="0" class="input" v-model.number="form.excreteBlock.urineCount" /></label>
          <label class="inp"><span>大便次数</span><input type="number" min="0" class="input" v-model.number="form.excreteBlock.bowelCount" /></label>
          <label class="inp span2"><span>大便形状 (Bristol 1-7)</span>
            <select class="input" v-model.number="form.excreteBlock.stoolForm">
              <option v-for="b in BRISTOL_SCALE" :key="b.v" :value="b.v">{{ b.label }}</option>
            </select>
            <div class="sc-v">当前 {{ form.excreteBlock.stoolForm }} · {{ BRISTOL_SCALE.find(b => b.v === form.excreteBlock.stoolForm)?.label || '' }}</div>
          </label>
          <label class="inp"><span>血尿</span>
            <div style="display:flex;align-items:center;gap:6px">
              <input type="checkbox" v-model="form.excreteBlock.bloodUrine" />
              <span>{{ form.excreteBlock.bloodUrine ? '有' : '无' }}</span>
            </div>
          </label>
          <label class="inp"><span>血便</span>
            <div style="display:flex;align-items:center;gap:6px">
              <input type="checkbox" v-model="form.excreteBlock.bloodStool" />
              <span>{{ form.excreteBlock.bloodStool ? '有' : '无' }}</span>
            </div>
          </label>
          <label class="inp span4"><span>备注</span><input class="input" v-model="form.excreteBlock.notes" placeholder="例：夜尿频繁 / 腹泻伴绞痛 / 便秘 3 天" /></label>
        </div>
      </section>

      <!-- 心得 / 精神 -->
      <section class="sec">
        <h4 class="sec-h">🧠 精神 / 心得体会（Markdown 富文本）</h4>
        <textarea class="input" rows="8" v-model="form.mental" placeholder="今天发生了什么？想到什么？想感谢谁？情绪/压力/反思/灵感... Markdown 渲染"></textarea>
        <div v-if="form.mental" style="margin-top:8px;padding:10px;border:1px dashed var(--line);border-radius:8px;background:var(--code-inline)">
          <div class="field-label" style="margin:0 0 4px">预览</div>
          <MarkdownRenderer :content="form.mental" />
        </div>
      </section>

      <!-- 自定义 KV + 标签 -->
      <section class="sec">
        <h4 class="sec-h">🏷️ 自定义标签 + KV 元数据</h4>
        <div class="pair-rows">
          <div class="pair-col">
            <div class="field-label">自定义标签</div>
            <div class="tag-input-row">
              <input class="input" v-model="tagInput" @keydown.enter.prevent="addTag" placeholder="例：#周一日 #情绪低谷 #恋爱" />
              <button class="chip" @click="addTag">+ 标签</button>
            </div>
            <div class="tag-list" v-if="form.customTags.length">
              <span v-for="t in form.customTags" :key="t" class="tag-pill" @click="removeTag(t)">#{{ t }} ×</span>
            </div>
          </div>
          <div class="pair-col">
            <div class="field-label">自定义 KV（最多 8 组，用于未来 AI 画像）</div>
            <div v-for="(kv, i) in form.customKV" :key="i" class="tag-input-row">
              <input class="input" v-model="kv.k" placeholder="键（例：体重kg）" style="max-width:140px" />
              <input class="input" v-model="kv.v" placeholder="值" />
              <button class="chip" @click="removeKV(i)">-</button>
            </div>
            <button class="chip" @click="addKV">+ KV</button>
          </div>
        </div>
      </section>
    </div>

    <!-- ====== 列表浏览 ====== -->
    <div v-if="tab === 'list'" class="panel">
      <div class="row" style="justify-content:space-between;gap:10px">
        <div class="row" style="margin-bottom:0;gap:6px">
          <input type="date" class="input" style="width:auto" v-model="qFrom" placeholder="起始日" />
          <span>~</span>
          <input type="date" class="input" style="width:auto" v-model="qTo" placeholder="结束日" />
          <select class="input" style="width:auto" v-model="qType">
            <option value="">全部类型</option>
            <option v-for="t in TYPE_OPTIONS" :key="t.id" :value="t.id">{{ t.label }}</option>
          </select>
          <input class="input" style="max-width:180px" v-model="qTag" placeholder="标签筛选（已有：{{ allTags.join('、') || '无' }}）" />
          <button class="chip" @click="refreshList">{{ listBusy ? '刷新中…' : '🔍 筛选' }}</button>
        </div>
        <button class="btn small" @click="tab = 'form'">+ 新增记录</button>
      </div>

      <div v-if="listBusy" class="hint" style="padding:20px;text-align:center">载入中…</div>
      <div v-else-if="!listGrouped.length" class="hint" style="padding:30px;text-align:center">
        暂无记录。试试切换到「📝 记录」填第一段，或者放开日期筛选。
      </div>
      <div v-else class="days-list">
        <div v-for="g in listGrouped" :key="g.date" class="day-group">
          <div class="day-head">
            <span class="day-date">📅 {{ g.date }}</span>
            <span class="hint">{{ g.rows.length }} 段 · 总时长 {{ g.rows.reduce((s, r) => s + Math.max(0, ((r.endTime||0)-(r.startTime||0))/60000), 0) }} 分钟</span>
          </div>
          <article v-for="r in g.rows" :key="r.id" class="rec-card">
            <div class="rec-left">
              <div class="rec-tl">{{ typeLabel(r.type) }}</div>
              <div class="rec-sub">{{ r.subType || '—' }}</div>
              <div class="rec-time">
                {{ new Date(r.startTime || 0).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) }}
                ~ {{ new Date(r.endTime || 0).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) }}
                <em>（{{ fmtRange(r.startTime, r.endTime) }}）</em>
              </div>
              <div class="rec-moodrow" v-if="r.mood || r.energy || r.stress || r.painIndex">
                <span class="pill" :class="'lv'+r.mood"   title="心情">mood {{ r.mood }}</span>
                <span class="pill" :class="'lv'+r.energy" title="能量">energy {{ r.energy }}</span>
                <span class="pill" :class="'lv'+(6-Math.min(5,r.stress))" title="压力">stress {{ r.stress }}</span>
                <span v-if="r.painIndex" class="pill pain">pain {{ r.painIndex }}</span>
              </div>
              <div class="rec-chips" v-if="(r.customTags && r.customTags.length) || r.location || (r.people && r.people.length)">
                <span v-if="r.location" class="tag-pill">📍 {{ r.location }}</span>
                <span v-for="p in r.people" :key="p" class="tag-pill">👤 {{ p }}</span>
                <span v-for="t in r.customTags" :key="t" class="tag-pill">#{{ t }}</span>
              </div>
            </div>
            <div class="rec-right">
              <div class="rec-mental-snip" v-if="r.mental">{{ String(r.mental).slice(0, 80) }}{{ r.mental.length > 80 ? '…' : '' }}</div>
              <div class="rec-actions">
                <button class="chip" @click="openPreview(r)">👁 详情</button>
                <button class="chip" @click="editRec(r.id)">✏️ 编辑</button>
                <button class="chip danger" @click="delRec(r.id)">🗑</button>
              </div>
            </div>
          </article>
        </div>
      </div>
    </div>

    <!-- ====== 画像报告 ====== -->
    <div v-if="tab === 'report'" class="panel">
      <div class="row" style="justify-content:space-between">
        <div class="row" style="margin-bottom:0">
          <span class="field-label" style="margin:0">画像周期</span>
          <button v-for="r in [7,14,30,90]" :key="r" class="chip" :class="{ on: reportRange === r }" @click="reportRange = r; loadPersona()">近 {{ r }} 天</button>
          <button class="btn small" :disabled="reportBusy" @click="loadPersona">🔄 刷新报告</button>
        </div>
        <div class="row" style="margin-bottom:0">
          <button class="btn small" :disabled="aiBusy || !persona" @click="aiEnhanceReport">
            {{ aiBusy ? 'AI 生成中…' : '🤖 AI 增强版调节（仅文字）' }}
          </button>
          <button class="btn small" :disabled="!persona" @click="copyReport">📋 复制完整报告</button>
        </div>
      </div>
      <div v-if="reportBusy" class="hint" style="padding:20px;text-align:center">正在结合 userOps + privacyRecords 生成画像…</div>
      <div v-else-if="!persona" class="hint" style="padding:20px;text-align:center">请先点「🔄 刷新报告」。</div>
      <div v-else class="report-body">
        <div class="report-stats">
          <div><span>记录数</span><b>{{ persona.stats.N }}</b></div>
          <div><span>平均睡眠</span><b>{{ persona.stats.avgSleep != null ? persona.stats.avgSleep.toFixed(1) + 'h' : '—' }}</b></div>
          <div><span>平均心情</span><b>{{ persona.stats.avgMood != null ? persona.stats.avgMood.toFixed(1) + '/5' : '—' }}</b></div>
          <div><span>平均能量</span><b>{{ persona.stats.avgEnergy != null ? persona.stats.avgEnergy.toFixed(1) + '/5' : '—' }}</b></div>
          <div><span>平均压力</span><b>{{ persona.stats.avgStress != null ? persona.stats.avgStress.toFixed(1) + '/5' : '—' }}</b></div>
        </div>
        <div class="report-grid">
          <section class="report-sec">
            <h5>🌿 物理画像</h5>
            <pre class="pre-wrap">{{ persona.physical }}</pre>
          </section>
          <section class="report-sec">
            <h5>🧭 行为画像（融合系统真实操作埋点）</h5>
            <pre class="pre-wrap">{{ persona.behavioral }}</pre>
          </section>
          <section class="report-sec">
            <h5>🧘 情绪 / 精神画像</h5>
            <pre class="pre-wrap">{{ persona.mental }}</pre>
          </section>
          <section class="report-sec highlight">
            <h5>🔬 下一步预测 / 调节建议（实验室文字版，<u>不改系统</u>）</h5>
            <pre class="pre-wrap">{{ persona.prediction }}</pre>
          </section>
        </div>
        <section v-if="persona.aiEnhanced" class="report-sec ai">
          <h5>🤖 AI 增强版调节报告（仅文字输出 · 数字生命画像分析）</h5>
          <MarkdownRenderer :content="persona.aiEnhanced" />
        </section>
        <div v-else class="hint" style="margin-top:8px">
          💡 若希望 AI 基于上面的"结构化画像"给出更有洞察力的建议，可点击右上角「🤖 AI 增强版调节」。
          输出为纯文字报告，不会真的修改系统任何设置或调度。
        </div>
      </div>
    </div>

    <!-- 详情预览弹窗 -->
    <teleport to="body">
      <div v-if="previewRec" class="modal-mask" @click.self="previewRec = null">
        <div class="modal" style="max-width:760px">
          <div class="modal-bar" style="margin-bottom:8px">
            <h3 style="margin:0">{{ typeLabel(previewRec.type) }} · {{ previewRec.subType || '' }} · {{ previewRec.date }}</h3>
            <div>
              <button class="btn small" @click="editRec(previewRec.id); previewRec = null">✏️ 编辑</button>
              <button class="btn small" @click="previewRec = null">关闭</button>
            </div>
          </div>
          <div class="pv-detail">
            <div class="pv-d-row"><span>时间段</span><b>{{ new Date(previewRec.startTime||0).toLocaleString() }} ~ {{ new Date(previewRec.endTime||0).toLocaleString() }} ({{ fmtRange(previewRec.startTime, previewRec.endTime) }})</b></div>
            <div class="pv-d-row"><span>地点/人物</span><b>{{ previewRec.location || '—' }}
              <template v-for="p in previewRec.people" :key="p" style="margin-left:6px">👤 {{ p }} </template>
            </b></div>
            <div class="pv-d-row"><span>6 维</span><b>心情{{ previewRec.mood }} 能量{{ previewRec.energy }} 专注{{ previewRec.focus }} 愉悦{{ previewRec.pleasure }} 压力{{ previewRec.stress }} 疼痛{{ previewRec.painIndex }}{{ previewRec.painParts?.length ? ' ('+previewRec.painParts.join('、')+')' : '' }}</b></div>
            <div class="pv-d-row" v-if="previewRec.anxiety || previewRec.depression || previewRec.confidence || previewRec.stressSource"><span>情绪深度</span><b>焦虑{{ previewRec.anxiety }} 抑郁{{ previewRec.depression }} 自信{{ previewRec.confidence }}{{ previewRec.stressSource ? ' 压力源：'+previewRec.stressSource : '' }}</b></div>
            <details v-if="previewRec.sleepBlock" class="det"><summary>😴 睡眠明细</summary><pre class="pre-wrap">{{ JSON.stringify(previewRec.sleepBlock, null, 2) }}</pre></details>
            <details v-if="previewRec.eatBlock"   class="det"><summary>🍽️ 饮食明细</summary><pre class="pre-wrap">{{ JSON.stringify(previewRec.eatBlock, null, 2) }}</pre></details>
            <details v-if="previewRec.moveBlock"  class="det"><summary>🏃 运动明细</summary><pre class="pre-wrap">{{ JSON.stringify(previewRec.moveBlock, null, 2) }}</pre></details>
            <details v-if="previewRec.learnBlock" class="det"><summary>📖 学习明细</summary><pre class="pre-wrap">{{ JSON.stringify(previewRec.learnBlock, null, 2) }}</pre></details>
            <details v-if="previewRec.workBlock"  class="det"><summary>💼 工作明细</summary><pre class="pre-wrap">{{ JSON.stringify(previewRec.workBlock, null, 2) }}</pre></details>
            <details v-if="previewRec.screenBlock" class="det"><summary>📱 屏幕明细</summary><pre class="pre-wrap">{{ JSON.stringify(previewRec.screenBlock, null, 2) }}</pre></details>
            <details v-if="previewRec.financeBlock" class="det"><summary>💰 财务明细</summary><pre class="pre-wrap">{{ JSON.stringify(previewRec.financeBlock, null, 2) }}</pre></details>
            <details v-if="previewRec.excreteBlock" class="det"><summary>🚽 排泄明细</summary><pre class="pre-wrap">{{ JSON.stringify(previewRec.excreteBlock, null, 2) }}</pre></details>
            <div v-if="previewRec.customTags?.length" class="pv-d-row"><span>自定义标签</span><b v-for="t in previewRec.customTags" :key="t">#{{ t }} </b></div>
            <div v-if="Object.keys(previewRec.customKV||{}).length" class="pv-d-row"><span>自定义 KV</span><b><pre class="pre-wrap">{{ JSON.stringify(previewRec.customKV, null, 2) }}</pre></b></div>
            <div v-if="previewRec.mental" class="pv-d-row"><span>精神/心得</span><b style="font-weight:400;text-align:left;display:block"><MarkdownRenderer :content="previewRec.mental" /></b></div>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.pv-root { padding: 4px 2px 40px; }
.pv-head {
  display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;
  flex-wrap: wrap; margin-bottom: 14px;
}
.tab-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.panel {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 14px 16px; margin-bottom: 14px;
}
.hint { color: var(--ink-2); font-size: 12px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
.chip-n { display:inline-block;margin-left:4px;background:var(--tag-bg);padding:0 6px;border-radius:99px;font-size:10px }

.slot-bar { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 12px 0; padding: 10px; background: var(--code-inline); border-radius: 8px; }
.slot-chip {
  background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 6px 10px;
  font-size: 12px; cursor: pointer; transition: .12s;
}
.slot-chip:hover { border-color: var(--accent); color: var(--accent); }
.slot-chip em { font-style: normal; margin-left: 4px; color: var(--ink-2); font-size: 11px; }

.sec { margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--line); }
.sec-h { margin: 0 0 10px; font-size: 14px; }

.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.grid6 { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
.span2 { grid-column: span 2; }
.span3 { grid-column: span 3; }
.span4 { grid-column: span 4; }
@media (max-width: 900px) {
  .grid3, .grid4 { grid-template-columns: repeat(2, 1fr); }
  .span2, .span3, .span4 { grid-column: span 2; }
}
@media (max-width: 560px) {
  .grid3, .grid4 { grid-template-columns: 1fr; }
  .span2, .span3, .span4 { grid-column: span 1; }
}
.inp { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ink-2); }
.score-card {
  background: var(--code-inline); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px;
  display: flex; flex-direction: column; gap: 4px;
}
.sc-head { font-size: 12px; font-weight: 700; color: var(--accent); }
.sc-v { font-size: 12px; color: var(--ink-2); text-align: right; }
.slider-box { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.slider-labels { display: flex; justify-content: space-between; font-size: 10px; color: var(--ink-2); }

.tag-input-row { display: flex; gap: 6px; align-items: center; }
.tag-list { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.tag-pill {
  background: var(--tag-bg); color: var(--accent); font-size: 12px;
  padding: 3px 10px; border-radius: 999px; cursor: pointer; user-select: none;
}
.tag-pill:hover { background: var(--accent); color: #fff; }

.tbl { display: flex; flex-direction: column; gap: 4px; }
.tbl-head, .tbl-row {
  display: grid; grid-template-columns: 1fr 120px 80px; gap: 6px; align-items: center;
}
.tbl-head { color: var(--ink-2); font-size: 11px; font-weight: 600; padding: 0 2px; }
.pair-rows { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 10px; }
.pair-col { background: var(--code-inline); border-radius: 8px; padding: 8px 10px; }
@media (max-width: 700px) { .pair-rows { grid-template-columns: 1fr; } }

/* 列表 */
.days-list { display: flex; flex-direction: column; gap: 14px; margin-top: 14px; }
.day-group { border-left: 3px solid var(--accent); padding-left: 10px; }
.day-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
.day-date { font-weight: 700; font-size: 14px; }
.rec-card {
  display: grid; grid-template-columns: 1.4fr 1fr; gap: 10px;
  background: var(--code-inline); border-radius: 10px; padding: 10px 12px; margin-bottom: 8px;
}
@media (max-width: 700px) { .rec-card { grid-template-columns: 1fr; } }
.rec-tl { font-size: 15px; font-weight: 700; }
.rec-sub { color: var(--ink-2); font-size: 12px; margin: 2px 0 4px; }
.rec-time { font-size: 12px; color: var(--ink-2); }
.rec-time em { font-style: normal; color: var(--accent); font-weight: 600; margin-left: 4px; }
.rec-moodrow { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
.pill {
  padding: 1px 8px; border-radius: 999px; font-size: 10px; font-weight: 700;
  background: #e5e7eb; color: #374151;
}
.pill.lv1 { background: #fee2e2; color: #991b1b; }
.pill.lv2 { background: #fed7aa; color: #9a3412; }
.pill.lv3 { background: #fef9c3; color: #854d0e; }
.pill.lv4 { background: #bbf7d0; color: #166534; }
.pill.lv5 { background: #bfdbfe; color: #1e40af; }
.pill.pain { background: #fecaca; color: #7f1d1d; }
.rec-chips { margin-top: 6px; display: flex; gap: 4px; flex-wrap: wrap; }
.rec-mental-snip { font-size: 12px; color: var(--ink-2); line-height: 1.6; margin-bottom: 6px; max-height: 60px; overflow: hidden; }
.rec-right { display: flex; flex-direction: column; justify-content: space-between; }
.rec-actions { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.chip.danger { background: #fee2e2; color: #991b1b; }

/* 报告 */
.report-stats {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 12px;
}
.report-stats > div {
  background: var(--code-inline); border: 1px solid var(--line); border-radius: 8px;
  padding: 8px 10px; display: flex; flex-direction: column; gap: 2px;
}
.report-stats span { font-size: 11px; color: var(--ink-2); }
.report-stats b { font-size: 18px; color: var(--accent); }
.report-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
@media (max-width: 800px) { .report-grid { grid-template-columns: 1fr; } }
.report-sec {
  background: var(--code-inline); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px;
}
.report-sec.highlight {
  grid-column: 1 / -1; background: linear-gradient(180deg, #ecfeff, var(--code-inline));
  border-color: #06b6d4;
}
.report-sec.ai {
  margin-top: 10px; grid-column: 1 / -1; background: linear-gradient(180deg, #f5f3ff, var(--code-inline));
  border-color: #8b5cf6;
}
.report-sec h5 { margin: 0 0 6px; font-size: 13px; }
.pre-wrap {
  white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.8; color: var(--ink);
  margin: 0; font-family: inherit;
}

/* 详情 */
.pv-detail { display: flex; flex-direction: column; gap: 8px; }
.pv-d-row {
  display: grid; grid-template-columns: 120px 1fr; gap: 10px; padding: 8px 0;
  border-bottom: 1px dashed var(--line);
}
.pv-d-row > span { font-size: 12px; color: var(--ink-2); }
.pv-d-row > b { font-size: 13px; color: var(--ink); font-weight: 600; word-break: break-word; }
.det { padding: 6px 8px; background: var(--code-inline); border-radius: 6px; margin-top: 6px; }
.det summary { cursor: pointer; font-weight: 600; font-size: 12px; }

/* 设置输入框高度更紧一些 */
.input[type="date"], .input[type="time"], .input[type="number"] { height: 32px; }
</style>
