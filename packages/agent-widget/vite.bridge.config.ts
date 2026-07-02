import { resolve } from "node:path";

import { defineConfig } from "vite";

/**
 * iframe 跨源控制桥打包配置：按 mode 各打单文件 UMD（不动 widget 主产物）。
 *
 * - mode=frame：src/iframe-bridge/frame-bridge.ts → dist/ragsystem-frame-bridge.umd.cjs（全局 RagFrameBridge）
 * - mode=host： src/iframe-bridge/host-bridge.ts  → dist/ragsystem-host-bridge.umd.cjs （全局 RagHostBridge）
 *
 * bridge 是纯 TS（无 .vue），不需 vue 插件；单文件 inlineDynamicImports；emptyOutDir:false 避免互删/删主产物。
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
} as const;

export default defineConfig(({ mode }) => {
  const cfg = MODE_CONFIG[mode === "host" ? "host" : "frame"];
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
