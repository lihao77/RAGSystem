# RAGSystem 项目结构

## 📁 目录结构

```
RAGSystem/
├── backend/                      # 后端服务
│   ├── adapters/                 # 适配器
│   ├── agents/                   # 智能代理
│   ├── config/                   # 配置模块
│   ├── data/                     # 数据文件
│   ├── nodes/                    # 节点系统 ⭐
│   │   ├── llmjson_v2/          # LLMJson V2节点
│   │   │   ├── config.py        # 配置（含UI元数据）
│   │   │   └── node.py          # 节点实现
│   │   ├── llmjson/             # LLMJson节点
│   │   ├── json2graph/          # Json2Graph节点
│   │   ├── vector_indexer/      # 向量索引节点
│   │   ├── base.py              # 节点基类
│   │   ├── registry.py          # 节点注册表
│   │   ├── schema_generator.py  # Schema生成器 ⭐
│   │   ├── config_store.py      # 配置存储
│   │   ├── CONFIG_UI_GUIDE.md   # 配置UI使用指南
│   │   └── UI_METADATA_REFERENCE.md  # UI元数据参考
│   ├── routes/                   # API路由
│   │   ├── nodes.py             # 节点API（含config-schema端点）
│   │   ├── workflows.py         # 工作流API
│   │   └── ...
│   ├── services/                 # 业务服务
│   ├── tools/                    # 工具函数
│   ├── utils/                    # 工具类
│   ├── workflows/                # 工作流
│   ├── app.py                    # Flask入口
│   ├── config.json               # 配置文件
│   ├── requirements.txt          # Python依赖
│   ├── test_all_node_configs.py  # 节点配置测试 ⭐
│   └── ...
│
├── frontend/                     # 前端应用
│   ├── src/
│   │   ├── api/                 # API服务
│   │   │   └── nodeService.js   # 节点API（含getConfigSchema）
│   │   ├── components/          # 组件
│   │   │   ├── layout/          # 布局组件
│   │   │   ├── visualization/   # 可视化组件
│   │   │   └── workflow/        # 工作流组件
│   │   │       ├── NodeConfigEditor.vue  # 配置编辑器 ⭐
│   │   │       └── WorkflowNode.vue
│   │   ├── views/               # 页面视图
│   │   │   ├── NodesView.vue    # 节点配置页面 ⭐
│   │   │   ├── WorkflowBuilderView.vue
│   │   │   └── ...
│   │   ├── router/              # 路由
│   │   ├── config.js            # 配置文件
│   │   └── main.js              # 入口文件
│   ├── package.json             # Node依赖
│   └── vite.config.js           # Vite配置
│
├── docs/                         # 文档 ⭐
│   ├── README.md                # 文档中心导航
│   └── node-config-ui/          # 节点配置UI文档
│       ├── README.md            # 文档导航
│       ├── QUICK_START_CONFIG_UI.md      # 快速启动
│       ├── NODE_CONFIG_SUMMARY.md        # 升级总结
│       ├── NODE_CONFIG_UI_UPGRADE.md     # 完整升级说明
│       ├── NODE_CONFIG_COMPARISON.md     # 升级前后对比
│       ├── NODE_CONFIG_CHANGELOG.md      # 更新日志
│       └── NODE_CONFIG_CHECKLIST.md      # 检查清单
│
├── data/                         # 数据目录
│   ├── admin_geojson/           # 行政区划数据
│   └── river_geojson/           # 河流数据
│
├── logs/                         # 日志目录
├── .gitignore                    # Git忽略文件
├── README.md                     # 项目README ⭐
├── PROJECT_STRUCTURE.md          # 本文件
├── LLMJSON_V2_INTEGRATION.md     # LLMJson V2集成文档
└── start_server.bat              # 一键启动脚本
```

## 🌟 核心模块说明

### 节点系统 (backend/nodes/)
节点系统是RAGSystem的核心功能模块，提供可配置的数据处理节点。

**核心文件：**
- `base.py` - 节点基类，定义节点接口
- `registry.py` - 节点注册表，管理所有节点
- `schema_generator.py` - 自动生成UI友好的配置Schema
- `config_store.py` - 配置持久化存储

**节点实现：**
- `llmjson_v2/` - LLM驱动的JSON提取节点（V2版本）
- `llmjson/` - LLM驱动的JSON提取节点
- `json2graph/` - JSON转知识图谱节点
- `vector_indexer/` - 向量索引节点

### 配置编辑器 (frontend/src/components/workflow/)
智能配置编辑器组件，提供友好的表单界面。

**核心组件：**
- `NodeConfigEditor.vue` - 配置编辑器主组件
  - 支持表单视图和JSON视图
  - 自动生成表单控件
  - 实时验证
  - 字段分组

### API路由 (backend/routes/)
提供RESTful API接口。

**节点相关API：**
- `GET /api/nodes/types` - 获取所有节点类型
- `GET /api/nodes/types/<type>` - 获取节点详情
- `GET /api/nodes/types/<type>/config-schema` - 获取配置Schema ⭐
- `GET /api/nodes/types/<type>/default-config` - 获取默认配置
- `POST /api/nodes/execute` - 执行节点

### 文档系统 (docs/)
完整的文档体系。

**文档分类：**
- 用户文档 - 快速启动、功能对比
- 开发文档 - 使用指南、API参考
- 项目文档 - 升级说明、更新日志

## 🔑 关键技术

### 后端
- **Flask** - Web框架
- **Pydantic** - 数据验证和配置管理
- **Neo4j** - 图数据库
- **ChromaDB** - 向量数据库

### 前端
- **Vue 3** - 前端框架
- **Element Plus** - UI组件库
- **Vite** - 构建工具

### 节点系统
- **Schema驱动** - 配置Schema自动生成UI
- **插件化** - 节点可独立开发和注册
- **类型安全** - Pydantic保证类型正确性

## 📊 代码统计

### 节点系统
- **4个节点**完成适配
- **40+个配置字段**
- **约2000行代码**

### 文档
- **9个文档文件**
- **约20000字**
- **100%覆盖率**

## 🔄 数据流

### 配置流程
```
1. 用户选择节点类型
   ↓
2. 前端请求配置Schema
   GET /api/nodes/types/<type>/config-schema
   ↓
3. 后端生成Schema
   SchemaGenerator.generate(ConfigClass)
   ↓
4. 前端渲染表单
   NodeConfigEditor根据Schema生成表单
   ↓
5. 用户编辑配置
   表单视图或JSON视图
   ↓
6. 实时验证
   前端验证 + 后端验证
   ↓
7. 保存配置
   POST /api/nodes/configs
```

### 节点执行流程
```
1. 加载配置
   从配置存储加载或使用临时配置
   ↓
2. 验证配置
   Pydantic验证配置正确性
   ↓
3. 执行节点
   POST /api/nodes/execute
   ↓
4. 返回结果
   JSON格式的执行结果
```

## 🎯 重点关注

### 新功能（2025-12-26）
- ⭐ 节点配置UI升级
- ⭐ Schema自动生成
- ⭐ 智能表单编辑器
- ⭐ 4个节点完成适配

### 核心文件
- `backend/nodes/schema_generator.py` - Schema生成器
- `frontend/src/components/workflow/NodeConfigEditor.vue` - 配置编辑器
- `backend/routes/nodes.py` - 节点API
- `docs/node-config-ui/README.md` - 文档导航

## 📚 相关文档

- [项目README](README.md) - 项目概述和快速启动
- [文档中心](docs/README.md) - 所有文档导航
- [节点配置UI文档](docs/node-config-ui/README.md) - 节点配置详细文档
- [快速启动指南](docs/node-config-ui/QUICK_START_CONFIG_UI.md) - 5分钟上手

---

**版本**: v1.0  
**最后更新**: 2025-12-26  

🚀 **了解项目结构，快速定位代码！**
