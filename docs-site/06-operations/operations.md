# 生产运维

## 启动与探针

```bash
npm install
npm run build:contracts
npm -w @ragsystem/agent-llm run build
npm -w @ragsystem/agent-sdk run build
npm -w @ragsystem/backend-ts run build
npm -w @ragsystem/backend-ts run start
```

负载均衡器使用 `GET /readyz` 判断是否接流量；容器存活使用 `GET /livez`。`GET /api/health` 需要租户身份，不应作为匿名探针。

## 数据与备份

至少备份以下路径：主库 `db/ragsystem.db`、知识库 `db/knowledge.db`、知识源 `db/knowledge-uploads/`、YAML 配置和用户记忆目录。备份前停止写入或使用 SQLite 一致性快照，恢复时保持数据库与 blob 同一版本。

## 日志与观测

`BACKEND_TS_LOG_LEVEL` 控制 pino 日志级别。Agent 运行时提供 metrics、context snapshot、event outbox 管理接口；outbox 的 pending/failed 数量是实时链路告警的首要信号。不要把 prompt、API key 或完整文件内容写入日志。

## 升级检查

1. 先运行 `npm run check:backend` 与 `npm run check:frontend`。
2. 检查 `agent-protocol` 事件 schema 与 WebSocket 客户端兼容。
3. 对 `sqlite-vec`、Node 版本和原生 ABI 做启动验证。
4. 滚动发布时先确认 `/readyz`，再切换流量；数据库迁移由启动流程执行。

## 安全基线

- 生产环境显式设置 `CORS_ORIGINS`，不要依赖默认全开。
- Widget 使用高熵 `WIDGET_JWT_SECRET`，secret 只在服务端保存；publishable key 仅配合 Origin 白名单。
- 限制 `RAG_DATA_ROOT` 权限，上传文件按 basename 处理并禁止路径穿越。
- 外部 MCP/LLM 连接设置网络出口和超时策略，权限模式默认保持人工审批。
