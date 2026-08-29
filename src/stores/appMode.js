// src/stores/appMode.js
// M3 演示模式：Pinia store 管理 'real' | 'test' 切换。
// 隔离模型（与 db.js 双实例配合）：
//   - 真实数据 → Dexie('sxybrick')；测试数据 → Dexie('sxybrick-test')（物理隔离，互不可见）
//   - 切换 = localStorage 标记 + setDbInstance() + 整页 reload（保证所有视图/缓存重查）
//   - 进入演示模式时若测试库为空 → testDataSeeder 自动填充示例数据
import { defineStore } from 'pinia';
import { setDbInstance, currentDbMode, MODE_KEY } from '../db.js';
import { seedTestDatabase, testDbEmpty } from '../utils/testDataSeeder.js';

export const useAppModeStore = defineStore('appMode', {
  state: () => ({
    // 初始值与 db.js 的 live binding 保持一致（两者都读 MODE_KEY）
    mode: currentDbMode(),
  }),
  getters: {
    isTest: (s) => s.mode === 'test',
    modeLabel: (s) => s.mode === 'test' ? '演示模式' : '真实数据',
  },
  actions: {
    /**
     * 启动时对齐：把 db 实例与 localStorage 标记对齐（main.js 在 mount 前 await）。
     * 进入 test 模式且测试库为空 → 自动播种示例数据。
     */
    async init() {
      const wanted = (typeof localStorage !== 'undefined' && localStorage.getItem(MODE_KEY) === 'test') ? 'test' : 'real';
      setDbInstance(wanted);
      this.mode = wanted;
      if (wanted === 'test') {
        try {
          if (await testDbEmpty()) await seedTestDatabase();
        } catch { /* 播种失败不阻塞启动：用户可手动重试（进入演示模式入口） */ }
      }
    },
    /** 进入演示模式（切换实例 + reload） */
    async enterTestMode() {
      try {
        setDbInstance('test');
        this.mode = 'test';
        if (typeof localStorage !== 'undefined') localStorage.setItem(MODE_KEY, 'test');
        if (await testDbEmpty()) await seedTestDatabase();
      } finally {
        location.reload();
      }
    },
    /** 退出演示模式（恢复真实数据 + reload；测试数据保留，下次进入仍在） */
    exitTestMode() {
      setDbInstance('real');
      this.mode = 'real';
      if (typeof localStorage !== 'undefined') localStorage.removeItem(MODE_KEY);
      location.reload();
    },
    /** 清空测试库（重置演示数据；真实数据不受影响） */
    async clearTestData() {
      const { db } = await import('../db.js');
      if (this.mode !== 'test') return;
      await db.transaction('rw',
        db.cards, db.reviews, db.images, db.tombstones, db.meta,
        db.aiChats, db.aiMemories, db.memos, db.plans, db.graphEdges,
        db.docs, db.pomoSessions, db.mindmaps, db.weeklyReports, db.achievements,
        db.exams, db.embeddings, db.notifications, db.errors, db.userOps,
        db.privacyRecords, db.snapshots, db.plugins, db.docFiles, db.docTexts,
        db.notes, db.dailyPlans, db.dailyTasks, db.trash, db.aiUsage,
        db.cardGroups, db.cardGroupLinks, db.analysisSessions, db.analysisMessages,
        async () => {
          for (const t of [db.cards, db.reviews, db.images, db.tombstones, db.meta,
            db.aiChats, db.aiMemories, db.memos, db.plans, db.graphEdges,
            db.docs, db.pomoSessions, db.mindmaps, db.weeklyReports, db.achievements,
            db.exams, db.embeddings, db.notifications, db.errors, db.userOps,
            db.privacyRecords, db.snapshots, db.plugins, db.docFiles, db.docTexts,
            db.notes, db.dailyPlans, db.dailyTasks, db.trash, db.aiUsage,
            db.cardGroups, db.cardGroupLinks, db.analysisSessions, db.analysisMessages]) {
            await t.clear();
          }
        });
    },
  },
});
