import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const devPort = Number(env.VITE_DEV_PORT || 5174)
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:5001'

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
            if (normalizedId.includes('/node_modules/zrender/')) {
              return 'vendor-zrender'
            }
            if (normalizedId.includes('/node_modules/echarts/')) {
              if (normalizedId.includes('/node_modules/echarts/lib/chart/')) {
                return 'vendor-echarts-charts'
              }
              if (normalizedId.includes('/node_modules/echarts/lib/component/')) {
                return 'vendor-echarts-components'
              }
              if (normalizedId.includes('/node_modules/echarts/lib/coord/')) {
                return 'vendor-echarts-coord'
              }
              return 'vendor-echarts-core'
            }
          },
        },
      },
    },
  }
})
