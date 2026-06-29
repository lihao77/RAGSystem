import { resolve } from "node:path";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

/**
 * widget 打包配置：Vue defineCustomElement → 单文件 UMD bundle。
 *
 * - customElement:true 把每个 .vue 编译成带 attachShadow 的 Custom Element，样式天然 Shadow DOM 隔离。
 * - 单文件 bundle：vue runtime + @ragsystem/agent-protocol + markdown-it + 组件全内联，
 *   宿主页一个 <script src> 引入即可，零宿主依赖、零构建工具。
 * - 产物 dist/ragsystem-widget.umd.cjs 暴露全局 RagWidget（见 src/web-component/define.ts）。
 */
export default defineConfig({
  plugins: [vue({ customElement: true })],
  // 依赖（vue/markdown-it/highlight.js）含 process.env.NODE_ENV 检查；浏览器无 process 全局，
  // 静态替换为对象字面，避免 ReferenceError: process is not defined。
  define: {
    "process.env": JSON.stringify({ NODE_ENV: "production" }),
  },
  build: {
    lib: {
      entry: resolve(__dirname, "src/web-component/define.ts"),
      name: "RagWidget",
      formats: ["umd"],
      fileName: () => "ragsystem-widget.umd.cjs",
    },
    rollupOptions: {
      // 单文件：动态 import 全内联，避免产物分 chunk（宿主只引一个文件）。
      output: { inlineDynamicImports: true },
    },
    cssCodeSplit: false,
  },
});
