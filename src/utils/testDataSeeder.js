// src/utils/testDataSeeder.js
// M3 演示模式：预置测试数据。首次进入演示模式且测试库为空时自动填充，
// 让各功能（卡片/复习/卡组/搜索/同步/分析/单词本/计划/资料库/知识图谱/AI 文档）都能立即演示。
// 只写测试库（db 已切到 sxybrick-test 实例），绝不触碰真实数据。
import { db, uid } from '../db.js';

const DAY = 86400000;
const NOW = Date.now();

/** 测试库是否为空（以卡片数为判据） */
export async function testDbEmpty() {
  try {
    return (await db.cards.count()) === 0;
  } catch {
    return true;
  }
}

/**
 * 播种演示数据：
 *   - 60 张卡片，覆盖 5 个科目（计网/OS/数据结构/高数/英语），含 tags 与不同掌握度
 *   - 复习记录：已背过的卡有 reviews 行 + 推进的 SRS 状态；新卡 dueAt 落在今天（可立即复习）
 *   - 3 个卡组：「2027 考研核心」(active)、「2028 扩展」(archived 备用)、「错题重练」(active)
 *   - 卡片-卡组关联：覆盖多组、仅备用组、未分组三种形态（用于演示备用停车）
 *   - 8 条知识图谱边（prereq/related，label 型 + cardId 键）——知识图谱模块演示
 *   - 5 条备忘 + 3 条笔记（搜索/备忘模块演示）
 *   - 4 条计划（active/done/archived 状态分布）——计划模块演示
 *   - 2 篇 AI 文档（summary/note）——AI 文档模块演示
 *   - 2 份资料文件（docFiles ready + docTexts 全文）——资料库模块演示
 *   - 36 张单词卡（word/phrase/sentence/template 四类 + 熟词 + SRS 分布）——单词本模块演示
 *   - 单词复习历史 + 3 个单词词组 + 关联 + 连续 21 天打卡
 */
export async function seedTestDatabase() {
  const t0 = NOW - 14 * DAY;
  await db.transaction('rw',
    db.cards, db.reviews, db.cardGroups, db.cardGroupLinks, db.memos, db.notes,
    db.plans, db.docs, db.docFiles, db.docTexts, db.graphEdges, db.meta,
    db.wordCards, db.wordReviews, db.wordGroups, db.wordGroupLinks, db.wordCheckins,
    async () => {
      // 设备标识（同步需要；测试库独立）
      const meta = await db.meta.get('deviceId');
      if (!meta) await db.meta.put({ key: 'deviceId', value: 'demo-device' });

      // ---- 卡片数据（front/back/科目/标签/掌握度档位） ----
      const mk = (i, front, back, subject, tags, srs) => {
        const t = t0 + i * 3600e3;
        return {
          id: `demo-card-${i}`,
          front, back, subject, tags,
          type: 'basic', marked: 0, source: '演示数据',
          ease: srs.ease, level: srs.level, intervalDays: srs.interval,
          dueAt: srs.due, reviewedAt: srs.reviewed,
          createdAt: t, updatedAt: Math.max(t, srs.updated ?? t),
        };
      };
      const mastered = (i, interval) => ({ ease: 2.6 + (i % 4) * 0.1, level: 4 + (i % 2), interval, due: NOW + interval * DAY, reviewed: NOW - interval * DAY, updated: NOW - interval * DAY });
      const learning = (i) => ({ ease: 2.3 + (i % 3) * 0.1, level: 2, interval: 2, due: NOW - (i % 5) * 3600e3, reviewed: NOW - (i % 3 + 1) * DAY, updated: NOW - (i % 3 + 1) * DAY });
      const fresh = (i) => ({ ease: 2.5, level: 0, interval: 0, due: NOW - i * 600e3, reviewed: 0, updated: t0 + i * 3600e3 });

      const cards = [
        // 计网（12）
        mk(1, 'TCP 三次握手的过程？', 'SYN → SYN-ACK → ACK；建立全双工连接，防止已失效的连接请求突然到达服务端造成资源浪费。', '计网', ['计网', '传输层', 'TCP'], learning(1)),
        mk(2, 'TCP 如何保证可靠传输？', '序号 + 确认（ACK）+ 超时重传 + 滑动窗口 + 拥塞控制。', '计网', ['计网', '传输层', 'TCP'], mastered(1, 12)),
        mk(3, 'DNS 的解析流程？', '本地缓存 → hosts → 本地 DNS 服务器（递归/迭代查询根、TLD、权威服务器）→ CNAME 链。', '计网', ['计网', '应用层', 'DNS'], learning(2)),
        mk(4, 'HTTP/1.1 与 HTTP/2 的核心差异？', 'H2 二进制分帧、头部压缩（HPACK）、多路复用（单连接并发）、服务端推送。', '计网', ['计网', '应用层', 'HTTP'], fresh(3)),
        mk(5, 'TCP 拥塞控制的四个阶段？', '慢启动（指数增长）→ 拥塞避免（线性）→ 快重传/快恢复（3 个重复 ACK）→ 超时（ssthresh 减半）。', '计网', ['计网', '传输层', 'TCP'], learning(5)),
        mk(6, 'UDP 与 TCP 的区别？', 'TCP 面向连接/可靠/字节流/慢；UDP 无连接/不可靠/报文/快，适合实时音视频、DNS 查询。', '计网', ['计网', '传输层', 'UDP'], mastered(2, 9)),
        mk(7, 'ARP 协议的作用？', '已知目标 IP 解析出 MAC 地址：广播 ARP 请求 → 目标单播应答 → 缓存表（带 TTL）。', '计网', ['计网', '网络层', 'ARP'], fresh(4)),
        mk(8, 'CIDR 子网划分的计算？', '网络号 = IP 与掩码按位与；主机数 = 2^(32-前缀) - 2（全 0/全 1 不可用）。', '计网', ['计网', '网络层', 'IP'], learning(1)),
        mk(9, 'HTTPS 握手过程？', 'ClientHello → ServerHello+证书 → 客户端验证证书并交换密钥 → 双方生成会话密钥 → 加密通信（TLS1.3 缩短为 1-RTT）。', '计网', ['计网', '应用层', 'HTTPS'], fresh(6)),
        mk(10, 'OSPF 与 RIP 的区别？', 'OSPF：链路状态、Dijkstra、收敛快、适合大网；RIP：距离向量、跳数上限 15、适合小网。', '计网', ['计网', '网络层', '路由'], learning(3)),
        mk(11, 'NAT 的作用？', '私有 IP ↔ 公网 IP 转换，缓解 IPv4 地址枯竭；静态/动态/端口多路复用（PAT）。', '计网', ['计网', '网络层', 'NAT'], fresh(2)),
        mk(12, 'HTTP/3 基于什么传输层协议？', 'QUIC（基于 UDP 实现可靠传输），0-RTT 建连、无队头阻塞、连接迁移。', '计网', ['计网', '应用层', 'HTTP'], fresh(5)),
        // 操作系统（12）
        mk(13, '进程与线程的区别？', '进程是资源分配的基本单位，线程是 CPU 调度的基本单位；同进程线程共享地址空间，切换开销小。', 'OS', ['操作系统', '进程'], mastered(3, 20)),
        mk(14, '死锁的四个必要条件？', '互斥、持有并等待、不可剥夺、循环等待；破坏任一条件即可预防。', 'OS', ['操作系统', '同步'], learning(3)),
        mk(15, '页面置换算法的比较？', 'FIFO（Belady 异常）/ Optimal（理论下界）/ LRU（近似 Optimal，常用）/ CLOCK（LRU 近似实现）。', 'OS', ['操作系统', '内存'], fresh(7)),
        mk(16, '虚拟内存的作用？', '以磁盘换空间，提供比物理内存更大的逻辑地址空间；按需调入 + 页表映射。', 'OS', ['操作系统', '内存', '虚拟内存'], learning(4)),
        mk(17, '常用进程调度算法？', 'FCFS（先来先服务）/ SJF（最短作业优先）/ 优先级 / RR（时间片轮转）/ 多级反馈队列（综合）。', 'OS', ['操作系统', '调度'], learning(6)),
        mk(18, '信号量与 PV 操作？', 'P(S)=wait：S-1，S<0 则阻塞；V(S)=signal：S+1，S<=0 则唤醒一个。用于互斥（初值1）与同步（初值0）。', 'OS', ['操作系统', '同步'], fresh(8)),
        mk(19, '银行家算法的目的？', '避免死锁：分配前检查系统是否处于安全状态（是否存在安全序列），不安全则不分配。', 'OS', ['操作系统', '同步'], learning(2)),
        mk(20, '分页与分段的区别？', '分页：固定大小、无逻辑意义、由系统划分；分段：可变大小、有逻辑意义（代码/数据/栈）、由用户划分。', 'OS', ['操作系统', '内存'], fresh(3)),
        mk(21, '磁盘调度算法？', 'FCFS / SSTF（最短寻道）/ SCAN（电梯，单向到底）/ C-SCAN（循环扫描）。', 'OS', ['操作系统', '文件'], learning(5)),
        mk(22, '系统调用的过程？', '用户态 → 陷入（trap/INT）→ 内核态 → 执行内核函数 → 返回用户态；参数经寄存器/栈传递。', 'OS', ['操作系统', '基础'], fresh(1)),
        mk(23, 'TLB 的作用？', '快表：缓存页表项，加速地址转换；命中则一次访存，未命中查页表并更新 TLB。', 'OS', ['操作系统', '内存'], fresh(6)),
        mk(24, '读者-写者问题的核心？', '读读不互斥、读写互斥、写写互斥；用信号量 rwmutex + count 计数实现读优先（可能写饥饿）。', 'OS', ['操作系统', '同步'], learning(1)),
        // 数据结构（12）
        mk(25, '时间复杂度 O(n log n) 的排序算法？', '归并排序（稳定）、堆排序（不稳定）、快排平均 O(n log n) 最坏 O(n²)。', '数据结构', ['数据结构', '排序'], mastered(1, 30)),
        mk(26, '二叉搜索树与平衡树的区别？', 'BST 有序性；BST 退化为链 O(n)，平衡树（AVL/红黑）保证 O(log n)。', '数据结构', ['数据结构', '树'], learning(3)),
        mk(27, 'B+ 树为什么适合数据库索引？', '矮胖（多路）、非叶子不存数据、叶子链表相连 → 范围查询 + 磁盘 IO 少。', '数据结构', ['数据结构', '树', '数据库'], fresh(5)),
        mk(28, '哈希表冲突的解决方法？', '开放定址（线性/二次探测）、链地址法；负载因子与再散列。', '数据结构', ['数据结构', '哈希'], learning(4)),
        mk(29, '栈的经典应用？', '括号匹配、表达式求值（中缀转后缀）、递归调用栈、函数调用返回地址保存。', '数据结构', ['数据结构', '栈'], mastered(2, 14)),
        mk(30, '循环队列判空/判满？', '判空 front==rear；判满 (rear+1)%max==front；牺牲一个单元区分。', '数据结构', ['数据结构', '队列'], fresh(2)),
        mk(31, '二叉树三种遍历的应用？', '前序（先根）、中序（排序树有序输出）、后序（先子树后根，用于删除/表达式求值）。', '数据结构', ['数据结构', '树'], learning(6)),
        mk(32, '堆的性质与堆排序？', '完全二叉树 + 堆序性（大顶堆：父≥子）；建堆 O(n)，排序 O(n log n)，不稳定。', '数据结构', ['数据结构', '树', '排序'], fresh(7)),
        mk(33, '拓扑排序的 Kahn 算法？', '不断删除入度为 0 的顶点并输出，同时更新邻接顶点入度；顶点数不足则存在环。', '数据结构', ['数据结构', '图'], learning(2)),
        mk(34, '并查集的操作与优化？', 'find（路径压缩）+ union（按秩合并）；近乎 O(1)，用于连通分量/最小生成树 Kruskal。', '数据结构', ['数据结构', '并查集'], fresh(4)),
        mk(35, 'KMP 算法的核心？', '失配时利用 next 数组（最长公共前后缀）右移，主串不回退；O(n+m)。', '数据结构', ['数据结构', '字符串'], fresh(3)),
        mk(36, '图的 BFS 与 DFS 区别？', 'BFS 用队列、按层扩展、求无权最短路；DFS 用栈/递归、深入优先、用于连通性/拓扑排序。', '数据结构', ['数据结构', '图'], mastered(3, 10)),
        // 高数（12）
        mk(37, '中值定理的条件与结论？', '闭区间连续 + 开区间可导 → 存在 ξ 使 f′(ξ) = (f(b)-f(a))/(b-a)。', '高数', ['高数', '中值定理'], mastered(4, 15)),
        mk(38, '判断级数收敛的常用方法？', '比较判别法、比值/根值判别法、莱布尼茨（交错）、p-级数（p>1 收敛）。', '高数', ['高数', '级数'], learning(2)),
        mk(39, '二重积分化为累次积分的步骤？', '画出积分区域 → 判断 X/Y 型 → 定上下限 → 先内后外积分。', '高数', ['高数', '积分'], fresh(6)),
        mk(40, '特征值与特征向量的定义？', 'Av = λv（v≠0）；|A-λE|=0 求 λ，再解 (A-λE)x=0 求 v。', '高数', ['高数', '线性代数'], learning(3)),
        mk(41, '反常积分 ∫₁^∞ 1/xᵖ dx 的收敛性？', 'p>1 收敛，p≤1 发散；这是判别反常积分的第一准则（p 判别法）。', '高数', ['高数', '反常积分'], learning(4)),
        mk(42, '反常积分 ∫₀¹ 1/xᵖ dx 的收敛性？', 'p<1 收敛，p≥1 发散；注意与无穷区间情形恰好相反。', '高数', ['高数', '反常积分'], fresh(2)),
        mk(43, '泰勒展开的条件？', '函数在某邻域内 n+1 阶可导；余项可用佩亚诺（局部）或拉格朗日（整体）形式。', '高数', ['高数', '泰勒'], learning(1)),
        mk(44, '洛必达法则的使用条件？', '0/0 或 ∞/∞ 型；分子分母在去心邻域可导且分母导数≠0；极限存在或为∞。', '高数', ['高数', '极限'], fresh(8)),
        mk(45, '方向导数与梯度的关系？', '方向导数 = 梯度 · 方向单位向量；梯度方向是增长最快的方向，模为最大增长率。', '高数', ['高数', '多元函数'], fresh(4)),
        mk(46, '极坐标下二重积分的面积微元？', 'dσ = r dr dθ；先定 θ 范围再定 r 范围（从原点出发的射线）。', '高数', ['高数', '积分'], learning(5)),
        mk(47, '三重积分化为三次积分的顺序？', '先定 z 上下限（穿针法），再在投影区域上做二重积分；可换先二后一。', '高数', ['高数', '积分'], fresh(1)),
        mk(48, '第一类曲线积分 ds 的计算？', 'ds = √(1+(y′)²) dx（直角坐标）或 √(r²+(r′)²) dθ（极坐标）；与方向无关。', '高数', ['高数', '积分'], learning(2)),
        // 英语（12）
        mk(49, '虚拟语气：与现在事实相反', 'If + 过去式, 主句 would/could + 动词原形。如 If I were you…', '英语', ['英语', '语法', '虚拟语气'], mastered(5, 8)),
        mk(50, '虚拟语气：与过去事实相反', 'If + had done, 主句 would have done。如 If I had studied…', '英语', ['英语', '语法', '虚拟语气'], learning(3)),
        mk(51, '定语从句 which/that 的区别？', '限制性从句两者皆可；介词后只用 which；先行词为 all/only 等时倾向 that。', '英语', ['英语', '语法', '从句'], fresh(7)),
        mk(52, '非谓语动词作状语的条件？', '逻辑主语 = 主句主语；doing（主动/进行）、done（被动/完成）、to do（目的/将来）。', '英语', ['英语', '语法', '非谓语'], learning(4)),
        mk(53, '倒装句的两种类型？', '完全倒装（Here comes…）与部分倒装（Never have I seen…）；否定词/only+状语/so 开头用部分倒装。', '英语', ['英语', '语法', '倒装'], fresh(5)),
        mk(54, '强调句 it is…that 的判断？', '去掉 it is…that 后句子仍完整即为强调句；强调人可用 who。', '英语', ['英语', '语法', '强调句'], fresh(3)),
        mk(55, '主谓一致的三个原则？', '语法一致（主语单复）、意义一致（集合名词）、就近原则（either…or / not only…but also）。', '英语', ['英语', '语法', '主谓一致'], learning(6)),
        mk(56, '非谓语动词的完成式？', 'having done（主动完成）/ having been done（被动完成）；表示先于谓语动词发生的动作。', '英语', ['英语', '语法', '非谓语'], fresh(2)),
        mk(57, '长难句拆分步骤？', '①找谓语动词 ②断开从句 ③抓住主干 ④逐层翻译。', '英语', ['英语', '长难句'], fresh(6)),
        mk(58, '翻译中的增译与省译？', '增译：补出省略成分（主语/连接词）；省译：冠词、范畴词（…问题 中的问题）。', '英语', ['英语', '翻译'], learning(1)),
        mk(59, '阅读细节题的定位技巧？', '题干关键词（专有名词/数字/大写）→ 原文定位 → 同义替换比对；警惕张冠李戴与绝对化选项。', '英语', ['英语', '阅读'], mastered(1, 6)),
        mk(60, '完形填空的逻辑衔接词？', 'however（转折）/ therefore（因果）/ moreover（递进）/ for example（举例）；先看逻辑关系再选词。', '英语', ['英语', '完形'], fresh(4)),
      ];
      await db.cards.bulkPut(cards);

      // ---- 复习记录（已背过的卡生成 2-4 条 reviews） ----
      const reviews = [];
      for (const c of cards) {
        if (!c.reviewedAt) continue;
        let t = Math.max(t0, c.reviewedAt - 3 * DAY);
        const n = 2 + (Number(c.id.slice(-1)) % 3);
        for (let k = 0; k < n; k++) {
          t += Math.floor((NOW - t) / (n + 1));
          reviews.push({
            id: `demo-rev-${c.id}-${k}`,
            cardId: c.id,
            rating: k === n - 1 ? 2 : (k % 2), // 最近一次「还模糊」，制造薄弱感
            reviewedAt: t,
            intervalDays: Math.min(c.intervalDays, k + 1),
          });
        }
      }
      // bulkPut（非 bulkAdd）：seeder 可能被重复调用（幂等要求），固定 id 下 add 会 ConstraintError
      await db.reviews.bulkPut(reviews);

      // ---- 卡组（3 个：核心 active / 扩展 archived / 错题 active） ----
      const gCore = { id: 'demo-group-core', name: '2027 考研核心', description: '必须掌握的知识点', color: '#4f7cff', status: 'active', sortOrder: 0, createdAt: t0, updatedAt: t0 };
      const gExt = { id: 'demo-group-ext', name: '2028 扩展', description: '明年再背（备用）', color: '#e6a23c', status: 'archived', sortOrder: 1, createdAt: t0, updatedAt: t0 };
      const gWrong = { id: 'demo-group-wrong', name: '错题重练', description: '薄弱卡集中营', color: '#f56c6c', status: 'active', sortOrder: 2, createdAt: t0, updatedAt: t0 };
      await db.cardGroups.bulkPut([gCore, gExt, gWrong]);

      // ---- 关联：多组 / 仅备用组 / 未分组 三种形态 ----
      const links = [];
      const add = (cardId, groupId) => links.push({ id: `demo-link-${cardId}-${groupId}`, cardId, groupId, addedAt: t0 });
      // 核心组：计网 + OS 重点
      [1, 2, 3, 4, 5, 6, 13, 14, 17, 18, 19, 25, 26, 37, 38, 49, 50].forEach(i => add(`demo-card-${i}`, 'demo-group-core'));
      // 扩展组（备用）：高数/英语靠后 + 新题 → 演示「备用停车」
      [15, 16, 20, 21, 22, 23, 24, 39, 40, 42, 44, 47, 53, 54, 57, 58, 59, 60].forEach(i => add(`demo-card-${i}`, 'demo-group-ext'));
      // 错题组：薄弱卡（learning 档）
      [1, 5, 8, 10, 14, 18, 24, 26, 33, 38, 41, 43, 48, 50, 58].forEach(i => add(`demo-card-${i}`, 'demo-group-wrong'));
      // 一卡多组：TCP 握手 同时在 核心 + 错题；TCP 可靠 在 核心 + 错题
      // 未分组：demo-card-7/9/11/12/27/28/29/30/31/32/34/35/36/45/46/51/52/55/56 保持无组
      await db.cardGroupLinks.bulkPut(links);

      // ---- 知识图谱边（label 型：from/to=front 文本，fromCardId/toCardId=稳定键） ----
      const frontById = new Map(cards.map(c => [c.id, c.front]));
      const edges = [
        ['demo-card-1', 'demo-card-2', 'prereq', '计网', 'TCP 三次握手 → TCP 可靠传输'],
        ['demo-card-13', 'demo-card-14', 'prereq', 'OS', '进程线程 → 死锁'],
        ['demo-card-15', 'demo-card-16', 'prereq', 'OS', '页面置换 → 虚拟内存'],
        ['demo-card-26', 'demo-card-27', 'prereq', '数据结构', 'BST/平衡树 → B+ 树'],
        ['demo-card-25', 'demo-card-36', 'related', '数据结构', '排序与图遍历（算法分析）'],
        ['demo-card-37', 'demo-card-43', 'prereq', '高数', '中值定理 → 泰勒展开'],
        ['demo-card-41', 'demo-card-42', 'related', '高数', '两类反常积分收敛对照'],
        ['demo-card-49', 'demo-card-50', 'prereq', '英语', '虚拟语气现在 → 过去'],
        ['demo-card-52', 'demo-card-56', 'prereq', '英语', '非谓语基本形式 → 完成式'],
      ].map(([from, to, label, subject]) => ({
        id: `demo-edge-${from}-${to}`,
        from: frontById.get(from).slice(0, 30),
        to: frontById.get(to).slice(0, 30),
        fromCardId: from, toCardId: to,
        label, subject, kind: 'manual',
        createdAt: t0, updatedAt: t0,
      }));
      await db.graphEdges.bulkPut(edges);

      // ---- 计划（active/done/archived 状态分布） ----
      await db.plans.bulkPut([
        { id: 'demo-plan-1', title: '408 二轮：计网传输层 + 网络层', content: 'TCP 可靠传输 / 拥塞控制 / 子网划分计算题每日 5 道', status: 'active', createdAt: t0, updatedAt: NOW - 2 * DAY },
        { id: 'demo-plan-2', title: '高数强化：反常积分收敛判别', content: 'p 判别法 + 极限比较法 + 真题专项 20 题', status: 'active', createdAt: t0, updatedAt: NOW - DAY },
        { id: 'demo-plan-3', title: '英语真题 2019-2023 二刷', content: '阅读精翻 + 生词整理进单词本', status: 'done', createdAt: t0 - 10 * DAY, updatedAt: NOW - 5 * DAY },
        { id: 'demo-plan-4', title: '2028 复试口语准备（备用）', content: '自我介绍模板 / 高频问答 30 题', status: 'archived', createdAt: t0 - 8 * DAY, updatedAt: t0 - 6 * DAY },
      ]);

      // ---- AI 文档（summary/note） ----
      await db.docs.bulkPut([
        {
          id: 'demo-doc-1', title: '计网传输层学习小结',
          content: '## 核心要点\n\n- TCP：面向连接、可靠、字节流；三次握手建立、四次挥手释放。\n- 可靠传输五件套：序号、确认、重传、滑动窗口、拥塞控制。\n- UDP：无连接、不可靠、报文，适合实时场景。\n\n## 易错点\n\n- 握手不能是两次：防止已失效的连接请求造成资源浪费。\n- 拥塞控制与流量控制的区别：前者网络视角，后者接收方视角。',
          type: 'summary', tags: ['计网', '传输层'], source: '演示数据',
          createdAt: t0, updatedAt: NOW - DAY,
        },
        {
          id: 'demo-doc-2', title: '高数反常积分笔记',
          content: '## p 判别法\n\n无穷区间：∫₁^∞ 1/xᵖ dx，p>1 收敛。\n瑕积分：∫₀¹ 1/xᵖ dx，p<1 收敛。\n\n## 方法\n\n极限比较法：lim f/g = c（0<c<∞）则同敛散。',
          type: 'note', tags: ['高数', '反常积分'], source: '演示数据',
          createdAt: t0, updatedAt: NOW - 3 * DAY,
        },
      ]);

      // ---- 资料库（docFiles 元数据 ready + docTexts 全文） ----
      await db.docFiles.bulkPut([
        { id: 'demo-file-1', name: '计网TCP笔记.md', ext: 'md', size: 512, mime: 'text/markdown', subject: '计网', status: 'ready', storage: 'opfs', createdAt: t0, updatedAt: t0 },
        { id: 'demo-file-2', name: '408复习计划.txt', ext: 'txt', size: 360, mime: 'text/plain', subject: '408', status: 'ready', storage: 'opfs', createdAt: t0, updatedAt: t0 },
      ]);
      await db.docTexts.bulkPut([
        { id: 'demo-file-1', text: '# 计网 TCP 笔记\n\n## 三次握手\n1. 客户端发 SYN\n2. 服务端回 SYN-ACK\n3. 客户端回 ACK\n\n## 四次挥手\nFIN → ACK → FIN → ACK（2MSL 等待）', textLen: 88, updatedAt: t0 },
        { id: 'demo-file-2', text: '408 复习计划\n\n一、数据结构（已完成二轮）\n二、操作系统：文件系统章节\n三、计网：传输层/网络层\n四、计组：存储系统', textLen: 60, updatedAt: t0 },
      ]);

      // ---- 备忘 + 笔记（搜索/备忘模块演示） ----
      await db.memos.bulkPut([
        { id: 'demo-memo-1', text: '演示备忘：整理计网 TCP 章节错题', important: 1, urgent: 1, at: NOW, createdAt: NOW },
        { id: 'demo-memo-2', text: '演示备忘：下周模拟测试高数级数部分', important: 1, urgent: 0, at: NOW + DAY, createdAt: NOW },
        { id: 'demo-memo-3', text: '演示备忘：单词本加入 50 个新词并过一遍', important: 0, urgent: 1, at: NOW + 2 * DAY, createdAt: NOW },
        { id: 'demo-memo-4', text: '演示备忘：打印 408 真题错题卷', important: 0, urgent: 0, at: NOW + 3 * DAY, createdAt: NOW },
        { id: 'demo-memo-5', text: '演示备忘：预约图书馆讨论间复习计组', important: 1, urgent: 0, at: NOW + 5 * DAY, createdAt: NOW },
      ]);
      await db.notes.bulkPut([
        {
          id: 'demo-note-1',
          title: '演示笔记：复习方法',
          content: '先用卡组把卡片按科目分组，再按「核心组 → 错题组」的顺序复习。\n\n- 核心组每天 20 张\n- 错题组隔天重练\n- 备用组（2028 扩展）不参与日常复习',
          category: '方法',
          tags: ['复习', '演示'],
          linkedCardIds: ['demo-card-1', 'demo-card-14'],
          linkedDocId: null,
          linkedPlanIds: ['demo-plan-1'],
          createdAt: t0,
          updatedAt: NOW,
        },
        {
          id: 'demo-note-2',
          title: '演示笔记：反常积分题型总结',
          content: '## 题型\n\n1. 直接套 p 判别法\n2. 极限比较法（找等价无穷小/无穷大）\n3. 换元化为标准型\n\n## 易错\n\n- 瑕点处理：积分区间内可能有多个瑕点要分段',
          category: '高数',
          tags: ['反常积分', '高数'],
          linkedCardIds: ['demo-card-41', 'demo-card-42'],
          linkedDocId: 'demo-doc-2',
          linkedPlanIds: ['demo-plan-2'],
          createdAt: t0,
          updatedAt: NOW - DAY,
        },
        {
          id: 'demo-note-3',
          title: '演示笔记：英语长难句拆分模板',
          content: '1. 找谓语动词（时态/人称标记）\n2. 断开从句（引导词定位）\n3. 抓主干（主谓宾）\n4. 逐层翻译合并',
          category: '英语',
          tags: ['长难句', '英语'],
          linkedCardIds: ['demo-card-57'],
          linkedDocId: null,
          linkedPlanIds: [],
          createdAt: t0,
          updatedAt: NOW - 2 * DAY,
        },
      ]);

      // ================= 单词本模块 =================
      // ---- 单词卡（word 20 + phrase 8 + sentence 5 + template 3 = 36） ----
      const wmk = (i, kind, word, phonetic, meaning, extra = {}) => {
        const dueOffset = extra.dueOffset ?? (i % 6); // 0=今天到期
        const level = extra.level ?? (i % 5 > 3 ? 4 : 1 + (i % 3));
        const interval = extra.interval ?? (level >= 4 ? 21 + (i % 4) * 9 : 1 + (i % 4));
        return {
          id: `demo-wc-${i}`,
          kind, word, phonetic,
          meaning,
          example: extra.example || '',
          exampleTrans: extra.exampleTrans || '',
          note: extra.note || '',
          tags: extra.tags || ['演示'],
          source: extra.source || '考研大纲',
          subject: '考研',
          familiar: extra.familiar || 0,
          ...(extra.pos ? { pos: extra.pos, defs: extra.defs || [{ pos: extra.pos, meaning }], mnemonics: extra.mnemonics || [], rootAffix: extra.rootAffix || '', confusions: extra.confusions || [] } : {}),
          ease: 2.5, level, intervalDays: interval,
          dueAt: NOW + dueOffset * DAY - (extra.duePast ? 3600e3 : 0),
          reviewedAt: extra.reviewed || 0,
          createdAt: t0 + i * 3600e3, updatedAt: NOW - (i % 5) * DAY,
        };
      };

      const words = [
        // ---- word 类（20，考研高频词） ----
        wmk(1, 'word', 'abandon', "əˈbændən", 'v. 放弃；抛弃', {
          example: 'He abandoned his car in the snow.', exampleTrans: '他弃车于雪中。',
          note: 'a+band+on：乐队解散=放弃', pos: 'v.', mnemonics: ['a(一个)+band(乐队)+on → 乐队散伙=放弃'], rootAffix: 'ab-(离开)+and(给予)+-on', confusions: [{ word: 'abandoned', meaning: 'adj. 被遗弃的' }], familiar: 1, level: 4, interval: 30, reviewed: NOW - 10 * DAY,
        }),
        wmk(2, 'word', 'access', "ˈækses", 'n. 通道；使用权 v. 访问', {
          example: 'Students need access to the library.', exampleTrans: '学生需要使用图书馆。',
          note: 'ac+cess(走)→走近→进入', pos: 'n./v.', mnemonics: ['ac(加强)+cess(走)→走过去→进入'], rootAffix: 'ac-(向)+cess(走)', confusions: [{ word: 'excess', meaning: 'n. 过量' }], dueOffset: 0,
        }),
        wmk(3, 'word', 'achieve', "əˈtʃiːv", 'v. 达到；实现', {
          example: 'You can achieve your goals with hard work.', exampleTrans: '通过努力你可以实现目标。',
          note: 'a+chieve(头)→到达顶点', pos: 'v.', mnemonics: ['a+chieve(chief首领)→成为首领=实现'], rootAffix: '', confusions: [], dueOffset: 1,
        }),
        wmk(4, 'word', 'acquire', "əˈkwaɪər", 'v. 获得；习得', {
          example: 'Children acquire language naturally.', exampleTrans: '儿童自然地习得语言。',
          note: '与 inquire(询问)区分', pos: 'v.', mnemonics: ['ac+quire(追求)→去追求得到'], rootAffix: 'ac-(向)+quire(追求)', confusions: [{ word: 'inquire', meaning: 'v. 询问' }], dueOffset: 0,
        }),
        wmk(5, 'word', 'adequate', "ˈædɪkwət", 'adj. 足够的；胜任的', {
          example: 'The supply is adequate for our needs.', exampleTrans: '供应足以满足我们的需求。',
          note: 'ad+equ(相等)+ate', pos: 'adj.', mnemonics: ['ad+equal→和需求相等=足够'], rootAffix: 'ad-(向)+equ(相等)', confusions: [{ word: 'sufficient', meaning: 'adj. 充足的（正式）' }], dueOffset: 2,
        }),
        wmk(6, 'word', 'advocate', "ˈædvəkeɪt", 'v. 提倡 n. 拥护者', {
          example: 'She advocates for environmental protection.', exampleTrans: '她提倡环境保护。',
          note: 'ad+voc(喊)+ate→为…呐喊', pos: 'v./n.', mnemonics: ['ad+voc(声音)+ate→为…发声'], rootAffix: 'ad-(向)+voc(喊)', confusions: [], dueOffset: 0, familiar: 1, level: 4, interval: 25, reviewed: NOW - 8 * DAY,
        }),
        wmk(7, 'word', 'allocate', "ˈæləkeɪt", 'v. 分配', {
          example: 'The school allocates funds to each department.', exampleTrans: '学校向每个系分配资金。',
          note: 'al+loc(地方)+ate→分到各处', pos: 'v.', mnemonics: ['al+loc(位置)+ate→放到各处'], rootAffix: 'al-(向)+loc(地方)', confusions: [{ word: 'locate', meaning: 'v. 定位' }], dueOffset: 1,
        }),
        wmk(8, 'word', 'alternative', "ɔːlˈtɜːrnətɪv", 'n. 替代方案 adj. 备选的', {
          example: 'Is there an alternative to this plan?', exampleTrans: '这个计划有替代方案吗？',
          note: 'altern(交替)+ative', pos: 'n./adj.', mnemonics: ['alter(改变)+native→改变的选择'], rootAffix: 'altern(交替)+-ative', confusions: [], dueOffset: 3,
        }),
        wmk(9, 'word', 'ambiguous', "æmˈbɪɡjuəs", 'adj. 模棱两可的', {
          example: 'The wording is ambiguous and confusing.', exampleTrans: '措辞模棱两可，令人困惑。',
          note: 'ambi(两)+gu→两边都沾', pos: 'adj.', mnemonics: ['ambi(双)+gu(走)→两边走=含糊'], rootAffix: 'ambi-(两)+gu(走)', confusions: [{ word: 'ambivalent', meaning: 'adj. 矛盾心理的' }], dueOffset: 0,
        }),
        wmk(10, 'word', 'anticipate', "ænˈtɪsɪpeɪt", 'v. 预期；预料', {
          example: 'We anticipate a rise in prices.', exampleTrans: '我们预期价格上涨。',
          note: 'anti(前)+cip(拿)+ate', pos: 'v.', mnemonics: ['anti(前面)+cipate→提前拿→预期'], rootAffix: 'anti-(前)+cip(拿)', confusions: [], dueOffset: 2,
        }),
        wmk(11, 'word', 'appeal', "əˈpiːl", 'v. 呼吁；吸引 n. 上诉', {
          example: 'The idea appeals to young people.', exampleTrans: '这个想法吸引年轻人。',
          note: 'ap+peal(拉)→拉过来', pos: 'v./n.', mnemonics: ['ap+peal(铃)→摇铃呼吁'], rootAffix: 'ap-(向)+peal(驱动)', confusions: [], dueOffset: 1,
        }),
        wmk(12, 'word', 'approach', "əˈproʊtʃ", 'n. 方法 v. 接近', {
          example: 'We need a new approach to the problem.', exampleTrans: '我们需要解决这个问题的新方法。',
          note: 'ap+proach(近)→接近', pos: 'n./v.', mnemonics: ['ap+proach(靠近)→走近=方法'], rootAffix: 'ap-(向)+proach(近)', confusions: [], dueOffset: 0,
        }),
        wmk(13, 'word', 'appropriate', "əˈproʊpriət", 'adj. 恰当的', {
          example: 'Casual clothes are not appropriate for an interview.', exampleTrans: '面试穿休闲装不合适。',
          note: 'ap+propri(自己的)+ate', pos: 'adj.', mnemonics: ['ap+proper(合适)+iate'], rootAffix: 'ap-(向)+propri(自己的)', confusions: [{ word: 'approximate', meaning: 'adj. 大约的' }], dueOffset: 4,
        }),
        wmk(14, 'word', 'assess', "əˈses", 'v. 评估', {
          example: 'Teachers assess students\' progress monthly.', exampleTrans: '老师每月评估学生进步。',
          note: 'as+sess(坐)→坐下来评估', pos: 'v.', mnemonics: ['as+sess(坐)→坐下来评估'], rootAffix: 'as-(向)+sess(坐)', confusions: [{ word: 'access', meaning: 'v. 访问' }], dueOffset: 0,
        }),
        wmk(15, 'word', 'assume', "əˈsuːm", 'v. 假定；承担', {
          example: "Let's assume the data is correct.", exampleTrans: '我们假定数据正确。',
          note: 'as+sum(拿)+e→拿来用=假定', pos: 'v.', mnemonics: ['as+sum(拿)→先拿来做假设'], rootAffix: 'as-(向)+sum(拿)', confusions: [{ word: 'consume', meaning: 'v. 消费' }], dueOffset: 2,
        }),
        wmk(16, 'word', 'attribute', "əˈtrɪbjuːt", 'v. 归因于 n. 属性', {
          example: 'He attributes his success to hard work.', exampleTrans: '他把成功归因于努力。',
          note: 'at+tribut(给)+e', pos: 'v./n.', mnemonics: ['at+tribute(贡品)→把功劳给…'], rootAffix: 'at-(向)+tribut(给)', confusions: [{ word: 'contribute', meaning: 'v. 贡献' }], dueOffset: 0, familiar: 1, level: 4, interval: 22, reviewed: NOW - 9 * DAY,
        }),
        wmk(17, 'word', 'available', "əˈveɪləbl", 'adj. 可获得的；有空的', {
          example: 'The report is available online.', exampleTrans: '报告可以在网上获取。',
          note: 'avail(有用)+able', pos: 'adj.', mnemonics: ['avail(有用)+able→有用的=可用的'], rootAffix: 'avail(有用)+-able', confusions: [], dueOffset: 1,
        }),
        wmk(18, 'word', 'benefit', "ˈbenɪfɪt", 'n. 好处 v. 受益', {
          example: 'Regular exercise benefits your health.', exampleTrans: '规律运动有益健康。',
          note: 'bene(好)+fit(做)', pos: 'n./v.', mnemonics: ['bene(好)+fit(做)→做好事=受益'], rootAffix: 'bene-(好)+fit(做)', confusions: [], dueOffset: 0, familiar: 1, level: 5, interval: 45, reviewed: NOW - 15 * DAY,
        }),
        wmk(19, 'word', 'capacity', "kəˈpæsəti", 'n. 容量；能力', {
          example: 'The stadium has a capacity of 50000.', exampleTrans: '体育场可容纳五万人。',
          note: 'cap(拿)+acity', pos: 'n.', mnemonics: ['cap(拿)+acity→能装下=容量'], rootAffix: 'cap(拿)+-acity', confusions: [], dueOffset: 3, familiar: 1, level: 4, interval: 28, reviewed: NOW - 7 * DAY,
        }),
        wmk(20, 'word', 'compensate', "ˈkɑːmpenseɪt", 'v. 补偿', {
          example: 'Nothing can compensate for the loss.', exampleTrans: '任何东西都无法弥补损失。',
          note: 'com(一起)+pens(称)+ate', pos: 'v.', mnemonics: ['com+pens(支付)→一起支付=赔偿'], rootAffix: 'com-(一起)+pens(称/支付)', confusions: [], dueOffset: 0,
        }),
        // ---- phrase 类（8，考研高频词组） ----
        wmk(21, 'phrase', 'account for', '—', '解释；占（比例）', {
          example: 'Exports account for 40% of GDP.', exampleTrans: '出口占 GDP 的 40%。',
          note: '写作高频：account for + 比例/原因', tags: ['词组', '写作'], source: '考研词组', dueOffset: 0,
        }),
        wmk(22, 'phrase', 'break down', '—', '分解；出故障', {
          example: 'The car broke down on the highway.', exampleTrans: '汽车在高速公路上抛锚了。',
          note: 'break down 还有「情绪崩溃」义', tags: ['词组'], source: '考研词组', dueOffset: 1,
        }),
        wmk(23, 'phrase', 'bring about', '—', '引起；导致', {
          example: 'The reform brought about great changes.', exampleTrans: '改革带来了巨大变化。',
          note: '同义：give rise to / lead to', tags: ['词组', '写作'], source: '考研词组', dueOffset: 0,
        }),
        wmk(24, 'phrase', 'carry out', '—', '执行；实施', {
          example: 'The team carried out the experiment.', exampleTrans: '团队实施了实验。',
          note: 'carry out a plan / an experiment', tags: ['词组'], source: '考研词组', dueOffset: 2,
        }),
        wmk(25, 'phrase', 'come across', '—', '偶然遇见；被理解', {
          example: 'I came across an old friend in the library.', exampleTrans: '我在图书馆偶遇一位老友。',
          note: 'come across 不用被动', tags: ['词组'], source: '考研词组', dueOffset: 0,
        }),
        wmk(26, 'phrase', 'deal with', '—', '处理；应对', {
          example: 'We must deal with this problem now.', exampleTrans: '我们必须现在处理这个问题。',
          note: 'deal with 比 solve 更常用', tags: ['词组', '写作'], source: '考研词组', dueOffset: 3,
        }),
        wmk(27, 'phrase', 'give rise to', '—', '引起；导致', {
          example: 'The policy gave rise to controversy.', exampleTrans: '该政策引发了争议。',
          note: '书面语，写作加分项', tags: ['词组', '写作'], source: '考研词组', dueOffset: 1,
        }),
        wmk(28, 'phrase', 'make sense of', '—', '理解；弄懂', {
          example: "I can't make sense of this passage.", exampleTrans: '我读不懂这篇文章。',
          note: 'make sense（讲得通）的及物形式', tags: ['词组'], source: '考研词组', dueOffset: 0,
        }),
        // ---- sentence 类（5，作文万能句） ----
        wmk(29, 'sentence', 'It is widely acknowledged that …', '—', '人们普遍认为……', {
          example: 'It is widely acknowledged that education is the key to success.', exampleTrans: '人们普遍认为教育是成功的关键。',
          note: '首段亮观点句', tags: ['写作', '模板句'], source: '作文句型', dueOffset: 1,
        }),
        wmk(30, 'sentence', 'There is no denying that …', '—', '不可否认……', {
          example: 'There is no denying that the Internet has changed our lives.', exampleTrans: '不可否认，互联网改变了我们的生活。',
          note: '后接完整从句', tags: ['写作', '模板句'], source: '作文句型', dueOffset: 0,
        }),
        wmk(31, 'sentence', 'What matters most is not … but …', '—', '最重要的不是……而是……', {
          example: 'What matters most is not the result but the process.', exampleTrans: '最重要的不是结果而是过程。',
          note: '对比强调结构', tags: ['写作', '模板句'], source: '作文句型', dueOffset: 2,
        }),
        wmk(32, 'sentence', 'Only in this way can we …', '—', '只有这样我们才能……', {
          example: 'Only in this way can we achieve sustainable development.', exampleTrans: '只有这样我们才能实现可持续发展。',
          note: 'only+状语提前 → 部分倒装', tags: ['写作', '倒装'], source: '作文句型', dueOffset: 0,
        }),
        wmk(33, 'sentence', 'It is high time that we took measures to …', '—', '是时候采取措施……了', {
          example: 'It is high time that we took measures to protect the environment.', exampleTrans: '是时候采取措施保护环境了。',
          note: 'that 从句用过去式（虚拟）', tags: ['写作', '虚拟语气'], source: '作文句型', dueOffset: 1,
        }),
        // ---- template 类（3，作文模板） ----
        wmk(34, 'template', '大作文框架（现象类）', '—', '首段描述现象 → 第二段分析原因（2-3 点）→ 第三段建议/展望', {
          example: 'As is vividly shown in the picture, … The reasons are as follows. To begin with, … Moreover, … In conclusion, …',
          exampleTrans: '如图生动所示……原因如下：首先……其次……总之……',
          note: '总分总结构，每段首句点题', tags: ['作文模板', '大作文'], source: '作文模板', dueOffset: 2,
        }),
        wmk(35, 'template', '小作文书信模板', '—', '称呼 → 开场白 → 要点 2-3 条 → 结尾致谢 → 落款', {
          example: 'Dear Sir or Madam, I am writing to … To begin with, … What is more, … I would be grateful if you could … Yours sincerely, Li Ming',
          exampleTrans: '尊敬的先生/女士，我写信是为了……首先……此外……如您能……我将不胜感激。您真诚的，李明',
          note: '落款统一 Li Ming / Zhang Wei', tags: ['作文模板', '小作文'], source: '作文模板', dueOffset: 1,
        }),
        wmk(36, 'template', '图表描述模板', '—', '总起 → 数据变化 → 对比 → 结论', {
          example: 'As is shown in the chart, the number of … increased steadily from … to … In contrast, … This trend reflects …',
          exampleTrans: '如图所示，……的数量从……稳步增长到……相比之下……这一趋势反映了……',
          note: '数据变化用 increase/decrease/fluctuate/remain stable', tags: ['作文模板', '图表'], source: '作文模板', dueOffset: 3,
        }),
      ];
      await db.wordCards.bulkPut(words);

      // ---- 单词复习历史（近 30 天 3-8 条/词） ----
      const wordReviews = [];
      for (const w of words) {
        if (w.kind === 'template') continue; // 模板不复习
        const n = 3 + (Number(w.id.slice(-1)) % 6);
        let t = NOW - (n + 2) * DAY;
        for (let k = 0; k < n; k++) {
          t += 1.5 * DAY;
          wordReviews.push({
            id: `demo-wrev-${w.id}-${k}`,
            cardId: w.id,
            rating: k === n - 1 ? 2 : (k % 2),
            reviewedAt: Math.min(t, NOW - (k === n - 1 ? 0 : 3600e3)),
            intervalDays: Math.min(w.intervalDays || 1, k + 1),
          });
        }
      }
      await db.wordReviews.bulkPut(wordReviews);

      // ---- 单词词组（3 个）+ 关联 ----
      const wgCore = { id: 'demo-wg-core', name: '考研高频核心', description: '大纲核心词汇', status: 'active', sortOrder: 0, createdAt: t0, updatedAt: t0 };
      const wgPhrase = { id: 'demo-wg-phrase', name: '高频词组', description: '写作阅读高频短语', status: 'active', sortOrder: 1, createdAt: t0, updatedAt: t0 };
      const wgEssay = { id: 'demo-wg-essay', name: '作文模板库', description: '备用：考前突击作文', status: 'archived', sortOrder: 2, createdAt: t0, updatedAt: t0 };
      await db.wordGroups.bulkPut([wgCore, wgPhrase, wgEssay]);

      const wordLinks = [];
      const wadd = (cardId, groupId) => wordLinks.push({ id: `demo-wlink-${cardId}-${groupId}`, cardId, groupId, addedAt: t0 });
      for (let i = 1; i <= 20; i++) wadd(`demo-wc-${i}`, 'demo-wg-core');       // word 全进核心
      for (let i = 21; i <= 28; i++) wadd(`demo-wc-${i}`, 'demo-wg-phrase');    // phrase 进词组
      for (let i = 29; i <= 36; i++) wadd(`demo-wc-${i}`, 'demo-wg-essay');     // sentence+template 进模板库
      // 少量一卡多组（熟词也进词组组，演示多组形态）
      ['demo-wc-1', 'demo-wc-18', 'demo-wc-27'].forEach(id => wadd(id, 'demo-wg-phrase'));
      await db.wordGroupLinks.bulkPut(wordLinks);

      // ---- 单词打卡：连续 21 天（含今天） ----
      const checkins = [];
      const nowD = new Date();
      for (let back = 20; back >= 0; back--) {
        const d = new Date(nowD);
        d.setDate(d.getDate() - back);
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        checkins.push({ id: `c-${date}`, date, count: 21 - back, createdAt: t0 + (20 - back) * DAY });
      }
      await db.wordCheckins.bulkPut(checkins);
    });
}
