<script setup>
// 图片分析策略设置块（可复用）：三档单选 + 每档说明与优缺点 + 基于当前数据的推荐。
//
// 为什么抽成组件（2026-09-14 用户反馈「这个选项放在哪里，没有看到」）：
// 该策略影响的是**全局** AI 行为（AI 对话 / Agent / 卡片联动 / 资料问答里的图片怎么处理），
// 但此前只长在「英语中心 → 设置」里 —— 用户自然会在「AI 助手 → AI 设置」里找，所以在那边
// 也必须能看到并直接改。两处共用同一个组件，读写同一份 wordSettings.imageAnalysis.mode。
//
// 交互约定：**改即保存**（选完立刻生效），不依赖外部表单的保存按钮 ——
// 因为它在 AI 设置弹窗里是独立存在的，没有"保存"上下文。
import { ref, onMounted } from 'vue';
import { t } from '../i18n/index.js';
import { getWordSettings, saveWordSettings } from '../word-repo.js';
import { recommendForCurrentData, normalizeVisionLimit, VISION_LIMIT_MAX, VISION_LIMIT_DEFAULT } from '../services/image-analysis.js';
import { IMAGE_QUALITY_KEYS, IMAGE_QUALITY_DEFAULT } from '../utils/img-compress.js';

const MODES = ['auto', 'ocrFirst', 'visionFirst'];
const LABEL_KEY = { auto: 'recModeAuto', ocrFirst: 'recModeOcr', visionFirst: 'recModeVision' };
// 三档的选项行（标题 + 详情/优缺点说明）
const OPTION_KEY = {
  auto: { label: 'imgModeAuto', desc: 'modeAutoDesc' },
  ocrFirst: { label: 'imgModeOcr', desc: 'modeOcrDesc' },
  visionFirst: { label: 'imgModeVision', desc: 'modeVisionDesc' },
};
// 质量档位的文案键（与 OPTION_KEY 同模式：静态映射，便于 i18n 闸门静态解析）
const QUALITY_KEY = {
  high: { label: 'qualityHigh', desc: 'qualityDescHigh' },
  standard: { label: 'qualityStandard', desc: 'qualityDescStandard' },
  low: { label: 'qualityLow', desc: 'qualityDescLow' },
};

const mode = ref('auto');
// round67：送图额度（一次请求最多附几张图）改为用户可调，默认 3。
// 上限 VISION_LIMIT_MAX(20)：图片按 token 计费，不设上限等于把账单交给手滑。
const visionLimit = ref(VISION_LIMIT_DEFAULT);
// round67b：图片质量档位 —— 降低单张体积比放大字节预算更有效
const quality = ref(IMAGE_QUALITY_DEFAULT);
const rec = ref(null);
const recLoading = ref(false);
const recError = ref(false);
const saving = ref(false);

async function load() {
  try {
    const s = await getWordSettings();
    const m = s?.imageAnalysis?.mode;
    mode.value = MODES.includes(m) ? m : 'auto';
    visionLimit.value = normalizeVisionLimit(s?.imageAnalysis?.visionLimit);
    const q = s?.imageAnalysis?.imageQuality;
    quality.value = IMAGE_QUALITY_KEYS.includes(q) ? q : IMAGE_QUALITY_DEFAULT;
  } catch {
    mode.value = 'auto';
    visionLimit.value = VISION_LIMIT_DEFAULT;
    quality.value = IMAGE_QUALITY_DEFAULT;
  }
}

async function setMode(m) {
  if (!MODES.includes(m) || m === mode.value) return;
  mode.value = m;
  saving.value = true;
  try {
    const s = await getWordSettings();
    await saveWordSettings({ imageAnalysis: { ...(s?.imageAnalysis || {}), mode: m } });
  } catch { /* 保存失败不阻塞选择（下次进入会看到旧值，用户可再点） */ } finally {
    saving.value = false;
  }
}

// 送图额度：改即保存。用 @change（失焦/回车）而非 @input，避免每敲一个数字就写一次库。
async function setLimit(v) {
  const n = normalizeVisionLimit(v);
  visionLimit.value = n; // 回显归一化结果：脏输入（0 / 999 / 'abc'）当场被纠正
  saving.value = true;
  try {
    const s = await getWordSettings();
    await saveWordSettings({ imageAnalysis: { ...(s?.imageAnalysis || {}), visionLimit: n } });
  } catch { /* 保存失败不阻塞 */ } finally {
    saving.value = false;
  }
}

// 质量档位：改即保存（与模式选择同约定）
async function setQuality(k) {
  if (!IMAGE_QUALITY_KEYS.includes(k) || k === quality.value) return;
  quality.value = k;
  saving.value = true;
  try {
    const s = await getWordSettings();
    await saveWordSettings({ imageAnalysis: { ...(s?.imageAnalysis || {}), imageQuality: k } });
  } catch { /* 保存失败不阻塞 */ } finally {
    saving.value = false;
  }
}

async function loadRecommendation() {
  recLoading.value = true;
  recError.value = false;
  try {
    rec.value = await recommendForCurrentData();
  } catch {
    recError.value = true;
  } finally {
    recLoading.value = false;
  }
}

function recModeLabel() {
  return rec.value?.mode ? t(`views.wordSettings.${LABEL_KEY[rec.value.mode]}`) : '';
}

onMounted(() => { load(); loadRecommendation(); });
</script>

<template>
  <section class="fblock ips">
    <h3>
      {{ t('views.wordSettings.imageTitle') }}
      <em class="hint-inline">{{ t('views.wordSettings.imageHint') }}</em>
    </h3>
    <div class="imgmode-list">
      <label
        v-for="m in MODES" :key="m"
        class="imgmode" :class="{ on: mode === m }"
      >
        <input type="radio" name="imgAnalysisMode" :value="m" :checked="mode === m" @change="setMode(m)" />
        <span class="imgmode-label">{{ t(`views.wordSettings.${OPTION_KEY[m].label}`) }}</span>
        <span class="imgmode-desc">{{ t(`views.wordSettings.${OPTION_KEY[m].desc}`) }}</span>
      </label>
    </div>
    <p class="imgmode-tip">{{ t('views.wordSettings.visionNeedsKey') }}</p>
    <div class="imgmode-limit">
      <label class="imgmode-limit-label" for="imgVisionLimit">{{ t('views.wordSettings.visionLimitLabel') }}</label>
      <input
        id="imgVisionLimit" class="imgmode-limit-input" type="number"
        :min="1" :max="VISION_LIMIT_MAX" step="1"
        :value="visionLimit" :disabled="saving"
        @change="setLimit($event.target.value)"
      />
      <span class="imgmode-limit-unit">{{ t('views.wordSettings.visionLimitUnit') }}</span>
      <span class="imgmode-limit-hint">{{ t('views.wordSettings.visionLimitHint') }}</span>
    </div>
    <div class="quality-block">
      <div class="quality-title">{{ t('views.wordSettings.qualityLabel') }}</div>
      <div class="imgmode-list">
        <label v-for="k in IMAGE_QUALITY_KEYS" :key="k" class="imgmode" :class="{ on: quality === k }">
          <input type="radio" name="imgQuality" :value="k" :checked="quality === k" @change="setQuality(k)" />
          <span class="imgmode-label">{{ t(`views.wordSettings.${QUALITY_KEY[k].label}`) }}</span>
          <span class="imgmode-desc">{{ t(`views.wordSettings.${QUALITY_KEY[k].desc}`) }}</span>
        </label>
      </div>
    </div>
    <div class="imgmode-rec">
      <span class="imgmode-rec-title">{{ t('views.wordSettings.recTitle') }}</span>
      <span v-if="recLoading">{{ t('views.wordSettings.recComputing') }}</span>
      <span v-else-if="recError">—</span>
      <span v-else-if="!rec?.stats?.imgRefs && !rec?.stats?.docVisual">{{ t('views.wordSettings.recNone') }}</span>
      <template v-else>
        <span v-if="rec.stats.docVisual">{{ t('views.wordSettings.recLineMixed', undefined, { imgs: rec.stats.imgRefs, docVisual: rec.stats.docVisual, pages: rec.stats.docVisionPages, mode: recModeLabel() }) }}</span>
        <span v-else>{{ t('views.wordSettings.recLine', undefined, { imgs: rec.stats.imgRefs, docs: rec.stats.imgDocs, mode: recModeLabel() }) }}</span>
        <button class="imgmode-apply" :disabled="mode === rec.mode || saving" @click="setMode(rec.mode)">
          {{ t('views.wordSettings.recApply') }}
        </button>
      </template>
    </div>
    <p v-if="rec?.reason" class="imgmode-reason">{{ rec.reason }}</p>
  </section>
</template>

<style scoped>
.ips h3 { font-size: 15px; margin: 0 0 10px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.hint-inline { font-style: normal; font-weight: 400; font-size: 12px; color: var(--ink-2); }
.imgmode-list { display: grid; gap: 8px; }
.imgmode {
  display: grid; gap: 4px; padding: 10px 12px; border: 1px solid var(--line);
  border-radius: var(--radius); cursor: pointer; background: var(--panel);
}
.imgmode.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, var(--panel)); }
.imgmode input { justify-self: start; }
.imgmode-label { font-weight: 600; font-size: 14px; }
.imgmode-desc { font-size: 12.5px; color: var(--ink-2); line-height: 1.7; }
.imgmode-tip { font-size: 12px; color: var(--ink-2); margin: 10px 0 0; line-height: 1.7; }
.imgmode-limit {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 10px; font-size: 12.5px; color: var(--ink-2);
}
.imgmode-limit-label { font-weight: 600; color: var(--ink); }
.imgmode-limit-input {
  width: 68px; padding: 4px 8px; border: 1px solid var(--line);
  border-radius: 6px; background: var(--panel); color: var(--ink); font-size: 13px;
}
.imgmode-limit-input:disabled { opacity: .5; }
.imgmode-limit-hint { flex-basis: 100%; font-size: 12px; line-height: 1.6; }
.quality-block { margin-top: 14px; }
.quality-title { font-weight: 600; font-size: 13px; margin-bottom: 8px; color: var(--ink); }
.imgmode-rec {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 10px; padding: 8px 10px; border-radius: var(--radius);
  background: var(--code-bg); font-size: 12.5px; color: var(--ink-2);
}
.imgmode-rec-title { font-weight: 600; color: var(--ink); }
.imgmode-apply {
  border: 1px solid var(--accent); color: var(--accent); background: transparent;
  border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer;
}
.imgmode-apply:disabled { opacity: .45; cursor: default; }
.imgmode-reason { font-size: 12px; color: var(--ink-2); margin: 8px 0 0; line-height: 1.7; }
</style>
