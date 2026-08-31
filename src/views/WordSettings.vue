<script setup>
// 英语设置页（图13：发音口音 / 学习节奏 / 默认例句难度 / AI 生成 + Key / 助记顺序 / 拆分助记 / 混淆辨析）
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { t } from '../i18n/index.js';
import { toast } from '../utils/toast.js';
import { getWordSettings, saveWordSettings } from '../word-repo.js';
import { LLM_PROVIDERS, testLlmConnection } from '../services/word-llm.js';
import WordQuickBar from '../components/WordQuickBar.vue';

const router = useRouter();
const form = ref(null);
const saving = ref(false);
const testing = ref(false);

const accents = [
  { id: 'en-US', label: t('views.wordSettings.accentUs') },
  { id: 'en-GB', label: t('views.wordSettings.accentGb') },
  { id: 'auto', label: t('views.wordSettings.accentAuto') },
];
const paces = [
  { id: 'slow', label: t('views.wordSettings.paceSlow') },
  { id: 'normal', label: t('views.wordSettings.paceNormal') },
  { id: 'fast', label: t('views.wordSettings.paceFast') },
];
const mnemonicOrders = [
  { id: 'auto', label: t('views.wordSettings.orderAuto') },
  { id: 'pos', label: t('views.wordSettings.orderPos') },
  { id: 'example', label: t('views.wordSettings.orderExample') },
];
const exampleLevels = ['simple', 'long', 'en1', 'en2'];
const levelLabels = {
  simple: t('views.wordSettings.levelSimple'),
  long: t('views.wordSettings.levelLong'),
  en1: t('views.wordSettings.levelEn1'),
  en2: t('views.wordSettings.levelEn2'),
};

onMounted(async () => { form.value = await getWordSettings(); });

async function save() {
  if (!form.value) return;
  saving.value = true;
  try {
    await saveWordSettings({
      accent: form.value.accent,
      learnPace: form.value.learnPace,
      recallPace: form.value.recallPace,
      spellHint: !!form.value.spellHint,
      exampleLevels: exampleLevels.filter(l => form.value.exampleLevels?.includes(l)),
      aiEnabled: !!form.value.aiEnabled,
      llmProvider: form.value.llmProvider,
      llmModel: form.value.llmModel,
      llmApiKey: form.value.llmApiKey,
      llmBase: form.value.llmBase,
      mnemonicOrder: form.value.mnemonicOrder,
      splitMnemonic: !!form.value.splitMnemonic,
      confusion: !!form.value.confusion,
      aiFallback: form.value.aiFallback,
      dailyGoal: Number(form.value.dailyGoal) || 20,
    });
    toast(t('views.wordSettings.savedToast'), 'success');
  } catch (e) {
    toast('保存失败：' + (e?.message || e), 'error');
  } finally {
    saving.value = false;
  }
}

function toggleLevel(l) {
  const arr = form.value.exampleLevels || [];
  form.value.exampleLevels = arr.includes(l) ? arr.filter(x => x !== l) : [...arr, l];
}

async function testConn() {
  if (!form.value) return;
  testing.value = true;
  try {
    const r = await testLlmConnection(form.value);
    if (r.ok) toast(t('views.wordSettings.testOk'), 'success');
    else toast(t('views.wordSettings.testFail', { msg: r.reason || '' }), 'error');
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <div class="wset" v-if="form">
    <div class="wset-head">
      <button class="back" @click="router.push('/english')">← {{ t('views.wordHub.navSettings') }}</button>
      <h1>{{ t('views.wordSettings.title') }}</h1>
      <p>{{ t('views.wordSettings.subtitle') }}</p>
    </div>

    <div class="wset-body">
      <!-- 发音口音 -->
      <section class="fblock">
        <label class="flabel">{{ t('views.wordSettings.accentLabel') }}</label>
        <div class="chip-row">
          <button v-for="a in accents" :key="a.id" class="chip" :class="{ on: form.accent === a.id }" @click="form.accent = a.id">{{ a.label }}</button>
        </div>
      </section>

      <!-- 学习 / 复习节奏 -->
      <section class="fblock two">
        <div>
          <label class="flabel">{{ t('views.wordSettings.learnPaceLabel') }}</label>
          <div class="chip-row">
            <button v-for="p in paces" :key="p.id" class="chip" :class="{ on: form.learnPace === p.id }" @click="form.learnPace = p.id">{{ p.label }}</button>
          </div>
        </div>
        <div>
          <label class="flabel">{{ t('views.wordSettings.recallPaceLabel') }}</label>
          <div class="chip-row">
            <button v-for="p in paces" :key="p.id" class="chip" :class="{ on: form.recallPace === p.id }" @click="form.recallPace = p.id">{{ p.label }}</button>
          </div>
        </div>
      </section>

      <!-- 拼写提示 -->
      <section class="fblock">
        <label class="switch-row">
          <span>{{ t('views.wordSettings.spellHintLabel') }}</span>
          <input type="checkbox" v-model="form.spellHint" />
        </label>
      </section>

      <!-- 默认例句难度 -->
      <section class="fblock">
        <label class="flabel">{{ t('views.wordSettings.exampleLevelsLabel') }}</label>
        <div class="chip-row">
          <button v-for="l in exampleLevels" :key="l" class="chip" :class="{ on: form.exampleLevels?.includes(l) }" @click="toggleLevel(l)">{{ levelLabels[l] }}</button>
        </div>
      </section>

      <!-- AI 自动生成 -->
      <section class="fblock">
        <label class="switch-row">
          <span>
            {{ t('views.wordSettings.aiEnabledLabel') }}
            <em class="hint-inline">{{ t('views.wordSettings.aiEnabledHint') }}</em>
          </span>
          <input type="checkbox" v-model="form.aiEnabled" />
        </label>
      </section>

      <!-- AI Key -->
      <section class="fblock">
        <h3>{{ t('views.wordSettings.aiKeyTitle') }}</h3>
        <div class="form-grid">
          <div class="fg">
            <label>{{ t('views.wordSettings.providerLabel') }}</label>
            <select v-model="form.llmProvider">
              <option value="">—</option>
              <option v-for="p in LLM_PROVIDERS" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
          </div>
          <div class="fg">
            <label>{{ t('views.wordSettings.modelLabel') }}</label>
            <input v-model="form.llmModel" :placeholder="LLM_PROVIDERS.find(p=>p.id===form.llmProvider)?.defaultModel || ''" />
          </div>
          <div class="fg fg-wide">
            <label>{{ t('views.wordSettings.apiKeyLabel') }}</label>
            <input type="password" v-model="form.llmApiKey" :placeholder="t('views.wordSettings.apiKeyPlaceholder')" />
          </div>
          <div class="fg fg-wide">
            <label>{{ t('views.wordSettings.baseLabel') }}</label>
            <input v-model="form.llmBase" :placeholder="t('views.wordSettings.basePlaceholder')" />
          </div>
        </div>
        <button class="test-btn" :disabled="testing" @click="testConn">
          {{ testing ? t('views.wordSettings.testing') : t('views.wordSettings.testBtn') }}
        </button>
      </section>

      <!-- 助记顺序 / 拆分助记 / 混淆辨析 -->
      <section class="fblock">
        <label class="flabel">{{ t('views.wordSettings.mnemonicOrderLabel') }}</label>
        <div class="chip-row">
          <button v-for="m in mnemonicOrders" :key="m.id" class="chip" :class="{ on: form.mnemonicOrder === m.id }" @click="form.mnemonicOrder = m.id">{{ m.label }}</button>
        </div>
      </section>
      <section class="fblock">
        <label class="switch-row"><span>{{ t('views.wordSettings.splitMnemonicLabel') }}</span><input type="checkbox" v-model="form.splitMnemonic" /></label>
        <label class="switch-row"><span>{{ t('views.wordSettings.confusionLabel') }}</span><input type="checkbox" v-model="form.confusion" /></label>
        <label class="flabel" style="margin-top:10px">{{ t('views.wordSettings.aiFallbackLabel') }}</label>
        <div class="chip-row">
          <button class="chip" :class="{ on: form.aiFallback === 'template' }" @click="form.aiFallback = 'template'">{{ t('views.wordSettings.fallbackTemplate') }}</button>
          <button class="chip" :class="{ on: form.aiFallback === 'silent' }" @click="form.aiFallback = 'silent'">{{ t('views.wordSettings.fallbackSilent') }}</button>
        </div>
      </section>

      <!-- 每日新学目标 -->
      <section class="fblock">
        <label class="flabel">{{ t('views.wordSettings.dailyGoalLabel') }}</label>
        <div class="goal-row">
          <input type="number" min="1" max="200" v-model.number="form.dailyGoal" />
          <span>{{ t('views.wordSettings.dailyGoalUnit') }}</span>
        </div>
      </section>

      <button class="save-btn" :disabled="saving" @click="save">{{ t('views.wordSettings.saveBtn') }}</button>
    </div>

    <WordQuickBar />
  </div>
</template>

<style scoped>
.wset { padding-bottom: 90px; }
.wset-head { padding: 16px 16px 4px; }
.wset-head .back { border: none; background: transparent; color: var(--ink-2); cursor: pointer; font-size: 13px; }
.wset-head h1 { margin: 6px 0 2px; font-size: 20px; color: var(--ink); }
.wset-head p { margin: 0; font-size: 12px; color: var(--ink-2); }
.wset-body { padding: 8px 16px; display: flex; flex-direction: column; gap: 14px; }
.fblock { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 14px; }
.fblock.two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.fblock h3 { margin: 0 0 10px; font-size: 14px; color: var(--ink); }
.flabel { display: block; font-size: 13px; font-weight: 600; color: var(--ink); margin-bottom: 8px; }
.chip-row { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { border: 1px solid var(--line); background: transparent; border-radius: 10px; padding: 6px 12px; font-size: 13px; cursor: pointer; color: var(--ink); }
.chip.on { border-color: var(--accent); background: var(--code-inline); color: var(--accent); }
.switch-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; font-size: 13px; color: var(--ink); }
.switch-row input { width: 18px; height: 18px; }
.hint-inline { display: block; font-size: 11px; color: var(--ink-2); font-style: normal; margin-top: 2px; max-width: 320px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.fg { display: flex; flex-direction: column; gap: 4px; }
.fg-wide { grid-column: span 2; }
.fg label { font-size: 12px; color: var(--ink-2); }
.fg select, .fg input { border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; background: var(--bg, #fff); color: var(--ink); font-size: 13px; }
.test-btn { margin-top: 10px; border: 1px solid var(--line); background: transparent; border-radius: 9px; padding: 7px 14px; cursor: pointer; color: var(--ink); font-size: 13px; }
.goal-row { display: flex; align-items: center; gap: 8px; }
.goal-row input { width: 90px; border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; background: var(--bg, #fff); color: var(--ink); font-size: 14px; }
.save-btn { border: none; background: var(--accent); color: #fff; border-radius: 12px; padding: 12px; font-size: 15px; cursor: pointer; }
.save-btn:disabled { opacity: .6; }
@media (max-width: 520px) { .fblock.two, .form-grid { grid-template-columns: 1fr; } }
</style>
