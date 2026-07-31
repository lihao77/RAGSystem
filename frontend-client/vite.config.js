import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const devPort = Number(env.VITE_DEV_PORT || 5174)
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:5002'

  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    server: {
      port: devPort,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
          ws: true,
        },
      },
      host: true,
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalizedId = id.replace(/\\/g, '/')
            if (normalizedId.includes('/node_modules/zrender/')) return 'vendor-zrender'
            if (normalizedId.includes('/node_modules/@ragsystem/chat-sdk-core/')
              || normalizedId.includes('/packages/chat-sdk-core/')) return 'vendor-chat-sdk'
            return undefined
          },
        },
      },
    },
  }
})
