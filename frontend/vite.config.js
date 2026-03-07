import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import cesium from 'vite-plugin-cesium'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const devPort = Number(env.VITE_DEV_PORT || 8080)
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:5000'
  const neo4jProxyTarget = env.VITE_NEO4J_PROXY_TARGET || 'http://localhost:7474'

  return {
    plugins: [vue(), cesium()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      host: true,
      port: devPort,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
        },
        '/neo4j': {
          target: neo4jProxyTarget,
          changeOrigin: true,
          rewrite: (requestPath) => requestPath.replace(/^\/neo4j/, ''),
        },
      },
    },
  }
})
