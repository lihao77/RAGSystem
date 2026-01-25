# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

RAGSystem 是一个基于知识图谱的智能问答系统，整合时序推理、空间分析和因果追踪功能。系统采用前后端分离架构，后端使用 Flask + Neo4j，前端使用 Vue 3 + Element Plus。

## 核心架构

### 三层架构
```
Routes (API层) → Services (业务层) → 数据访问层 (Neo4j/SQLite-vec)
```

### 关键子系统
1. **智能体系统** (`backend/agents/`) - 统一入口的多智能体架构，支持任务分解和协调
2. **节点系统** (`backend/nodes/`) - 可配置的数据处理节点，支持热插拔
3. **LLMAdapter** (`backend/llm_adapter/`) - 统一的 LLM 管理接口，支持多提供商
4. **工作流系统** (`backend/workflows/`) - 节点编排和执行引擎
5. **向量检索** (`backend/vector_store/`) - 基于 SQLite + sqlite-vec 的语义搜索

### 智能体系统（核心特性）

#### 架构设计
智能体系统采用 **MasterAgent 统一入口架构**：
- 所有用户请求通过 MasterAgent 作为唯一入口
- MasterAgent 自动分析任务复杂度并决定执行策略（simple/complex）
- 支持任务自动分解和多智能体协调
- 详见 `backend/agents/docs/UNIFIED_ENTRY_ARCHITECTURE.md`

#### 核心组件
- `BaseAgent` - 智能体基类，定义统一接口 (`backend/agents/base.py`)
- `AgentOrchestrator` - 编排器，管理路由和协调 (`backend/agents/orchestrator.py`)
- `MasterAgent` - 主协调智能体，系统统一入口 (`backend/agents/master_agent.py`)
- `AgentLoader` - 动态加载器，从配置文件加载智能体 (`backend/agents/agent_loader.py`)

#### 智能体配置化系统
**所有智能体通过 YAML 配置文件定义**，无需编写代码：
- 配置文件: `backend/agents/configs/agent_configs.yaml`
- 配置模型: `backend/agents/agent_config.py` (AgentConfig, AgentLLMConfig, AgentToolConfig)
- 配置管理: `backend/agents/config_manager.py`

**智能体实现模板**：
**ReActAgent** (`backend/agents/react_agent.py`)
   - 推理与行动智能体，使用 Structured Output 代替 Function Calling
   - 支持任何支持 JSON mode 的模型
   - 推理过程完全可见 (thought → actions → observation)
   - 运行时工具权限验证

**配置示例**：
```yaml
agents:
  qa_agent:
    agent_name: qa_agent
    display_name: 知识图谱问答智能体
    enabled: true
    llm:
      provider: deepseek
      model_name: deepseek-chat
      temperature: 0.2
      max_tokens: 4096
    tools:
      enabled_tools:
        - query_knowledge_graph_with_nl
        - find_causal_chain
    custom_params:
      type: react
      behavior:
        system_prompt: "你是一个知识图谱问答助手..."
        max_rounds: 10
```

#### 自研工具调用机制
**不依赖特定 LLM 提供商的 Function Calling API**，支持任何大模型：
- **工具定义**: `backend/tools/function_definitions.py` (11个专业工具)
  1. `query_knowledge_graph_with_nl` - 自然语言查询（核心工具）
  2. `search_knowledge_graph` - 结构化搜索
  3. `get_entity_relations` - 关系探索
  4. `execute_cypher_query` - 直接执行Cypher
  5. `analyze_temporal_pattern` - 时序分析
  6. `find_causal_chain` - 因果追踪
  7. `compare_entities` - 实体对比
  8. `aggregate_statistics` - 聚合统计
  9. `get_spatial_neighbors` - 空间邻近查询
  10. `get_graph_schema` - 图谱Schema
  11. `query_emergency_plan` - 应急预案检索（向量RAG）
  12. `generate_chart` - ECharts图表生成

- **工具执行器**: `backend/tools/tool_executor.py`
  - `execute_tool(tool_name, arguments)` 统一执行入口
  - 路由到具体服务实现
  - 错误处理与结果包装

#### API 端点
```bash
GET  /api/agent/agents           # 列出所有智能体
POST /api/agent/execute          # 执行任务（自动路由到 MasterAgent）
POST /api/agent/execute-stream   # 流式执行（SSE）
GET  /api/agent/config           # 获取所有智能体配置
PUT  /api/agent/config/:name     # 更新智能体配置
```

### 节点系统设计
节点系统是本项目的核心特色，采用 Schema-driven UI 设计：
- 所有节点继承 `INode` 接口和 `NodeConfigBase` 配置基类
- 配置使用 Pydantic 模型，通过 `json_schema_extra` 添加 UI 元数据
- `schema_generator.py` 自动生成前端友好的配置 Schema
- 前端 `NodeConfigEditor.vue` 根据 Schema 自动渲染表单

## 常用命令

### 开发环境启动
```bash
# 后端启动（在 backend/ 目录） conda activate ragsystem
python app.py
# 默认运行在 http://localhost:5000

# 前端启动（在 frontend/ 目录）
npm run dev
# 默认运行在 http://localhost:5173

# Windows 一键启动
start_server.bat
```

### 测试
```bash
# 测试所有节点配置
cd backend
python test_all_node_configs.py

# 测试特定节点
python -c "from nodes.llmjson_v2.node import LLMJsonV2Node; print(LLMJsonV2Node.get_config_schema())"
```

### 前端构建
```bash
cd frontend
npm run build      # 构建生产版本
npm run preview    # 预览构建结果
```

### 数据库
```bash
# Neo4j 需要单独启动（使用 Neo4j Desktop 或 Docker）
# 确保 Neo4j 在 bolt://localhost:7687 运行

# SQLite + sqlite-vec 向量库
# 无需额外服务，单文件数据库自动创建在 backend/data/vector_store.db
```

## 配置系统

### 配置优先级（从高到低）
1. 环境变量（格式：`SECTION__KEY`，如 `NEO4J__PASSWORD`）
2. `backend/config/yaml/config.yaml`（用户配置，不提交到 git）
3. `backend/config/yaml/config.default.yaml`（默认配置）

### 关键配置项
```yaml
# backend/config/yaml/config.yaml
neo4j:
  uri: bolt://localhost:7687
  user: neo4j
  password: your_password

# 向量存储配置（新版）
vector_store:
  backend: sqlite_vec              # sqlite_vec (推荐) 或 postgresql (未来)
  sqlite_vec:
    database_path: data/vector_store.db  # 数据库文件路径
    vector_dimension: 768          # 向量维度（需与 Embedding 模型匹配）
    distance_metric: cosine        # 距离度量: cosine, l2, ip

llm:
  provider: deepseek               # 必须在 LLMAdapter 中配置对应 Provider
  model_name: deepseek-chat        # 模型名称
  temperature: 0.7
  max_tokens: 4096

# Embedding 配置（使用远程 API）
embedding:
  mode: remote                     # 仅支持 remote 模式
  remote:
    api_endpoint: https://api.openai.com/v1  # 或 DeepSeek 等兼容 API
    api_key: your_api_key
    model_name: text-embedding-3-small
```

## 开发指南

### 添加/配置智能体
**通过 YAML 配置文件添加智能体，无需编写代码**：

1. 编辑 `backend/agents/configs/agent_configs.yaml`
2. 添加新的智能体配置：
   ```yaml
   agents:
     my_agent:
       agent_name: my_agent
       display_name: 我的智能体
       description: 专门处理XX任务
       enabled: true
       llm:
         provider: deepseek
         temperature: 0.3
       tools:
         enabled_tools:
           - query_knowledge_graph_with_nl
           - find_causal_chain
       custom_params:
         type: react
         behavior:
           system_prompt: "你是一个专门做XX的智能体..."
           max_rounds: 10
   ```
3. 重启后端，智能体自动加载
4. 或通过前端 `/agent-config` 界面在线配置

### 添加新工具
1. 在 `backend/tools/function_definitions.py` 中添加工具定义：
   ```python
   {
       "type": "function",
       "function": {
           "name": "my_tool",
           "description": "工具描述",
           "parameters": {
               "type": "object",
               "properties": {
                   "param1": {"type": "string", "description": "参数说明"}
               },
               "required": ["param1"]
           }
       }
   }
   ```
2. 在 `backend/tools/tool_executor.py` 中实现工具逻辑：
   ```python
   def execute_tool(tool_name, arguments):
       if tool_name == 'my_tool':
           return my_tool_impl(arguments)

   def my_tool_impl(arguments):
       # 实现工具逻辑
       return {"success": True, "data": result}
   ```
3. 在智能体配置中启用该工具

### 添加新节点
1. 在 `backend/nodes/` 创建节点目录
2. 实现 `config.py`（配置类，继承 `NodeConfigBase`）
3. 实现 `node.py`（节点类，继承 `INode`）
4. 在配置类的 Field 中添加 UI 元数据：
   ```python
   from pydantic import Field

   class MyConfig(NodeConfigBase):
       api_key: str = Field(
           default="",
           description="API密钥",
           json_schema_extra={
               'group': 'api',          # 分组
               'format': 'password',    # 显示为密码框
               'order': 1               # 排序
           }
       )
   ```
5. 节点会自动被 `registry.py` 发现并注册

### 添加新 API 路由
1. 在 `backend/routes/` 创建蓝图文件
2. 实现路由处理函数
3. 在 `backend/app.py` 中注册蓝图：
   ```python
   from routes.my_route import my_bp
   app.register_blueprint(my_bp, url_prefix='/api/my-route')
   ```

### 使用 LLMAdapter
LLMAdapter 是统一的 LLM 调用接口，已替代旧的 LLMService：
```python
from llm_adapter import get_default_adapter

adapter = get_default_adapter()
response = adapter.generate(
    messages=[{"role": "user", "content": "Hello"}],
    temperature=0.7
)
```

配置 Provider 通过前端管理界面（`/llm-adapter`）或直接调用 API。

### 前端组件开发
- 使用 Element Plus 组件库
- API 调用封装在 `frontend/src/api/` 目录
- 可复用组件放在 `frontend/src/components/`
- 页面视图放在 `frontend/src/views/`

### 节点配置 UI 元数据
参考 `backend/nodes/UI_METADATA_REFERENCE.md` 获取完整的元数据选项。

常用元数据：
- `group`: 字段分组（`api`, `model`, `template`, `advanced` 等）
- `format`: 格式类型（`password`, `url`, `textarea`, `json` 等）
- `order`: 字段排序
- `options`: 下拉选项
- `minimum/maximum`: 数值范围
- `placeholder`: 占位符文本

## 代码规范

### 后端
- 使用 Pydantic 进行数据验证
- 所有配置类继承 `NodeConfigBase` 或 `BaseModel`
- API 路由使用蓝图组织
- 服务层代码放在 `backend/services/`
- 工具函数放在 `backend/utils/` 或 `backend/tools/`

### 前端
- 组件使用 Vue 3 Composition API
- 使用 `<script setup>` 语法
- 状态管理使用组件内部状态或 provide/inject
- 样式使用 scoped CSS

### 命名规范
- Python: snake_case（函数、变量）、PascalCase（类）
- JavaScript: camelCase（函数、变量）、PascalCase（组件）
- 配置键: snake_case
- API 路径: kebab-case

## 重要注意事项

### 向量存储重构 (2026-01-24)
系统已完全重构向量存储，使用 SQLite + sqlite-vec：
- ✅ **零依赖部署**: 单文件数据库，无需额外服务
- ✅ **SQL 原生支持**: 强大的元数据过滤和查询
- ✅ **体积减少 ~500MB**: 移除 PyTorch/sentence-transformers 依赖
- ✅ **远程 Embedding**: 使用 OpenAI 兼容 API（DeepSeek/智谱/自建服务）
- ✅ **智能维度推断**: 自动从 Embedding 模型获取向量维度，无需手动配置
- ✅ **自动重建机制**: 检测维度不匹配时自动重建数据库
- ✅ **数据迁移工具**: `utils/migrate_vector_dimension.py` 用于重新编码现有数据
- 🔧 配置项: `vector_store.backend` (默认 `sqlite_vec`)
- 📖 详见 `VECTOR_STORE_MIGRATION.md` 完整迁移指南

**重要特性：维度自动匹配**
- 系统会自动从 Embedder 获取实际向量维度
- 如果配置的维度与 Embedder 不匹配，自动使用 Embedder 维度
- 检测到现有数据库维度不匹配时，自动备份并重建
- 使用迁移工具可保留数据并重新编码：
  ```bash
  cd backend
  python -m utils.migrate_vector_dimension  # 迁移所有集合
  python -m utils.migrate_vector_dimension --collection default  # 迁移指定集合
  ```

### LLMAdapter 迁移
系统已从 LLMService 迁移到 LLMAdapter：
- ❌ 不要使用 `get_llm_service()`，已移除
- ✅ 使用 `get_default_adapter()`
- 配置文件已迁移到 YAML 格式
- 详见 `LLMADAPTER_MIGRATION_GUIDE.md`

### 节点配置 UI
- 节点配置已升级为智能表单系统（2025-12-26）
- 如需修改节点配置 UI，在配置类的 Pydantic Field 添加 `json_schema_extra`
- 运行 `test_all_node_configs.py` 验证配置正确性
- 详见 `docs/node-config-ui/README.md`

### 数据库连接
- Neo4j 必须先启动才能运行后端
- 使用 `db.test_connection()` 测试连接
- SQLite + sqlite-vec 用于向量存储，会自动初始化（单文件数据库）

### 安全
- 配置文件 `config.yaml` 和 `config.js` 已添加到 `.gitignore`
- API 密钥等敏感信息应从环境变量读取
- 使用 `format: 'password'` 隐藏敏感配置字段

## 故障排查

### 后端启动失败
1. 检查 Neo4j 是否运行
2. 检查 `backend/config/yaml/config.yaml` 配置
3. 查看后端日志输出

### 前端显示异常
1. 检查后端 API 是否正常响应
2. 打开浏览器开发者工具查看控制台错误
3. 检查 CORS 配置

### 节点显示 JSON 编辑器而非表单
1. 运行 `python test_all_node_configs.py` 检查配置
2. 检查后端日志中的 Schema 生成错误
3. 确认配置类继承了 `NodeConfigBase`
4. 检查 `json_schema_extra` 格式

### 向量存储问题
1. 检查 `backend/config/yaml/config.yaml` 中 `vector_store` 配置
2. 确认 `embedding.mode` 设置为 `remote` 并配置了 API Key
3. 检查 SQLite 数据库文件权限（`backend/data/vector_store.db`）
4. 查看后端日志中的向量存储初始化信息

### LLM 调用失败
1. 检查 LLMAdapter Provider 配置
2. 访问 `/llm-adapter` 管理界面测试连接
3. 确认 API Key 正确且有效
4. 检查网络连接

## 文档资源

### 智能体系统
- **统一入口架构**: `backend/agents/docs/UNIFIED_ENTRY_ARCHITECTURE.md` - 架构设计详解
- **智能体配置**: `backend/agents/configs/agent_configs.yaml` - 配置文件示例
- **配置模型**: `backend/agents/agent_config.py` - AgentConfig 数据模型
- **动态加载**: `backend/agents/agent_loader.py` - 智能体加载机制

### 工具系统
- **工具定义**: `backend/tools/function_definitions.py` - 所有工具的定义
- **工具执行**: `backend/tools/tool_executor.py` - 工具执行逻辑

### 向量存储系统（新版）
- **抽象基类**: `backend/vector_store/base.py` - VectorStoreBase 接口
- **SQLite 实现**: `backend/vector_store/sqlite_store.py` - SQLite + sqlite-vec
- **客户端**: `backend/vector_store/client.py` - 工厂模式客户端
- **Embedder**: `backend/vector_store/embedder.py` - 远程 API 向量化
- **迁移指南**: `VECTOR_STORE_MIGRATION.md` - 从 ChromaDB 迁移

### 其他文档
- **快速参考**: `QUICK_REFERENCE.md` - 常用信息速查
- **项目结构**: `PROJECT_STRUCTURE.md` - 详细目录结构
- **节点系统**: `docs/node-config-ui/README.md` - 节点配置文档
- **LLMAdapter**: `LLMADAPTER_MIGRATION_GUIDE.md` - LLM 适配器指南
- **配置 UI 指南**: `backend/nodes/CONFIG_UI_GUIDE.md` - 开发节点配置
- **UI 元数据参考**: `backend/nodes/UI_METADATA_REFERENCE.md` - 完整元数据选项

## 技术栈

### 后端
- Flask 2.3.3 - Web 框架
- Pydantic 2.12.5 - 数据验证
- Neo4j 6.0.3 - 图数据库驱动
- SQLite + sqlite-vec - 向量数据库（零依赖）
- requests - HTTP 客户端（用于远程 Embedding API）

### 前端
- Vue 3.3.8 - 前端框架
- Element Plus 2.4.3 - UI 组件库
- Vue Router 4.2.5 - 路由
- Vite 5.0.0 - 构建工具
- ECharts 5.4.3 - 数据可视化

### 外部服务
- llmjson: LLM 驱动的 JSON 提取（源码安装）
- json2graph: JSON 转知识图谱（源码安装）
- 远程 Embedding API: OpenAI / DeepSeek / 智谱 AI 等兼容服务
