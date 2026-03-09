# RAGSystem 项目结构

本文档只描述仓库当前仍在使用的主目录和入口文件。

## 顶层

```text
RAGSystem/
├── backend/
├── docs/
├── frontend/
├── frontend-client/
├── README.md
├── QUICK_REFERENCE.md
├── PROJECT_STRUCTURE.md
└── FRONTEND_USAGE_GUIDE.md
```

## backend/

```text
backend/
├── app.py
├── agents/
├── config/
├── execution/
├── file_index/
├── integrations/
├── mcp/
├── model_adapter/
├── nodes/
├── routes/
├── scripts/
├── services/
├── tests/
├── tools/
├── vector_store/
└── workflows/
```

说明：

- `app.py`：Flask 入口，注册所有 blueprint、静态文件和启动检查
- `routes/`：HTTP API
- `services/`：主要服务层
- `execution/`：执行平面和可观测性适配
- `tests/`：当前后端测试入口

## backend/agents/

```text
backend/agents/
├── config/
├── configs/
├── context/
├── core/
├── docs/
├── events/
├── implementations/
├── monitoring/
├── skills/
└── streaming/
```

说明：

- `config/loader.py`：从 `agent_configs.yaml` 加载 Agent，并强制装载 `master_agent_v2`
- `implementations/react/`：`ReActAgent`
- `implementations/master/`：`MasterAgentV2`
- `events/`：事件总线和 SSE 适配

## backend/nodes/

```text
backend/nodes/
├── base.py
├── config_store.py
├── registry.py
├── schema_generator.py
├── CONFIG_UI_GUIDE.md
├── UI_METADATA_REFERENCE.md
├── json2graph/
├── llmjson/
├── llmjson_v2/
└── vector_indexer/
```

说明：

- 节点通过 `node.py` + `config.py` 组织
- `registry.py` 扫描子目录注册节点
- `schema_generator.py` 从 Pydantic 配置生成前端表单 Schema
- `config_store.py` 持久化节点实例配置和预设

## frontend/

```text
frontend/
├── src/
│   ├── api/
│   ├── components/
│   ├── composables/
│   ├── router/
│   └── views/
├── .env.example
├── package.json
└── vite.config.js
```

说明：

- 使用 `vue-router`
- 默认开发端口 `8080`
- `vite.config.js` 代理 `/api` 到后端，代理 `/neo4j` 到 Neo4j HTTP

## frontend-client/

```text
frontend-client/
├── src/
│   ├── api/
│   ├── components/
│   ├── styles/
│   └── views/
├── .env.example
├── package.json
└── vite.config.js
```

说明：

- 不使用 `vue-router`
- `src/App.vue` 根据 `window.location.pathname` 切换页面
- 默认开发端口 `5174`

## docs/

```text
docs/
├── README.md
├── DOCUMENTATION_MAP.md
├── ARCHITECTURE_BOUNDARIES.md
├── FILE_SYSTEM_INTEGRATION.md
├── P3_EXECUTION_LAYER_CHECKLIST.md
├── P3_EXECUTION_LAYER_DESIGN.md
├── P4_OBSERVABILITY_ROUTES.md
└── archive/
```

说明：

- `docs/` 只保留当前文档入口和少量专题文档
- 历史迁移、交付总结和升级记录进入 `docs/archive/`
