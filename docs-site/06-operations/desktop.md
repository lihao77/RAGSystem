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

## 对话附件

桌面端选择文件后先保留为待发送附件，发送消息或保存消息编辑时才登记到会话：

- 普通磁盘文件通过 Electron `webUtils.getPathForFile` 获取路径，调用 `/api/agent/sessions/:sessionId/files/link` 登记 `linked_local` 引用，不复制文件内容，也不受 multipart 上传大小限制。
- 只有 PNG、JPEG（含 `.jpg`/`.jpeg`）、WebP、GIF 作为可内联图片，通过 `/files/upload` 上传到会话的 `uploads/` 目录，供图片请求归一化和缓存使用。TIFF、BMP、SVG、HEIC、AVIF 等按普通文件引用，仍可由工具读取。剪贴板或程序生成、没有磁盘路径的附件同样上传。
- 浏览器端没有 Electron 路径桥接，继续上传附件。此桌面策略用于与本机 `backend-local` 配套的前端。

本地文件引用在读取时使用原文件的当前内容；移动或删除原文件会使其不可读。删除会话附件引用不会删除原文件。引用登记失败会阻止发送，不会静默转为上传。已经保存的受管附件保持原有行为，重用会话附件不会重新登记或复制。

可内联图片格式白名单由前后端共享。后端在附件解析、历史消息投影和辅助视觉描述时重新检查，不依赖旧消息的 `kind=image` 标记；构造模型图片请求前还检查实际字节的格式签名，不把不支持的内容强行声明成 PNG。

## 发布检查

1. `npm run check:backend` 和前端 check 通过。
2. 桌面进程能连接 `/readyz`，登录后能打开 `/api/health`。
3. WebSocket 使用 session-scoped 单次 ticket，不把长期 JWT 放入 URL。
4. 关闭窗口后后台 Runtime、outbox dispatcher 和子进程均退出。
5. 用户数据目录可备份和恢复，升级不覆盖 `RAG_DATA_ROOT`。

桌面端详细实现若与本页不一致，以 `desktop-electron` 源码和实际构建脚本为准；未验证的能力不在文档中宣称为已支持。
