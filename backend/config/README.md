# RAGSystem 配置

配置由 **Pydantic 模型**（`models.py`）定义，默认值在代码里。无需示例或默认 YAML 即可运行。

## 结构

```
backend/config/
├── __init__.py
├── base.py       # 加载与合并逻辑
├── models.py     # 配置项与默认值（唯一真相源）
├── README.md
└── yaml/
    └── config.yaml   # 可选，只写需要覆盖的项（勿提交，.gitignore）
```

## 使用

- **不创建 config.yaml**：全部使用 `models.py` 中的默认值（如 `neo4j.uri=bolt://localhost:7687`、`vector_store.backend=sqlite_vec` 等）。
- **需要覆盖时**：在 `yaml/config.yaml` 中只写要改的键，与 Pydantic 模型结构一致即可。例如：

```yaml
neo4j:
  password: "your_password"
llm:
  provider: test
  provider_type: deepseek
  model_name: deepseek-chat
```

## 优先级（从高到低）

1. 环境变量（如 `NEO4J__PASSWORD`）
2. `yaml/config.yaml`
3. `models.py` 中的默认值

## 配置项来源

所有字段与默认值见 **`models.py`**（`AppConfig`、`Neo4jConfig`、`VectorStoreConfig`、`LLMConfig`、`EmbeddingConfig` 等）。  
LLM/Embedding 的 API Key 等在「Model Adapter」中配置，本配置仅可指定 provider、provider_type、model_name。

## 热重载

```python
from config import reload_config
config = reload_config()
```
