<template>
  <div class="uikit">
    <div class="page-head">
      <h2>🧩 UI 组件库</h2>
      <p class="hint">
        Element Plus × 主题桥接的活样本 —— 所有组件颜色均来自当前主题 token，切换到任意
        「风格 × 配色模式」会自动跟随。本页也用于验证桥接层是否"出戏"。
      </p>
    </div>

    <!-- 基础控件 -->
    <section class="uikit-sec">
      <h3>按钮 Button</h3>
      <div class="uikit-row">
        <el-button>默认</el-button>
        <el-button type="primary">主要</el-button>
        <el-button type="success">成功</el-button>
        <el-button type="warning">警告</el-button>
        <el-button type="danger">危险</el-button>
        <el-button type="info">信息</el-button>
      </div>
      <div class="uikit-row">
        <el-button plain>朴素</el-button>
        <el-button type="primary" plain>主要朴素</el-button>
        <el-button type="danger" plain>危险朴素</el-button>
        <el-button round>圆角</el-button>
        <el-button type="primary" circle aria-label="搜索"><el-icon><Search /></el-icon></el-button>
        <el-button type="primary" :icon="Refresh" circle aria-label="刷新" />
        <el-button type="primary" disabled>禁用</el-button>
        <el-button type="primary" loading>加载中</el-button>
      </div>
      <div class="uikit-row">
        <el-button size="large">大号</el-button>
        <el-button>默认</el-button>
        <el-button size="small">小号</el-button>
        <el-button type="text">文字按钮</el-button>
        <el-button type="primary" link>链接按钮</el-button>
        <el-button-group>
          <el-button type="primary"><el-icon><ArrowLeft /></el-icon>上一张</el-button>
          <el-button type="primary">下一张<el-icon><ArrowRight /></el-icon></el-button>
        </el-button-group>
      </div>
    </section>

    <!-- 表单控件 -->
    <section class="uikit-sec">
      <h3>表单 Form</h3>
      <div class="uikit-grid">
        <div class="uikit-field"><label>输入框</label><el-input v-model="f.input" placeholder="请输入内容" clearable /></div>
        <div class="uikit-field"><label>带图标</label><el-input v-model="f.input2" placeholder="搜索卡片" :prefix-icon="Search" clearable /></div>
        <div class="uikit-field"><label>数字</label><el-input-number v-model="f.num" :min="0" :max="100" /></div>
        <div class="uikit-field"><label>下拉选择</label>
          <el-select v-model="f.select" placeholder="选择科目" clearable style="width:100%">
            <el-option v-for="o in subjects" :key="o" :label="o" :value="o" />
          </el-select>
        </div>
        <div class="uikit-field"><label>日期</label><el-date-picker v-model="f.date" type="date" placeholder="选择日期" style="width:100%" /></div>
        <div class="uikit-field"><label>时间</label><el-time-picker v-model="f.time" placeholder="选择时间" style="width:100%" /></div>
        <div class="uikit-field"><label>开关</label><div style="display:flex;gap:14px;padding-top:6px"><el-switch v-model="f.switch1" /><el-switch v-model="f.switch2" active-text="FSRS" inactive-text="SM-2" /></div></div>
        <div class="uikit-field"><label>滑杆</label><el-slider v-model="f.slider" :max="100" /></div>
        <div class="uikit-field"><label>单选</label>
          <el-radio-group v-model="f.radio">
            <el-radio value="easy">简单</el-radio>
            <el-radio value="hard">困难</el-radio>
            <el-radio value="again">重来</el-radio>
          </el-radio-group>
        </div>
        <div class="uikit-field"><label>多选</label>
          <el-checkbox-group v-model="f.checks">
            <el-checkbox value="m1">背单词</el-checkbox>
            <el-checkbox value="m2">做真题</el-checkbox>
            <el-checkbox value="m3">看资料</el-checkbox>
          </el-checkbox-group>
        </div>
        <div class="uikit-field"><label>评分</label><el-rate v-model="f.rate" /></div>
        <div class="uikit-field"><label>标签输入</label><el-tag v-for="t in f.tags" :key="t" closable style="margin-right:6px" @close="f.tags = f.tags.filter(x => x !== t)">{{ t }}</el-tag></div>
      </div>
      <div class="uikit-row" style="margin-top:12px">
        <el-input v-model="f.newTag" placeholder="添加标签" style="width:180px" @keyup.enter="addTag" />
        <el-button type="primary" @click="addTag">添加</el-button>
      </div>
    </section>

    <!-- 反馈 -->
    <section class="uikit-sec">
      <h3>反馈 Feedback</h3>
      <div class="uikit-row" style="flex-wrap:wrap;gap:8px">
        <el-tag type="primary">主色</el-tag>
        <el-tag type="success">已掌握</el-tag>
        <el-tag type="warning">待复习</el-tag>
        <el-tag type="danger">易错</el-tag>
        <el-tag type="info">信息</el-tag>
        <el-tag closable>可关闭</el-tag>
        <el-tag type="success" effect="dark">实心</el-tag>
        <el-tag type="warning" effect="plain">描边</el-tag>
      </div>
      <div class="uikit-row">
        <el-alert type="success" title="今日计划完成 ✓" description="已复习 32 张卡片，保持率 91%" :closable="false" />
      </div>
      <div class="uikit-row">
        <el-alert type="warning" title="有 8 张卡片即将到期" description="建议今晚 21:00 前完成复习，否则遗忘曲线开始衰减。" :closable="false" />
      </div>
      <div class="uikit-row" style="align-items:center;gap:24px">
        <el-progress :percentage="65" :stroke-width="12" style="flex:1;min-width:140px" />
        <el-progress :percentage="42" type="circle" :width="72" :stroke-width="10" />
        <el-progress :percentage="88" :stroke-width="12" status="exception" style="flex:1;min-width:140px" />
      </div>
      <div class="uikit-row">
        <el-badge :value="12" class="item"><el-button size="small">待复习</el-button></el-badge>
        <el-badge is-dot class="item"><el-button size="small">新消息</el-button></el-badge>
        <el-button size="small" @click="showMsg('success')">成功提示</el-button>
        <el-button size="small" type="warning" @click="showMsg('warning')">警告提示</el-button>
        <el-button size="small" type="danger" @click="showMsg('error')">错误提示</el-button>
        <el-button size="small" type="primary" @click="showNotify">系统通知</el-button>
      </div>
    </section>

    <!-- 数据展示 -->
    <section class="uikit-sec">
      <h3>数据 Data</h3>
      <el-table :data="rows" style="width:100%">
        <el-table-column prop="subject" label="科目" width="140" />
        <el-table-column prop="cards" label="卡片数" width="90" sortable />
        <el-table-column prop="due" label="待复习" width="90">
          <template #default="{ row }">
            <el-tag :type="row.due > 10 ? 'danger' : 'success'" size="small">{{ row.due }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="retention" label="保持率" width="140">
          <template #default="{ row }">
            <el-progress :percentage="row.retention" :stroke-width="8" :status="row.retention >= 85 ? 'success' : undefined" />
          </template>
        </el-table-column>
        <el-table-column label="操作">
          <template #default="{ row }">
            <el-button link type="primary" @click="toast(`开始复习「${row.subject}」`)">复习</el-button>
            <el-button link type="danger" @click="toast(`已归档「${row.subject}」`,'error')">归档</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="uikit-row" style="justify-content:flex-end;margin-top:10px">
        <el-pagination background layout="prev, pager, next, total" :total="120" :page-size="10" />
      </div>
    </section>

    <!-- 导航与浮层 -->
    <section class="uikit-sec">
      <h3>导航与浮层 Navigation / Overlay</h3>
      <div class="uikit-row">
        <el-breadcrumb separator="/">
          <el-breadcrumb-item :to="{ path: '/' }">首页</el-breadcrumb-item>
          <el-breadcrumb-item>学习</el-breadcrumb-item>
          <el-breadcrumb-item>背诵</el-breadcrumb-item>
        </el-breadcrumb>
      </div>
      <el-tabs v-model="tab2">
        <el-tab-pane label="卡片" name="a">卡片相关设置与统计。</el-tab-pane>
        <el-tab-pane label="复习" name="b">复习节奏与调度参数。</el-tab-pane>
        <el-tab-pane label="同步" name="c">跨设备数据同步状态。</el-tab-pane>
      </el-tabs>
      <div class="uikit-row">
        <el-steps :active="2" align-center style="max-width:520px;width:100%">
          <el-step title="收集错题" description="导入错题本" />
          <el-step title="生成卡片" description="AI 提炼知识点" />
          <el-step title="循环复习" description="FSRS 调度" />
        </el-steps>
      </div>
      <div class="uikit-row">
        <el-tooltip content="Tooltip：间隔复习是最有效的记忆方式" placement="top">
          <el-button size="small">悬浮提示</el-button>
        </el-tooltip>
        <el-popover placement="bottom" :width="240" trigger="click">
          <template #reference><el-button size="small">点击弹出</el-button></template>
          <div>Popover 内容：可以放任何东西，比如快捷操作。</div>
          <div style="margin-top:8px;text-align:right"><el-button size="small" type="primary">知道了</el-button></div>
        </el-popover>
        <el-button size="small" type="primary" @click="dialogOpen = true">对话框</el-button>
        <el-button size="small" type="primary" @click="drawerOpen = true">抽屉</el-button>
        <el-button size="small" @click="avatarOpen = true">头像弹出层</el-button>
      </div>
    </section>

    <!-- 对话框 -->
    <el-dialog v-model="dialogOpen" title="主题桥接验证" width="440px">
      <p>这个对话框的背景、文字、按钮颜色都来自当前主题 token。试试把风格切到「卡牌 / 王者 / 星际」，或切到「夜间 / 护眼」，再打开一次。</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <el-tag type="primary">自动跟随</el-tag>
        <el-tag type="success">无硬编码</el-tag>
      </div>
      <template #footer>
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button type="primary" @click="dialogOpen = false">确认</el-button>
      </template>
    </el-dialog>

    <!-- 抽屉 -->
    <el-drawer v-model="drawerOpen" title="复习抽屉" size="380px">
      <p>抽屉同样跟随主题。里面可以放：今日待复习、错题 TOP、快捷入口。</p>
      <el-empty description="今日已完成全部复习 🎉" :image-size="80" />
    </el-drawer>

    <!-- 头像弹出层 -->
    <el-popover :visible="avatarOpen" placement="bottom" :width="280" @hide="avatarOpen = false">
      <div style="display:flex;gap:14px;align-items:center">
        <el-avatar :size="52" :src="avatarUrl">S</el-avatar>
        <div>
          <div style="font-weight:600">SxyBrick 学习员</div>
          <div class="hint">连续打卡 17 天 · 本周保持率 92%</div>
        </div>
      </div>
    </el-popover>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue';
import { ElMessage, ElNotification } from 'element-plus';
import { toast } from '../utils/toast.js';
import { Refresh, Search, ArrowLeft, ArrowRight } from '@element-plus/icons-vue';

const subjects = ['计算机组成原理', '线性代数', '数据结构', '操作系统', '编译原理'];

const f = reactive({
  input: '',
  input2: '',
  num: 8,
  select: '',
  date: '',
  time: '',
  switch1: true,
  switch2: true,
  slider: 65,
  radio: 'easy',
  checks: ['m1'],
  rate: 4,
  tags: ['考研', '408'],
  newTag: '',
});
function addTag() {
  const t = f.newTag.trim();
  if (!t) return;
  if (!f.tags.includes(t)) f.tags.push(t);
  f.newTag = '';
}

const rows = [
  { subject: '计算机组成原理', cards: 128, due: 12, retention: 88 },
  { subject: '线性代数', cards: 96, due: 3, retention: 91 },
  { subject: '数据结构', cards: 210, due: 26, retention: 76 },
  { subject: '操作系统', cards: 64, due: 0, retention: 95 },
];

const tab2 = ref('a');
const dialogOpen = ref(false);
const drawerOpen = ref(false);
const avatarOpen = ref(false);
const avatarUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="104" height="104"><rect width="104" height="104" rx="20" fill="#2563eb"/><text x="52" y="68" font-size="44" text-anchor="middle" fill="#fff" font-family="sans-serif">S</text></svg>'
);

function showMsg(type) {
  const map = {
    success: ['操作成功', '卡片已保存，下次复习已排期'],
    warning: ['注意', '今日还有 8 张卡片待复习'],
    error: ['操作失败', '同步中断，请检查网络后重试'],
  };
  const [title, message] = map[type] || [];
  if (type === 'success') toast(title + '：' + message);
  else ElMessage({ type, title, message, grouping: true });
}
function showNotify() {
  ElNotification({
    title: '监督力提醒',
    message: '你已连续 3 天未达复习目标，损失进度：+8 张累积待复习。',
    type: 'warning',
    duration: 4000,
  });
}
</script>

<style scoped>
.uikit { max-width: 860px; }
.page-head { margin-bottom: 8px; }
.page-head h2 { margin: 0 0 6px; }
.uikit-sec {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 18px 20px;
  margin: 14px 0;
}
.uikit-sec h3 { margin: 0 0 14px; font-size: 15px; color: var(--ink); }
.uikit-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.uikit-row:last-child { margin-bottom: 0; }
.uikit-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; }
.uikit-field label { display: block; font-size: 12px; color: var(--ink-2); margin-bottom: 4px; }
.item { margin-right: 8px; }
</style>
