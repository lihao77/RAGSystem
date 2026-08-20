# 插件 UI 与插件配置（Plugin UI & Plugin Config）

后端插件可以声明两样前端可见的东西：

1. **租户级（场景级）配置**：插件注册 systemConfig 扩展后，设置页出现该插件的配置分区，读写走统一 system-config API；
2. **配套前端 view**：插件自带一个 ESM bundle，后端在 `/api/<plugin>/ui/` 下伺服，前端按插件清单动态装载。

契约类型集中在 `packages/plugin-ui-sdk`（`@ragsystem/plugin-ui-sdk`）。

## 一、插件配置（systemConfig 扩展）

插件在 runtime 工厂里注册扩展（skills/knowledge/memory/pet 同款模式）：

```ts
context.runtimes.register((runtimeContext) => {
  const unregister = runtimeContext.systemConfig.registerExtension(
    PET_PLUGIN_ID,                       // 约定：扩展 id = 插件 manifest id
    createPetSystemConfigExtension(runtimeContext.systemConfig.getSection("pet")),
  );
  return { dispose: unregister };
});
```

扩展声明 `{ defaults, groups }`：defaults 是默认值树（组 key 支持点号嵌套语义），groups 是表单分组 schema（字段类型 boolean/number/password/select/string_list/text/textarea，见 `backend-core/src/contracts/runtime/system-config.ts`）。

- **作用域**：租户级（本地版 = 每个场景独立；SaaS = 每租户独立），存储由产品适配（local YAML `config/app/config.yaml` / SaaS Postgres `saas_system_configs`）。
- **暴露**：`GET /api/system-config/schema` 返回的组带 `sourceExtension`（= 插件 id），前端插件设置页按它分组；`GET /api/plugins`（tenant）的 `configGroups` 字段同源。
- **读取**：请求/操作时 `systemConfig.getSection("<组 key>")` 热读（改完即生效）；不要在工厂创建时快照（除非接受重启生效）。
- **注册时回灌**：把 `getSection` 的当前值作为 defaults 传入，避免 rebuildProjection 丢已存值。
- **敏感字段**：按 key 名自动脱敏（password/api_key/token 等），PATCH 回写时 `********` 占位被丢弃。

## 二、插件前端 view（运行时 ESM 微前端）

### 清单声明（后端）

插件在 `register()` 里经第 10 个注册面 `context.ui` 声明：

```ts
context.ui.register({
  bundleUrl: "/api/pet/ui/bundle.js",     // 同源路径（必须 / 开头）
  exposePublic: true,                      // 需要认证前挂路由（如独立窗直开）时置 true
  views: [{
    route: "/pet",                         // 前端路由路径
    entry: "PetPanel",                     // view 名称（用于路由命名）
    title: "宠物",
    placement: "standalone",               // standalone = 顶级路由；management = 管理中心导航
    public: true,                          // 免登录可访问
  }],
});
```

宿主端点：

- `GET /api/plugins/ui-manifests`（public scope）：仅 `exposePublic: true` 插件的 `{id, bundleUrl, views}`——路由守卫在认证前加载并动态 addRoute；
- `GET /api/plugins`（tenant scope）：完整清单 `{id, version, ui, configGroups}`（设置页与管理中心导航用）。

### bundle 契约（apiVersion 1）

bundle 是一个 ESM 模块，**必须导出**：

```js
export function mountView(element, host) {
  const app = createApp(MyComponent, { pluginHost: host });
  app.mount(element);
  return { unmount: () => app.unmount() };
}
```

- `element`：宿主提供的 DOM 容器；插件在其中自建 app。
- `host`（PluginUiHostContext）：`{ apiVersion, pluginId, view, api, events }`。
  - `api.get/post/put/patch/del(url, ...)`：同源 API 客户端，自动携带登录态；
  - `events.latest(event)`：本插件 plugin_event 下行帧的最近一条（只读，data 按不可信数据处理）。

**运行时边界**：bundle **自带 Vue 运行时**（构建时不 external），与宿主零共享实例——组件内不要依赖宿主的 provide/inject、Pinia、router，一切交互经 `pluginHost` props 注入。挂载失败或同步抛错只影响该 view（宿主渲染错误卡片）。

### 构建约定（vite lib 模式）

以 pet 为模板（`plugins/backend-plugin-pet/ui/`）：

```js
// ui/vite.config.js
export default defineConfig({
  plugins: [vue()],
  // 必需：Vue 的 esm-bundler 构建含 process.env.NODE_ENV 守卫，Vite lib 模式不自动替换，
  // 浏览器无 process 会抛 ReferenceError（"process is not defined"）
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    lib: { entry: resolve(__dirname, 'src/entry.js'), formats: ['es'], fileName: () => 'bundle.js' },
    cssCodeSplit: false,
    rollupOptions: { output: { assetFileNames: (a) => a.names?.[0]?.endsWith('.css') ? 'style.css' : 'assets/[name][extname]' } },
  },
});
```

- 产物：`ui/dist/bundle.js` + `ui/dist/style.css`（CSS 固定名，`mountView` 以 `import.meta.url` 推导同目录 `<link>` 注入——动态 import 不会自动加载 CSS）。
- 命令：包内 `npm run build:ui`。
- 后端伺服：插件在自己的路由前缀下伺服（防穿越 + 手动 content-type，参考 `plugins/backend-plugin-pet/src/pet-assets.ts` 的 `registerPetUiRoutes`）。
- 桌面打包：`desktop-electron/scripts/prepare-backend.mjs` 把 `ui/dist` 拷到 `plugin-assets/<plugin>/ui`；插件运行时按双布局探测（包内 `ui/dist` → 桌面 `plugin-assets`）。

### 安全说明

ESM view 在浏览器主环境执行，与宿主同源、可携带登录态调用 API——**视为信任边界内的第一方/过审代码**，与后端插件代码同级对待。市场阶段引入不可信第三方时，应为其提供 iframe 隔离档位（bundle 契约不适用）。
