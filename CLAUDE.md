# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

RAGSystem - 时空知识图谱问答系统，基于知识图谱的智能问答系统，整合时序推理、空间分析和因果追踪功能。

技术栈：
- 后端：Python Flask + Neo4j + DeepSeek API
- 前端：Vue.js 3 + Vite + Element Plus
- 可视化：3D Force Graph + Cesium + ECharts

## 常用开发命令

### 后端开发
```bash
cd backend
pip install -r requirements.txt
python app.py  # 启动后端服务，端口 5000
```

### 前端开发
```bash
cd frontend
npm install
npm run dev    # 启动前端服务，端口 5173
npm run build  # 构建生产版本
```

### 一键启动（Windows）
```bash
start_server.bat  # 同时启动前后端服务
```

### 数据库操作
```bash
# Neo4j 需要单独安装，确保服务运行在本地 7687 端口
# 使用 Neo4j Browser 访问：http://localhost:7474
```

## 架构要点

### 后端架构
- **入口文件**：`backend/app.py` - Flask 应用主入口，注册所有蓝图
- **数据库连接**：`backend/db.py` - Neo4j 连接管理，使用单例模式
- **路由结构**：模块化蓝图设计，每个功能模块独立路由文件
  - `home.py` - 首页统计和文档管理
  - `search.py` - 实体和关系搜索
  - `visualization.py` - 图可视化数据接口
  - `graphrag.py` - 知识图谱问答核心逻辑
  - `function_call.py` - LLM 工具调用接口
- **配置管理**：`backend/config.json` - 集中配置管理，包含 Neo4j 和 LLM API 配置

### 前端架构
- **入口文件**：`frontend/src/main.js` - Vue 应用入口
- **主组件**：`frontend/src/App.vue` - 主布局组件，包含侧边栏导航
- **路由配置**：`frontend/src/router/index.js` - Vue Router 配置
- **API 服务**：`frontend/src/api/` - 模块化 API 服务层
- **视图组件**：`frontend/src/views/` - 页面级组件
- **可视化组件**：`frontend/src/components/visualization/` - 图表和地图组件

### 关键集成模式
- **实体与状态节点分离**：静态实体（地点/设施/事件）+ 时序状态节点
- **OPTIONAL MATCH 查询**：处理可能缺失的节点类型，确保查询健壮性
- **函数调用接口**：OpenAI 兼容的工具调用，支持自然语言到 Cypher 查询转换
- **文件处理流程**：上传 → 存储 → 处理 → 图谱生成

## 配置系统

### 新配置系统（推荐）
项目已重构配置系统，使用 YAML + Pydantic 提供类型安全和验证。

**配置管理器**：`backend/config/` - 统一配置管理入口

**配置文件**（按优先级）：
1. 环境变量（最高优先级）- `NEO4J_PASSWORD`, `LLM_API_KEY` 等
2. `backend/config/config.yaml`（用户配置）
3. `backend/config/yaml/config.default.yaml`（默认配置）

**使用方式**：
```python
from config import get_config

config = get_config()
neo4j_uri = config.neo4j.uri
api_key = config.llm.api_key
```

**完整文档**：参见 `backend/config/README.md`

**向后兼容**：旧版 `config.json` 和 `.env` 文件仍然可用

### 原始配置系统（向后兼容）
`backend/config.json` - 集中配置管理，包含 Neo4j 和 LLM API 配置

### 前端配置
`frontend/src/config.js` - 前端配置（可从示例文件复制）

### 开发注意事项
- 所有敏感配置都在 `.gitignore` 中，不会提交到版本控制
- CORS 配置只允许特定源访问，开发时注意端口匹配
- Neo4j 需要安装 APOC 插件支持高级查询功能
- 文件上传限制可通过 `config.system.max_content_length` 配置