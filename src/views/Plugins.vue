<script setup>
// P3-4 插件 / MCP 接入管理页面
// 功能：
//   1. 列出已安装插件（启用状态、版本、作者、工具数、上次错误）
//   2. 安装插件：从示例一键安装 / 粘贴代码安装 / 从 .js 文件安装
//   3. 启用 / 禁用 / 卸载插件
//   4. 调用插件工具：选择工具 → 填写参数(JSON) → 执行 → 查看结果
//   5. 触发测试钩子：手动触发 onCardSaved 让用户感知钩子机制
import { confirmDialog } from '../utils/confirm.js';
import { ref, onMounted, computed } from 'vue';
import { toast } from '../utils/toast.js';
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
  catch (e) { toast('加载插件列表失败：' + (e?.message || e), 'error'); }
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
  const t = tools.value.find(x => x.name === toolName.value);
  if (!t?.inputSchema?.properties) { toolArgsText.value = '{}'; return; }
  // 生成 { 字段名: '' } 模板
  const sample = {};
  for (const [k, v] of Object.entries(t.inputSchema.properties)) {
    sample[k] = v.type === 'number' ? 0 : '';
  }
  toolArgsText.value = JSON.stringify(sample, null, 2);
}

async function runTool() {
  if (!selected.value || !toolName.value) { toast('请先选择插件与工具', 'error'); return; }
  toolBusy.value = true;
  toolError.value = '';
  toolResult.value = null;
  try {
    const args = JSON.parse(toolArgsText.value || '{}');
    toolResult.value = await invokeTool(selected.value, toolName.value, args);
    toast('工具执行成功', 'success');
  } catch (e) {
    toolError.value = e?.message || String(e);
    toast('工具执行失败：' + toolError.value, 'error');
  } finally { toolBusy.value = false; }
}

async function fireHook(event) {
  try {
    await triggerHook(event, { id: 'demo-card', front: '演示卡片', back: '这是触发钩子的演示数据' });
    toast(`已向所有已启用插件分发事件：${event}（查看控制台日志）`, 'success');
  } catch (e) { toast('事件分发失败：' + (e?.message || e), 'error'); }
}

async function onToggle(id, enabled) {
  try {
    await togglePlugin(id, enabled);
    await load();
    toast(enabled ? '插件已启用' : '插件已禁用', 'success');
  } catch (e) { toast('切换失败：' + (e?.message || e), 'error'); }
}

async function onUninstall(id) {
  if (!(await confirmDialog('确定卸载该插件？卸载后无法恢复，需重新安装。'))) return;
  try {
    await uninstallPlugin(id);
    if (selected.value === id) { selected.value = null; tools.value = []; }
    await load();
    toast('插件已卸载', 'success');
  } catch (e) { toast('卸载失败：' + (e?.message || e), 'error'); }
}

function onExport(id) {
  const p = plugins.value.find(x => x.id === id);
  if (!p) return;
  try {
    downloadPluginPackage(p);
    toast('插件包已导出（.json 文件，可分享或备份）', 'success');
  } catch (e) { toast('导出失败：' + (e?.message || e), 'error'); }
}

async function onImportPackage(e) {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  try {
    const r = await importPluginPackageFile(f);
    await load();
    toast(`插件包导入成功：${r.id} v${r.version}`, 'success');
  } catch (e) { toast('导入失败：' + (e?.message || e), 'error'); }
}

function openInstall() {
  showInstall.value = true;
  installCode.value = '';
  installAuthor.value = '';
  installDesc.value = '';
}

function loadExample() {
  installCode.value = exampleCode;
  toast('已填入示例插件（word-count）源码，可直接安装体验', 'info');
}

// 官方示例库：?raw 注入源码，一键安装
const OFFICIAL_EXAMPLES = [
  {
    id: 'weekly-review',
    name: '错题周报',
    desc: '统计近 7 天错题/正确率/科目分布，附「错题周报助手」Agent，工作台直接对话',
    tags: ['1 工具', '1 Agent'],
    install: () => installPlugin(weeklyReviewCode),
  },
  {
    id: 'pomo-stats',
    name: '番茄统计',
    desc: '汇总今日/本周专注次数与时长，按标签拆解，附「番茄统计助手」Agent',
    tags: ['1 工具', '1 Agent'],
    install: () => installPlugin(pomoStatsCode),
  },
  {
    id: 'due-alert',
    name: '到期提醒',
    desc: '复习后检查未来 3 天到期洪峰，超阈值浏览器通知；可查到期分布',
    tags: ['1 工具', '1 Agent', 'onReviewRated 钩子'],
    install: () => installPlugin(dueAlertCode),
  },
];

const officialExamples = computed(() => OFFICIAL_EXAMPLES.map(ex => ({
  ...ex,
  installed: plugins.value.some(p => p.id === ex.id),
})));

async function installExample(ex) {
  installBusy.value = true;
  try {
    await ex.install();
    await load();
    toast(`示例插件安装成功：${ex.id}`, 'success');
  } catch (e) { toast('安装失败：' + (e?.message || e), 'error'); }
  finally { installBusy.value = false; }
}

async function doInstall() {
  if (!installCode.value.trim()) { toast('请填入插件代码，或点击「填入示例」', 'error'); return; }
  installBusy.value = true;
  try {
    const r = await installPlugin(installCode.value, {
      author: installAuthor.value, description: installDesc.value,
    });
    showInstall.value = false;
    await load();
    toast(`插件安装成功：${r.id} v${r.version}`, 'success');
  } catch (e) { toast('安装失败：' + (e?.message || e), 'error'); }
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
    toast('已读取文件，请补充作者/说明后点击「安装」', 'info');
  } catch (e) { toast('读取文件失败：' + (e?.message || e), 'error'); }
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
        <span>插件 / MCP 接入</span>
        <button class="btn small primary" @click="openInstall">+ 安装插件</button>
      </div>
      <p class="hint" style="margin-top:0">
        插件以 ES Module 形式存于本地 IndexedDB，运行时通过 Blob URL 动态加载。<br/>
        工具定义与 <a href="https://modelcontextprotocol.io" target="_blank">MCP 协议</a> 兼容（name/description/inputSchema），
        未来可桥接真正的 MCP server。仅安装可信来源的插件——插件代码在本应用上下文中执行。
      </p>

      <div v-if="loading" class="hint">加载中...</div>
      <div v-else-if="!plugins.length" class="empty">
        <div style="font-size:42px;margin-bottom:8px">🔌</div>
        <div style="margin-bottom:12px">暂无插件</div>
        <button class="btn small" @click="openInstall">+ 安装第一个插件</button>
      </div>
      <div v-else class="plugin-list">
        <div v-for="p in plugins" :key="p.id" class="plugin-item" :class="{ on: selected === p.id, disabled: !p.enabled }" @click="selectPlugin(p.id)">
          <div class="plugin-main">
            <div class="plugin-name">{{ p.id }} <span class="plugin-ver">v{{ p.version }}</span></div>
            <div class="plugin-desc">{{ p.description || '(无说明)' }}</div>
            <div class="plugin-meta">
              <span>{{ (p.tools || []).length }} 个工具</span>
              <span v-if="p.author"> · 作者 {{ p.author }}</span>
              <span> · 安装于 {{ fmtTime(p.installedAt) }}</span>
              <span v-if="p.enabled && p.integration" class="agent-chip" :class="{ on: p.integration.activated }">
                {{ p.integration.activated ? '已接入 Agent 编排器' : '未接入' }}
                <template v-if="p.integration.tools.length || p.integration.agents.length">
                  （{{ p.integration.tools.length }} 工具 · {{ p.integration.agents.length }} Agent）
                </template>
              </span>
            </div>
            <div v-if="p.lastError" class="plugin-err" :title="p.lastError">⚠ {{ p.lastError }}</div>
          </div>
          <div class="plugin-actions" @click.stop>
            <label class="switch">
              <input type="checkbox" :checked="!!p.enabled" @change="onToggle(p.id, $event.target.checked)" />
              <span>{{ p.enabled ? '启用' : '禁用' }}</span>
            </label>
            <button class="btn small" @click="onExport(p.id)" :title="'导出插件包（.json）'">导出</button>
            <button class="btn small danger" @click="onUninstall(p.id)">卸载</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 官方示例库 -->
    <div class="panel" style="margin-top:16px">
      <div class="panel-title">官方示例库</div>
      <p class="hint" style="margin-top:0">
        一键体验插件生态——安装后工具/Agent 自动接入编排器，Agent 工作台直接可用。
        源码在 <code>src/plugins/examples/</code>，可作开发模板。
      </p>
      <div class="example-grid">
        <div v-for="ex in officialExamples" :key="ex.id" class="example-card">
          <div class="example-name">{{ ex.name }} <span class="plugin-ver">{{ ex.id }}</span></div>
          <div class="plugin-desc">{{ ex.desc }}</div>
          <div class="plugin-meta">
            <span v-for="t in ex.tags" :key="t" class="example-tag">{{ t }}</span>
          </div>
          <div style="margin-top:8px">
            <button class="btn small primary" :disabled="ex.installed || installBusy" @click="installExample(ex)">
              {{ ex.installed ? '✓ 已安装' : '一键安装' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 工具调用面板 -->
    <div v-if="currentPlugin" class="panel" style="margin-top:16px">
      <div class="panel-title">工具调用：{{ currentPlugin.id }}</div>
      <p v-if="currentPlugin.enabled && currentPlugin.integration?.activated" class="hint" style="margin-top:0">
        ✅ 已注册到 Agent 编排器——在「Agent 工作台」或 AI 助手中，模型可以直接调用该插件的工具；
        插件若导出 <code>agents</code>，对应 Agent 也会出现在 Agent 列表。
      </p>
      <div v-if="!tools.length" class="hint">该插件没有声明工具。</div>
      <template v-else>
        <div class="row">
          <select v-model="toolName" class="input" style="max-width:240px" @change="prefillArgs">
            <option v-for="t in tools" :key="t.name" :value="t.name">{{ t.name }}</option>
          </select>
          <button class="btn primary" :disabled="toolBusy || !currentPlugin.enabled" @click="runTool">
            {{ toolBusy ? '执行中...' : '执行' }}
          </button>
        </div>
        <div v-if="!currentPlugin.enabled" class="hint" style="color:var(--red)">插件未启用，无法调用工具。</div>
        <div class="field-label">参数（JSON）</div>
        <textarea v-model="toolArgsText" class="input code" rows="6" placeholder="{}"></textarea>
        <div v-if="toolError" class="hint" style="color:var(--red);margin-top:8px">⚠ {{ toolError }}</div>
        <div v-if="toolResult != null" class="field-label" style="margin-top:12px">返回结果</div>
        <pre v-if="toolResult != null" class="result-box">{{ JSON.stringify(toolResult, null, 2) }}</pre>
      </template>

      <div class="field-label" style="margin-top:16px">事件钩子（手动触发测试）</div>
      <div class="hook-row">
        <button v-for="[evt, label] in hookEvents" :key="evt" class="chip" @click="fireHook(evt)">
          {{ evt }} <small>{{ label }}</small>
        </button>
      </div>
      <p class="hint" style="margin-top:6px">点击后会向所有已启用插件分发该事件，插件可在 console 输出日志。</p>
    </div>

    <!-- 安装面板 -->
    <div v-if="showInstall" class="modal-mask" @click.self="showInstall = false">
      <div class="modal">
        <h3 style="margin-top:0">安装插件</h3>
        <p class="hint" style="margin-top:0">粘贴 ES Module 代码，或从 .js 文件读取。代码须导出 manifest 对象 + 与 tools 同名的异步函数。</p>
        <div class="row" style="margin-bottom:8px">
          <button class="btn small" @click="loadExample">填入示例</button>
          <button class="btn small" @click="$refs.fileInput.click()">从 .js 文件读取</button>
          <button class="btn small" @click="$refs.pkgInput.click()">导入插件包 (.json)</button>
          <input ref="pkgInput" type="file" accept=".json,application/json" style="display:none" @change="onImportPackage" />
          <input ref="fileInput" type="file" accept=".js,.mjs,text/javascript" style="display:none" @change="onFile" />
        </div>
        <p class="hint" style="margin-top:0">插件包：单文件分发（manifest + 源码），可用右上「导出」生成，适合备份与分享。</p>
        <textarea v-model="installCode" class="input code" rows="12" placeholder="export const manifest = { name: '...', version: '1.0.0', tools: [...] };&#10;export async function toolName(args) { ... }"></textarea>
        <div class="row" style="margin-top:8px">
          <input v-model="installAuthor" class="input" style="max-width:200px" placeholder="作者（选填）" />
          <input v-model="installDesc" class="input" style="flex:1" placeholder="说明（选填，会覆盖 manifest.description）" />
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
          <button class="btn" @click="showInstall = false">取消</button>
          <button class="btn primary" :disabled="installBusy" @click="doInstall">{{ installBusy ? '安装中...' : '安装' }}</button>
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
