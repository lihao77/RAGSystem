# 后端插件配置 / Backend Plugin Configuration

后端插件可以通过 YAML 完成安装后的启停、排序和初始化参数配置。插件本身仍是 TypeScript/JavaScript 模块，因此新增业务能力需要编写插件代码；接入已有插件不需要修改 `backend-local` 或 `backend-saas`。

Backend plugins use YAML for activation, ordering, and initialization options. A plugin remains a TypeScript/JavaScript module; once its package is installed, neither backend composition root needs source changes.

## 快速接入 / Quick start

安装插件包，编辑当前后端目录的正式配置，然后启动后端：

```bash
npm install @company/ragsystem-plugin-example
# Edit backend-local/backend.plugins.yaml
npm run dev:backend-local
```

Local 默认读取 `backend-local/backend.plugins.yaml`，SaaS 默认读取 `backend-saas/backend.plugins.yaml`。也可以使用 `BACKEND_PLUGIN_CONFIG` 指定其他文件。配置文件是必需且唯一的插件清单；不存在或无效时，后端在监听端口前退出。

Local reads `backend-local/backend.plugins.yaml` by default and SaaS reads `backend-saas/backend.plugins.yaml`. `BACKEND_PLUGIN_CONFIG` can select another file. The YAML manifest is required and is the only plugin inventory.

生产环境建议始终使用绝对路径：

```dotenv
BACKEND_PLUGIN_CONFIG=/etc/ragsystem/backend.plugins.yaml
```

## 配置格式 / Schema

```yaml
version: 1
plugins:
  - module: "@ragsystem/backend-plugin-memory/module.js"

  - module: "@company/ragsystem-plugin-example/module.js"
    enabled: true
    config:
      endpoint: "${EXAMPLE_PLUGIN_ENDPOINT}"
      token: "${EXAMPLE_PLUGIN_TOKEN}"
      timeoutMs: 10000
```

- `version`：当前必须为 `1`。
- `plugins`：数组顺序即装载顺序；依赖关系仍由插件 manifest 校正。
- `module`：npm 包导出、绝对文件路径，或相对 YAML 文件目录的 `./`、`../` 路径。
- `enabled`：默认为 `true`；设为 `false` 时模块不会被导入。
- `config`：原样传给插件的 `create({ config })`，具体字段由插件校验。

根对象和插件条目使用严格校验。未知字段、重复模块、错误类型、缺失环境变量、缺少配置文件或无法导入的模块都会让后端在监听端口前退出。系统没有代码内插件目录，也不会回退到环境变量中的插件名称列表。

`${NAME}` 可出现在已启用插件的任意字符串配置值中。变量来自进程环境以及后端工作目录的 `.env`；缺失变量只报告变量名，不记录替换后的配置值。禁用插件不会解析占位符。

## 插件模块契约 / Module contract

包必须导出名为 `backendPluginModule` 的稳定入口：

```ts
import type { BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";

const manifest = {
  id: "@company/ragsystem-plugin-example",
  version: "1.0.0",
} as const;

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest,
  create({ config }) {
    const options = parsePluginConfig(config);
    return {
      manifest,
      register(context) {
        context.routes.register("tenant", "/api/example", async (app) => {
          // Install Fastify routes here.
        });
      },
    };
  },
};
```

推荐在插件包中导出 `./module.js`，并把 `@ragsystem/backend-core` 和 `fastify` 声明为 peer dependencies。插件应在 `create` 阶段严格校验自身配置；存储、路由、工具、运行时和生命周期通过 `BackendPluginContext` 注册。需要同时支持 Local 与 SaaS 时，根据运行时的 `deploymentKind` 选择实现，并通过 host resources 获取数据库或对象存储。

The loader validates `apiVersion`, manifest identity, and the returned plugin instance. Plugin-specific configuration remains the plugin package's responsibility.

## Docker 与安全 / Docker and security

容器部署需要把文件只读挂载到后端容器，并设置绝对路径：

```yaml
services:
  backend:
    environment:
      BACKEND_PLUGIN_CONFIG: /etc/ragsystem/backend.plugins.yaml
    volumes:
      - ./backend.plugins.yaml:/etc/ragsystem/backend.plugins.yaml:ro
```

插件模块拥有与后端进程相同的权限。只允许部署管理员修改配置或安装插件包，不要从租户可写目录加载模块。配置变更在重启后生效，当前不支持热加载。

Plugin modules execute with backend process privileges. Restrict package installation and YAML writes to deployment administrators. Changes take effect after restart; hot reload is intentionally not supported.
