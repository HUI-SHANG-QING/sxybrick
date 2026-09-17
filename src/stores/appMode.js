// src/stores/appMode.js
// M3 演示模式：Pinia store 管理 'real' | 'test' 切换。
// 隔离模型（与 db.js 双实例配合）：
//   - 真实数据 → Dexie('sxybrick')；测试数据 → Dexie('sxybrick-test')（物理隔离，互不可见）
//   - 切换 = localStorage 标记 + setDbInstance() + 整页 reload（保证所有视图/缓存重查）
//   - 进入演示模式时若测试库为空 → testDataSeeder 自动填充示例数据
import { defineStore } from 'pinia';
import { setDbInstance, currentDbMode, MODE_KEY } from '../db.js';
import { seedTestDatabase, testDbEmpty, refreshDemoSchedule } from '../utils/testDataSeeder.js';

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
          // round108【真机实测发现的竞态】：main.js 这里是 fire-and-forget（没 await），
          // 播种 60 卡 + 96 复习要好几秒，而 `app.mount()` 早就跑了 → 总览页读到**播种前的空库**
          // 并把 0 缓存进共享快照，此后不会自己刷新（实测：首进全 0、手动重进才显示 60 卡/51 待复习）。
          // 修法沿用「切演示模式」已有的模式：**播种完就 reload 一次**，让所有视图在数据就绪后重新挂载。
          // 一次性守卫防死循环（万一播种未落库，键存在则不再 reload）。
          const empty = await testDbEmpty();
          if (empty) {
            await seedTestDatabase();
            const GUARD = 'sxy_demo_seeded_reload';
            const done = (() => { try { return sessionStorage.getItem(GUARD) === '1'; } catch { return true; } })();
            if (!done) {
              try { sessionStorage.setItem(GUARD, '1'); } catch { /* 隐私模式：跳过守卫，直接 reload 一次 */ }
              location.reload();
              return;
            }
          } else {
            // round33 S-3：演示库非空（非首播）时做「时间滚动」——过夜/隔周后 demo 卡
            // 的 dueAt 已集体过期，全部显示逾期会让演示失真，重新铺到今天起 0~5 天。
            await refreshDemoSchedule();
          }
        } catch { /* 播种/滚动失败不阻塞启动：用户可手动重试（进入演示模式入口） */ }
      }
    },
    /** 进入演示模式（切换实例 + reload） */
    async enterTestMode() {
      try {
        setDbInstance('test');
        this.mode = 'test';
        if (typeof localStorage !== 'undefined') localStorage.setItem(MODE_KEY, 'test');
        if (await testDbEmpty()) await seedTestDatabase();
        else await refreshDemoSchedule(); // round33 S-3：非首播进入演示也滚动到期时间
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
      // round17 R17-32：此前手写 35 表清单已落后 schema（漏 word 系列 8 表 + wordExportHistory），
      // 测试库残留单词数据会串到下一次演示。改由 db.tables 动态枚举——新增表不再有漏清风险
      // （与 stores/reset.js 的 resetAllData 同款思路）。
      const tables = db.tables.map((t) => t);
      await db.transaction('rw', tables, async () => {
        for (const t of tables) await t.clear();
      });
    },
  },
});
