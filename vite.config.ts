import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    includeAssets: ['favicon.svg'],
    manifest: {
      name: 'MyNews', short_name: 'MyNews', description: 'Personal news monitoring',
      theme_color: '#111827', background_color: '#f5f7fb', display: 'standalone',
      start_url: '/', scope: '/',
      icons: [
        { src: '/pwa-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
        { src: '/pwa-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' }
      ]
    },
    workbox: { navigateFallback: '/index.html', globPatterns: ['**/*.{js,css,html,svg,png,ico}'] }
  })],
  server: { port: 5174, proxy: { '/api': 'http://127.0.0.1:8787' } }
});
