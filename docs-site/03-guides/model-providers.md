# 模型 Provider

模型 Provider 管理 LLM 的接入配置（API key、endpoint、模型列表、参数）。本章基于 `backend-ts/src/services/integrations/model-adapter-service.ts`、`contracts/model-adapter.ts` 与 `routes/model-adapter.ts`。

## 配置文件

```
<RAG_DATA_ROOT>/config/model_adapter/providers.yaml
```

::: tip 出处
`model-adapter-service.ts:17` → `PROVIDERS_CONFIG_RELATIVE_PATH = path.join("config", "model_adapter", "providers.yaml")`。
:::

## Provider 配置结构

来自 `contracts/model-adapter.ts` 的 `ModelProviderConfig`（zod 推导的类型）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | Provider 名称 |
| `provider_type` | string | 类型标识（如 openai/anthropic 等） |
| `key` / `api_key` | string | 认证密钥 |
| `api_endpoint` | string | 接口地址 |
| `model` | string | 默认模型 |
| `models` | string[] | 可用模型列表 |
| `model_map` | Record | 模型映射（值为 string 或 string[]） |
| `temperature` | number | 采样温度 |
| `max_tokens` / `max_completion_tokens` | number | 输出长度限制 |
| `max_context_tokens` | number | 上下文窗口 |
| `thinking_budget_tokens` | number | 思考预算（推理模型） |
| `reasoning_effort` | string | 推理强度 |
| `timeout` | number | 请求超时 |
| `retry_attempts` / `retry_delay` / `retry_backoff_factor` | number | 重试策略 |
| `supports_function_calling` | boolean | 是否支持函数调用 |
| `supports_vision` | boolean | 是否支持视觉 |
| `supports_prompt_caching` | boolean | Anthropic prompt cache 总开关（默认开） |
| `cache_ttl_seconds` | number | KV cache 有效期（秒，memory 前缀快照失效阈值，默认 300） |
| `is_loaded` / `is_available` | boolean | 运行时状态 |

## Provider 类型元数据

`provider-types` 端点返回 `ProviderTypeInfo`，描述每种 provider 类型的可配置字段：

```ts
interface ProviderTypeInfo {
  value: string;          // 类型标识
  label: string;          // 显示名
  default_endpoint: string;
  config_fields: ProviderConfigField[];  // 表单字段定义
}
```

每个 `ProviderConfigField` 含 `key`/`label`/`type`/`default`/`help`/`options`，前端据此动态渲染配置表单。

## 管理 API（路由前缀 `/api/model-adapter`）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/provider-types` | 列出所有支持的 provider 类型（含表单字段定义） |
| `GET` | `/providers` | 列出已配置的 provider（API Key 不回传，仅返回 `api_key_configured`） |
| `POST` | `/providers` | 创建 provider（body 走 `ProviderPayloadSchema`） |
| `PUT` | `/providers/order` | 调整 provider 优先级顺序（body: `{ provider_keys: string[] }`） |
| `PUT` | `/providers/:providerKey` | 更新 provider |
| `DELETE` | `/providers/:providerKey` | 删除 provider；存在 Agent/向量化器/Reranker 引用时返回 409 |
| `GET` | `/providers/:providerKey/usages` | 列出引用该 provider 的配置 |
| `GET` | `/providers/:providerKey/check` | 检查 provider 可用性 |
| `POST` | `/test` | 测试调用（body 走 `TestProviderRequestSchema`） |

### 测试调用

`POST /test` 接受 `TestProviderRequest`：

```ts
{
  provider?: string,
  provider_type?: string,
  model?: string | string[],
  prompt?: string,
  task?: string,        // 默认 "chat"
  documents?: unknown[],
}
```

返回 `response` 含 `content`/`embeddings`/`results`、`model`、`latency` 和 `error` 等任务相关字段。Chat、Embedding 与 Rerank 都会调用对应的真实 Provider 接口；调用失败时 HTTP 请求仍可成功返回，但 `response.error` 会携带厂商错误，调用方必须据此判定测试失败。Provider 不存在时同样返回带 `error` 的空结果。

Provider 列表接口不会返回 API Key 明文或掩码值。管理端通过 `api_key_configured` 判断密钥是否已配置，编辑时留空表示保持现有密钥。

## 在运行时中的角色

`ModelAdapterService` 在 `runtime-container.ts:135` 实例化，是 Agent 运行时的 LLM 提供方：

- `agentExecution` 通过 `providersProvider: () => modelAdapter.listProviders()` 获取可用 provider
- `AgentCompressionService`（上下文压缩）也复用 `() => modelAdapter.listProviders()`
- provider 的 `supports_prompt_caching` / `cache_ttl_seconds` 影响 Anthropic 路径的历史滚动 cache_control 断点与 memory 前缀快照失效

## 与共享包的关系

实际的 LLM 调用由 `@ragsystem/agent-llm` 包完成（见 `backend-ts/package.json` 依赖）。`ModelAdapterService` 负责配置管理与 provider 选择，agent-llm 负责 provider 协议适配（OpenAI / Anthropic 等）。详见 [共享协议包](/05-sdk/shared-packages)。
