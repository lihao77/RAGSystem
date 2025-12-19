# RAGSystem 配置系统文档

## 概述

配置系统已经重构为更灵活、更安全的架构，使用 YAML 格式和 Pydantic 验证。

## 主要改进

1. **统一配置管理**: 单一入口管理所有配置
2. **类型安全**: 使用 Pydantic 进行运行时类型检查和验证
3. **环境变量覆盖**: 支持通过环境变量覆盖配置文件中的设置
4. **热重载**: 支持运行时重新加载配置
5. **外部库支持**: 为 llmjson 和 json2graph-for-review 提供了扩展配置

## 配置文件结构

```
backend/
├── config/
│   ├── __init__.py                      # 配置管理器入口
│   ├── base.py                           # 配置加载逻辑
│   ├── models.py                         # Pydantic 配置模型
│   └── yaml/
│       ├── config.default.yaml          # 默认配置
│       └── config.yaml.example          # 用户配置模板
```

## 使用方式

### 快速开始

1. 复制配置文件模板：
```bash
cd backend/config/yaml
cp config.yaml.example ../config.yaml
```

2. 编辑 `config/config.yaml`，填写您的配置信息

3. 使用配置管理器：
```python
from config import get_config

config = get_config()

# 访问配置
neo4j_uri = config.neo4j.uri
api_key = config.llm.api_key
max_content_length = config.system.max_content_length
```

### 配置优先级

配置加载遵循以下优先级（从高到低）：

1. **环境变量**: `NEO4J_PASSWORD`, `LLM_API_KEY`, 等
2. **用户配置文件**: `config/config.yaml`
3. **默认配置文件**: `config/yaml/config.default.yaml`
4. **代码默认值**: Pydantic 模型中的默认值

### 环境变量

支持通过环境变量覆盖配置：

| 环境变量 | 作用 | 示例 |
|---------|------|------|
| `NEO4J_URI` | Neo4j 连接地址 | `bolt://localhost:7687` |
| `NEO4J_USER` | Neo4j 用户名 | `neo4j` |
| `NEO4J_PASSWORD` | Neo4j 密码 | `your_password` |
| `LLM_API_ENDPOINT` | LLM API 端点 | `https://api.deepseek.com/v1` |
| `LLM_API_KEY` | LLM API 密钥 | `sk-your-key` |
| `LLM_MODEL_NAME` | LLM 模型名称 | `deepseek-chat` |

**示例**：

```bash
# Windows
set NEO4J_PASSWORD=mysecret
set LLM_API_KEY=sk-mykey
python app.py

# Linux/Mac
export NEO4J_PASSWORD=mysecret
export LLM_API_KEY=sk-mykey
python app.py
```

### 热重载

```python
from config import reload_config

# 重新加载配置
config = reload_config()
print("配置已重新加载")
```

## 配置模型

### AppConfig

主配置模型，包含以下子配置：

```python
class AppConfig(BaseModel):
    neo4j: Neo4jConfig              # Neo4j 数据库配置
    llm: LLMConfig                  # LLM API 配置
    system: SystemConfig            # 系统配置
    external_libs: ExternalLibsConfig  # 外部库配置
```

### Neo4jConfig

```python
uri: str = "bolt://localhost:7687"  # 连接地址
user: str = "neo4j"                  # 用户名
password: str = ""                    # 密码（从环境变量覆盖）
```

### LLMConfig

```python
api_endpoint: str = "https://api.deepseek.com/v1"  # API 端点
api_key: str = ""                                    # API 密钥（从环境变量覆盖）
model_name: str = "deepseek-chat"                   # 模型名称
temperature: float = 0.7                           # 生成温度
max_tokens: int = 4096                             # 最大令牌数
```

### SystemConfig

```python
max_content_length: int = 104857600     # 文件上传限制（字节）
```

### EmbeddingConfig

```python
mode: str = "local"                    # 模式: "local" 或 "remote"
local: LocalEmbeddingConfig            # 本地模型配置
remote: RemoteEmbeddingConfig          # 远程 API 配置
```

**LocalEmbeddingConfig**:
```python
model_name: str = "BAAI/bge-small-zh-v1.5"  # 本地模型名称
device: str = "cpu"                          # 设备: cpu 或 cuda
cache_dir: str | None = None                # 模型缓存目录
```

**RemoteEmbeddingConfig**:
```python
api_endpoint: str = ""                      # API 端点
api_key: str = ""                           # API 密钥
model_name: str = "text-embedding-3-small" # 远程模型名称
timeout: int = 30                          # 超时时间（秒）
max_retries: int = 3                       # 最大重试次数
```

详细使用说明请参考：`EMBEDDING_GUIDE.md`

### ExternalLibsConfig

为外部库预留的配置：

```python
llmjson: Dict[str, Any] = {}      # llmjson 配置
json2graph: Dict[str, Any] = {}   # json2graph-for-review 配置
```

## 外部库集成

### 集成 llmjson

在了解 llmjson 的具体配置需求后，可以修改配置文件：

```yaml
external_libs:
  llmjson:
    enabled: true
    config:
      # 根据 llmjson 的具体配置需求添加
      max_output_tokens: 4096
      temperature: 0.7
```

在代码中使用：

```python
from config import get_config

config = get_config()
llmjson_config = config.external_libs.llmjson
```

### 集成 json2graph-for-review

```yaml
external_libs:
  json2graph:
    enabled: true
    config:
      # 根据 json2graph-for-review 的具体配置需求添加
      entity_recognition: true
      relation_extraction: true
```

在代码中使用：

```python
from config import get_config

config = get_config()
json2graph_config = config.external_libs.json2graph
```

## 向后兼容

新配置系统完全向后兼容：

1. 原有的 `config.json` 和 `.env` 文件仍然可用
2. 现有的代码无需修改即可继续运行
3. 新旧配置系统可以并存

## 迁移指南

从旧配置系统迁移到新系统只需三步：

### 步骤 1: 替换配置加载代码

**旧代码：**
```python
with open('config.json', 'r', encoding='utf-8') as f:
    config = json.load(f)
```

**新代码：**
```python
from config import get_config

config = get_config()
```

### 步骤 2: 更新配置访问

**旧代码：**
```python
api_key = config.get('llm', {}).get('apiKey', '')
```

**新代码：**
```python
api_key = config.llm.api_key
```

### 步骤 3: 删除重复代码

移除配置加载的重复代码，统一使用 `get_config()`。

## 测试

### 测试配置系统

```bash
cd backend
python test_config.py
```

### 测试环境变量覆盖

```bash
# 设置环境变量后测试
set NEO4J_PASSWORD=test_password
set LLM_API_KEY=sk-test-key
python test_config_env.py
```

## 常见问题

### Q: 为什么环境变量没有生效？

A: 环境变量需要在应用启动前设置，且必须使用正确的变量名（参考上文的环境变量列表）。

### Q: 如何修改默认配置？

A: 修改 `config/yaml/config.default.yaml` 文件中的默认值。

### Q: 如何添加新的配置项？

A: 先在 `models.py` 中添加 Pydantic 模型字段，然后在 YAML 文件中添加对应的默认值。

### Q: 配置热重载会影响性能吗？

A: 配置热重载只在调用 `reload_config()` 时执行，对性能没有影响。

## 最佳实践

1. **敏感信息使用环境变量**：API 密钥、密码等敏感信息建议通过环境变量配置
2. **配置文件纳入版本控制**：`config.default.yaml` 应该纳入版本控制，`config.yaml` 应该加入 `.gitignore`
3. **使用类型注解**：利用 Pydantic 的类型检查尽早发现配置错误
4. **提供配置示例**：为新功能提供配置示例和文档
5. **保持向后兼容**：新配置项应该有合理的默认值，确保旧版本配置仍然可用
