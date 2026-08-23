<script setup>
// 新建/编辑卡片弹窗：科目(含自定义)、标签自动完成、Markdown 实时预览、
// 图片插入(本地存储)、字数统计(7500 预警 / 8000 上限)、实时校验
import { ref, computed, watch } from 'vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import { toast } from '../utils/toast.js';
import { getSubjects, getTags, createCard, updateCard } from '../repo.js';
import { putImage } from '../images.js';
import { uid } from '../db.js';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  card: { type: Object, default: null },
});
const emit = defineEmits(['update:modelValue', 'saved']);

const MAX = 8000, WARN = 7500, MAX_TAGS = 16;

const subject = ref('');
const customSubject = ref('');
const useCustomSubject = ref(false);
const subjects = ref([]);
const allTags = ref([]);
const tags = ref([]);
const tagInput = ref('');
const source = ref('');
const type = ref('basic');
const showTagSuggest = ref(false);
const front = ref('');
const back = ref('');
const preview = ref(true);
const errors = ref({});
const saving = ref(false);

const frontLen = computed(() => [...front.value].length);
const backLen = computed(() => [...back.value].length);

watch(() => props.modelValue, async (open) => {
  if (!open) return;
  errors.value = {};
  subjects.value = await getSubjects();
  allTags.value = await getTags();
  if (props.card) {
    front.value = props.card.front;
    back.value = props.card.back;
    tags.value = [...(props.card.tags || [])];
    source.value = props.card.source || '';
    type.value = props.card.type || 'basic';
    const known = subjects.value.some(s => s.name === props.card.subject);
    useCustomSubject.value = !!props.card.subject && !known;
    subject.value = known ? props.card.subject : '';
    customSubject.value = known ? '' : props.card.subject;
  } else {
    front.value = ''; back.value = ''; tags.value = []; source.value = ''; type.value = 'basic';
    subject.value = ''; customSubject.value = ''; useCustomSubject.value = false;
    tagInput.value = '';
  }
});

const tagSuggestions = computed(() => {
  const kw = tagInput.value.trim();
  return allTags.value
    .filter(t => !tags.value.includes(t.name) && (!kw || t.name.includes(kw)))
    .slice(0, 8);
});

function addTag(name) {
  const n = String(name).trim();
  if (!n) return;
  if (tags.value.length >= MAX_TAGS) return toast(`标签最多 ${MAX_TAGS} 个`, 'error');
  if (!tags.value.includes(n)) tags.value.push(n);
  tagInput.value = '';
}
function onTagBlur() {
  if (tagInput.value.trim()) addTag(tagInput.value);
  setTimeout(() => { showTagSuggest.value = false; }, 150);
}

function onTagKeydown(e) {
  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput.value); }
  else if (e.key === 'Backspace' && !tagInput.value && tags.value.length) tags.value.pop();
}

function limitField(v) {
  const chars = [...v];
  return chars.length > MAX ? chars.slice(0, MAX).join('') : v;
}

// 图片插入：存本地 IndexedDB，正文里插入 sxy-img:// 引用
async function insertImage(side, file) {
  if (!file || !file.type.startsWith('image/')) return toast('请选择图片文件', 'error');
  try {
    const id = uid();
    await putImage(id, file, file.type);
    const md = `\n![image](sxy-img://${id})\n`;
    if (side === 'front') front.value = limitField(front.value + md);
    else back.value = limitField(back.value + md);
    toast('图片已插入', 'success');
  } catch (e) { toast(e.message, 'error'); }
}
function onPaste(side, e) {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); insertImage(side, item.getAsFile()); }
}

const frontLabel = computed(() => type.value === 'cloze' ? '句子（用 {{答案}} 挖空）' : type.value === 'choice' ? '题干（问题）' : '正面（提示 / 问题）');
const backLabel = computed(() => type.value === 'choice' ? '选项 + 答案' : type.value === 'cloze' ? '解释 / 提示（可选）' : '背面（结论 / 答案）');
const frontPh = computed(() => type.value === 'cloze' ? '把要挖空的位置用 {{答案}} 包起来，例如：CPU 的中文是 {{中央处理器}}' : type.value === 'choice' ? '输入题干，例如：以下哪个不是操作系统？' : '背诵时先看到的提示，支持 Markdown / 公式 / 代码块');
const backPh = computed(() => type.value === 'choice' ? '每行一个选项（A~D），最后一行写答案。例如：\nA. Linux\nB. Windows\nC. Chrome\nD. macOS\n答案：C' : type.value === 'cloze' ? '可选：补充解释或助记，帮助理解' : '翻开要记住的内容，支持 Markdown');

function validate() {
  const errs = {};
  const finalSubject = useCustomSubject.value ? customSubject.value.trim() : subject.value;
  if (useCustomSubject.value && !finalSubject) errs.subject = '请输入自定义科目名称';
  if (useCustomSubject.value && [...finalSubject].length > 30) errs.subject = '科目名称不超过 30 字';
  if (!front.value.trim()) errs.front = '正面内容不能为空';
  if (!back.value.trim()) errs.back = '背面内容不能为空';
  if (frontLen.value > MAX) errs.front = `正面不能超过 ${MAX} 字`;
  if (backLen.value > MAX) errs.back = `背面不能超过 ${MAX} 字`;
  if (tags.value.length > MAX_TAGS) errs.tags = `标签最多 ${MAX_TAGS} 个`;
  errors.value = errs;
  return Object.keys(errs).length === 0;
}

async function save() {
  if (tagInput.value.trim()) addTag(tagInput.value);
  if (!validate()) return;
  saving.value = true;
  try {
    const payload = {
      front: front.value.trim(),
      back: back.value.trim(),
      subject: useCustomSubject.value ? customSubject.value.trim() : subject.value,
      tags: tags.value,
      source: source.value,
      type: type.value,
    };
    if (props.card) await updateCard(props.card.id, payload);
    else await createCard(payload);
    emit('saved');
    emit('update:modelValue', false);
    toast(props.card ? '已保存修改' : '卡片已创建', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally { saving.value = false; }
}

function close() { emit('update:modelValue', false); }
</script>

<template>
  <teleport to="body">
    <div v-if="modelValue" class="modal-mask" @click.self="close">
      <div class="modal">
        <h3>{{ card ? '编辑卡片' : '新建卡片' }}</h3>

        <div class="field-label" style="margin-top:4px">题型</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="chip" :class="{ on: type === 'basic' }" @click="type = 'basic'">正反面</button>
          <button class="chip" :class="{ on: type === 'cloze' }" @click="type = 'cloze'">填空</button>
          <button class="chip" :class="{ on: type === 'choice' }" @click="type = 'choice'">选择</button>
        </div>

        <div class="field-label">科目</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <select v-model="subject" class="input" style="max-width:240px" :disabled="useCustomSubject"
                  @change="useCustomSubject = subject === '__custom__'">
            <option value="">不限科目</option>
            <option v-for="s in subjects" :key="s.name" :value="s.name">{{ s.name }}</option>
            <option value="__custom__">自定义…</option>
          </select>
          <input v-if="useCustomSubject" v-model="customSubject" class="input" style="max-width:240px"
                 placeholder="输入自定义科目" maxlength="30" />
        </div>
        <div v-if="errors.subject" class="hint error">{{ errors.subject }}</div>

        <div class="field-label">来源（可选）</div>
        <input v-model="source" class="input" placeholder="如：计算机网络 第3章 / 某教材 P123" maxlength="60" />

        <div class="field-label">标签（最多 {{ MAX_TAGS }} 个，回车添加）</div>
        <div class="tag-box input" style="position:relative">
          <span v-for="t in tags" :key="t" class="tag-pill" style="margin-right:6px">
            {{ t }} <a style="cursor:pointer" @click="tags = tags.filter(x => x !== t)">×</a>
          </span>
          <input v-model="tagInput" style="border:none;outline:none;flex:1;min-width:120px"
                 placeholder="输入标签，回车添加" @keydown="onTagKeydown"
                 @focus="showTagSuggest = true" @blur="onTagBlur" />
          <div v-if="showTagSuggest && tagSuggestions.length" class="suggest">
            <div v-for="s in tagSuggestions" :key="s.name" class="suggest-item" @mousedown.prevent="addTag(s.name)">
              {{ s.name }} <span class="hint">{{ s.count }}</span>
            </div>
          </div>
        </div>
        <div class="hint" style="margin-top:4px">已用过：
          <a v-for="s in allTags.slice(0, 10)" :key="s.name" class="chip" style="margin:2px" @click="addTag(s.name)">{{ s.name }}</a>
        </div>
        <div v-if="errors.tags" class="hint error">{{ errors.tags }}</div>

        <div class="field-label" style="display:flex;justify-content:space-between;align-items:center">
          <span>{{ frontLabel }}</span>
          <label class="btn small">插入图片<input type="file" accept="image/*" hidden
            @change="insertImage('front', $event.target.files[0]); $event.target.value = ''" /></label>
        </div>
        <textarea v-model="front" class="input" :class="{ invalid: errors.front }" rows="5"
                  :placeholder="frontPh"
                  @input="front = limitField(front)" @paste="onPaste('front', $event)"></textarea>
        <div class="hint" :class="{ warn: frontLen >= WARN, error: frontLen >= MAX }">
          {{ frontLen }} / {{ MAX }} 字<span v-if="frontLen >= WARN && frontLen < MAX"> · 接近上限，请注意精简</span>
        </div>
        <div v-if="errors.front" class="hint error">{{ errors.front }}</div>

        <div class="field-label" style="display:flex;justify-content:space-between;align-items:center">
          <span>{{ backLabel }}</span>
          <label class="btn small">插入图片<input type="file" accept="image/*" hidden
            @change="insertImage('back', $event.target.files[0]); $event.target.value = ''" /></label>
        </div>
        <textarea v-model="back" class="input" :class="{ invalid: errors.back }" rows="7"
                  :placeholder="backPh"
                  @input="back = limitField(back)" @paste="onPaste('back', $event)"></textarea>
        <div class="hint" :class="{ warn: backLen >= WARN, error: backLen >= MAX }">
          {{ backLen }} / {{ MAX }} 字<span v-if="backLen >= WARN && backLen < MAX"> · 接近上限，请注意精简</span>
        </div>
        <div v-if="errors.back" class="hint error">{{ errors.back }}</div>

        <div class="field-label" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" v-model="preview" id="pv" />
          <label for="pv" style="margin:0">实时预览</label>
        </div>
        <div v-if="preview" class="preview-grid">
          <div class="preview-pane"><div class="hint">正面预览</div><MarkdownRenderer :content="front" /></div>
          <div class="preview-pane"><div class="hint">背面预览</div><MarkdownRenderer :content="back" /></div>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px">
          <button class="btn" @click="close">取消</button>
          <button class="btn primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.tag-box { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.suggest {
  position: absolute; top: 100%; left: 0; right: 0; background: var(--panel); z-index: 10;
  border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.12);
  max-height: 200px; overflow-y: auto;
}
.suggest-item { padding: 8px 12px; cursor: pointer; }
.suggest-item:hover { background: var(--code-inline); }
.preview-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.preview-pane { border: 1px dashed var(--line); border-radius: 8px; padding: 10px; max-height: 260px; overflow-y: auto; }
@media (max-width: 720px) { .preview-grid { grid-template-columns: 1fr; } }
</style>