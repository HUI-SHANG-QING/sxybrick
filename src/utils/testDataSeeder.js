// src/utils/testDataSeeder.js
// M3 演示模式：预置测试数据。首次进入演示模式且测试库为空时自动填充，
// 让各功能（卡片/复习/卡组/搜索/同步/分析）都能立即演示。
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
 *   - 20 张卡片，覆盖 5 个科目（计网/OS/数据结构/高数/英语），含 tags 与不同掌握度
 *   - 复习记录：已背过的卡有 reviews 行 + 推进的 SRS 状态；新卡 dueAt 落在今天（可立即复习）
 *   - 3 个卡组：「2027 考研核心」(active)、「2028 扩展」(archived 备用)、「错题重练」(active)
 *   - 卡片-卡组关联：覆盖多组、仅备用组、未分组三种形态（用于演示备用停车）
 *   - 2 条备忘 + 1 条笔记（供搜索/备忘模块演示）
 */
export async function seedTestDatabase() {
  const t0 = NOW - 14 * DAY;
  await db.transaction('rw',
    db.cards, db.reviews, db.cardGroups, db.cardGroupLinks, db.memos, db.notes, db.meta,
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
        // 计网（4）
        mk(1, 'TCP 三次握手的过程？', 'SYN → SYN-ACK → ACK；建立全双工连接，防止已失效的连接请求突然到达服务端造成资源浪费。', '计网', ['计网', '传输层', 'TCP'], learning(1)),
        mk(2, 'TCP 如何保证可靠传输？', '序号 + 确认（ACK）+ 超时重传 + 滑动窗口 + 拥塞控制。', '计网', ['计网', '传输层', 'TCP'], mastered(1, 12)),
        mk(3, 'DNS 的解析流程？', '本地缓存 → hosts → 本地 DNS 服务器（递归/迭代查询根、TLD、权威服务器）→ CNAME 链。', '计网', ['计网', '应用层', 'DNS'], learning(2)),
        mk(4, 'HTTP/1.1 与 HTTP/2 的核心差异？', 'H2 二进制分帧、头部压缩（HPACK）、多路复用（单连接并发）、服务端推送。', '计网', ['计网', '应用层', 'HTTP'], fresh(3)),
        // 操作系统（4）
        mk(5, '进程与线程的区别？', '进程是资源分配的基本单位，线程是 CPU 调度的基本单位；同进程线程共享地址空间，切换开销小。', 'OS', ['操作系统', '进程'], mastered(2, 20)),
        mk(6, '死锁的四个必要条件？', '互斥、持有并等待、不可剥夺、循环等待；破坏任一条件即可预防。', 'OS', ['操作系统', '同步'], learning(3)),
        mk(7, '页面置换算法的比较？', 'FIFO（Belady 异常）/ Optimal（理论下界）/ LRU（近似 Optimal，常用）/ CLOCK（LRU 近似实现）。', 'OS', ['操作系统', '内存'], fresh(4)),
        mk(8, '虚拟内存的作用？', '以磁盘换空间，提供比物理内存更大的逻辑地址空间；按需调入 + 页表映射。', 'OS', ['操作系统', '内存', '虚拟内存'], learning(4)),
        // 数据结构（4）
        mk(9, '时间复杂度 O(n log n) 的排序算法？', '归并排序（稳定）、堆排序（不稳定）、快排平均 O(n log n) 最坏 O(n²)。', '数据结构', ['数据结构', '排序'], mastered(3, 30)),
        mk(10, '二叉搜索树与平衡树的区别？', 'BST 有序性；BST 退化为链 O(n)，平衡树（AVL/红黑）保证 O(log n)。', '数据结构', ['数据结构', '树'], learning(5)),
        mk(11, 'B+ 树为什么适合数据库索引？', '矮胖（多路）、非叶子不存数据、叶子链表相连 → 范围查询 + 磁盘 IO 少。', '数据结构', ['数据结构', '树', '数据库'], fresh(5)),
        mk(12, '哈希表冲突的解决方法？', '开放定址（线性/二次探测）、链地址法；负载因子与再散列。', '数据结构', ['数据结构', '哈希'], learning(1)),
        // 高数（4）
        mk(13, '中值定理的条件与结论？', '闭区间连续 + 开区间可导 → 存在 ξ 使 f′(ξ) = (f(b)-f(a))/(b-a)。', '高数', ['高数', '中值定理'], mastered(4, 15)),
        mk(14, '判断级数收敛的常用方法？', '比较判别法、比值/根值判别法、莱布尼茨（交错）、p-级数（p>1 收敛）。', '高数', ['高数', '级数'], learning(2)),
        mk(15, '二重积分化为累次积分的步骤？', '画出积分区域 → 判断 X/Y 型 → 定上下限 → 先内后外积分。', '高数', ['高数', '积分'], fresh(6)),
        mk(16, '特征值与特征向量的定义？', 'Av = λv（v≠0）；|A-λE|=0 求 λ，再解 (A-λE)x=0 求 v。', '高数', ['高数', '线性代数'], learning(6)),
        // 英语（4）
        mk(17, '虚拟语气：与现在事实相反', 'If + 过去式, 主句 would/could + 动词原形。如 If I were you…', '英语', ['英语', '语法', '虚拟语气'], mastered(5, 8)),
        mk(18, '虚拟语气：与过去事实相反', 'If + had done, 主句 would have done。如 If I had studied…', '英语', ['英语', '语法', '虚拟语气'], learning(7)),
        mk(19, '定语从句 which/that 的区别？', '限制性从句两者皆可；介词后只用 which；先行词为 all/only 等时倾向 that。', '英语', ['英语', '语法', '从句'], fresh(7)),
        mk(20, '非谓语动词作状语的条件？', '逻辑主语 = 主句主语；doing（主动/进行）、done（被动/完成）、to do（目的/将来）。', '英语', ['英语', '语法', '非谓语'], learning(8)),
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
      // 核心组：计网 + OS 前 4 张
      ['demo-card-1', 'demo-card-2', 'demo-card-3', 'demo-card-4', 'demo-card-5', 'demo-card-6'].forEach(id => add(id, 'demo-group-core'));
      // 扩展组（备用）：高数后 2 张 + 英语后 2 张 → 演示「备用停车」
      ['demo-card-15', 'demo-card-16', 'demo-card-19', 'demo-card-20'].forEach(id => add(id, 'demo-group-ext'));
      // 错题组：挑几张薄弱卡（learning 档）
      ['demo-card-1', 'demo-card-6', 'demo-card-10', 'demo-card-14'].forEach(id => add(id, 'demo-group-wrong'));
      // 一卡多组：TCP 握手 同时在 核心 + 错题
      // 未分组：demo-card-7/8/9/11/12/13/17/18 保持无组（向后兼容演示）
      await db.cardGroupLinks.bulkPut(links);

      // ---- 备忘 + 笔记（搜索/备忘模块演示） ----
      await db.memos.bulkPut([
        { id: 'demo-memo-1', text: '演示备忘：整理计网 TCP 章节错题', important: 1, urgent: 1, at: NOW, createdAt: NOW },
        { id: 'demo-memo-2', text: '演示备忘：下周模拟测试高数级数部分', important: 1, urgent: 0, at: NOW + DAY, createdAt: NOW },
      ]);
      await db.notes.put({
        id: 'demo-note-1',
        title: '演示笔记：复习方法',
        content: '先用卡组把卡片按科目分组，再按「核心组 → 错题组」的顺序复习。\n\n- 核心组每天 20 张\n- 错题组隔天重练\n- 备用组（2028 扩展）不参与日常复习',
        category: '方法',
        tags: ['复习', '演示'],
        linkedCardIds: ['demo-card-1', 'demo-card-6'],
        linkedDocId: null,
        linkedPlanIds: [],
        createdAt: t0,
        updatedAt: NOW,
      });
    });
}
