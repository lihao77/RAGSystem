# MCP 服务

MCP（Model Context Protocol）在 RAGSystem 中是**一等公民能力载体**——不只是外部工具，还携带 resources、prompts、per-tool 风险等级与 skill 协同。本章基于 `backend-ts/src/services/integrations/mcp-service.ts` 与 `routes/mcp.ts` 的真实实现。

## 能力概览

MCP 服务由 `McpService` 提供（`runtime-container.ts` 中实例化，挂载为 `container.mcp`）。它支持三件套能力：

| 能力 | 说明 | 数据来源 |
|------|------|----------|
| **Tools** | 工具调用（function calling） | `listAllTools()` / `listServerTools()` |
| **Resources** | 资源读取（可被 Agent 引用） | `listServerResources()` / `readResource()` |
| **Prompts** | 预设提示词模板 | `listServerPrompts()` / `getPrompt()` |

此外还集成 **MCP Registry**（在线服务器目录）用于搜索与一键安装。

::: tip 来源
`mcp-service.ts` 公开方法清单（共 16 个 async 方法）：`searchRegistry`、`installServerFromRegistry`、`autoConnectEnabledServers`、`addServer`、`updateServer`、`connectServer`、`testServer`、`readResource`、`getPrompt`、`callRuntimeTool`、`callTool` 等（含内部连接器方法）。
:::

## 配置文件

MCP 服务器连接配置存于运行时数据目录：

```
<RAG_DATA_ROOT>/config/mcp/mcp_servers.yaml
```

::: tip 出处
`mcp-service.ts:33` → `MCP_SERVERS_RELATIVE_PATH = path.join("config", "mcp", "mcp_servers.yaml")`。默认 dataRoot 派生逻辑见 `mcp-service.ts:907`。
:::

## 启动时自动连接

`createRuntimeContainer` 初始化 `McpService` 后立即调用：

```ts
void mcp.autoConnectEnabledServers();
```

（见 `runtime-container.ts:141`）

即配置中标记为启用（enabled）的服务器会在后端启动时自动建立连接，无需手动触发。

## 管理 API（路由前缀 `/api/mcp`）

所有端点均返回 `{ success, message, data }` 包装格式（`ok()` 辅助函数）。

### Registry（在线目录）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/registry/servers` | 搜索 MCP Registry 服务器，支持 `search`/`cursor`/`limit`/`latest_only` 查询参数 |
| `POST` | `/registry/install` | 从 Registry 安装服务器（body 走 `McpRegistryInstallSchema` 校验） |

### 服务器管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/servers` | 列出所有服务器（含连接状态、工具数） |
| `POST` | `/servers` | 添加服务器（body 走 `McpServerCreateSchema`） |
| `PUT` | `/servers/:serverName` | 更新配置并应用 |
| `DELETE` | `/servers/:serverName` | 删除服务器 |
| `POST` | `/servers/:serverName/connect` | 连接 |
| `POST` | `/servers/:serverName/disconnect` | 断开（标记 manual） |
| `POST` | `/servers/:serverName/test` | 测试连接，返回 `{ success, message, tool_count }` |

### 能力查询（三件套）

| 方法 | 路径 | 能力 |
|------|------|------|
| `GET` | `/servers/:serverName/tools` | 该服务器的工具列表 |
| `GET` | `/tools` | 所有已连接服务器的全部工具（聚合） |
| `GET` | `/servers/:serverName/resources` | 资源列表 |
| `POST` | `/servers/:serverName/resources/read` | 读取资源（body: `{ uri }`） |
| `GET` | `/servers/:serverName/prompts` | 提示词列表 |
| `POST` | `/servers/:serverName/prompts/get` | 获取提示词（body: `{ name, arguments? }`） |
| `GET` | `/prompts` | 所有服务器的提示词聚合 |
| `GET` | `/servers/:serverName/metrics` | 该服务器的调用指标 |

## 工具定义的丰富元数据

`routes/mcp.ts` 的 `normalizeMcpToolDefinition` 揭示，每个 MCP 工具可携带以下自描述元数据（透传给 Agent）：

| 字段 | 含义 |
|------|------|
| `description` | 工具描述 |
| `parameters` | JSON Schema 参数定义 |
| `usage_contract` | 用法契约（数组） |
| `returns` | 返回值结构说明 |
| `annotations` | MCP 标准注解 |
| `risk_level` | **per-tool 风险等级**（用于权限/审批策略） |
| `allowed_callers` | 允许的调用方（默认 `["direct"]`） |
| `source` | 来源标记（默认 `"mcp"`） |

这是 MCP "一等公民"定位的体现：不只是函数签名，还携带风险与契约信息供权限系统决策。

## 典型使用流程

1. **添加服务器**：`POST /api/mcp/servers` 写入 `mcp_servers.yaml`
2. **连接**：`POST /api/mcp/servers/{name}/connect`，或重启后由 `autoConnectEnabledServers` 自动连接
3. **查看能力**：`GET /api/mcp/servers/{name}/tools` 确认可用工具
4. **测试**：`POST /api/mcp/servers/{name}/test` 验证连通性与工具数
5. Agent 运行时通过 `McpTools`（`tools/McpTools`）自动发现并调用已连接服务器的工具

## 错误处理

MCP 相关错误以 `McpServiceError` 抛出（带 `statusCode`），路由层 `toHttpError` 转换为 `HttpError`。注意若干端点在服务器不存在（404）时返回空结果而非报错（如 tools/resources/prompts 列表返回空数组），便于前端容错。
