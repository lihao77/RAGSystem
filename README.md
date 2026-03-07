# RAGSystem - 时空知识图谱问答系统

基于知识图谱的智能问答系统，整合时序推理、空间分析和因果追踪功能，后端基于 Flask + Neo4j，前端采用「后台管理端 + 多 Agent 客户端」双前端架构。

## 快速启动

### 环境准备

1. **安装 Neo4j 数据库**
   - 下载并安装 [Neo4j Desktop](https://neo4j.com/download/)
   - 创建数据库实例并启动

2. **安装依赖**
   ```bash
   # 后端依赖
   cd backend
   pip install -r requirements.txt

   # 后台管理端依赖
   cd ../frontend
   npm install

   # 多 Agent 客户端依赖
   cd ../frontend-client
   npm install
   ```

   Windows PowerShell（后端一键安装）：
   ```powershell
   cd backend
   .\install_dependencies.ps1
   ```

   Windows CMD：
   ```bat
   cd backend
   install_dependencies.bat
   ```

3. **配置文件**

   后端运行时环境：
   ```bash
   cd backend
   cp .env.example .env
   ```

   **LLM 配置（推荐使用 ModelAdapter）**

   编辑配置文件 `backend/config/yaml/config.yaml`：

   ```yaml
   neo4j:
     uri: bolt://localhost:7687
     user: neo4j
     password: your_password

   llm:
     provider: your_provider_key   # ModelAdapter 中配置的 Provider 复合键，如 test_deepseek
     model_name: deepseek-chat     # 模型名称
     api_key: your_api_key         # API 密钥（也可通过环境变量配置）
     temperature: 0.7
     max_tokens: 4096
   ```

   **向量化器与向量库**

   - 向量存储基于 **SQLite + sqlite-vec**，不再使用 ChromaDB
   - 向量化器（Embedding 模型）通过「向量知识库 → 向量化器」页面或 `backend/vector_store/config/vectorizers.yaml` 管理  
   - 不再使用 `config.embedding` 段配置向量化器，详细说明见 [向量存储迁移指南](docs/migration/VECTOR_STORE_MIGRATION.md)

   前端开发配置：
   ```bash
   cd frontend
   cp .env.example .env
   ```

   多 Agent 客户端配置：
   ```bash
   cd frontend-client
   cp .env.example .env
   ```

### 启动服务

**方式一：分别启动（推荐开发时使用）**

启动后端：
```bash
cd backend
python app.py
# 后端运行在 http://localhost:5000
```

启动前端（后台管理端）：
```bash
cd frontend
npm run dev
# 后台管理端运行在 http://localhost:8080
```

启动前端（多 Agent 客户端）：
```bash
cd frontend-client
npm run dev
# 多 Agent 客户端运行在 http://localhost:5174
```

**方式二：一键启动（Windows）**

```bash
start_server.bat
```

### 获取API密钥

- **DeepSeek API Key**: [https://platform.deepseek.com](https://platform.deepseek.com)
- **百度地图API Key**（可选）: [https://lbsyun.baidu.com](https://lbsyun.baidu.com)

## 核心功能

### 1. 节点系统
- **智能配置界面** - 从简陋的JSON文本框升级为专业的智能表单系统
- **多节点支持** - LLMJson、Json2Graph、VectorIndexer等
- **实时验证** - 配置时立即验证，减少错误
- **详细文档** - 查看 [节点配置UI文档](docs/node-config-ui/README.md)

### 2. ModelAdapter - 统一模型管理接口
- **多提供商支持** - 通过 Provider 复合键支持 DeepSeek、OpenRouter 等 OpenAI 兼容服务
- **统一接口** - 统一封装 LLM 与 Embedding 调用逻辑
- **灵活配置** - 单一配置文件 `backend/model_adapter/configs/providers.yaml` 管理所有 Provider
- **成本与统计** - 记录 token 使用量与延迟指标
- **工具调用 / JSON 模式** - 适配 ReActAgent 等高级调用模式
- **管理界面** - 提供图形化管理界面（访问 `/model-adapter`）

### 3. 知识图谱
- **时空知识图谱** - 支持时序和空间信息
- **Neo4j存储** - 高性能图数据库
- **可视化展示** - 直观的图谱可视化

### 4. 智能问答与多智能体系统
- **RAG 增强** - 结合向量检索和知识图谱查询
- **多智能体协作** - 通过 MasterAgent 统一入口和 ReActAgent 推理执行复杂任务
- **多模型支持** - 通过 ModelAdapter 使用不同厂商的模型
- **上下文理解** - 基于会话上下文与 Skills 系统进行任务分解与知识注入

## 目录结构（简要）

```
RAGSystem/
├── backend/                      # 后端服务
│   ├── app.py                    # Flask 入口
│   ├── config/                   # 配置系统（YAML + Pydantic）
│   ├── agents/                   # 多智能体系统（MasterAgent、ReActAgent 等）
│   ├── model_adapter/            # ModelAdapter 统一模型适配层
│   ├── vector_store/             # 向量存储（SQLite + sqlite-vec）
│   ├── nodes/                    # 节点系统
│   ├── routes/                   # API 路由
│   ├── services/                 # 业务服务
│   ├── tools/                    # 工具定义与执行
│   └── requirements.txt          # Python 依赖
│
├── frontend/                     # 后台管理前端（Vue 3 + Element Plus）
│   ├── src/
│   └── package.json
│
├── frontend-client/              # 多 Agent 对话与监控前端
│   ├── src/
│   └── package.json
│
├── docs/                         # 文档中心
│   ├── README.md
│   ├── DOCUMENTATION_MAP.md
│   └── node-config-ui/
└── start_server.bat             # Windows 一键启动脚本
```

## 安全说明

⚠️ 配置文件包含敏感信息，已添加到 `.gitignore`，请勿提交到版本控制。

## 📚 文档

- **[快速参考](QUICK_REFERENCE.md)** ⭐ - 常用信息速查
- **[文档中心](docs/README.md)** - 所有文档导航
- **[项目结构](PROJECT_STRUCTURE.md)** - 详细的项目结构说明
- **[节点配置UI文档](docs/node-config-ui/README.md)** - 节点系统配置界面升级文档
- **[快速启动指南](docs/node-config-ui/QUICK_START_CONFIG_UI.md)** - 5分钟快速上手节点配置
- **[向量存储迁移指南](docs/migration/VECTOR_STORE_MIGRATION.md)** - 从 ChromaDB 迁移到 SQLite-vec
- **[ModelAdapter 迁移指南](docs/migration/LLMADAPTER_MIGRATION_GUIDE.md)** - ModelAdapter 统一 LLM 管理接口文档

## 🎯 最新更新

### ModelAdapter 全面集成 (2025-01-03)
- ✅ 统一的 LLM 管理接口 - 支持 OpenAI、DeepSeek、OpenRouter 等多提供商
- ✅ 灵活配置 - 支持配置多个 Provider 和模型列表
- ✅ 成本追踪 - 自动记录 token 使用量和调用成本
- ✅ 前端集成 - 新增 ModelAdapterView.vue 管理界面
- ✅ LLMService 移除 - 全面使用 ModelAdapter，代码更简洁
- ✅ 配置升级 - 迁移到 YAML 格式，支持环境变量覆盖

查看详情：[ModelAdapter 迁移指南](docs/migration/LLMADAPTER_MIGRATION_GUIDE.md)

### 节点配置UI升级 (2025-12-26)
- ✅ 智能表单生成 - 根据配置类型自动选择UI控件
- ✅ 字段分组展示 - 配置项按功能分组
- ✅ 实时验证 - 输入时立即验证
- ✅ 双视图模式 - 表单视图 + JSON视图
- ✅ 4个节点完成适配 - LLMJson V2、LLMJson、Json2Graph、VectorIndexer

查看详情：[节点配置UI升级文档](docs/node-config-ui/README.md)
