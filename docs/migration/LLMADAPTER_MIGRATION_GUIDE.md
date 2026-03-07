# ModelAdapter 历史迁移说明

> 最后更新：2026-03-07  
> 状态：历史文档（当前实现已统一为 `ModelAdapter`）

## 当前结论

- `LLMService` 与旧 `LLMAdapter` 路线已经结束
- 当前后端仅保留 `ModelAdapter`
- 当前 API 入口仅保留：`/api/model-adapter/...`
- 旧兼容 API 前缀已删除
- 旧兼容包目录已删除

## 如果你在看旧文档或旧教程

请将以下内容统一替换：

- `LLMAdapter` → `ModelAdapter`
- 旧后端兼容目录 → `backend/model_adapter/...`
- 旧 API 前缀 → `/api/model-adapter/...`
- 旧前端适配器页面 → `ModelAdapterView.vue`

## 当前推荐入口

### Python 代码

```python
from model_adapter import get_default_adapter
from model_adapter.providers import OpenAIProvider
```

### HTTP API

```text
GET  /api/model-adapter/providers
POST /api/model-adapter/providers
PUT  /api/model-adapter/providers/{provider_key}
DELETE /api/model-adapter/providers/{provider_key}
POST /api/model-adapter/test
```

### 前端页面

- 管理端页面：`/model-adapter`
- 相关实现：`frontend/src/views/ModelAdapterView.vue`

## 备注

这个文件保留的唯一目的，是给旧提交、旧截图、旧部署记录提供一个“历史到现状”的映射说明。
新代码和新文档请只使用 `ModelAdapter` 术语。
