// 生成 100 张随机卡片 + 全模块数据，PUT 到局域网中枢（node sync-hub/seed-hub.mjs <hubUrl> <token>）
// 用途：为主机/手机的真机同步验证准备源头数据。
const B = process.argv[2] || 'http://localhost:4780';
const TOKEN = process.argv[3];
if (!TOKEN) { console.error('用法: node sync-hub/seed-hub.mjs <hubUrl> <token>'); process.exit(1); }

const SUBJ = ['计算机网络', '操作系统', '数据结构', '计算机组成原理', '高等数学', '线性代数', '概率论'];
const TAGPOOL = ['重点', '易错', '概念', '公式', '算法', '协议', '内存', '进程', '极限', '矩阵', '概率', '背诵', '真题', '高频', '推导', '案例'];
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = arr => arr[rnd(0, arr.length - 1)];
const now = Date.now();
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const QS = ['TCP 三次握手', '进程与线程', '二叉树的遍历', '矩阵的秩', '极限的定义', '贝叶斯公式', '分布式一致性', '虚拟内存', '快速排序', '拉格朗日中值定理', '哈希冲突', '死锁的四个必要条件', '全概率公式', '特征值与特征向量', '递归与迭代', '页表与快表'];
const ACTS = ['简述', '解释', '对比', '推导', '计算', '分析'];
const ANS = ['关键在于概念的内涵与外延。', '结合例子理解即可。', '注意边界条件与特殊情形。', '先理解原理再记忆结论。', '推导过程分三步：定义→性质→应用。', '常与链表、栈、图、向量、级数、缓存、调度结合考察。'];

const cards = [];
const reviews = [];
for (let i = 0; i < 100; i++) {
  const id = uid();
  const subject = pick(SUBJ);
  const nTags = rnd(0, 3);
  const tags = [];
  while (tags.length < nTags) { const t = pick(TAGPOOL); if (!tags.includes(t)) tags.push(t); }
  const type = pick(['basic', 'basic', 'basic', 'cloze', 'choice']);
  const front = `【${subject}】${pick(ACTS)} ${pick(QS)}（第${i + 1}题）？`;
  const back = '参考答案：' + pick(ANS);
  const createdAt = now - rnd(0, 60) * 86400000 - rnd(0, 86400000);
  const reviewed = Math.random() < 0.7;
  const level = rnd(0, 6);
  cards.push({
    id, front, back, subject, tags, type,
    marked: Math.random() < 0.15, mnemonic: '',
    wrongReason: Math.random() < 0.25 ? pick(['概念混淆', '记忆不牢', '粗心', '其他']) : '',
    source: '测试数据', frontChars: front.length, backChars: back.length,
    ease: +(1.3 + Math.random() * 1.5).toFixed(2), level, intervalDays: rnd(0, 30),
    dueAt: reviewed ? now + rnd(-15, 20) * 86400000 : createdAt,
    createdAt, updatedAt: createdAt + rnd(0, 86400000),
  });
  if (reviewed) {
    const k = rnd(1, 4);
    for (let j = 0; j < k; j++) {
      reviews.push({ id: uid(), cardId: id, reviewedAt: createdAt + rnd(0, 30) * 86400000, rating: pick([0, 0, 1, 1, 2, 2, 2]), levelAfter: level, guessed: false, difficulty: rnd(0, 2), wrongReason: '' });
    }
  }
}
const t = Date.now();
const backup = {
  version: 3, app: 'sxybrick', exportedAt: t,
  cards, reviews, tombstones: [], images: [],
  docs: [
    { id: uid(), title: '操作系统·文件系统总结', content: '# 文件系统\n\n- inode 与目录项\n- 软链接与硬链接', type: 'summary', tags: ['操作系统'], createdAt: t, updatedAt: t },
    { id: uid(), title: '高数复习计划', content: '- 极限\n- 导数', type: 'plan', tags: ['高数'], createdAt: t, updatedAt: t },
  ],
  plans: [
    { id: uid(), title: '本周背诵计划', content: '每天 20 张', status: 'active', createdAt: t, updatedAt: t },
    { id: uid(), title: '上月计划', content: '已完成', status: 'done', createdAt: t - 86400000 * 10, updatedAt: t },
  ],
  graphEdges: [
    { id: uid(), from: '进程', to: '线程', label: '包含', subject: '操作系统', createdAt: t, updatedAt: t },
    { id: uid(), from: 'TCP', to: '三次握手', label: '建立连接', subject: '计算机网络', createdAt: t, updatedAt: t },
    { id: uid(), from: '矩阵', to: '特征值', label: '推导', subject: '线性代数', createdAt: t, updatedAt: t },
  ],
  memos: [
    { id: uid(), text: '复习计算机网络第三章', important: true, urgent: true, at: t, createdAt: t },
    { id: uid(), text: '整理错题本', important: false, urgent: false, at: t, createdAt: t },
  ],
  pomoSessions: [
    { id: uid(), startedAt: t - 3600000, duration: 25, createdAt: t },
    { id: uid(), startedAt: t - 7200000, duration: 25, createdAt: t },
  ],
  aiChats: [
    { id: uid(), type: 'feynman', title: '费曼练习', createdAt: t - 86400000, updatedAt: t - 3600000, messages: [{ role: 'user', content: '什么是死锁？' }, { role: 'assistant', content: '死锁指……' }] },
    { id: uid(), type: 'chat', title: 'AI问答', createdAt: t - 86400000, updatedAt: t, messages: [] },
  ],
  aiMemories: [],
  streakMeta: { goal: 20, updatedAt: t },
};

const res = await fetch(`${B}/backup`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'x-sync-token': TOKEN },
  body: JSON.stringify(backup),
});
if (!res.ok) { console.error('PUT 失败:', res.status, await res.text()); process.exit(1); }
const merged = await res.json();
console.log(`✅ 已向中枢写入：卡片 ${merged.cards.length} 张，复习 ${merged.reviews.length} 条，文档 ${merged.docs.length}，计划 ${merged.plans.length}，图谱边 ${merged.graphEdges.length}，备忘 ${merged.memos.length}，番茄 ${merged.pomoSessions.length}，对话 ${merged.aiChats.length}，每日目标 ${merged.streakMeta?.goal}`);