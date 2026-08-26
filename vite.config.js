import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/sxybrick/',
  plugins: [
    vue(),
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