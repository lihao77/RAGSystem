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
        // axios 被 npm workspace 提升到 root node_modules，
        // vite 7 dep optimizer 用 fs.readFile 扫 frontend-client/node_modules 找不到，
        // 显式指向 root 实际位置（修复 504 Outdated Optimize Dep）
        'axios': path.resolve(__dirname, '..', 'node_modules', 'axios'),
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
            if (normalizedId.includes('/node_modules/echarts/') || normalizedId.includes('/node_modules/zrender/')) {
              return 'vendor-echarts'
            }
          },
        },
      },
    },
  }
})
