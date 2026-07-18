# 关于本文档站

本站是 RAGSystem 当前版本的技术文档，目标是准确说明系统构造、使用方式、接口和运维边界。

## 源码为唯一真相来源

::: warning 重要约定
本站所有内容均从**实际源码**提取并交叉验证，不依赖仓库内的任何 Markdown 文档。
:::

本站的内容直接根据当前源码、package.json、schema、测试和构建配置整理：

| 对象 | 处理方式 |
|------|----------|
| 源码（`.ts` / `.js` / `package.json`） | **唯一真相来源**，所有结论回此处核实 |
| 当前源码、schema、测试、构建配置 | 事实来源 |
| 无法从当前仓库核实的内容 | 不写入当前文档 |

## 范围

- **聚焦 TS 目标后端**（`backend-ts`，Fastify + TypeScript，端口 5002）
- 当前运行主线是 `backend-ts`（默认端口 5002）
- 语言：**中文为主**，暂不做英文版

## 内容来源对照

每个章节的关键事实都能在源码中找到对应：

| 文档板块 | 源码来源 |
|----------|----------|
| 环境变量与配置 | `backend-ts/src/config/env.ts`、`backend-ts/src/app.ts` |
| 运行时数据目录 | 各 service 的 `configPath` 派生（`runtime-container.ts` + 对应 service） |
| HTTP 路由清单 | `backend-ts/src/routes/` 下各 `register*` 与 `app.ts` 注册 |
| 架构分层 | `backend-ts/src/{config,contracts,routes,services,tools}` 目录结构 |
| 共享协议包 | `packages/agent-protocol` 等的 `package.json` 与导出 |
| 架构和接口 | 当前 `backend-ts/src`、`packages/*/src` 与 `app.ts` |

## 如何使用本站

- **想跑起来**：从 [安装与启动](/00-start/getting-started) 开始
- **想理解整体**：看 [系统上下文](/02-architecture/system-context)
- **管理 Memory**：[Memory 使用与治理](/03-guides/memory)
- **查接口**：[HTTP API](/04-api/http) 与 [Memory API](/04-api/memory)
- **看运维**：[运维总览](/06-operations/)

## 反馈

发现文档与源码不符，或内容缺失，请以源码为准提出修正。文档站代码位于 `docs-site/`，修改后在仓库根目录运行 `npm --prefix docs-site run build` 验证。

## 文档维护规则

每次功能变更按影响面同步更新：

| 代码变化 | 必须检查的文档 |
|---|---|
| 用户页面、工作流、按钮或权限 | `03-guides/` |
| HTTP 路由、请求/响应 schema、错误码 | `04-api/` |
| 环境变量、Docker、数据卷、探针 | `00-start/` 与 `06-operations/` |
| repository、runtime、存储边界 | `02-architecture/` |
| 重要取舍和不可逆约束 | `07-adr/` |

新增或更新页面时：

1. 在 front matter 标记 `status`、`audience`、`source`、`verified_at`。
2. 区分“当前已实现”和“规划中”，不要把路线图写成现状。
3. API 示例必须能映射到当前 Zod/API contract 或路由源码。
4. 安全示例不得使用生产 secret；开发默认凭证必须明确标记仅限本机。
5. 更新 VitePress 导航，并运行构建检查内部链接。
