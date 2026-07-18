# RAG 生命周期

RAGSystem 的知识问答由“入库、检索、生成、观测”四段组成。当前实现使用 SQLite + `sqlite-vec`，Embedding 通过 `@ragsystem/agent-llm` 的 Provider 适配层调用。

## 端到端流程

```text
上传文件 -> 解析/分块 -> Embedding -> knowledge.db
                                      |
用户问题 -> query embedding -> 向量召回 -> reranker -> Agent 上下文
                                                            |
                                                    LLM + 工具循环 -> 事件流
```

## 入库

1. `POST /api/knowledge-bases/files/upload` 写入源文件 blob。
2. `POST /api/knowledge-bases/index-file` 或 `POST /api/knowledge-bases/index` 触发解析、分块和向量写入。
3. `GET /api/knowledge-bases/file-status` 查询索引状态；失败记录在知识库元数据中。

源文件位于 `<RAG_DATA_ROOT>/db/knowledge-uploads/`，向量和配置位于同一 `knowledge.db`。单次 multipart 最多 20 个文件，单文件上限 100 MiB。

## 检索

`POST /api/knowledge-bases/search` 接收查询和检索参数，先由当前 vectorizer 生成查询向量，再执行 sqlite-vec 召回；配置 reranker 时进行二次排序。Agent 的 `KnowledgeTools` 复用同一 service，因此 UI 检索与 Agent 检索不会产生两套行为。

常用配置面：

| 资源 | 接口 | 作用 |
|---|---|---|
| Vectorizer | `GET/POST /vectorizers` | Embedding、分块和激活版本 |
| Reranker | `GET/POST /rerankers` | 模型或规则重排 |
| Collection | `GET /collections` | 查看索引集合 |
| Embedding 模型 | `/api/embedding-models` | Provider 模型元数据 |

## 生成与引用

召回结果由 Agent context builder 注入当前轮上下文，随后进入 `agent-sdk` 的工具循环。事件通过 durable outbox 发布到 WebSocket/SSE；前端应以事件中的来源和序号渲染引用，不要自行重做检索。

## 质量与故障排查

- sqlite-vec 加载失败会让 Runtime 启动失败，不会静默返回空结果。
- 召回为空时先检查 vectorizer 是否已激活、文档状态是否为 indexed、Embedding Provider 是否可用。
- 相关性不足时分别调 chunk 策略、召回数量和 reranker，避免只提高 top-k。
- 生产环境应备份 `knowledge.db` 与 `knowledge-uploads/`，两者必须成对恢复。

## 最小调用示例

```bash
curl -X POST http://localhost:5002/api/knowledge-bases/search \
  -H "content-type: application/json" \
  -d '{"query":"系统如何创建会话","top_k":5}'
```
