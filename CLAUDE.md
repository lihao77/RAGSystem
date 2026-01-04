# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

RAGSystem 是一个基于知识图谱的智能问答系统，整合时序推理、空间分析和因果追踪功能。系统采用前后端分离架构，后端使用 Flask + Neo4j，前端使用 Vue 3 + Element Plus。

## 核心架构

### 三层架构
```
Routes (API层) → Services (业务层) → 数据访问层 (Neo4j/ChromaDB)
```

### 关键子系统
1. **智能体系统** (`backend/agents/`) - 统一入口的多智能体架构，支持任务分解和协调
2. **节点系统** (`backend/nodes/`) - 可配置的数据处理节点，支持热插拔
3. **LLMAdapter** (`backend/llm_adapter/`) - 统一的 LLM 管理接口，支持多提供商
4. **工作流系统** (`backend/workflows/`) - 节点编排和执行引擎
5. **向量检索** (`backend/services/`) - 基于 ChromaDB 的语义搜索

### 智能体系统（核心特性）
智能体系统采用 **MasterAgent 统一入口架构**：
- 所有用户请求通过 MasterAgent 作为唯一入口
- MasterAgent 自动分析任务复杂度并决定执行策略
- 支持任务自动分解和多智能体协调
- 详见 `backend/agents/UNIFIED_ENTRY_ARCHITECTURE.md`

**核心组件**：
- `BaseAgent` - 智能体基类，定义统一接口
- `AgentOrchestrator` - 编排器，管理路由和协调
- `MasterAgent` - 主协调智能体，系统统一入口
- `QAAgent` - 知识图谱问答智能体，使用 Function Calling

**API 端点**：
```bash
GET  /api/agent/agents      # 列出所有智能体
POST /api/agent/execute     # 执行任务（自动路由到 MasterAgent）
POST /api/agent/collaborate # 多智能体协作
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

llm:
  provider: deepseek           # 必须在 LLMAdapter 中配置对应 Provider
  model_name: deepseek-chat    # 模型名称
  temperature: 0.7
  max_tokens: 4096

embedding:
  mode: local                  # local 或 remote
  local:
    model_name: BAAI/bge-small-zh-v1.5
```

## 开发指南

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
- ChromaDB 用于向量存储，会自动初始化

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

### LLM 调用失败
1. 检查 LLMAdapter Provider 配置
2. 访问 `/llm-adapter` 管理界面测试连接
3. 确认 API Key 正确且有效
4. 检查网络连接

## 文档资源

### 智能体系统
- **统一入口架构**: `backend/agents/UNIFIED_ENTRY_ARCHITECTURE.md` - 架构设计详解
- **MasterAgent 指南**: `backend/agents/MASTER_AGENT_GUIDE.md` - 使用和配置
- **使用指南**: `backend/agents/USAGE_GUIDE.md` - 快速开始
- **设计文档**: `backend/agents/AGENT_SYSTEM_DESIGN.md` - 系统设计

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
- ChromaDB 0.4.22 - 向量数据库
- sentence-transformers 5.2.0 - 嵌入模型

### 前端
- Vue 3.3.8 - 前端框架
- Element Plus 2.4.3 - UI 组件库
- Vue Router 4.2.5 - 路由
- Vite 5.0.0 - 构建工具
- ECharts 5.4.3 - 数据可视化

### 外部依赖
- llmjson: LLM 驱动的 JSON 提取（源码安装）
- json2graph: JSON 转知识图谱（源码安装）
