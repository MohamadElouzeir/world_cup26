import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Files baked into the precache (the app shell + icons).
      includeAssets: [
        'icon.svg',
        'icon-maskable.svg',
        'apple-touch-icon.png',
      ],
      manifest: {
        name: 'World Cup 2026 · Bedtime Tracker',
        short_name: 'WC26 Tracker',
        description:
          'Personal World Cup 2026 tracker showing KSA kickoff times, with late-night games filtered out.',
        theme_color: '#0f172a',
        background_color: '#020617',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: 'icon-maskable.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
          {
            src: 'apple-touch-icon.png',
            sizes: '180x180',
            type: 'image/png',
            purpose: 'any',
          },
        ],
      },
      workbox: {
        // Precache the built JS/CSS/HTML for instant, offline app shell.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        runtimeCaching: [
          {
            // The live match feed: prefer fresh data, fall back to cache
            // when offline so the app still shows the last-known fixtures.
            urlPattern: ({ url }) =>
              url.origin === 'https://worldcup26.ir',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'wc26-games',
              networkTimeoutSeconds: 6,
              expiration: {
                maxEntries: 8,
                maxAgeSeconds: 60 * 60 * 24, // keep last response up to 1 day
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        // Let us test the SW/manifest during `npm run dev` too.
        enabled: true,
        type: 'module',
      },
    }),
  ],
})
