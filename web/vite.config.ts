import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server proxies all /api calls to the on-premise backend (tablet) on :8080.
// SSE (text/event-stream) works through the proxy because we disable buffering.
// Backend target is overridable via env (VITE_API_TARGET) for cases where :8080
// is taken and the backend runs on another local port. Read via globalThis to
// avoid needing @types/node just for the config.
const apiTarget =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.VITE_API_TARGET ?? 'http://localhost:8080'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind to all interfaces so the dev UI is reachable from other PCs on the LAN.
    host: true,
    // Allow access via the machine's LAN IP / hostname (Vite host check).
    allowedHosts: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        // Required so EventSource (SSE) is streamed, not buffered.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Accept-Encoding', 'identity')
          })
        },
      },
    },
  },
})
