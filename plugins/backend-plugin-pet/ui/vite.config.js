import { resolve } from 'node:path';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// 插件 UI bundle 构建（lib 模式，ESM 单文件输出 ui/dist/bundle.js）。
// 不打 external：bundle 自带 Vue 运行时，宿主经 mountView DOM 边界挂载（见 docs/PLUGIN_UI.md）。
export default defineConfig({
  root: __dirname,
  plugins: [vue()],
  // Vue 的 esm-bundler 构建含 process.env.NODE_ENV 守卫；Vite lib 模式不自动替换，
  // 浏览器无 process 会直接抛 ReferenceError——必须显式 define 掉。
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/entry.js'),
      formats: ['es'],
      name: 'pet-ui',
      fileName: () => 'bundle.js',
    },
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    target: 'es2020',
    rollupOptions: {
      output: {
        // CSS 固定文件名：mountView 以 import.meta.url 推导同目录 <link>（lib 模式 CSS 不会内联进 JS）
        assetFileNames: (assetInfo) => (assetInfo.names?.[0]?.endsWith('.css') ? 'style.css' : 'assets/[name][extname]'),
      },
    },
  },
});
