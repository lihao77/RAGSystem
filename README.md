# RAGSystem - 时空知识图谱问答系统

基于知识图谱的智能问答系统，整合时序推理、空间分析和因果追踪功能。

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

   # 前端依赖
   cd frontend
   npm install
   ```

3. **配置文件**

   **LLM 配置（推荐使用 LLMAdapter）**

   编辑配置文件 `backend/config/yaml/config.yaml`：

   ```yaml
   neo4j:
     uri: bolt://localhost:7687
     user: neo4j
     password: your_password

   llm:
     provider: deepseek           # LLM 提供商
     model_name: deepseek-chat    # 模型名称
     api_key: your_api_key        # API 密钥
     temperature: 0.7
     max_tokens: 4096

   embedding:
     mode: local                  # 或 remote
     local:
       model_name: BAAI/bge-small-zh-v1.5
     remote:
       api_endpoint: https://api-inference.modelscope.cn/v1
       api_key: your_emb_key
   ```

   前端配置：
   ```bash
   cd frontend/src
   cp config.example.js config.js
   ```

### 启动服务

**方式一：分别启动**

启动后端：
```bash
cd backend
python app.py
# 后端运行在 http://localhost:5000
```

启动前端：
```bash
cd frontend
npm run dev
# 前端运行在 http://localhost:5173
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

### 2. LLMAdapter - 统一LLM管理接口
- **多提供商支持** - 支持 OpenAI、DeepSeek、OpenRouter 等主流 LLM 服务
- **灵活配置** - 可为每个提供商配置多个模型，运行时动态选择
- **统一接口** - 所有 LLM 调用通过同一接口，无需关心底层实现
- **成本追踪** - 自动记录 token 使用量和调用成本
- **工具调用** - 支持 Function Calling 功能
- **管理界面** - 提供图形化管理界面（访问 `/llm-adapter`）

配置示例：
```yaml
# 编辑 backend/config/yaml/config.yaml
llm:
  provider: deepseek           # LLM 提供商
  model_name: deepseek-chat    # 模型名称
  api_key: your_api_key
  temperature: 0.7
  max_tokens: 4096
```

### 3. 知识图谱
- **时空知识图谱** - 支持时序和空间信息
- **Neo4j存储** - 高性能图数据库
- **可视化展示** - 直观的图谱可视化

### 4. 智能问答
- **RAG增强** - 结合检索和生成
- **多模型支持** - 支持多种LLM模型（通过 LLMAdapter）
- **上下文理解** - 智能理解用户意图

## 目录结构

```
RAGSystem/
├── backend/           # 后端服务
│   ├── app.py        # Flask入口
│   ├── config.json   # 配置文件
│   ├── nodes/        # 节点系统
│   │   ├── llmjson_v2/    # LLMJson V2节点
│   │   ├── llmjson/       # LLMJson节点
│   │   ├── json2graph/    # Json2Graph节点
│   │   └── vector_indexer/ # 向量索引节点
│   └── requirements.txt
├── frontend/          # 前端应用
│   ├── src/
│   │   ├── views/
│   │   │   └── NodesView.vue  # 节点配置界面
│   │   ├── components/
│   │   │   └── workflow/
│   │   │       └── NodeConfigEditor.vue  # 配置编辑器
│   │   └── config.js # 配置文件
│   └── package.json
├── docs/              # 文档
│   └── node-config-ui/  # 节点配置UI文档
│       ├── README.md    # 文档导航
│       ├── QUICK_START_CONFIG_UI.md  # 快速启动
│       └── ...
└── start_server.bat  # 一键启动脚本
```

## 安全说明

⚠️ 配置文件包含敏感信息，已添加到 `.gitignore`，请勿提交到版本控制。

## 📚 文档

- **[快速参考](QUICK_REFERENCE.md)** ⭐ - 常用信息速查
- **[文档中心](docs/README.md)** - 所有文档导航
- **[项目结构](PROJECT_STRUCTURE.md)** - 详细的项目结构说明
- **[节点配置UI文档](docs/node-config-ui/README.md)** - 节点系统配置界面升级文档
- **[快速启动指南](docs/node-config-ui/QUICK_START_CONFIG_UI.md)** - 5分钟快速上手节点配置
- **[LLMJson V2集成文档](LLMJSON_V2_INTEGRATION.md)** - LLMJson V2节点集成说明
- **[LLMAdapter 迁移指南](LLMADAPTER_MIGRATION_GUIDE.md)** - LLMAdapter 统一 LLM 管理接口文档

## 🎯 最新更新

### LLMAdapter 全面集成 (2025-01-03)
- ✅ 统一的 LLM 管理接口 - 支持 OpenAI、DeepSeek、OpenRouter 等多提供商
- ✅ 灵活配置 - 支持配置多个 Provider 和模型列表
- ✅ 成本追踪 - 自动记录 token 使用量和调用成本
- ✅ 前端集成 - 新增 LLMAdapterView.vue 管理界面
- ✅ LLMService 移除 - 全面使用 LLMAdapter，代码更简洁
- ✅ 配置升级 - 迁移到 YAML 格式，支持环境变量覆盖

查看详情：[LLMAdapter 迁移指南](LLMADAPTER_MIGRATION_GUIDE.md)

### 节点配置UI升级 (2025-12-26)
- ✅ 智能表单生成 - 根据配置类型自动选择UI控件
- ✅ 字段分组展示 - 配置项按功能分组
- ✅ 实时验证 - 输入时立即验证
- ✅ 双视图模式 - 表单视图 + JSON视图
- ✅ 4个节点完成适配 - LLMJson V2、LLMJson、Json2Graph、VectorIndexer

查看详情：[节点配置UI升级文档](docs/node-config-ui/README.md)
