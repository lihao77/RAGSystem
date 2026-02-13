# 知识图谱后端 - Flask版本

这是一个基于Flask框架重构的知识图谱后端项目，提供知识图谱的构建、查询、可视化和评估功能。

## 快速开始

### 首次部署最小配置

**必需配置**（1 个文件）：

1. **复制并编辑 Model Adapter 配置**
```bash
cd backend
cp model_adapter/configs/providers.yaml.example model_adapter/configs/providers.yaml
# 编辑 providers.yaml，填入真实 API 密钥（或使用 ${ENV_VAR} 环境变量）
```

**可选配置**：

- `config/yaml/config.yaml`：Neo4j、向量库、系统默认 LLM/Embedding。不存在时使用 `config/models.py` 默认值。可复制 `config/yaml/config.yaml.example` 为 `config.yaml` 后修改。
- `agents/configs/agent_configs.yaml`：智能体列表与行为。可复制 `agents/configs/agent_configs.yaml.example` 为 `agent_configs.yaml` 后修改。

**启动**：
```bash
cd backend
python app.py
```
服务默认运行在 `http://localhost:5000`。

> 敏感配置文件（`providers.yaml`、`config.yaml`、`agent_configs.yaml`）已加入仓库 `.gitignore`，请勿提交真实密钥。

### 详细文档

- **[配置系统指南](../docs/configuration-guide.md)**：配置文件说明、首次部署、安全实践
- **Backend 配置调查报告**：`../docs/BACKEND_CONFIG_SURVEY.md`（配置体系与加载方式）

### 常见问题

**启动报错：缺少 providers.yaml**

```
缺少必需配置: .../providers.yaml
```

解决：在 `backend` 目录下执行：
```bash
cp model_adapter/configs/providers.yaml.example model_adapter/configs/providers.yaml
# 编辑 providers.yaml 填入真实 API 密钥
```

**如何检查配置是否正常？**
```bash
cd backend
python -m config.health_check
```

更多问题见 [配置系统指南](../docs/configuration-guide.md)。

## 功能特性

- **系统设置管理**: 配置Neo4j数据库、LLM服务和地理编码服务
- **数据导入**: 支持文档上传和知识图谱生成
- **实体搜索**: 多条件实体搜索和关系查询
- **图谱可视化**: 提供节点和关系的可视化数据
- **评估功能**: 生成评估样本，支持实体抽取和关系抽取评估
- **统计分析**: 知识图谱统计信息和文档管理

## 项目结构

```
backend_flask/
├── app.py                 # Flask应用主文件
├── db.py                  # Neo4j数据库连接
├── requirements.txt       # Python依赖
├── .env.example          # 环境变量示例
├── README.md             # 项目说明
├── utils/
│   └── settings.py       # 系统设置工具
└── routes/
    ├── settings.py       # 系统设置路由
    ├── home.py          # 首页统计路由
    ├── import_routes.py # 数据导入路由
    ├── search.py        # 搜索功能路由
    ├── visualization.py # 可视化路由
    └── evaluation.py    # 评估功能路由
```

## 安装和运行

### 1. 环境要求

- Python 3.8+
- Neo4j 4.0+
- pip

### 2. 安装依赖

```bash
cd backend_flask
pip install -r requirements.txt
```

### 3. 配置环境变量

复制 `.env.example` 为 `.env` 并修改配置：

```bash
cp .env.example .env
```

编辑 `.env` 文件，配置以下参数：

- **Neo4j配置**: 数据库连接信息
- **LLM API配置**: 大语言模型服务配置
- **地理编码配置**: 地理编码服务配置
- **系统配置**: 工作目录、Python路径等

### 4. 启动服务

```bash
python app.py
```

服务将在 `http://localhost:5000` 启动。

## API接口

### 系统设置 (`/api/settings`)

- `GET /api/settings/` - 获取系统配置
- `POST /api/settings/` - 保存系统配置
- `POST /api/settings/test-neo4j` - 测试Neo4j连接
- `POST /api/settings/test-llm` - 测试LLM服务连接
- `POST /api/settings/test-geocoding` - 测试地理编码服务

### 首页统计 (`/api/home`)

- `GET /api/home/stats` - 获取知识图谱统计数据
- `GET /api/home/recent-documents` - 获取最近处理的文档
- `GET /api/home/document/<id>` - 获取文档详情

### 数据导入 (`/api/import`)

- `POST /api/import/upload` - 文件上传
- `POST /api/import/process` - 开始处理文件
- `GET /api/import/status/<task_id>` - 获取任务状态
- `GET /api/import/history` - 获取处理历史
- `POST /api/import/scan-directory` - 扫描目录
- `POST /api/import/cancel/<task_id>` - 取消任务

### 搜索功能 (`/api/search`)

- `POST /api/search/entities` - 搜索实体
- `POST /api/search/relationships` - 搜索关系
- `GET /api/search/suggestions` - 获取搜索建议
- `GET /api/search/categories` - 获取所有类别
- `GET /api/search/document-sources` - 获取文档来源

### 可视化 (`/api/visualization`)

- `GET /api/visualization/entities` - 获取可视化实体
- `GET /api/visualization/relationships` - 获取实体关系
- `GET /api/visualization/state-chain/<entity_id>` - 获取状态链
- `GET /api/visualization/graph-data` - 获取图数据
- `GET /api/visualization/node-types` - 获取节点类型
- `GET /api/visualization/relationship-types` - 获取关系类型

### 评估功能 (`/api/evaluation`)

- `GET /api/evaluation/documents` - 获取文档列表
- `POST /api/evaluation/generate-samples` - 生成评估样本
- `GET /api/evaluation/samples` - 获取样本文件列表
- `GET /api/evaluation/samples/<filename>` - 获取样本文件内容
- `DELETE /api/evaluation/samples/<filename>` - 删除样本文件
- `GET /api/evaluation/entity-types` - 获取实体类型

## 配置说明

### Neo4j配置

```env
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your_password
```

### LLM服务配置

```env
LLM_API_ENDPOINT=https://api.openai.com/v1
LLM_API_KEY=sk-your-api-key
LLM_MODEL_NAME=gpt-3.5-turbo
```

### 地理编码服务配置

支持百度地图和高德地图：

```env
GEOCODING_SERVICE=baidu  # 或 amap
GEOCODING_API_KEY=your_api_key
```

## 开发说明

### 添加新路由

1. 在 `routes/` 目录下创建新的路由文件
2. 定义蓝图和路由函数
3. 在 `app.py` 中注册蓝图

### 数据库操作

使用 `db.py` 中的 `get_session()` 函数获取Neo4j会话：

```python
from db import get_session

session = get_session()
try:
    result = session.run("MATCH (n) RETURN n LIMIT 10")
    # 处理结果
finally:
    session.close()
```

### 错误处理

所有路由都应包含适当的错误处理和日志记录：

```python
import logging

logger = logging.getLogger(__name__)

try:
    # 业务逻辑
    pass
except Exception as e:
    logger.error(f'操作失败: {e}')
    return jsonify({'error': '操作失败', 'details': str(e)}), 500
```

## 部署说明

### 生产环境配置

1. 设置 `FLASK_ENV=production`
2. 使用WSGI服务器（如Gunicorn）
3. 配置反向代理（如Nginx）
4. 设置适当的日志级别

### Docker部署

可以创建Dockerfile进行容器化部署：

```dockerfile
FROM python:3.9-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

EXPOSE 5000
CMD ["python", "app.py"]
```

## 故障排除

### 常见问题

1. **Neo4j连接失败**: 检查数据库是否运行，连接信息是否正确
2. **文件上传失败**: 检查上传目录权限和文件大小限制
3. **LLM服务连接失败**: 验证API密钥和端点URL
4. **APOC插件问题**: 确保Neo4j安装了APOC插件

### 日志查看

应用日志会输出到控制台，包含详细的错误信息和调试信息。

## 许可证

本项目采用MIT许可证。