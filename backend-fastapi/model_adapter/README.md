# Model Adapter

`backend-fastapi/model_adapter/` 是后端统一的模型 Provider 适配层。

## 当前结构

- `adapter.py`：`ModelAdapter` 主入口和默认单例
- `base.py`：通用响应类型与 Provider 基类
- `config_store.py`：`providers.yaml` 读写
- `providers.py`：兼容导出层，实际厂商实现位于 `backend-fastapi/integrations/model_providers/`
- `configs/providers.yaml`：Provider 实例配置
- `configs/providers.yaml.example`：示例

## 配置方式

- 当前只使用一个 YAML 文件保存全部 Provider
- 顶层键是 provider key，通常采用 `{name}_{provider_type}` 形式
- 每个 Provider 可配置 `model_map`、`api_key`、`api_endpoint` 等字段

示例：

```yaml
test_deepseek:
  name: test
  provider_type: deepseek
  api_key: ${DEEPSEEK_API_KEY}
  model_map:
    chat: deepseek-chat
    embedding: text-embedding-3-small
```

## 主要 API

- `GET /api/model-adapter/providers`
- `POST /api/model-adapter/providers`
- `PUT /api/model-adapter/providers/<provider_key>`
- `DELETE /api/model-adapter/providers/<provider_key>`
- `GET /api/model-adapter/providers/<provider_key>/check`
- `POST /api/model-adapter/test`

## 与其他子系统的关系

- Agent 与向量能力通过 provider key 使用这里的配置
- `frontend-client` 通过 `/api/model-adapter` 管理 Provider

## 验证

```powershell
python -m py_compile backend-fastapi\model_adapter\adapter.py
```
