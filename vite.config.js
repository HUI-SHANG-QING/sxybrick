import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/sxybrick/',
  plugins: [
    vue(),
    // P3-2 PWA 离线优化：registerType=autoUpdate 让新版本后台预缓存完毕后激活；
    //   workbox.runtimeCaching 分层缓存策略——
    //   · CDN 字体（Google Fonts）：CacheFirst（高频稳定、长期不变）
    //   · 图片源（图床/icon）：StaleWhileRevalidate（秒级可用、后台回源更新）
    //   · OpenAI 兼容 API 请求：NetworkOnly（绝不缓存：每条答案都不同，缓存会污染对话）
    //   · 同源静态资源（assets）：StaleWhileRevalidate（构建产物带 hash，离线优先，后台回源校对）
    // manifest.shortcuts：让 PWA 桌面图标长按 / 拖出菜单直达「背诵 / 添加卡片 / 模考」
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'SxyBrick 记忆卡片',
        short_name: 'SxyBrick',
        description: '离线记忆卡片 · 手动导出/导入同步',
        theme_color: '#16202c',
        background_color: '#f5f6f8',
        display: 'standalone',
        start_url: '/sxybrick/',
        scope: '/sxybrick/',
        icons: [
          { src: 'icon-hero-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-hero-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon-hero-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
        shortcuts: [
          { name: '今日背诵', short_name: '背诵', url: '/sxybrick/#/review', icons: [{ src: 'icon-hero-192.png', sizes: '192x192' }] },
          { name: '添加卡片', short_name: '卡片', url: '/sxybrick/#/cards', icons: [{ src: 'icon-hero-192.png', sizes: '192x192' }] },
          { name: '组卷模考', short_name: '模考', url: '/sxybrick/#/exam', icons: [{ src: 'icon-hero-192.png', sizes: '192x192' }] },
        ],
      },
      workbox: {
        // 预缓存清单除默认构建产物外，再追加图标，确保离线启动画面可见
        additionalManifestEntries: [
          { url: 'icon.svg', revision: null },
          { url: 'icon-hero-192.png', revision: null },
        ],
        // 静态资源带 hash，maxAge 拉长到 30 天不会拿到陈旧版本；上限提到 100 条避免被清
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            // 图床 / 图标源：StaleWhileRevalidate（先返回缓存秒级可用，后台异步拉新版）
            urlPattern: ({ url, request }) => request.destination === 'image',
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'sxybrick-img',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 14 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // OpenAI 兼容 API（chat/completions 等）：NetworkOnly，绝不缓存
            //   原因：AI 每次响应内容不同，缓存命中会让对话串台；这里显式声明以避免被通用规则误捕
            urlPattern: ({ url }) => /\/v\d+\/(chat\/completions|completions|embeddings|messages)$/i.test(url.pathname) || url.hostname.endsWith('openai.com') || url.hostname.endsWith('deepseek.com'),
            handler: 'NetworkOnly',
            options: { cacheName: 'sxybrick-ai-nocache' },
          },
          {
            // 同源静态资源（assets/*）：带 hash 的构建产物，SWR 优先离线
            urlPattern: ({ url, sameOrigin }) => sameOrigin && /\/assets\/|\/(index|manifest)\.json|\.webmanifest$/i.test(url.pathname),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'sxybrick-assets',
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        // 开发态不注册 SW（2026-08-29 修复白屏）：dev SW 会用 SWR 缓存 dev server 的非 hash 资源，
        // dev server 重启 / 依赖重新优化后，SW 仍返回旧模块 → import 失败 → 整页白屏。
        // 生产 build 的 workbox 离线缓存完全不受影响（build 时按上方配置生成 sw.js）。
        enabled: false,
        type: 'autoUpdate',
      },
    }),
  ],
  server: {
    port: 5173,
    host: true, // 允许局域网内手机/平板访问开发服务
  },
  build: {
    // 代码分割兜底：把重型依赖强制分到独立 chunk，避免被任何路由/组件的静态 import 拖入首屏
    // 配合路由懒加载 + MarkdownRenderer/ThreeDCharacter 的按需加载，最大化首屏体积优化
    chunkSizeWarningLimit: 950,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/echarts')) return 'echarts';
          if (id.includes('node_modules/echarts-wordcloud')) return 'echarts';
          if (id.includes('node_modules/katex')) return 'katex';
          if (id.includes('node_modules/highlight.js')) return 'hljs';
          if (id.includes('node_modules/marked')) return 'marked';
          // Element Plus 全量注册：拆成独立 chunk 做长期缓存。
          // ⚠ 铁律：icons-vue 必须与 element-plus 同 chunk（2026-08-29 修复）——
          //   EP 内部组件 import icons，icons 的 rollup 产物又反向引用 EP 模块，
          //   拆成两个 chunk 会形成跨 chunk 循环依赖，生产构建运行时抛
          //   "Cannot access 'x' before initialization"(TDZ) → 整页白屏。
          //   dev 模式无此问题（Vite 预构建 ESM live binding 可容忍循环）。
          if (id.includes('node_modules/@element-plus/icons-vue') || id.includes('node_modules/element-plus')) return 'element-plus';
          // tesseract.js 仅 CJS 入口，commonjs 插件会把动态 import 内联进主 bundle——
          // 强制拆独立 chunk，确保 OCR 引擎懒加载不进首屏
          if (id.includes('node_modules/tesseract.js')) return 'tesseract';
        },
      },
    },
  },
});