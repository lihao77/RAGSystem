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
| `supports_prompt_caching` | boolean | 当前 Provider 的 Prompt Cache 能力开关（默认开） |
| `cache_ttl_seconds` | number | KV cache 有效期（秒，memory 前缀快照失效阈值，默认 300） |
| `is_loaded` / `is_available` | boolean | 运行时状态 |

## Provider 类型元数据

`provider-types` 端点返回 `ProviderTypeInfo`，描述每种 provider 类型的可配置字段：

```ts
interface ProviderTypeInfo {
  value: string;          // 类型标识
  label: string;          // 显示名
  default_endpoint: string;
  supports_embedding: boolean;             // 是否支持 Embedding
  supports_rerank: boolean;                // 是否支持 Rerank
  config_fields: ProviderConfigField[];  // 表单字段定义
}
```

每个 `ProviderConfigField` 含 `key`/`label`/`type`/`default`/`help`/`options`，前端据此动态渲染配置表单。

当前内置 Chat Provider 类型包括：

| Provider 类型 | 协议路径 | Embedding | Rerank |
|------|------|------|------|
| `openai_resp` | OpenAI Responses | 支持 | 不支持 |
| `openai_chat` / `openai_proxy` | OpenAI Chat Completions | 支持 | 不支持 |
| `anthropic` | Anthropic Messages | 不支持 | 不支持 |
| `gemini` | Gemini GenerateContent | 不支持 | 不支持 |
| `mistral` | OpenAI-compatible Chat | 支持 | 不支持 |
| `groq` | OpenAI-compatible Chat | 不支持 | 不支持 |
| `qwen` | DashScope OpenAI-compatible Chat | 支持 | 不支持（当前统一适配器） |
| `deepseek` | OpenAI-compatible Chat | 不支持 | 不支持 |
| `openrouter` | OpenAI-compatible Chat | 支持（取决于所选 embedding 模型） | 支持（取决于所选 rerank 模型） |
| `modelscope` | OpenAI-compatible Chat | 支持（取决于所选 embedding 模型） | 不支持（当前统一适配器） |

`rerank_api` 仅用于 Rerank，不具备 Chat 能力；它可以配置 Jina、Cohere、OpenRouter 等兼容 `/rerank` 的服务。

阿里云 DashScope/Qwen 官方提供 Rerank API，但当前接口路径和请求结构不是统一适配器默认的 `/rerank` 兼容格式；如需使用，应通过 `rerank_api` 配置对应的专用 Endpoint，或后续增加原生 DashScope Rerank 适配器。

自动前缀缓存由供应商控制，管理界面不会为这类 Provider 显示“启用 Prompt Cache”开关；`supports_prompt_caching` 只对协议支持显式缓存块或缓存键的 Provider 暴露。

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

管理页面会按 Provider 已配置的 `model_map` 列出 Chat、Embedding、Rerank 测试任务，不再隐式只测其中一个。Embedding 测试校验向量维度和数值；Rerank 测试同时提交相关与无关文档，并校验相关文档得分更高。

配置了 `model_map.rerank`、Endpoint 与 API Key 的 Provider 可以直接在知识库“重排序器”页面接入。知识库只保存 Provider 引用，运行时动态读取 Provider 的模型、Endpoint 与密钥。

Provider 列表接口不会返回 API Key 明文或掩码值。管理端通过 `api_key_configured` 判断密钥是否已配置，编辑时留空表示保持现有密钥。

## 在运行时中的角色

`ModelAdapterService` 在 `runtime-container.ts:135` 实例化，是 Agent 运行时的 LLM 提供方：

- `agentExecution` 通过 `providersProvider: () => modelAdapter.listProviders()` 获取可用 provider
- `AgentCompressionService`（上下文压缩）也复用 `() => modelAdapter.listProviders()`
- provider 的 capability matrix 决定协议分派、原生工具调用、Prompt Cache、usage 解析和 Embedding 默认入口

## 与共享包的关系

实际的 LLM 调用由 `@ragsystem/agent-llm` 包完成（见 `backend-ts/package.json` 依赖）。`ModelAdapterService` 负责配置管理与 provider 选择，agent-llm 负责 provider 协议适配（OpenAI / Anthropic 等）。详见 [共享协议包](/05-sdk/shared-packages)。
