# 接口约定

HTTP 路由以 Fastify 插件注册，输入校验使用 Zod/显式类型，业务响应通常使用 `contracts/common.ts` 的 `ok()` 包装。

## 基本约定

| 项目 | 约定 |
|---|---|
| 基础地址 | 开发环境 `http://localhost:5002` |
| 内容类型 | JSON 请求使用 `application/json`；上传使用 multipart |
| 成功响应 | `{ success: true, data, message? }`；部分管理端点返回命名字段 |
| 失败响应 | `{ success: false, error: { code, message, details? } }` |
| 分页 | 端点自行声明 `limit/offset`，无声明时不要假设游标语义 |
| 时间 | JSON 使用 ISO 8601 字符串；事件另带单调递增 `seq` |

## 鉴权域

`app.ts` 按身份域注册插件，而不是通过 URL 字符串猜测权限：

| 域 | 典型前缀 | 规则 |
|---|---|---|
| 探针/安装 | `/livez`、`/readyz`、`/api/bootstrap`、`/api/install` | 公开或一次性安装流程 |
| 租户业务 | `/api/agent`、`/api/mcp`、`/api/knowledge-bases` | session identity + tenant role |
| 控制面 | `/api/admin`、`/api/platform` | 管理员/平台身份 |
| Widget | `/api/widget`、`/api/agui` | Widget JWT 或 publishable key + Origin |
| WebSocket | `/api/agent/sessions/:id/ws` | HTTP 后先申请 60 秒单次 ticket |

租户角色为 `member < admin < owner`。资源访问还会校验 tenant 和 session owner；失败时通常返回 404 隐藏资源存在性，角色不足返回 403。

## 状态码

`400` 输入或 schema 错误，`401` 身份/凭证无效，`403` 角色不足，`404` 资源不存在或不属于当前租户，`409` 状态冲突，`413` 上传过大，`415` 不支持的媒体类型，`500` 未分类服务错误，`503` 可选能力未启用（例如 Widget）。

## 流式接口

- SSE：`POST /api/agent/stream` 和 `/api/agui` 返回事件流；客户端必须处理完成、错误和中断事件。
- WebSocket：建立连接后按 envelope 传输，服务端事件带 `seq`；断线恢复以最后确认序号查询 outbox/快照。
- 事件 schema 位于 `@ragsystem/agent-protocol`，不要在前端复制定义。

## 版本与兼容

当前没有独立 `/v1` 前缀，兼容性由共享包版本和 schema 测试保证。变更请求/响应时同时更新 `packages/api-contracts`、路由测试和本页；删除字段优先经历弃用周期。
