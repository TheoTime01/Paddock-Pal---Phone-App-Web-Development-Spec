import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // Three pages, one origin (§1). No framework: the capture page is a state
  // machine and a render loop, and React buys nothing here.
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        capture: resolve(__dirname, 'capture/index.html'),
        watch: resolve(__dirname, 'watch/index.html'),
      },
    },
  },
  worker: { format: 'es' },
  server: {
    host: true, // the turret phone tests against the dev machine over LAN
    proxy: {
      // `wrangler dev worker/index.js` on 8787 serves /api/session locally.
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
