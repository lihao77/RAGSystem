import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import cesium from 'vite-plugin-cesium'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue(), cesium()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    port: 8080,
    proxy: {
      '/api': {
        target: 'http://10.24.250.158:5000',
        changeOrigin: true
      },
      '/neo4j': {
        target: 'http://10.24.250.158:7474',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/neo4j/, '')
      }
    }
  }
})