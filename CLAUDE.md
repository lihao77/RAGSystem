# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

RAGSystem 是一个基于知识图谱的智能问答系统，整合时序推理、空间分析和因果追踪功能。系统采用前后端分离架构：后端使用 Flask + Neo4j；前端为**双前端**——`frontend/` 负责后台管理（配置、工作流、向量库等），`frontend-client/` 负责多 Agent 对话与落地页，均使用 Vue 3 + Element Plus。

## 核心架构

### 三层架构
```
Routes (API层) → Services (业务层) → 数据访问层 (Neo4j/SQLite-vec)
```

### 关键子系统
1. **智能体系统** (`backend/agents/`) - 统一入口的多智能体架构，支持任务分解和协调
2. **节点系统** (`backend/nodes/`) - 可配置的数据处理节点，支持热插拔
3. **ModelAdapter** (`backend/model_adapter/`) - 统一的 AI 模型管理接口，支持多提供商（LLM + Embedding）
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

#### 可观测性系统（新增 2026-02-23）

**结构化日志** (`backend/agents/logging/`)
- JSON 格式日志输出
- 上下文绑定（agent_name, session_id, trace_id）
- 性能指标记录（duration_ms, token_usage）
- 使用示例：
  ```python
  from agents.logging import get_logger
  logger = get_logger("qa_agent", session_id="abc-123")
  logger.info("tool_call", tool_name="query_kg", duration_ms=1234)
  ```

**性能指标收集** (`backend/agents/monitoring/`)
- 自动订阅事件总线，收集智能体执行指标
- 工具调用统计、错误分布分析
- API: `GET /api/agent/metrics`

**监控 API**
- `GET /api/agent/metrics` - 获取系统性能指标
- `GET /api/agent/metrics?agent_name=<name>` - 获取单个智能体指标
- `POST /api/agent/metrics/reset` - 重置性能指标

#### 错误处理与重试（新增 2026-02-23）

**错误分类器** (`backend/agents/errors/`)
- 区分可重试错误（网络、超时）和不可重试错误（参数、权限）
- 自动识别错误类型并提供推荐重试配置
- 使用示例：
  ```python
  from agents.errors import ErrorClassifier
  if ErrorClassifier.is_retryable(exception):
      # 重试逻辑
  ```

**重试装饰器** (`backend/utils/retry_decorator.py`)
- 自动重试失败操作，支持指数退避
- 使用示例：
  ```python
  @retry_on_failure(max_retries=3, backoff_factor=2.0)
  def execute_tool(tool_name, arguments):
      pass
  ```

**检查点恢复** (`backend/agents/recovery/`)
- 在关键节点保存执行状态
- 支持从失败点恢复执行
- API: `POST /api/agent/sessions/<session_id>/recover`

#### 工具权限控制（新增 2026-02-23）

**工具风险等级** (`backend/tools/permissions.py`)
- LOW: 只读操作（如 query_knowledge_graph_with_nl）
- MEDIUM: 可能耗时操作（如 find_causal_chain）
- HIGH: 写操作/执行命令（如 execute_cypher_query，需用户审批）

**权限验证**
- 在工具执行前自动检查权限
- 检查工具是否在智能体配置中启用
- 高风险工具需要用户审批（通过 USER_APPROVAL_REQUIRED 事件）

**配置示例**：
```yaml
agents:
  qa_agent:
    tools:
      enabled_tools:
        - query_knowledge_graph_with_nl  # 低风险，自动允许
        - search_knowledge_graph          # 低风险，自动允许
        # execute_cypher_query 未启用（高风险）
```

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
- **工具定义**: `backend/tools/function_definitions.py`（10+ 专业工具，含 Skills 注入的 `load_skill_resource`、`execute_skill_script`）
  - 知识图谱：`query_knowledge_graph_with_nl`、`search_knowledge_graph`、`get_entity_relations`、`execute_cypher_query`、`get_graph_schema`
  - 时序/因果/空间：`analyze_temporal_pattern`、`find_causal_chain`、`get_spatial_neighbors`
  - 分析/展示：`compare_entities`、`aggregate_statistics`、`generate_chart`、`generate_map`
  - 向量 RAG：`query_emergency_plan`
  - 数据与几何：`process_data_file`、`get_entity_geometry`、`transform_data`

- **工具执行器**: `backend/tools/tool_executor.py`
  - `execute_tool(tool_name, arguments)` 统一执行入口
  - 路由到具体服务实现
  - 错误处理与结果包装

#### API 端点
```bash
# 智能体执行（backend/routes/agent.py，前缀 /api/agent）
GET  /api/agent/agents              # 列出所有智能体
POST /api/agent/execute             # 执行任务（自动路由到 MasterAgent）
POST /api/agent/stream               # 流式执行（SSE）
POST /api/agent/execute/<agent_name> # 指定智能体执行
GET  /api/agent/sessions             # 会话列表
POST /api/agent/sessions             # 创建会话

# 性能监控（新增）
GET  /api/agent/metrics              # 获取系统性能指标
GET  /api/agent/metrics?agent_name=<name>  # 获取单个智能体指标
POST /api/agent/metrics/reset        # 重置性能指标

# 检查点恢复（新增）
POST /api/agent/sessions/<session_id>/recover      # 从检查点恢复执行
GET  /api/agent/sessions/<session_id>/checkpoints  # 列出会话检查点

# 智能体配置（backend/routes/agent_config.py，前缀 /api/agent-config）
GET    /api/agent-config/configs           # 获取所有智能体配置
GET    /api/agent-config/configs/<name>    # 获取单个配置
PUT    /api/agent-config/configs/<name>   # 更新智能体配置
PATCH  /api/agent-config/configs/<name>   # 部分更新
DELETE /api/agent-config/configs/<name>   # 删除配置
GET    /api/agent-config/tools             # 可用工具列表
GET    /api/agent-config/skills            # 可用 Skills 列表
```

### Skills 系统（领域知识增强）

Skills 系统为智能体提供领域知识注入能力，采用渐进式披露和依赖隔离设计。

#### 核心特性

1. **渐进式披露（Progressive Disclosure）**
   - 初始仅加载 Skill 名称和描述（~100 tokens）
   - 按需加载详细文档（Additional Resources）
   - 零上下文执行工具脚本（Utility Scripts）
   - 节省 60-95% 上下文消耗

2. **依赖完全隔离**
   - 每个 Skill 拥有独立的 Python 虚拟环境
   - 自动创建和管理虚拟环境（`.venv/`）
   - 自动安装 `requirements.txt` 中的依赖
   - 避免版本冲突和环境污染
   - 跨平台 UTF-8 编码支持

3. **权限精细控制**
   - 基于配置的 Skills 分配
   - 每个智能体只能访问授权的 Skills
   - 自动注入 Skills 系统工具（`load_skill_resource`, `execute_skill_script`）

#### Skill 目录结构

```
backend/agents/skills/
├── my-skill/
│   ├── SKILL.md                # 主文件（必需，包含 YAML Front Matter）
│   ├── requirements.txt        # 依赖声明（可选，用于脚本）
│   ├── .venv/                  # 虚拟环境（自动创建）
│   ├── additional-doc.md       # 引用文档（按需加载）
│   └── scripts/
│       └── process_data.py     # 工具脚本（零上下文执行）
```

#### SKILL.md 格式

```markdown
---
name: my-skill
description: 简短描述 Skill 的功能和使用场景
---

# Skill 标题

## 核心流程
简洁的操作步骤...

## 详细文档
完整说明请参见 [additional-doc.md](additional-doc.md)

## 工具脚本
使用验证脚本：
\`\`\`bash
python scripts/process_data.py
\`\`\`
```

#### 智能体配置

```yaml
agents:
  qa_agent:
    tools:
      enabled_tools:
        - query_knowledge_graph_with_nl
        # Skills 工具无需手动添加，会自动注入

    skills:
      enabled_skills:
        - disaster-report-example  # 启用的 Skill 列表
        - data-analysis-skill
      auto_inject: true            # 自动注入 Skills 系统工具
```

#### Skills 系统工具

当智能体启用 Skills 时，自动获得两个工具：

1. **load_skill_resource** - 加载引用文档
   ```json
   {
     "tool": "load_skill_resource",
     "arguments": {
       "skill_name": "my-skill",
       "resource_file": "additional-doc.md"
     }
   }
   ```

2. **execute_skill_script** - 执行工具脚本（在隔离环境中）
   ```json
   {
     "tool": "execute_skill_script",
     "arguments": {
       "skill_name": "my-skill",
       "script_name": "process_data.py",
       "arguments": []
     }
   }
   ```

#### 依赖隔离配置

Skills 隔离由 `backend/agents/skills/skill_environment.py` 实现；隔离模式可通过「系统配置」或调用时传入。若在配置文件中声明，需在 `backend/config/yaml/config.yaml` 中增加 `skills` 段（当前 `backend/config/models.py` 的 `AppConfig` 未定义 `skills` 字段，但 `extra='allow'` 会保留 YAML 中的该段）：

```yaml
# backend/config/yaml/config.yaml（可选）
skills:
  isolation_mode: venv   # venv（推荐）| docker | shared
  # 虚拟环境目录名由代码固定为 .venv（skill_dir / ".venv"）
```

#### 核心组件

- **SkillLoader** (`backend/agents/skills/skill_loader.py`)
  - 加载所有 Skills
  - 解析 SKILL.md 的 YAML Front Matter
  - 提供按需加载资源文件的接口

- **SkillEnvironment** (`backend/agents/skills/skill_environment.py`)
  - 管理虚拟环境（创建、依赖安装）
  - 在隔离环境中执行脚本
  - 强制 UTF-8 编码（解决 Windows GBK 问题）

- **工具执行器** (`backend/tools/tool_executor.py`)
  - `load_skill_resource()` - 加载资源文件
  - `execute_skill_script()` - 执行脚本（调用 SkillEnvironment）

#### 文档资源

- **系统概述**: `backend/agents/skills/README.md`
- **依赖隔离指南**: `backend/agents/skills/SKILL_DEPENDENCY_ISOLATION.md`
- **使用机制**: `backend/agents/skills/HOW_AI_USES_SKILLS.md`
- **权限控制**: `backend/agents/skills/SKILLS_PERMISSION_CONTROL.md`
- **测试 Skill**: `backend/agents/skills/test-isolation-skill/`

#### 测试

```bash
# 测试依赖隔离功能
cd backend
python test_skill_isolation.py

# 测试结果：
# ✓ Skill 成功加载
# ✓ 虚拟环境自动创建
# ✓ 依赖自动安装
# ✓ 脚本在隔离环境中执行
# ✓ 后端依赖不可见（环境隔离成功）
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
# 后端（在 backend/ 目录）
conda activate ragsystem   # 或使用项目虚拟环境
python app.py
# 默认 http://localhost:5000

# 前端（双前端架构，需分别启动）
cd frontend && npm run dev          # 后台管理端，默认 http://localhost:5173
cd frontend-client && npm run dev  # 多 Agent 对话/落地页端，默认端口见其 package.json

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
# 后台管理端
cd frontend && npm run build && npm run preview

# 多 Agent 端
cd frontend-client && npm run build && npm run preview
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
1. **环境变量**（在 `backend/config/base.py` 中显式读取）：`NEO4J_URI`、`NEO4J_USER`、`NEO4J_PASSWORD`、`LLM_API_ENDPOINT`、`LLM_API_KEY`、`LLM_MODEL_NAME`
2. **用户配置**：`backend/config/yaml/config.yaml`（可选，不提交到 git；不存在时仅用 Pydantic 默认值）
3. **默认 YAML**：`backend/config/yaml/config.default.yaml`（可选，当前仓库未提供；无则用空 dict）
4. **Pydantic 默认值**：`backend/config/models.py` 中 `AppConfig` 及各子模型的 Field default

### 关键配置项

配置结构由 `backend/config/models.py` 定义（`AppConfig`、`Neo4jConfig`、`LLMConfig`、`VectorStoreConfig` 等）。用户只需提供覆盖项，其余使用 Pydantic 默认值。示例见 `backend/config/yaml/config.yaml.example`。

```yaml
# backend/config/yaml/config.yaml（可选，仅写需覆盖项）
neo4j:
  uri: bolt://localhost:7687
  user: neo4j
  password: your_password   # 或使用环境变量占位符 "${NEO4J_PASSWORD}"

vector_store:
  backend: sqlite_vec
  sqlite_vec:
    database_path: data/vector_store.db
    vector_dimension: 0     # 0=自动与当前激活向量化器一致
    distance_metric: cosine

llm:
  provider: ""              # ModelAdapter 中的 Provider name
  provider_type: ""         # 用于复合键 {name}_{provider_type}
  model_name: ""
  temperature: 0.7
  max_tokens: 4096

embedding:
  provider: ""
  provider_type: ""
  model_name: ""
  batch_size: 100

system:
  max_content_length: 104857600

# 注意：向量化器（Embedding 模型）已迁移到「向量库管理」，不再使用 config.embedding。
# 请在「向量知识库」页的「向量化器」Tab 中添加并激活向量化器；配置存于 backend/vector_store/config/vectorizers.yaml。
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
         max_completion_tokens: 4096    # 单次输出的最大 token 数
         max_context_tokens: 128000     # 模型支持的最大上下文窗口（如 DeepSeek 128K）
       tools:
         enabled_tools:
           - query_knowledge_graph_with_nl
           - find_causal_chain
       custom_params:
         type: react
         behavior:
           system_prompt: "你是一个专门做XX的智能体..."
           max_rounds: 10
           # max_context_tokens: 80000  # 可选：显式指定对话历史预算（覆盖自动计算）
   ```
3. 重启后端，智能体自动加载
4. 或通过前端 `/agent-config` 界面在线配置

**LLM 配置说明**：
- `max_completion_tokens`：单次生成的最大 token 数（输出长度限制）
- `max_context_tokens`：模型支持的最大上下文窗口（输入+输出总长度）
  - 如 GPT-4 Turbo: 128000
  - 如 DeepSeek V3: 128000
  - 如 Claude 3.5 Sonnet: 200000
- `behavior.max_context_tokens`：可选，显式指定对话历史的上下文预算
  - 不配置时自动计算：`(max_context_tokens * 0.9) - 2000 - max_completion_tokens`
  - 预留空间给 system prompt、输出和安全边界
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

### 创建新 Skill

**通过文件系统创建 Skill，无需编写代码**：

1. 创建 Skill 目录结构
   ```bash
   mkdir -p backend/agents/skills/my-skill/scripts
   ```

2. 创建 `SKILL.md`（必需）
   ```markdown
   ---
   name: my-skill
   description: 简短描述功能和使用场景（用于智能体判断何时使用）
   ---

   # 我的 Skill

   ## 核心流程
   1. 步骤一...
   2. 步骤二...

   ## 详细文档
   更多信息参见 [详细文档](details.md)

   ## 工具脚本
   使用数据处理脚本：
   \`\`\`bash
   python scripts/process.py
   \`\`\`
   ```

3. 创建 `requirements.txt`（可选，用于脚本依赖）
   ```txt
   # Use English comments to avoid encoding issues
   pandas>=2.0.0
   requests>=2.31.0
   ```

4. 创建工具脚本（可选）
   ```python
   # backend/agents/skills/my-skill/scripts/process.py
   #!/usr/bin/env python
   # -*- coding: utf-8 -*-
   import sys

   def main():
       print("Processing...")
       return 0

   if __name__ == "__main__":
       sys.exit(main())
   ```

5. 在智能体配置中启用
   ```yaml
   agents:
     qa_agent:
       skills:
         enabled_skills:
           - my-skill
   ```

6. 测试 Skill
   ```bash
   cd backend
   python test_skill_isolation.py
   ```

**重要提示**：
- ✅ `requirements.txt` 使用英文注释（避免 Windows GBK 编码问题）
- ✅ 仅包含脚本必需的依赖（最小化原则）
- ✅ 固定版本范围（如 `pandas>=2.0.0,<3.0.0`）
- ❌ 避免巨型依赖（如 torch, tensorflow）

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
2. 实现路由处理函数（如需配置，从 `config import get_config`）
3. 在 `backend/app.py` 中注册蓝图：
   ```python
   from routes.my_route import my_bp
   app.register_blueprint(my_bp, url_prefix='/api/my-route')
   ```

### 使用 ModelAdapter
ModelAdapter 是统一的 AI 模型调用接口，支持 LLM 和 Embedding（实现见 `backend/model_adapter/adapter.py`）：
```python
from model_adapter import get_default_adapter

adapter = get_default_adapter()

# LLM 调用（provider 必填；model 可选，不传时用该 Provider 的默认模型）
response = adapter.chat_completion(
    messages=[{"role": "user", "content": "Hello"}],
    provider="test_deepseek",   # 复合键或 name，可选传 provider_type
    model=None,                 # 可选
    temperature=0.7
)

# Embedding 调用
response = adapter.embed(
    texts=["文本内容"],
    provider="test_openrouter",
    model="openai/text-embedding-3-small"
)
```

**复合键机制：**
- Provider 使用 `{name}_{provider_type}` 作为唯一标识（`_make_provider_key`）
- 示例：`test_deepseek`、`test_openrouter`
- 支持同名但不同类型的 Provider 共存

**配置管理：**
- 单一配置文件：`backend/model_adapter/configs/providers.yaml`（示例：`providers.yaml.example`）
- 配置存储类：`backend/model_adapter/config_store.py` 的 `ModelAdapterConfigStore`
- API 与前端：蓝图挂载在 `/api/model-adapter`；前端管理界面路由一般为 `/model-adapter`
- 热重载：`adapter.reload()`（失败时自动回滚）

### 前端组件开发
- 双前端架构：两个独立前端，均使用 Vue 3 + Element Plus
  - **frontend/**：后台管理端（配置、工作流、向量库、节点、系统设置等）
  - **frontend-client/**：多 Agent 对话与落地页（聊天、执行计划、流式输出、性能监控等）
- API 分别封装在 `frontend/src/api/`、`frontend-client/src/api/`
- 可复用组件与页面视图各自在对应目录的 `components/`、`views/`

#### 前端新功能（2026-02-23）

**用户审批对话框** (`frontend-client/src/components/ApprovalDialog.vue`)
- 监听 SSE 流中的 `USER_APPROVAL_REQUIRED` 事件
- 显示智能体请求执行高风险工具的审批对话框
- 支持批准/拒绝操作，60秒倒计时自动拒绝
- 调用 `/api/agent/approvals/<id>/respond` API 响应审批

**性能监控面板** (`frontend-client/src/views/AgentMonitor.vue`)
- 访问路径: `/monitor` 或 `/agent-monitor`
- 显示系统级指标（智能体总数、总调用次数、平均耗时、成功率）
- 显示智能体详情（工具使用统计、错误分布、性能指标）
- 支持智能体筛选、刷新和重置功能
- 使用 `/api/agent/metrics` API 获取数据

**使���指南**: 详见 `FRONTEND_USAGE_GUIDE.md`

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
- ✅ **智能维度推断**: 自动从当前激活向量化器获取向量维度
- 🔧 配置项: `vector_store.backend` (默认 `sqlite_vec`)
- 📖 详见 `docs/migration/VECTOR_STORE_MIGRATION.md` 完整迁移指南

### 向量库版本化与插件式管理 (2026-02)
- ✅ **向量化器独立配置**: 与主配置解耦，存于 `backend/vector_store/config/vectorizers.yaml`，键为 `provider_key_model_name`
- ✅ **单一激活向量化器**: 索引与默认检索使用「当前激活」的向量化器；`get_embedder()` / 向量库初始化**仅**读向量库管理配置，**不再**读 `config.embedding`
- ✅ **多向量化器并存**: 新增向量化器时只注册到 `embedding_models`，**不**删除或重建已有向量表
- ✅ **可观测与迁移**: 可查看某向量化器下已向量化文档；支持将某集合迁移到指定向量化器（重新向量化并写入）
- ✅ **删除仅限配置**: 仅在用户于「向量库管理」中删除某向量化器时，才删除其配置及 DB 中对应 `document_vectors` / `embedding_models`
- 🔧 前端：向量知识库 → **向量化器** Tab：列表、新增、激活、查看文档、迁移、删除
- 🔧 API：`/api/vector-library/vectorizers`（GET/POST）、`/api/vector-library/vectorizers/<key>/activate`、`/docs`、`/migrate`、DELETE
- 📖 向量化器配置存储：`backend/vector_store/vectorizer_config.py`（VectorizerConfigStore）

### ModelAdapter 架构（2026-02-13 更新）
系统已完成 ModelAdapter 架构升级：
- ✅ **单一配置文件**：从多文件改为 `providers.yaml`，减少 95% IO 操作
- ✅ **复合键机制**：使用 `{name}_{provider_type}` 解决同名配置覆盖问题
- ✅ **热重载支持**：`adapter.reload()` 方法，失败自动回滚
- ✅ **代码简化**：ConfigStore 从 286 行减少到 130 行
- ❌ **LLMAdapter 已废弃**：统一使用 ModelAdapter

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
1. 启动前会执行 `backend/config/health_check.py` 中的健康检查（Neo4j、ModelAdapter、向量化器等），失败会直接退出并提示
2. 检查 Neo4j 是否运行（默认 `bolt://localhost:7687`）
3. 检查 `backend/config/yaml/config.yaml` 或环境变量（见「配置优先级」）
4. 查看后端日志输出

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
1. 检查 `backend/config/yaml/config.yaml` 中 `vector_store` 配置（数据库路径、距离度量等）
2. **向量化器**：在「向量知识库」→「向量化器」Tab 中至少添加并激活一个向量化器（Provider + 模型来自 Model Adapter）
3. 检查 SQLite 数据库文件权限（`backend/data/vector_store.db`）
4. 查看后端日志中的向量存储初始化信息；若提示「未配置激活的向量化器」，请到前端向量化器管理添加并激活

### LLM 调用失败
1. 检查 ModelAdapter Provider 配置
2. 访问 `/model-adapter` 管理界面测试连接
3. 确认 API Key 正确且有效
4. 检查网络连接
5. 如果是同名 Provider，确认使用了正确的 `provider_type`

### Skill 依赖隔离问题
1. **虚拟环境创建失败**
   - 检查目录权限：`chmod -R 755 backend/agents/skills/`
   - 确认磁盘空间充足（虚拟环境约 50MB）

2. **依赖安装超时**
   - 使用国内镜像：在 `requirements.txt` 首行添加 `-i https://pypi.tuna.tsinghua.edu.cn/simple`
   - 检查网络连接

3. **脚本找不到模块**
   - 删除虚拟环境重建：`rm -rf .venv && rm .venv/.installed`
   - 检查 `requirements.txt` 编码（使用英文注释）

4. **UTF-8 编码错误**
   - 已通过 `PYTHONIOENCODING=utf-8` 和 `PYTHONUTF8=1` 环境变量解决
   - 如仍有问题，检查脚本文件编码是否为 UTF-8

## 文档资源

### 智能体系统
- **统一入口架构**: `backend/agents/docs/UNIFIED_ENTRY_ARCHITECTURE.md` - 架构设计详解
- **智能体配置**: `backend/agents/configs/agent_configs.yaml`（由 `AgentConfigManager` 读写，示例见 `agent_configs.yaml.example`）
- **配置模型**: `backend/agents/agent_config.py` - AgentConfig、AgentLLMConfig、AgentToolConfig、AgentSkillConfig 等
- **系统升级总结**: `backend/agents/docs/AGENT_SYSTEM_UPGRADE_SUMMARY.md` - 可观测性、错误处理、权限控制升级说明（2026-02-23）
- **可观测性指南**: `backend/agents/docs/guides/OBSERVABILITY.md` - 结构化日志、性能指标、监控 API
- **错误处理指南**: `backend/agents/docs/guides/ERROR_HANDLING.md` - 重试机制、错误分类、检查点恢复
- **权限控制指南**: `backend/agents/docs/guides/PERMISSIONS.md` - 工具风险等级、权限验证、用户审批

### Skills 系统
- **系统概述**: `backend/agents/skills/README.md` - Skills 系统整体介绍
- **依赖隔离指南**: `backend/agents/skills/SKILL_DEPENDENCY_ISOLATION.md` - 完整依赖管理文档
- **使用机制**: `backend/agents/skills/HOW_AI_USES_SKILLS.md` - 智能体如何使用 Skills
- **权限控制**: `backend/agents/skills/SKILLS_PERMISSION_CONTROL.md` - 权限配置说明
- **测试 Skill**: `backend/agents/skills/test-isolation-skill/` - 环境隔离测试示例
- **动态加载**: `backend/agents/agent_loader.py` - 智能体加载机制

### 工具系统
- **工具定义**: `backend/tools/function_definitions.py` - 所有工具的定义
- **工具执行**: `backend/tools/tool_executor.py` - 工具执行逻辑（含权限检查）
- **工具权限**: `backend/tools/permissions.py` - 工具风险等级和权限配置

### 向量存储系统（新版）
- **抽象基类**: `backend/vector_store/base.py` - VectorStoreBase 接口
- **SQLite 实现**: `backend/vector_store/sqlite_store.py` - SQLite + sqlite-vec
- **客户端**: `backend/vector_store/client.py` - 工厂模式客户端
- **Embedder**: `backend/vector_store/embedder.py` - 按当前激活向量化器初始化（不读 config.embedding）
- **向量化器配置**: `backend/vector_store/vectorizer_config.py` - VectorizerConfigStore，YAML 存于 `backend/vector_store/config/vectorizers.yaml`
- **向量库管理 API**: `backend/routes/vector_library.py`（前缀 `/api/vector-library`）- 向量化器列表/新增/激活、按向量化器查文档/迁移/删除等
- **迁移指南**: `docs/migration/VECTOR_STORE_MIGRATION.md` - 从 ChromaDB 迁移

### 配置与迁移
- **配置系统指南**: `docs/configuration-guide.md` - 首次部署、健康检查、常见问题
- **迁移指南**: `docs/migration/README.md` - 向量存储、LLMAdapter 等迁移文档

### 其他文档
- **快速参考**: `QUICK_REFERENCE.md` - 常用信息速查
- **项目结构**: `PROJECT_STRUCTURE.md` - 详细目录结构
- **节点系统**: `docs/node-config-ui/README.md` - 节点配置文档
- **ModelAdapter**: `backend/model_adapter/README.md` - AI 模型适配器指南
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
