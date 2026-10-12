import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Dev against the REAL server: it rejects requests whose Origin is not its own host, so add
// "localhost:5190" to `extraHosts` in ~/.config/agent-worlds/config.json (then restart the server).
// The mock server (web/mock/server.mjs) does no origin check.
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
