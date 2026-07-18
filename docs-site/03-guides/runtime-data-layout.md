# 运行时数据目录

本章描述 TS 后端运行时产生的数据与配置的物理布局。所有路径均来自源码中各 service 的 `configPath` / `dbPath` 派生逻辑，根目录由 `RAG_DATA_ROOT` 决定。

## 数据根目录

```
RAG_DATA_ROOT（环境变量，设置且非空）
    ↓ 否则
~/.ragsystem
```

派生逻辑见 `backend-ts/src/config/env.ts:53`、`runtime-container.ts:199`。

## 目录结构

```
<RAG_DATA_ROOT>/                      # 默认 ~/.ragsystem
├── db/
│   ├── ragsystem.db                  # 主库：会话/消息/任务/权限/metrics/widget_tokens
│   ├── knowledge.db                  # 知识库：向量 + vectorizer/reranker 配置面
│   └── knowledge-uploads/            # 知识库上传文件物理 blob 存储
├── config/
│   ├── app/
│   │   └── config.yaml               # 应用级系统配置
│   ├── mcp/
│   │   └── mcp_servers.yaml          # MCP 服务器连接配置
│   ├── model_adapter/
│   │   └── providers.yaml            # 模型 Provider（API key/endpoint/model 列表）
│   └── daemon/
│       └── daemon.yaml               # 守护 Agent 调度配置
└── （各工具的运行时产物：artifacts、memory、file-history 等，均在 dataRoot 子树下）
```

## 路径派生来源（逐项核实）

### 数据库

| 文件 | 派生逻辑 | 出处 |
|------|----------|------|
| `ragsystem.db` | `BACKEND_TS_DB_PATH` → `<dataRoot>/db/ragsystem.db` | `env.ts:54` |
| `knowledge.db` | sqlite-vec driver 的 `database_path` → `<dataRoot>/db/knowledge.db` | `sqlite-vec-driver.ts:767` |
| `knowledge-uploads/` | driver 的 `knowledgeUploadsRoot` → `<dataRoot>/db/knowledge-uploads` | `sqlite-vec-driver.ts:84` |

::: warning 旧 vectors.db 不再使用
源码中存在对旧 `db/vectors.db` 的检测与告警（`sqlite-vec-driver.ts:778`）。知识库已改名到 `knowledge.db`，旧文件不再被引用，需重新配置 vectorizer/reranker 并重新索引。
:::

### 配置文件

| 配置 | 相对路径 | 常量定义 |
|------|----------|----------|
| MCP | `config/mcp/mcp_servers.yaml` | `MCP_SERVERS_RELATIVE_PATH` (`mcp-service.ts:33`) |
| Provider | `config/model_adapter/providers.yaml` | `PROVIDERS_CONFIG_RELATIVE_PATH` (`model-adapter-service.ts:17`) |
| Daemon | `config/daemon/daemon.yaml` | `DAEMON_CONFIG_RELATIVE_PATH` (`daemon-service.ts:19`) |
| 应用 | `config/app/config.yaml` | `system-config-service.ts:341` |

## SQLite 句柄与生命周期

`createRuntimeContainer` 会创建多个独立 SQLite 句柄，**共享同一 `dbPath`**（WAL 模式允许并发连接）：

| Store | 用途 | close 顺序 |
|-------|------|-----------|
| `conversationStore` | 会话/消息/任务/metrics（最底层，最后关） | 最后 |
| `fileIndex` | 文件索引 | 先于 conversationStore |
| `vectorStore`（knowledge.db，独立文件） | 向量 + 知识库配置 | `vectorLibrary.close()` |
| `widgetCredentialStore`（仅启用 widget 鉴权时） | widget token | `widgetCredentialStore.close()` |

`memoryStore`、`fileHistory` 为纯文件存储，无 SQLite 句柄，无需 close。

::: tip 完整 close 逻辑
见 `runtime-container.ts:251-266`。关闭顺序为：`outboxDispatcher.stop()` → `widgetCredentialStore.close()` → `mcp.close()` → `daemon.close()` → `vectorLibrary.close()` → `fileIndex.close()` → `conversationStore.close()`。
:::

## 临时库（`:memory:`）

当 `dbPath === ":memory:"`（测试/瞬态场景），知识库随之走 `:memory:`，与主库同生命周期、随 container 关闭重置。否则知识库落到共享的 `<dataRoot>/db/knowledge.db`。

该逻辑见 `runtime-container.ts:151-154`，目的是避免测试配置（vectorizer/reranker）跨实例泄漏到持久化文件。

## 桌面端的数据目录

Electron 桌面端的数据目录策略以 `desktop-electron` 当前实现为准；服务端默认数据根是 `~/.ragsystem`。
