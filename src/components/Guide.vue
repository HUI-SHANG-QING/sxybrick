<script setup>
// 新手指引：分步介绍系统核心功能，可跳过
import { ref } from 'vue';

const emit = defineEmits(['done']);

const steps = [
  { title: '欢迎来到 SxyBrick', text: '一款本地优先的记忆卡片 + AI Agent 学习系统。数据全部存在你自己的设备中，不经过任何服务器，隐私无忧。支持安装为桌面/手机应用，离线也能用。' },
  { title: '总览 · 工作台', text: '「总览」Dashboard 一眼看清今日待背/任务/连续打卡/番茄时长。「工作台」Workspace 聚合复习、费曼、AI 建议、学习教练四象限，一站式开启今日学习。' },
  { title: '卡片 · 卡组 · 联动分析 · 洞察', text: '「卡片」支持正反面、填空（{{答案}}）、选择三种题型，可插入图片并自动 OCR 识别。「卡组」多对多自定义分组（含激活/归档）。「联动分析」挖掘卡片引用/内容关联，支持预设快捷分析与 AI 自由问答。「卡片洞察」单卡遗忘曲线与图谱关联度可视化。' },
  { title: '背诵复习 · 双引擎调度', text: '「背诵」按记忆曲线自动派卡，自评「没记住/模糊/记住」算下次时间。切换两种引擎：SM-2（含短期巩固阶段+错因惩罚）或 FSRS-4.5（用你的真实复习样本训练19个权重，个性化遗忘曲线）。支持考试前紧迫度优先排序与自适应节奏微调。' },
  { title: '英语模块 · 13种复习模式', text: '独立「英语中心」不背单词风 UI：「单词本」管理词库、「背诵」13 种模式（看词选义/看义选词/拼写/听力/词根搭配/英英互译/测验等）、「词组分组」自定义词单、「AI 智能模式」LLM 批量生成例句/释义/记忆法、「统计」学习曲线、「导出」打包词单。全程复用 FSRS 调度算法。' },
  { title: '每日规划 · 计划 · 模考 · 生成测验', text: '「每日规划」口述→拆解任务→四象限→早晚对比打卡+日程到点浮层提醒。「计划」拆解长期目标为阶段里程碑。「模考」限时全真考场（乱序+计时+评分）。「生成测验」LLM 从知识点自动出选择/填空/简答题（测试效应提升记忆）。' },
  { title: '错题 · 费曼 · 番茄钟', text: '「错题本」聚合答错卡片，按错因（概念混淆/计算错误/知识点空白等）分类并针对性缩短复习间隔。「费曼学习法」以教代学：口述解释 → AI 诊断漏洞 → 生成薄弱卡。「番茄钟」专注计时+白噪音，工作/休息循环，任务绑定到番茄块。' },
  { title: '备忘 · 笔记 · 自动分类', text: '「备忘」四象限短便签快速记录。「笔记」厚笔记支持标题/正文/标签/双向链/富文本。「分类」TF-IDF 本地自动归类卡片/资料/笔记三类实体，无需手工打标。' },
  { title: '图谱 · 导图 · 文档 · 书房 · 资料库', text: '「知识图谱」可视化知识点关联（悬空边自动对齐卡片ID）。「思维导图」卡片节点结构树化导出。「文档」AI 上传资料→解析→问答→沉淀笔记。「书房」集中管理所有学习资料。「资料库」批量上传→全量 OCR/PDF 解析→预览→问答→用户选择性生成卡片。' },
  { title: 'AI 助手 · Agent 工作台', text: '「AI 助手」结合真实数据答疑、智能组卡、费曼、周报生成、卡片诊断。「Agent工作台」内置 10+ 专业 Agent（答疑/分析/组卡/出题/计划/口诀/错题/图谱/智能复习等），支持自动路由、多步工具编排、轨迹可视化与 MCP 工具运行时扩展。' },
  { title: '数据 · 周报 · 成就 · 仪表盘 · 超级监控 · 体检', text: '「数据」统计背诵/正确/错因/学科热力图。「周报」AI 自动总结本周学习+下周建议。「成就」学习里程碑解锁（卡/单词/连续打卡等）。「仪表盘」恐怖监控图表。「超级监控」全人生数据时间线+导出/清空。「体检」系统自检：数据完整性/损坏/孤儿行/僵尸图边/过期墓碑一键修复。' },
  { title: '搜索 · 回收站 · 插件 · 组件库', text: '「搜索」全局全文检索卡片/笔记/备忘/文档。「回收站」删除内容 30 天内可恢复（本地 trash 表，不同步）。「插件」P3-4 本地插件 + MCP 接入：工具调用 + 事件钩子扩展。「组件库」Element Plus × 主题桥接活样本，验证风格/配色联动效果。' },
  { title: '导出 · 多端同步', text: '「导出」支持 JSON/CSV/Markdown/Anki 四种格式，按卡组/学科筛选。「同步」两种本地方案：① 导出/导入数据包，支持冲突预览（新增/覆盖/重复/删除分项）、6 阶段进度条、坏图不回滚主数据；② 局域网 Hub 一键同步（手机/平板/电脑同一 Wi-Fi，30+ 表全量对齐）。' },
  { title: '主题 · 外观 · 导航风格', text: '「设置-外观」9 种主题皮肤：经典/专注/活力/纸墨/国风山水水墨（点击水面涟漪+山体云雾+飞鸟+鼠标视差）/猫咪生活报/卡牌桌游/王者大厅/星际HUD/冒险3D符石。支持亮色/暗色/跟随系统三模式，4 种字体切换，自定义核心导航项（不常用功能折叠到「更多」）。' },
  { title: '学习引擎 · 通知 · 埋点 · 语言', text: '「设置-学习引擎」切换 SM-2 ↔ FSRS，一键训练个性化权重。「设置-提醒」桌面通知权限+日程到点浮层。埋点开关：A 级（背诵/导出/同步大事件）与 B 级（按钮点击）独立开关。i18n 中英双语一键切换。' },
  { title: 'PWA · 演示模式 · 存储 · 再见', text: 'PWA 可安装到桌面/主屏，离线完整可用，新版本静默下载后提示激活。「演示模式」一键进入 test 数据库（真实数据物理隔离），体验示例卡/示例数据后可清空重置。顶部实时显示存储占用/配额告警。准备好了吗？开始你的 SxyBrick 学习之旅吧！' },
];
const idx = ref(0);

function next() {
  if (idx.value < steps.length - 1) idx.value++;
  else emit('done');
}
function skip() { emit('done'); }
</script>

<template>
  <div class="guide">
    <div class="card">
      <div class="dots">
        <span v-for="(s, i) in steps" :key="i" class="dot" :class="{ on: i === idx }"></span>
      </div>
      <div class="step-num">{{ idx + 1 }} / {{ steps.length }}</div>
      <h2 class="g-title">{{ steps[idx].title }}</h2>
      <p class="g-text">{{ steps[idx].text }}</p>
      <div class="btns">
        <button class="btn" @click="skip">跳过</button>
        <button class="btn primary" @click="next">{{ idx === steps.length - 1 ? '开始使用' : '下一步' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.guide { position: fixed; inset: 0; z-index: 1000; background: rgba(5, 6, 10, .72); backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; padding: 20px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; max-width: 420px; width: 100%; padding: 28px 26px; text-align: center; box-shadow: 0 24px 60px rgba(0,0,0,.4); }
.dots { display: flex; justify-content: center; gap: 8px; margin-bottom: 18px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line-strong); transition: all .3s; }
.dot.on { background: var(--accent); width: 22px; border-radius: 4px; }
.step-num { font-size: 12px; color: var(--ink-2); margin-bottom: 8px; }
.g-title { margin: 0 0 14px; font-size: 22px; }
.g-text { color: var(--ink-2); line-height: 1.8; font-size: 15px; margin: 0 0 26px; }
.btns { display: flex; gap: 12px; justify-content: center; }
</style>