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
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    host: true, // 允许局域网内手机/平板访问开发服务
  },
});