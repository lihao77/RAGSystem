# Model Adapter

`backend/model_adapter/` 是后端统一的模型 Provider 适配层。

## 当前结构

- `adapter.py`：`ModelAdapter` 主入口和默认单例
- `base.py`：通用响应类型与 Provider 基类
- `config_store.py`：`providers.yaml` 读写
- `providers.py`：兼容导出层，实际厂商实现位于 `backend/integrations/model_providers/`
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

- `backend/config/` 只保存默认 provider 指针和模型名
- Agent 和向量子系统通过 provider key 使用这里的配置
- 前端管理端的 `/model-adapter` 页面直接操作这些接口

## 验证

```powershell
cd backend
python -m pytest tests\model_adapter_config_store_test.py
```
