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
            // Google Fonts CSS + woff2：长期稳定且带正确 long-term 缓存头，CacheFirst 最省请求
            urlPattern: ({ url }) => url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'sxybrick-fonts',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
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
        // 开发态也启用 SW，方便在 dev 下验证离线缓存策略（生产 build 仍按上面 workbox 配置走）
        enabled: true,
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
          if (id.includes('node_modules/element-plus')) return 'element-plus';
          if (id.includes('node_modules/marked')) return 'marked';
        },
      },
    },
  },
});