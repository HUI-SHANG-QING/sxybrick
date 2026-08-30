<script setup>
// 多用户（档案）管理弹窗：用户目录 + 切换 + 新建 + 删除 + 跨档案迁移
// 单机本地优先：无密码鉴权，登录=切换档案；每个档案独立 Dexie 库（见 src/db.js / src/user.js）。
import { ref, watch } from 'vue';
import {
  users, activeUserId, activeUser, createUser, switchUser, deleteUser, migrateData, migrationScope,
} from '../user.js';
import { toast } from '../utils/toast.js';

const open = ref(false);
const newName = ref('');

// 迁移面板状态
const migrating = ref(false);
const prog = ref(0);
const result = ref(null);
const fromId = ref('default');
const toId = ref('');
const scopeMode = ref('all'); // all | subject | group
const scopeSubjects = ref([]);
const scopeGroup = ref('');
const scopeInfo = ref({ subjects: [], groups: [] });

function openManager() {
  open.value = true;
  fromId.value = activeUserId.value;
  result.value = null;
  refreshScope();
}
function close() { open.value = false; }

async function refreshScope() {
  try { scopeInfo.value = await migrationScope(fromId.value); } catch { scopeInfo.value = { subjects: [], groups: [] }; }
}

watch(fromId, refreshScope);

function doCreate() {
  const name = newName.value.trim();
  if (!name) return toast('请输入档案名称', 'warn');
  const u = createUser(name);
  newName.value = '';
  toast(`已创建档案「${u.name}」`, 'success');
  refreshScope();
}

function doSwitch(id) {
  if (id === activeUserId.value) { close(); return; }
  switchUser(id); // 内部写 localStorage + 切库 + 整页 reload
}

async function doDelete(id) {
  if (id === 'default') return toast('默认档案不可删除', 'warn');
  if (!confirm('删除该档案会清空其全部本地数据且不可恢复，确认删除？')) return;
  try { await deleteUser(id); toast('已删除档案', 'success'); refreshScope(); }
  catch (e) { toast('删除失败：' + e.message, 'error'); }
}

async function doMigrate() {
  if (!toId.value) return toast('请选择目标档案', 'warn');
  if (fromId.value === toId.value) return toast('源与目标不能是同一档案', 'warn');
  migrating.value = true; prog.value = 0; result.value = null;
  try {
    const scope = scopeMode.value === 'all'
      ? { all: true }
      : scopeMode.value === 'subject'
        ? { subjects: scopeSubjects.value }
        : { groupId: scopeGroup.value };
    const r = await migrateData(fromId.value, toId.value, scope, (p) => { prog.value = p; });
    result.value = r;
    toast(`迁移完成：卡片 ${r.cards} 张 · 图谱边 ${r.edges} 条 · 导图 ${r.mindmaps} 个`, 'success');
  } catch (e) {
    toast('迁移失败：' + e.message, 'error');
  } finally {
    migrating.value = false;
  }
}

const otherUsers = (id) => users.value.filter(u => u.id !== id);
</script>

<template>
  <div v-if="open" class="um-mask" @click.self="close">
    <div class="um-panel" role="dialog" aria-modal="true">
      <div class="um-head">
        <h3>👤 用户档案（多账户）</h3>
        <button class="um-x" @click="close" aria-label="关闭">✕</button>
      </div>

      <p class="um-sub">
        每个档案是独立的一套本地数据（类比微信的多个账号）。新建档案把重要但量少的卡片迁过去，
        量大不重要的可先搁置。
      </p>

      <!-- 当前 + 列表 -->
      <div class="um-section-title">档案列表</div>
      <div class="um-users">
        <div v-for="u in users" :key="u.id" class="um-user" :class="{ on: u.id === activeUserId }">
          <div class="um-uinfo">
            <span class="um-avatar">{{ (u.name || '?').slice(0, 1) }}</span>
            <div>
              <div class="um-uname">{{ u.name }}<span v-if="u.id === 'default'" class="um-tag">默认</span></div>
              <div class="um-uid">id: {{ u.id }}</div>
            </div>
          </div>
          <div class="um-uact">
            <button v-if="u.id !== activeUserId" class="btn mini" @click="doSwitch(u.id)">切换</button>
            <button v-else class="btn mini on" disabled>当前</button>
            <button v-if="u.id !== 'default'" class="btn mini danger" @click="doDelete(u.id)">删除</button>
          </div>
        </div>
        <div v-if="!users.length" class="hint">暂无其他档案</div>
      </div>

      <!-- 新建 -->
      <div class="um-section-title">新建档案</div>
      <div class="um-newrow">
        <input v-model="newName" class="input" placeholder="档案名，如「考研精选」" maxlength="24" @keyup.enter="doCreate" />
        <button class="btn primary" @click="doCreate">＋ 新建</button>
      </div>

      <div class="um-divider"></div>

      <!-- 迁移面板 -->
      <div class="um-section-title">📦 跨档案迁移（把重要少量内容搬过去）</div>
      <div class="um-mig">
        <div class="um-mig-row">
          <label>从</label>
          <select v-model="fromId" class="input">
            <option v-for="u in users" :key="u.id" :value="u.id">{{ u.name }}<template v-if="u.id==='default'">（默认）</template></option>
          </select>
          <label>到</label>
          <select v-model="toId" class="input">
            <option value="" disabled>选择目标档案</option>
            <option v-for="u in otherUsers(fromId)" :key="u.id" :value="u.id">{{ u.name }}</option>
          </select>
        </div>

        <div class="um-mig-row">
          <label>范围</label>
          <select v-model="scopeMode" class="input">
            <option value="all">全部卡片</option>
            <option value="subject">按科目</option>
            <option value="group">按卡组</option>
          </select>
        </div>

        <div v-if="scopeMode === 'subject'" class="um-subjects">
          <label v-for="s in scopeInfo.subjects" :key="s" class="um-chip">
            <input type="checkbox" :value="s" v-model="scopeSubjects" /> {{ s }}
          </label>
          <div v-if="!scopeInfo.subjects.length" class="hint">该档案暂无卡片</div>
        </div>

        <div v-if="scopeMode === 'group'" class="um-mig-row">
          <select v-model="scopeGroup" class="input">
            <option value="" disabled>选择卡组</option>
            <option v-for="g in scopeInfo.groups" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
        </div>

        <button class="btn primary um-mig-go" :disabled="migrating || !toId" @click="doMigrate">
          {{ migrating ? `迁移中… ${Math.round(prog * 100)}%` : '开始迁移' }}
        </button>
        <div v-if="migrating" class="um-bar"><div class="um-bar-in" :style="{ width: (prog * 100) + '%' }"></div></div>

        <div v-if="result" class="um-result">
          迁移完成：卡片 {{ result.cards }} 张 · 图谱边 {{ result.edges }} 条 · 导图 {{ result.mindmaps }} 个 · 笔记 {{ result.notes }} · 备忘 {{ result.memos }} · 卡组 {{ result.groups }}
          <div class="hint">切换至目标档案即可查看。迁移幂等，可重复执行。</div>
        </div>
      </div>

      <div class="um-foot">
        <span class="hint">单机本地优先：无密码，切换即「登录」。数据物理隔离，删除档案=清空该库。</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.um-mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 16px; }
.um-panel { width: min(560px, 96vw); max-height: 90vh; overflow-y: auto; background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-radius: 16px; padding: 18px 20px; box-shadow: 0 20px 60px rgba(0,0,0,.3); }
.um-head { display: flex; align-items: center; justify-content: space-between; }
.um-head h3 { margin: 0; font-size: 17px; }
.um-x { border: none; background: none; font-size: 18px; cursor: pointer; color: var(--ink-2); }
.um-sub { font-size: 13px; color: var(--ink-2); line-height: 1.6; margin: 8px 0 12px; }
.um-section-title { font-weight: 600; font-size: 13px; margin: 14px 0 8px; color: var(--ink); }
.um-users { display: flex; flex-direction: column; gap: 8px; }
.um-user { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
.um-user.on { border-color: var(--accent); }
.um-uinfo { display: flex; align-items: center; gap: 10px; }
.um-avatar { width: 34px; height: 34px; border-radius: 50%; background: var(--accent); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-weight: 600; }
.um-uname { font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 6px; }
.um-tag { font-size: 10px; background: var(--line); color: var(--ink-2); border-radius: 6px; padding: 1px 5px; }
.um-uid { font-size: 11px; color: var(--ink-2); }
.um-uact { display: flex; gap: 6px; }
.um-newrow { display: flex; gap: 8px; }
.um-divider { height: 1px; background: var(--line); margin: 16px 0 4px; }
.um-mig { display: flex; flex-direction: column; gap: 10px; }
.um-mig-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.um-mig-row label { font-size: 13px; color: var(--ink-2); min-width: 34px; }
.um-mig-row .input { flex: 1; min-width: 120px; }
.um-subjects { display: flex; flex-wrap: wrap; gap: 6px; }
.um-chip { font-size: 12px; border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
.um-mig-go { align-self: flex-start; }
.um-bar { height: 6px; background: var(--line); border-radius: 4px; overflow: hidden; }
.um-bar-in { height: 100%; background: var(--accent); transition: width .2s; }
.um-result { font-size: 13px; background: var(--code-inline); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; line-height: 1.6; }
.um-foot { margin-top: 14px; }
.btn { border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
.btn:hover { border-color: var(--accent); }
.btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.btn.mini { padding: 4px 10px; font-size: 12px; }
.btn.mini.on { opacity: .6; cursor: default; }
.btn.danger { color: var(--red); border-color: var(--red); }
.input { border: 1px solid var(--line); background: var(--bg); color: var(--ink); border-radius: 8px; padding: 6px 10px; font-size: 13px; }
.hint { font-size: 12px; color: var(--ink-2); }
</style>
