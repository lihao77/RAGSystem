# RAGSystem 开发文档整合

> **最后更新**: 2025-12-19  
> **整合说明**: 本文档整合了所有关键开发指南和注意事项

---

## 📖 目录

1. [项目概览](#项目概览)
2. [快速开始](#快速开始)
3. [系统架构](#系统架构)
4. [配置系统](#配置系统)
5. [初始化系统](#初始化系统)
6. [向量库使用](#向量库使用)
7. [节点系统](#节点系统)
8. [前端开发](#前端开发)
9. [常见问题](#常见问题)

---

## 项目概览

RAGSystem - 时空知识图谱问答系统，基于知识图谱的智能问答系统，整合时序推理、空间分析和因果追踪功能。

**技术栈：**
- 后端：Python Flask + Neo4j + DeepSeek API
- 前端：Vue.js 3 + Vite + Element Plus
- 可视化：3D Force Graph + Cesium + ECharts

---

## 快速开始

### 1. 环境准备

```bash
# 安装依赖
cd backend
pip install -r requirements.txt

cd ../frontend
npm install
```

### 2. 配置系统

**后端配置**（二选一）：

**方法1：使用新配置系统（推荐）**
```bash
cd backend
cp config/config.example.yaml config/config.yaml
# 编辑 config/config.yaml 填入配置
```

**方法2：使用环境变量**
```bash
# Windows
set NEO4J_PASSWORD=your_password
set LLM_API_KEY=your_api_key

# Linux/Mac
export NEO4J_PASSWORD=your_password
export LLM_API_KEY=your_api_key
```

**前端配置**：
```bash
cd frontend
cp src/config.example.js src/config.js
```

### 3. 启动服务

```bash
# 后端
cd backend
python app.py

# 前端
cd frontend
npm run dev

# 或使用一键启动（Windows）
start_server.bat
```

---

## 系统架构

### 核心模块

```
RAGSystem/
├── backend/
│   ├── app.py              # Flask 应用入口
│   ├── config/             # 配置系统（YAML + Pydantic）
│   ├── db.py               # Neo4j 连接管理（单例）
│   ├── routes/             # API 路由
│   ├── vector_store/       # 向量数据库
│   ├── tools/              # LLM 工具调用
│   ├── nodes/              # 节点处理系统
│   └── workflows/          # 工作流系统
└── frontend/
    ├── src/
    │   ├── views/          # 页面组件
    │   ├── components/     # 公共组件
    │   ├── composables/    # 组合式函数
    │   ├── api/            # API 服务
    │   └── router/         # 路由配置
    └── public/
```

### 数据流

```
用户请求 → 前端路由 → API 调用 → 后端路由
    ↓
配置检查（未配置则提示）
    ↓
业务逻辑处理
    ↓
数据库查询（Neo4j / Vector DB）
    ↓
LLM 处理（可选）
    ↓
返回结果
```

---

## 配置系统

### 新配置系统（推荐）

**配置文件**：`backend/config/config.yaml`

```yaml
# Neo4j 配置
neo4j:
  uri: bolt://localhost:7687
  user: neo4j
  password: your_password

# LLM 配置
llm:
  api_endpoint: https://api.deepseek.com/v1
  api_key: your_api_key
  model_name: deepseek-chat
  temperature: 0.7
  max_tokens: 4096

# Embedding 配置
embedding:
  mode: local  # local 或 remote
  
  # 本地模型配置
  local:
    model_name: BAAI/bge-small-zh-v1.5
    device: cpu  # cpu 或 cuda
    cache_dir: null
  
  # 远程 API 配置
  remote:
    api_endpoint: https://api.openai.com/v1
    api_key: your_api_key
    model_name: text-embedding-3-small
    timeout: 30
    max_retries: 3

# 系统配置
system:
  max_content_length: 104857600  # 100MB
```

### 使用配置

```python
from config import get_config

config = get_config()

# 访问配置
neo4j_uri = config.neo4j.uri
api_key = config.llm.api_key
embedding_mode = config.embedding.mode
```

### 配置优先级

1. **环境变量**（最高）→ `NEO4J_PASSWORD=xxx`
2. **用户配置文件** → `config/config.yaml`
3. **默认配置** → `config/yaml/config.default.yaml`
4. **代码默认值**（最低）

---

## 初始化系统

### 延迟初始化机制

系统支持在配置未完成时推迟初始化，配置完成后再初始化。

**特性**：
- ✅ 单例模式：避免重复初始化
- ✅ 延迟初始化：未配置时不强制初始化
- ✅ 配置更新：支持配置完成后重新初始化

### Neo4j 连接管理

```python
from db import neo4j_conn

# 建立连接（单例，不会重复连接）
driver = neo4j_conn.connect()

# 配置更新后重新连接
driver = neo4j_conn.reconnect()
```

### 向量库初始化

```python
from init_vector_store import init_vector_store

# 初始化（内置重复检查）
success = init_vector_store()

# 强制重新初始化（配置更新后）
success = init_vector_store(force=True)
```

### Flask Debug 模式问题

**问题**：Flask debug 模式会导致应用启动两次（reloader）

**解决**：已禁用 reloader
```python
# app.py
app.run(
    host='0.0.0.0',
    port=5000,
    debug=True,
    use_reloader=False  # 避免双重初始化
)
```

---

## 向量库使用

### Embedding 模型配置

**本地模型（推荐用于开发）**：
```yaml
embedding:
  mode: local
  local:
    model_name: BAAI/bge-small-zh-v1.5  # 轻量级
    device: cpu
```

**远程 API（用于生产）**：
```yaml
embedding:
  mode: remote
  remote:
    api_endpoint: https://api.openai.com/v1
    api_key: your_key
    model_name: text-embedding-3-small
```

### 使用向量库

```python
from vector_store import VectorIndexer, VectorRetriever

# 索引文档
indexer = VectorIndexer(collection_name="my_docs")
indexer.index_documents(documents, metadata)

# 检索相似文档
retriever = VectorRetriever(collection_name="my_docs")
results = retriever.search("查询文本", top_k=5)
```

### 三种索引方式

1. **直接索引**：适合简单文档
2. **批量索引**：适合大量文档
3. **节点索引**：使用节点系统处理

---

## 节点系统

### 节点类型标准

**数据类型**：
- `string`: 字符串
- `number`: 数字
- `boolean`: 布尔值
- `array`: 数组
- `object`: 对象
- `file`: 文件上传

### 创建自定义节点

```python
# nodes/my_node/node.py
from nodes.base import BaseNode

class MyNode(BaseNode):
    def execute(self, inputs, config):
        # 处理逻辑
        result = process(inputs['text'])
        return {'output': result}
```

```python
# nodes/my_node/config.py
NODE_CONFIG = {
    "name": "我的节点",
    "type": "my_node",
    "inputs": [
        {
            "name": "text",
            "type": "string",
            "label": "输入文本",
            "required": True
        }
    ],
    "outputs": [
        {
            "name": "output",
            "type": "string",
            "label": "输出结果"
        }
    ]
}
```

---

## 前端开发

### 配置检查机制

**路由级别（自动）**：
```javascript
// router/index.js
{
  path: '/graphrag',
  meta: {
    title: 'GraphRAG 问答',
    requiresConfig: { 
      neo4j: true,   // 需要 Neo4j
      llm: true      // 需要 LLM
    }
  }
}
```

**组件级别（手动）**：
```vue
<script setup>
import { useConfigCheck } from '@/composables/useConfigCheck'

const { requireConfig } = useConfigCheck()

async function handleAction() {
  // 检查配置
  if (!await requireConfig({ neo4j: true })) {
    return  // 未配置或用户取消
  }
  
  // 继续执行
  await doSomething()
}
</script>
```

### 配置缓存

**缓存时间**：30秒

**清除缓存**：
```javascript
import { resetConfigStatusCache } from '@/composables/useConfigCheck'

// 保存配置后清除缓存
await saveConfig()
resetConfigStatusCache()  // 重要！
```

---

## 常见问题

### Q1: 配置完成后无法进入页面？

**原因**：配置状态缓存未更新

**解决**：
1. 等待30秒（缓存自动过期）
2. 或在保存配置时确保调用了 `resetConfigStatusCache()`

### Q2: 向量库初始化失败？

**检查**：
1. 确认 embedding 配置正确
2. 本地模式：确认模型已下载
3. 远程模式：确认 API 密钥有效

**解决**：
```python
from init_vector_store import is_vector_db_configured

if not is_vector_db_configured():
    print("向量库未配置")
```

### Q3: Neo4j 连接失败？

**检查**：
1. Neo4j 服务是否启动
2. 连接地址、用户名、密码是否正确
3. 端口 7687 是否开放

**测试连接**：
```python
from db import test_connection

if test_connection():
    print("连接成功")
```

### Q4: 系统启动时初始化两次？

**原因**：Flask debug 模式的 reloader 机制

**解决**：已在 `app.py` 中设置 `use_reloader=False`

### Q5: 前端路由守卫不生效？

**检查**：
1. 路由 meta 中是否有 `requiresConfig`
2. `useConfigCheck.js` 是否正确导入
3. 浏览器控制台是否有错误

### Q6: 嵌入模型配置修改后不生效？

**原因**：可能是以下几种情况
1. 配置文件格式不正确
2. 单例模式缓存了旧模型
3. 服务未重启

**解决**：
1. 检查配置格式（需要嵌套结构）
2. 重启后端服务
3. 调用 `init_vector_store(force=True)` 强制重新加载

---

## 开发建议

### 1. 配置管理
- ✅ 使用新配置系统（YAML）
- ✅ 敏感信息使用环境变量
- ✅ 不要提交 `config.yaml` 到版本控制

### 2. 代码规范
- ✅ 使用类型注解（Python）
- ✅ 使用 Composition API（Vue 3）
- ✅ 遵循单一职责原则

### 3. 错误处理
- ✅ 捕获并记录所有异常
- ✅ 返回友好的错误消息
- ✅ 避免暴露敏感信息

### 4. 性能优化
- ✅ 使用单例模式避免重复初始化
- ✅ 合理使用缓存（如配置状态）
- ✅ 批量处理避免频繁请求

### 5. 测试
- ✅ 编写单元测试
- ✅ 测试配置更新流程
- ✅ 测试错误处理逻辑

---

## 相关文档

- **主要文档**：
  - `README.md` - 项目简介
  - `CLAUDE.md` - AI 助手指南
  
- **技术细节**：
  - `backend/config/README.md` - 配置系统详解
  - `backend/tools/README.md` - 工具调用指南
  - `frontend/CONFIG_CHECK_GUIDE.md` - 配置检查使用指南

---

## 维护记录

| 日期 | 修改内容 | 备注 |
|------|---------|------|
| 2025-12-19 | 创建整合文档 | 合并所有关键指南 |
| 2025-12-19 | 修复配置缓存问题 | 缓存时间改为30秒 |
| 2025-12-19 | 完善配置检查功能 | 路由守卫 + 手动检查 |
| 2025-12-19 | 重构初始化系统 | 延迟初始化 + 单例模式 |

---

**最后更新**: 2025-12-19  
**维护者**: 开发团队
