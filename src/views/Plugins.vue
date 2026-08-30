<script setup>
// P3-4 插件 / MCP 接入管理页面
// 功能：
//   1. 列出已安装插件（启用状态、版本、作者、工具数、上次错误）
//   2. 安装插件：从示例一键安装 / 粘贴代码安装 / 从 .js 文件安装
//   3. 启用 / 禁用 / 卸载插件
//   4. 调用插件工具：选择工具 → 填写参数(JSON) → 执行 → 查看结果
//   5. 触发测试钩子：手动触发 onCardSaved 让用户感知钩子机制
import { t } from '../i18n/index.js';
import { confirmDialog } from '../utils/confirm.js';
import { ref, onMounted, computed } from 'vue';
import { toast } from '../utils/toast.js';
import EmptyState from '../components/EmptyState.vue';
import {
  listPlugins, installPlugin, togglePlugin, uninstallPlugin,
  invokeTool, listTools, triggerHook, getAgentIntegration,
} from '../plugins/registry.js';
import { downloadPluginPackage, importPluginPackageFile } from '../plugins/package.js';
import { SUPPORTED_HOOKS } from '../plugins/manifest.js';
// 用 ?raw 把示例插件源码作为字符串注入（Vite 原生支持）
import exampleCode from '../plugins/example-plugin.js?raw';
import weeklyReviewCode from '../plugins/examples/weekly-review.js?raw';
import pomoStatsCode from '../plugins/examples/pomo-stats.js?raw';
import dueAlertCode from '../plugins/examples/due-alert.js?raw';

const plugins = ref([]);
const loading = ref(false);
const selected = ref(null);   // 当前查看的插件 id
const tools = ref([]);
const toolName = ref('');
const toolArgsText = ref('{}');
const toolResult = ref(null);
const toolBusy = ref(false);
const toolError = ref('');

// 安装面板
const showInstall = ref(false);
const installCode = ref('');
const installAuthor = ref('');
const installDesc = ref('');
const installBusy = ref(false);

async function load() {
  loading.value = true;
  try {
    const rows = await listPlugins();
    // 并行补充「Agent 编排器集成」状态（已注册工具/Agent）
    plugins.value = await Promise.all(rows.map(async (p) => ({
      ...p,
      integration: await getAgentIntegration(p.id),
    })));
  }
  catch (e) { toast(t('views.plugins.loadFail', undefined, { msg: (e?.message || e) }), 'error'); }
  finally { loading.value = false; }
}

async function selectPlugin(id) {
  selected.value = id;
  tools.value = await listTools(id);
  toolName.value = tools.value[0]?.name || '';
  toolResult.value = null;
  toolError.value = '';
  // 用工具 inputSchema 生成参数模板
  prefillArgs();
}

function prefillArgs() {
  const def = tools.value.find(x => x.name === toolName.value);
  if (!def?.inputSchema?.properties) { toolArgsText.value = '{}'; return; }
  // 生成 { 字段名: '' } 模板
  const sample = {};
  for (const [k, v] of Object.entries(def.inputSchema.properties)) {
    sample[k] = v.type === 'number' ? 0 : '';
  }
  toolArgsText.value = JSON.stringify(sample, null, 2);
}

async function runTool() {
  if (!selected.value || !toolName.value) { toast(t('views.plugins.selectFirst'), 'error'); return; }
  toolBusy.value = true;
  toolError.value = '';
  toolResult.value = null;
  try {
    const args = JSON.parse(toolArgsText.value || '{}');
    toolResult.value = await invokeTool(selected.value, toolName.value, args);
    toast(t('views.plugins.toolOk'), 'success');
  } catch (e) {
    toolError.value = e?.message || String(e);
    toast(t('views.plugins.toolFail', undefined, { msg: toolError.value }), 'error');
  } finally { toolBusy.value = false; }
}

async function fireHook(event) {
  try {
    await triggerHook(event, { id: 'demo-card', front: '演示卡片', back: '这是触发钩子的演示数据' });
    toast(t('views.plugins.hookDispatched', undefined, { event }), 'success');
  } catch (e) { toast(t('views.plugins.hookFail', undefined, { msg: (e?.message || e) }), 'error'); }
}

async function onToggle(id, enabled) {
  try {
    await togglePlugin(id, enabled);
    await load();
    toast(t('views.plugins.toggleOk', undefined, { state: enabled ? t('views.plugins.enabledLabel') : t('views.plugins.disabledLabel') }), 'success');
  } catch (e) { toast(t('views.plugins.toggleFail', undefined, { msg: (e?.message || e) }), 'error'); }
}

async function onUninstall(id) {
  if (!(await confirmDialog(t('views.plugins.uninstallConfirm')))) return;
  try {
    await uninstallPlugin(id);
    if (selected.value === id) { selected.value = null; tools.value = []; }
    await load();
    toast(t('views.plugins.uninstalled'), 'success');
  } catch (e) { toast(t('views.plugins.uninstallFail', undefined, { msg: (e?.message || e) }), 'error'); }
}

function onExport(id) {
  const p = plugins.value.find(x => x.id === id);
  if (!p) return;
  try {
    downloadPluginPackage(p);
    toast(t('views.plugins.exported'), 'success');
  } catch (e) { toast(t('views.plugins.exportFail', undefined, { msg: (e?.message || e) }), 'error'); }
}

async function onImportPackage(e) {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  try {
    const r = await importPluginPackageFile(f);
    await load();
    toast(t('views.plugins.pkgImported', undefined, { id: r.id, version: r.version }), 'success');
  } catch (e) { toast(t('views.plugins.pkgFail', undefined, { msg: (e?.message || e) }), 'error'); }
}

function openInstall() {
  showInstall.value = true;
  installCode.value = '';
  installAuthor.value = '';
  installDesc.value = '';
}

function loadExample() {
  installCode.value = exampleCode;
  toast(t('views.plugins.exampleLoaded'), 'info');
}

// 官方示例库：?raw 注入源码，一键安装
const OFFICIAL_EXAMPLES = [
  { id: 'weekly-review', key: 'exWeekly', hook: null, install: () => installPlugin(weeklyReviewCode) },
  { id: 'pomo-stats', key: 'exPomo', hook: null, install: () => installPlugin(pomoStatsCode) },
  { id: 'due-alert', key: 'exDue', hook: 'onReviewRated', install: () => installPlugin(dueAlertCode) },
];

const officialExamples = computed(() => OFFICIAL_EXAMPLES.map(ex => {
  const tags = [t('views.plugins.tagTool', undefined, { n: 1 }), t('views.plugins.tagAgent', undefined, { n: 1 })];
  if (ex.hook) tags.push(t('views.plugins.tagHook', undefined, { hook: ex.hook }));
  return {
    ...ex,
    name: t('views.plugins.' + ex.key + 'Name'),
    desc: t('views.plugins.' + ex.key + 'Desc'),
    tags,
    installed: plugins.value.some(p => p.id === ex.id),
  };
}));

async function installExample(ex) {
  installBusy.value = true;
  try {
    await ex.install();
    await load();
    toast(t('views.plugins.exampleInstalledOk', undefined, { id: ex.id }), 'success');
  } catch (e) { toast(t('views.plugins.exampleFail', undefined, { msg: (e?.message || e) }), 'error'); }
  finally { installBusy.value = false; }
}

async function doInstall() {
  if (!installCode.value.trim()) { toast(t('views.plugins.fillCode'), 'error'); return; }
  installBusy.value = true;
  try {
    const r = await installPlugin(installCode.value, {
      author: installAuthor.value, description: installDesc.value,
    });
    showInstall.value = false;
    await load();
    toast(t('views.plugins.installedOk', undefined, { id: r.id, version: r.version }), 'success');
  } catch (e) { toast(t('views.plugins.installFail', undefined, { msg: (e?.message || e) }), 'error'); }
  finally { installBusy.value = false; }
}

async function onFile(e) {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  try {
    const code = await f.text();
    installCode.value = code;
    showInstall.value = true;
    toast(t('views.plugins.fileRead'), 'info');
  } catch (e) { toast(t('views.plugins.fileReadFail', undefined, { msg: (e?.message || e) }), 'error'); }
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const currentPlugin = computed(() => plugins.value.find(p => p.id === selected.value));
const hookEvents = computed(() => Object.entries(SUPPORTED_HOOKS));

onMounted(load);
</script>

<template>
  <div style="max-width:760px;margin:0 auto">
    <div class="panel">
      <div class="panel-title" style="display:flex;justify-content:space-between;align-items:center">
        <span>{{ t('views.plugins.title') }}</span>
        <button class="btn small primary" @click="openInstall">{{ t('views.plugins.installBtn') }}</button>
      </div>
      <p class="hint" style="margin-top:0">
        {{ t('views.plugins.hintPreLink') }}
        <a href="https://modelcontextprotocol.io" target="_blank">{{ t('views.plugins.mcpLink') }}</a>
        {{ t('views.plugins.hintPostLink') }}
      </p>

      <div v-if="loading" class="hint">{{ t('views.plugins.loading') }}</div>
      <EmptyState v-else-if="!plugins.length" icon="🔌" :title="t('views.plugins.emptyTitle')" :message="t('views.plugins.emptyMsg')">
        <button class="btn small" @click="openInstall">{{ t('views.plugins.installFirst') }}</button>
      </EmptyState>
      <div v-else class="plugin-list">
        <div v-for="p in plugins" :key="p.id" class="plugin-item" :class="{ on: selected === p.id, disabled: !p.enabled }" @click="selectPlugin(p.id)">
          <div class="plugin-main">
            <div class="plugin-name">{{ p.id }} <span class="plugin-ver">v{{ p.version }}</span></div>
            <div class="plugin-desc">{{ p.description || t('views.plugins.noDesc') }}</div>
            <div class="plugin-meta">
              <span>{{ t('views.plugins.metaTools', undefined, { n: (p.tools || []).length }) }}</span>
              <span v-if="p.author">{{ t('views.plugins.metaAuthor', undefined, { author: p.author }) }}</span>
              <span>{{ t('views.plugins.metaInstalled', undefined, { time: fmtTime(p.installedAt) }) }}</span>
              <span v-if="p.enabled && p.integration" class="agent-chip" :class="{ on: p.integration.activated }">
                {{ p.integration.activated ? t('views.plugins.agentActivated') : t('views.plugins.agentInactive') }}
                <template v-if="p.integration.tools.length || p.integration.agents.length">
                  {{ t('views.plugins.agentCount', undefined, { tools: p.integration.tools.length, agents: p.integration.agents.length }) }}
                </template>
              </span>
            </div>
            <div v-if="p.lastError" class="plugin-err" :title="p.lastError">{{ t('views.plugins.errTitle', undefined, { msg: p.lastError }) }}</div>
          </div>
          <div class="plugin-actions" @click.stop>
            <label class="switch">
              <input type="checkbox" :checked="!!p.enabled" @change="onToggle(p.id, $event.target.checked)" />
              <span>{{ p.enabled ? t('views.plugins.enabledLabel') : t('views.plugins.disabledLabel') }}</span>
            </label>
            <button class="btn small" @click="onExport(p.id)" :title="t('views.plugins.exportTitle')">{{ t('views.plugins.exportBtn') }}</button>
            <button class="btn small danger" @click="onUninstall(p.id)">{{ t('views.plugins.uninstallBtn') }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 官方示例库 -->
    <div class="panel" style="margin-top:16px">
      <div class="panel-title">{{ t('views.plugins.examplesTitle') }}</div>
      <p class="hint" style="margin-top:0">
        {{ t('views.plugins.examplesHint') }}
        <code>src/plugins/examples/</code>
        {{ t('views.plugins.examplesHintPost') }}
      </p>
      <div class="example-grid">
        <div v-for="ex in officialExamples" :key="ex.id" class="example-card">
          <div class="example-name">{{ ex.name }} <span class="plugin-ver">{{ ex.id }}</span></div>
          <div class="plugin-desc">{{ ex.desc }}</div>
          <div class="plugin-meta">
            <span v-for="tag in ex.tags" :key="tag" class="example-tag">{{ tag }}</span>
          </div>
          <div style="margin-top:8px">
            <button class="btn small primary" :disabled="ex.installed || installBusy" @click="installExample(ex)">
              {{ ex.installed ? t('views.plugins.exampleInstalled') : t('views.plugins.exampleInstall') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 工具调用面板 -->
    <div v-if="currentPlugin" class="panel" style="margin-top:16px">
      <div class="panel-title">{{ t('views.plugins.toolPanelTitle', undefined, { id: currentPlugin.id }) }}</div>
      <p v-if="currentPlugin.enabled && currentPlugin.integration?.activated" class="hint" style="margin-top:0">
        ✅ {{ t('views.plugins.toolRegistered') }}
        <code>agents</code>
        {{ t('views.plugins.toolRegisteredPost') }}
      </p>
      <div v-if="!tools.length" class="hint">{{ t('views.plugins.noTools') }}</div>
      <template v-else>
        <div class="row">
          <select v-model="toolName" class="input" style="max-width:240px" @change="prefillArgs">
            <option v-for="tool in tools" :key="tool.name" :value="tool.name">{{ tool.name }}</option>
          </select>
          <button class="btn primary" :disabled="toolBusy || !currentPlugin.enabled" @click="runTool">
            {{ toolBusy ? t('views.plugins.running') : t('views.plugins.runBtn') }}
          </button>
        </div>
        <div v-if="!currentPlugin.enabled" class="hint" style="color:var(--red)">{{ t('views.plugins.disabledWarn') }}</div>
        <div class="field-label">{{ t('views.plugins.paramLabel') }}</div>
        <textarea v-model="toolArgsText" class="input code" rows="6" placeholder="{}"></textarea>
        <div v-if="toolError" class="hint" style="color:var(--red);margin-top:8px">{{ t('views.plugins.errTitle', undefined, { msg: toolError }) }}</div>
        <div v-if="toolResult != null" class="field-label" style="margin-top:12px">{{ t('views.plugins.returnLabel') }}</div>
        <pre v-if="toolResult != null" class="result-box">{{ JSON.stringify(toolResult, null, 2) }}</pre>
      </template>

      <div class="field-label" style="margin-top:16px">{{ t('views.plugins.hookTitle') }}</div>
      <div class="hook-row">
        <button v-for="[evt, label] in hookEvents" :key="evt" class="chip" @click="fireHook(evt)">
          {{ evt }} <small>{{ label }}</small>
        </button>
      </div>
      <p class="hint" style="margin-top:6px">{{ t('views.plugins.hookHint') }}</p>
    </div>

    <!-- 安装面板 -->
    <div v-if="showInstall" class="modal-mask" @click.self="showInstall = false">
      <div class="modal">
        <h3 style="margin-top:0">{{ t('views.plugins.installTitle') }}</h3>
        <p class="hint" style="margin-top:0">{{ t('views.plugins.installHint') }}</p>
        <div class="row" style="margin-bottom:8px">
          <button class="btn small" @click="loadExample">{{ t('views.plugins.loadExample') }}</button>
          <button class="btn small" @click="$refs.fileInput.click()">{{ t('views.plugins.readFileBtn') }}</button>
          <button class="btn small" @click="$refs.pkgInput.click()">{{ t('views.plugins.importPkgBtn') }}</button>
          <input ref="pkgInput" type="file" accept=".json,application/json" style="display:none" @change="onImportPackage" />
          <input ref="fileInput" type="file" accept=".js,.mjs,text/javascript" style="display:none" @change="onFile" />
        </div>
        <p class="hint" style="margin-top:0">{{ t('views.plugins.pkgHint') }}</p>
        <textarea v-model="installCode" class="input code" rows="12" placeholder="export const manifest = { name: '...', version: '1.0.0', tools: [...] };&#10;export async function toolName(args) { ... }"></textarea>
        <div class="row" style="margin-top:8px">
          <input v-model="installAuthor" class="input" style="max-width:200px" :placeholder="t('views.plugins.authorPlaceholder')" />
          <input v-model="installDesc" class="input" style="flex:1" :placeholder="t('views.plugins.descPlaceholder')" />
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
          <button class="btn" @click="showInstall = false">{{ t('views.plugins.cancelBtn') }}</button>
          <button class="btn primary" :disabled="installBusy" @click="doInstall">{{ installBusy ? t('views.plugins.installRunning') : t('views.plugins.installBtnLabel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px; }
.panel-title { font-weight: 700; font-size: 15px; margin-bottom: 6px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.field-label { font-size: 13px; font-weight: 600; color: var(--ink-2); margin: 12px 0 6px; }
.hint { font-size: 12px; color: var(--ink-2); line-height: 1.6; }
.empty { text-align: center; padding: 24px 0; color: var(--ink-2); }
.plugin-list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.plugin-item { display: flex; justify-content: space-between; align-items: center; gap: 12px; border: 2px solid var(--line); border-radius: 10px; padding: 10px 12px; cursor: pointer; transition: .15s; }
.plugin-item:hover { border-color: var(--accent); }
.plugin-item.on { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
.plugin-item.disabled { opacity: .6; }
.plugin-main { flex: 1; min-width: 0; }
.plugin-name { font-weight: 600; color: var(--ink); }
.plugin-ver { font-size: 11px; color: var(--ink-2); margin-left: 4px; }
.plugin-desc { font-size: 12px; color: var(--ink-2); margin-top: 2px; }
.plugin-meta { font-size: 11px; color: var(--ink-2); margin-top: 2px; }
.plugin-err { font-size: 11px; color: var(--red); margin-top: 4px; }
.agent-chip { display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 10px; font-size: 11px; border: 1px solid var(--line); color: var(--ink-2); }
.agent-chip.on { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.plugin-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
.example-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; margin-top: 10px; }
.example-card { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: color-mix(in srgb, var(--panel) 60%, transparent); }
.example-name { font-weight: 600; color: var(--ink); }
.example-tag { display: inline-block; margin: 2px 6px 2px 0; padding: 1px 8px; border-radius: 10px; font-size: 11px; border: 1px solid var(--line); color: var(--ink-2); }
.switch { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; }
.switch input { accent-color: var(--accent); }
.btn.danger { border-color: color-mix(in srgb, var(--red) 40%, var(--line)); color: var(--red); }
.input.code { font-family: monospace; font-size: 12px; white-space: pre; }
.result-box { background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px; font-size: 12px; overflow: auto; max-height: 300px; }
.hook-row { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { padding: 4px 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); cursor: pointer; font-size: 12px; }
.chip:hover { border-color: var(--accent); }
.chip small { color: var(--ink-2); margin-left: 4px; }
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 200; padding: 16px; }
.modal { background: var(--panel); border-radius: 12px; padding: 20px; max-width: 640px; width: 100%; max-height: 90vh; overflow: auto; }
</style>
