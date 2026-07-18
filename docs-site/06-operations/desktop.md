# 桌面端

`desktop-electron` 是 Electron 壳，不是独立的 RAG 运行时。桌面端应复用 TS 后端的 HTTP/WS 接口和 `RAG_DATA_ROOT` 数据目录；具体启动命令以 `desktop-electron` 当前源码为准。

## 当前边界

| 层 | 责任 |
|---|---|
| Electron main | 窗口、进程生命周期、开发/生产资源定位 |
| TS backend | Agent、知识库、MCP、模型、存储和鉴权 |
| Vue frontend | 页面、状态、HTTP/WS 客户端 |
| 数据目录 | SQLite、上传、配置、记忆和 skill |

## 联调方式

先启动 TS 后端并确认 `/readyz`，再启动桌面壳；桌面端使用的 API base URL 必须指向实际 TS 后端端口（默认 `5002`）。不要把旧的 Python `5001` 启动命令写入新的桌面流程。

## 发布检查

1. `npm run check:backend` 和前端 check 通过。
2. 桌面进程能连接 `/readyz`，登录后能打开 `/api/health`。
3. WebSocket 使用 session-scoped 单次 ticket，不把长期 JWT 放入 URL。
4. 关闭窗口后后台 Runtime、outbox dispatcher 和子进程均退出。
5. 用户数据目录可备份和恢复，升级不覆盖 `RAG_DATA_ROOT`。

桌面端详细实现若与本页不一致，以 `desktop-electron` 源码和实际构建脚本为准；未验证的能力不在文档中宣称为已支持。
