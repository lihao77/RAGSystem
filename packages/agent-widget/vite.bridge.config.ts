import { resolve } from "node:path";

import { defineConfig } from "vite";

/**
 * 按需 UMD 打包配置：各入口独立单文件 UMD（主包 widget 由 vite.config.ts 打，此处打按需附加包）。
 *
 * - mode=frame：src/iframe-bridge/frame-bridge.ts → dist/ragsystem-frame-bridge.umd.cjs（全局 RagFrameBridge）
 * - mode=host： src/iframe-bridge/host-bridge.ts  → dist/ragsystem-host-bridge.umd.cjs （全局 RagHostBridge）
 * - mode=tools：src/host-tools/index.ts           → dist/ragsystem-host-tools.umd.cjs  （全局 RagHostTools，dom/map 工具集）
 *
 * 三个入口都是纯 TS（无 .vue），不需 vue 插件；单文件 inlineDynamicImports；emptyOutDir:false 避免互删/删主产物。
 */
const MODE_CONFIG = {
  frame: {
    entry: "src/iframe-bridge/frame-bridge.ts",
    name: "RagFrameBridge",
    fileName: "ragsystem-frame-bridge",
  },
  host: {
    entry: "src/iframe-bridge/host-bridge.ts",
    name: "RagHostBridge",
    fileName: "ragsystem-host-bridge",
  },
  tools: {
    entry: "src/host-tools/index.ts",
    name: "RagHostTools",
    fileName: "ragsystem-host-tools",
  },
} as const;

export default defineConfig(({ mode }) => {
  const cfg = MODE_CONFIG[mode as keyof typeof MODE_CONFIG] ?? MODE_CONFIG.frame;
  return {
    define: {
      "process.env": JSON.stringify({ NODE_ENV: "production" }),
    },
    build: {
      lib: {
        entry: resolve(__dirname, cfg.entry),
        name: cfg.name,
        formats: ["umd"],
        fileName: () => `${cfg.fileName}.umd.cjs`,
      },
      rollupOptions: {
        output: { inlineDynamicImports: true },
      },
      emptyOutDir: false,
    },
  };
});
