#!/usr/bin/env node
/**
 * 插件脚手架：npm run create-plugin -- <name>
 * 在 plugins/backend-plugin-<name>/ 生成可构建的插件骨架：
 * 后端（module/plugin/systemConfig）+ 前端（ui/ vite lib）+ 构建配置 + README。
 * 生成后：cd plugins/backend-plugin-<name> && npm install && npm run build && npm run build:ui
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error("用法: npm run create-plugin -- <name>（小写字母开头，kebab-case）");
  process.exit(1);
}
const pluginDir = path.resolve("plugins", `backend-plugin-${name}`);
const packageId = `@ragsystem/backend-plugin-${name}`;
if (fs.existsSync(pluginDir)) {
  console.error(`错误: 目录已存在 ${pluginDir}`);
  process.exit(1);
}

const files = {
  "package.json": JSON.stringify({
    name: packageId,
    version: "0.1.0",
    private: true,
    type: "module",
    exports: {
      "./*.js": {
        development: "./src/*.ts",
        types: "./dist/*.d.ts",
        default: "./dist/*.js",
      },
    },
    engines: { node: ">=22.5.0" },
    scripts: {
      build: "tsc -p tsconfig.json",
      "build:ui": "vite build -c ui/vite.config.js",
      typecheck: "tsc -p tsconfig.json --noEmit",
      test: "npm run build && node --test tests/*.test.mjs",
    },
    dependencies: {
      "@ragsystem/agent-sdk": "*",
    },
    peerDependencies: {
      "@ragsystem/backend-core": "0.1.x",
    },
    devDependencies: {
      "@types/node": "^22.5.0",
      "@vitejs/plugin-vue": "^5.2.4",
      typescript: "^5.6.0",
      vite: "^6.4.3",
      vue: "^3.5.24",
    },
  }, null, 2) + "\n",

  "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "declaration": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "ui"]
}
`,

  "src/module.ts": `import type { BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { create${pascal(name)}Plugin, PLUGIN_ID } from "./plugin.js";

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    if (config !== undefined && config !== null) {
      throw new Error(\`${packageId} 暂不支持安装配置（config 请留空）\`);
    }
    return create${pascal(name)}Plugin();
  },
};
`,

  "src/plugin.ts": `import fs from "node:fs";
import path from "node:path";

import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { resolvePluginAssetDir } from "@ragsystem/backend-core/plugins/plugin-assets.js";
import type {} from "@ragsystem/backend-core/fastify-context.js";

import { createSystemConfigExtension, PLUGIN_CONFIG_KEY } from "./system-config.js";

export const PLUGIN_ID = "${packageId}";

export function create${pascal(name)}Plugin(): BackendPlugin {
  return {
    manifest: { id: PLUGIN_ID, version: "0.1.0" },
    register(context) {
      // 1) 配置：systemConfig 扩展（租户级，设置页 schema 驱动，请求时热读）
      context.runtimes.register((runtimeContext) => {
        const unregister = runtimeContext.systemConfig
          ? runtimeContext.systemConfig.registerExtension(
            PLUGIN_ID,
            createSystemConfigExtension(runtimeContext.systemConfig.getSection(PLUGIN_CONFIG_KEY)),
          )
          : () => undefined;
        return { dispose: unregister };
      });

      // 2) 后端路由（tenant scope，走统一鉴权）
      context.routes.register("tenant", "/api/${name}", async (app) => {
        app.get("/summary", async (request) => {
          const config = request.container.systemConfig.getSection(PLUGIN_CONFIG_KEY) ?? {};
          return { plugin: PLUGIN_ID, config };
        });
      });

      // 3) 前端 view（自带 bundle；exposePublic 仅免登录直开时需要）
      context.ui.register({
        bundleUrl: "/api/${name}/ui/bundle.js",
        views: [{ route: "/${name}", entry: "Panel", title: "${name}", placement: "management" }],
      });
      const uiRoot = resolvePluginAssetDir({
        moduleUrl: import.meta.url,
        relative: "ui",
        workspaceRelative: "ui/dist",
        pluginId: PLUGIN_ID,
      });
      context.routes.register("public", "/api/${name}", async (app) => {
        app.get("/ui/bundle.js", async (_request, reply) => {
          const file = path.join(uiRoot, "bundle.js");
          if (!fs.existsSync(file)) return await reply.code(404).send({ error: "ui bundle not built (npm run build:ui)" });
          reply.header("content-type", "application/javascript; charset=utf-8");
          return await reply.send(fs.createReadStream(file));
        });
      });
    },
  };
}
`,

  "src/system-config.ts": `import { z } from "zod";

import type { SystemConfigExtension } from "@ragsystem/backend-core/contracts/runtime/system-config.js";

export const PLUGIN_CONFIG_KEY = "${name.replace(/-/g, "_")}";

const ConfigSchema = z.object({
  enabled: z.boolean().default(true),
}).strict();

export type PluginConfig = z.infer<typeof ConfigSchema>;

export function resolveConfig(value: unknown): PluginConfig {
  const parsed = ConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : ConfigSchema.parse({});
}

/** 注册时回灌已存值，避免 rebuildProjection 丢配置（skills/pet 同款模式）。 */
export function createSystemConfigExtension(currentValue: unknown): SystemConfigExtension {
  return {
    defaults: { [PLUGIN_CONFIG_KEY]: resolveConfig(currentValue) },
    groups: [
      {
        key: PLUGIN_CONFIG_KEY,
        label: "${name}",
        description: "${packageId} 配置（本场景生效）",
        fields: [
          { key: "enabled", label: "启用", type: "boolean", default: true, help: "插件功能开关" },
        ],
      },
    ],
  };
}
`,

  "ui/vite.config.js": `import { resolve } from 'node:path';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// 插件 UI bundle 构建（lib 模式，ESM 单文件输出 ui/dist/bundle.js）
export default defineConfig({
  root: __dirname,
  plugins: [vue()],
  // 必需：Vue esm-bundler 构建含 process.env.NODE_ENV 守卫，Vite lib 模式不自动替换
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/entry.js'),
      formats: ['es'],
      name: '${name}-ui',
      fileName: () => 'bundle.js',
    },
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    target: 'es2020',
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => (assetInfo.names?.[0]?.endsWith('.css') ? 'style.css' : 'assets/[name][extname]'),
      },
    },
  },
});
`,

  "ui/src/entry.js": `import { createApp } from 'vue';

import Panel from './Panel.vue';

// 样式与 bundle 同目录（style.css）；动态 import 不会自动加载 CSS，需手工挂 <link>
const STYLE_HREF = new URL('./style.css', import.meta.url).href;

function ensureStylesheet() {
  const existing = document.querySelector(\`link[data-plugin-ui="${name}"][href="\${STYLE_HREF}"]\`);
  if (existing) return null;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLE_HREF;
  link.dataset.pluginUi = '${name}';
  document.head.appendChild(link);
  return link;
}

export function mountView(element, host) {
  const link = ensureStylesheet();
  const app = createApp(Panel, { pluginHost: host ?? null });
  app.mount(element);
  return { unmount: () => { app.unmount(); link?.remove(); } };
}
`,

  "ui/src/Panel.vue": `<template>
  <div class="${name}-panel">
    <h2>${name}</h2>
    <p v-if="error" class="${name}-error">{{ error }}</p>
    <template v-else-if="summary">
      <p>配置（本场景生效）：</p>
      <pre>{{ summary.config }}</pre>
    </template>
    <p v-else>加载中…</p>
  </div>
</template>

<script setup>
// 硬契约：CSS 类名必须以插件名做命名空间前缀（防止污染宿主与其他插件）
import { onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps({ pluginHost: { type: Object, default: null } });
const summary = ref(null);
const error = ref('');
let abort = null;

onMounted(async () => {
  abort = new AbortController();
  try {
    const data = props.pluginHost?.api
      ? await props.pluginHost.api.get('/api/${name}/summary')
      : await (await fetch('/api/${name}/summary')).json();
    summary.value = data;
  } catch (e) {
    error.value = e?.message || '加载失败';
  }
});

// 硬契约：卸载必须清理全部全局副作用（定时器/监听器/注入的 DOM 节点）
onBeforeUnmount(() => abort?.abort());
</script>

<style scoped>
.${name}-panel { padding: 24px; max-width: 720px; }
.${name}-error { color: #e0524c; }
</style>
`,

  "tests/plugin.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";

import { PLUGIN_ID, createSystemConfigExtension } from "../dist/index.js";

test("配置扩展注册与回灌", () => {
  const extension = createSystemConfigExtension({ enabled: false });
  assert.equal(extension.defaults["${name.replace(/-/g, "_")}"].enabled, false);
});

test("ui 清单注册", async () => {
  const manager = new BackendPluginManager([(await import("../dist/index.js")).backendPluginModule.create({ config: undefined })]);
  await manager.register();
  assert.equal(manager.listUi()[0]?.pluginId, PLUGIN_ID);
  await manager.stop();
});
`,

  "src/index.ts": `export { backendPluginModule } from "./module.js";
export { create${pascal(name)}Plugin, PLUGIN_ID } from "./plugin.js";
export { createSystemConfigExtension, resolveConfig, PLUGIN_CONFIG_KEY } from "./system-config.js";
export type { PluginConfig } from "./system-config.js";
`,

  "README.md": `# ${packageId}

脚手架生成的插件（npm run create-plugin -- ${name}）。

## 开发

\`\`\`bash
npm install                 # workspace 内会提升依赖，首次生成后在根目录 npm install 即可
npm run build               # 后端 TS 构建（dist/）
npm run build:ui            # 前端 bundle（ui/dist/bundle.js + style.css）
npm test
\`\`\`

本地联调：repo 根目录 \`npm run plugin -- add plugins/backend-plugin-${name}\`（源码方式，tsx watch 自动重载）；
管理中心出现「${name}」入口；配置在 设置 → 插件管理。

## 分发

\`\`\`bash
npm run bundle-plugin -- plugins/backend-plugin-${name} --asset ui/dist:ui
# → release/backend-plugin-${name}-0.1.0.zip + sha256
\`\`\`

## 约定（详见 docs/PLUGIN_UI.md 与 docs/BACKEND_PLUGIN_CONFIG.md）

- 配置：systemConfig 扩展，注册时回灌当前值，读取走请求时热读；
- UI：mountView DOM 边界契约；CSS 类名带插件名前缀；卸载清理全部全局副作用；
- 资产：resolvePluginAssetDir 三布局探测（分发/ workspace / 桌面）。
`,
};

function pascal(kebab) {
  return kebab.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join("");
}

for (const [file, content] of Object.entries(files)) {
  const target = path.join(pluginDir, ...file.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}
console.log(`已生成: ${pluginDir}`);
console.log("下一步: 根目录 npm install → 插件目录 npm run build && npm run build:ui → npm run plugin -- add plugins/backend-plugin-" + name);
