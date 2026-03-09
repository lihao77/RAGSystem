# 配置系统

`backend/config/` 定义系统级配置模型、加载逻辑和启动前健康检查。

## 当前文件

- `models.py`：`AppConfig` 及子模型默认值
- `base.py`：配置加载器
- `health_check.py`：启动前检查
- `schemas.py`：跨配置校验
- `yaml/config.yaml.example`：示例覆盖文件

## 当前加载顺序

`ConfigManager.load()` 的顺序是：

1. 可选的 `config/yaml/config.default.yaml`
2. 可选的 `config/yaml/config.yaml`
3. 环境变量覆盖
4. `AppConfig` 默认值补齐

`.env` 会在加载前从 `backend/.env` 读取。

## 当前环境变量覆盖

代码里显式支持的覆盖项：

- `NEO4J_URI`
- `NEO4J_USER`
- `NEO4J_PASSWORD`
- `LLM_API_ENDPOINT`
- `LLM_API_KEY`
- `LLM_MODEL_NAME`

运行服务本身还会读取：

- `FLASK_HOST`
- `FLASK_PORT`
- `PORT`
- `FLASK_DEBUG`
- `FLASK_USE_RELOADER`
- `CORS_ORIGINS`
- `UPLOAD_FOLDER`
- `FRONTEND_DIST`

## 主要配置结构

`models.py` 当前定义：

- `neo4j`
- `vector_store`
- `llm`
- `system`
- `embedding`
- `external_libs`

示例：

```yaml
neo4j:
  uri: bolt://localhost:7687
  user: neo4j
  password: your-password

llm:
  provider: test
  provider_type: deepseek
  model_name: deepseek-chat
```

## 健康检查

`health_check.py` 会：

- 检查敏感文件是否已加入 `.gitignore`
- 检查 `providers.yaml` 是否存在
- 如果 `providers.yaml` 存在，则继续做跨配置校验

说明：

- 缺少 `providers.yaml` 只会给出警告，不阻止后端启动
- 这意味着可以先启动服务，再通过管理端创建 Provider
