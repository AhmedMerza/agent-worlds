import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Dev: the Vite server on 5190 proxies REST + websockets to the server (mock: 4322).
const target = 'http://127.0.0.1:4322'
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5190,
    strictPort: true,
    proxy: {
      '/api': target,
      '/ws': { target, ws: true },
      '/pty': { target, ws: true },
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
})
