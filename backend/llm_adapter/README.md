# LLM Adapter（已废弃组件）

> ⚠️ **重要说明：自 2026-02 起，LLMAdapter 已被新的 `ModelAdapter` 完全替代。**  
> - 新代码与前端管理界面请参考：`backend/model_adapter/README.md`  
> - API 前缀从 `/api/llm-adapter/...` 迁移为 `/api/model-adapter/...`  
> - 新的 Provider 配置集中存放在 `backend/model_adapter/configs/providers.yaml`
>
> 本文件保留作为「历史设计与迁移参考」，不再代表当前推荐实现方式。

## 功能特性（历史实现）

### 核心功能
- **多 Provider 支持**：支持 OpenAI、DeepSeek、OpenRouter 等主流 LLM 服务
- **统一接口**：所有 LLM 调用通过同一接口，无需关心底层实现
- **灵活配置**：支持每个提供商配置多个模型，运行时动态选择
- **成本追踪**：自动记录 token 使用量和成本
- **错误处理**：完善的错误处理和日志记录
- **工具调用**：支持 Function Calling / Tools 功能

### LLM Provider

所有 LLM Provider 都实现了以下方法：

- `chat_completion()`：发送对话补全请求
- `generate_text()`：发送文本生成请求
- `is_available()`：检查 Provider 是否可用
- `get_model_list()`：获取支持的模型列表
- `calculate_cost()`：计算调用成本

### 支持的 Provider

#### OpenAI Provider

```python
from llm_adapter.providers import OpenAIProvider

provider = OpenAIProvider(
    api_key="your-api-key",
    name="my-openai",
    model="gpt-3.5-turbo"
)
```

支持特性：
- 支持工具调用（Function Calling）
- Token 使用统计
- 成本计算

支持的模型：
- gpt-4-turbo-preview
- gpt-4
- gpt-3.5-turbo
- gpt-3.5-turbo-16k

#### DeepSeek Provider

```python
from llm_adapter.providers import DeepSeekProvider

provider = DeepSeekProvider(
    api_key="your-api-key",
    name="my-deepseek",
    model="deepseek-chat"
)
```

支持特性：
- 支持工具调用（Function Calling）
- 更具性价比
- 快速响应

支持的模型：
- deepseek-chat
- deepseek-coder

#### OpenRouter Provider

```python
from llm_adapter.providers import OpenRouterProvider

provider = OpenRouterProvider(
    api_key="your-api-key",
    name="my-openrouter",
    model="anthropic/claude-3-sonnet-20240229"
)
```

支持特性：
- 支持多种模型
- 自动价格匹配

支持的模型：
- anthropic/claude-3-sonnet
- anthropic/claude-3-opus
- anthropic/claude-3-haiku
- openai/gpt-4-turbo-preview
- google/gemini-pro

## 快速开始

### 基础使用

```python
from llm_adapter import get_default_adapter
from llm_adapter.providers import DeepSeekProvider

# 获取默认适配器
adapter = get_default_adapter()

# 注册 Provider（从配置或代码）
# 系统启动时会自动加载 config/yaml/config.yaml 中的配置

# 发送请求（必须指定 provider 和 model）
messages = [
    {"role": "user", "content": "你好，请介绍一下自己"}
]

response = adapter.chat_completion(
    messages=messages,
    provider="deepseek",  # 必需参数
    model="deepseek-chat"  # 必需参数
)

if response.error:
    print(f"错误: {response.error}")
else:
    print(f"回复: {response.content}")
    print(f"延迟: {response.latency:.2f}s")
    print(f"成本: ${response.cost:.6f}")
```

### 从配置创建 Provider

在 `config/yaml/config.yaml` 中配置：

```yaml
llm:
  provider: deepseek
  model_name: deepseek-chat
  api_key: your-api-key
  temperature: 0.7
  max_tokens: 4096
```

系统启动时会自动加载这些配置。

### API 服务

启动后端服务器后，可以通过 API 管理 Provider：

```bash
# 获取 Provider 列表
curl http://localhost:5000/api/llm-adapter/providers

# 创建 Provider
curl -X POST http://localhost:5000/api/llm-adapter/providers \
  -H "Content-Type: application/json" \
  -d '{
    "provider_type": "deepseek",
    "name": "My-DeepSeek",
    "api_key": "your-api-key",
    "models": ["deepseek-chat", "deepseek-coder"]
  }'

# 测试 Provider
curl -X POST http://localhost:5000/api/llm-adapter/test \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "My-DeepSeek",
    "model": "deepseek-chat",
    "prompt": "你好，请介绍一下自己"
  }'

# 获取服务状态
curl http://localhost:5000/api/config/services/status
```

### 前端管理界面

访问 `/llm-adapter` 页面，可以：
- 查看所有 Provider 列表
- 添加新的 Provider
- 编辑 Provider 配置（模型列表、温度等）
- 删除 Provider
- 测试 Provider
- 高级选项（温度、最大 token 数、超时时间等）

在系统设置 `/settings` 页面，可以：
- 选择 LLM 提供商
- 选择或输入模型名称
- 调整温度、最大 token 数等参数
- 测试 LLM 连接

## 配置说明

### 配置文件

- **默认配置**：`backend/config/yaml/config.default.yaml`
- **用户配置**：`backend/config/yaml/config.yaml`（覆盖默认配置）
- **环境变量**：最高优先级

### LLM 配置格式

```yaml
llm:
  # LLMAdapter 配置（推荐方式）
  provider: "deepseek"  # 提供商：openai / deepseek / openrouter
  model_name: "deepseek-chat"  # 模型名称
  temperature: 0.7      # 温度参数（默认）
  max_tokens: 4096      # 最大 token 数（默认）
  timeout: 30          # 超时时间（秒）
  retry_attempts: 3    # 重试次数

  # 旧版配置（向后兼容）
  api_endpoint: https://api.deepseek.com/v1
  api_key: "your-api-key"
```

**注意**：如果配置了 `provider`，旧版配置将被忽略。

### 配置优先级

1. **环境变量**：如 `LLM__PROVIDER="openai"`
2. **用户配置**（config.yaml）
3. **默认配置**（config.default.yaml）

### 环境变量配置

```bash
# LLM 提供商和模型
export LLM__PROVIDER="deepseek"
export LLM__MODEL_NAME="deepseek-chat"

# 旧版兼容
export LLM__API_ENDPOINT="https://api.deepseek.com/v1"
export LLM__API_KEY="your-api-key"
```

## 对于其他服务的迁移指南

### 从旧版 LLM 配置迁移

旧版配置（直接指定 API）：
```yaml
llm:
  api_endpoint: https://api.deepseek.com/v1
  api_key: your-api-key
  model_name: deepseek-chat
```

新版配置（使用 LLMAdapter）：
```yaml
llm:
  provider: deepseek
  model_name: deepseek-chat
  api_key: your-api-key
```

### 在代码中迁移

修改前（使用 LLMService）：
```python
from services.llm_service import get_llm_service

llm_service = get_llm_service()
response = llm_service.chat_completion(messages=messages)
answer = response['choices'][0]['message']['content']
```

修改后（使用 LLMAdapter）：
```python
from llm_adapter import get_default_adapter

adapter = get_default_adapter()
response = adapter.chat_completion(
    messages=messages,
    provider=config.llm.provider,
    model=config.llm.model_name
)

if response.error:
    logger.error(f"LLM 调用失败: {response.error}")
else:
    answer = response.content
```

修改前（直接调用 API）：
```python
import requests

response = requests.post(
    f"{config.llm.api_endpoint}/chat/completions",
    headers={"Authorization": f"Bearer {config.llm.api_key}"},
    json={"model": config.llm.model_name, "messages": messages}
)
```

修改后（使用 adapter）：
```python
from llm_adapter import get_default_adapter

adapter = get_default_adapter()
response = adapter.chat_completion(
    messages=messages,
    provider=config.llm.provider,
    model=config.llm.model_name
)
```

那会有更好的错误处理和使用信息。

## API 参考

### LLMAdapter 方法

- `register_provider(provider)`：注册 Provider
- `register_provider_from_config(config, save_config=True)`：从配置注册
- `remove_provider(provider_name, delete_config=True)`：删除 Provider
- `get_provider(provider_name)`：获取 Provider 实例
- `chat_completion(messages, provider, model, **kwargs)`：发送对话请求
- `get_available_providers()`：获取可用 Provider 列表
- `get_provider_configs()`：获取所有 Provider 配置

### LLMResponse 属性

- `content`：响应内容
- `error`：错误信息（如果有）
- `model`：使用的模型
- `provider`：使用的 Provider
- `usage`：Token 使用情况
- `cost`：成本（美元）
- `latency`：延迟（秒）
- `tool_calls`：工具调用列表

## 错误处理

所有 API 调用都可能返回错误：

```python
response = adapter.chat_completion(messages=messages, provider=provider, model=model)

if response.error:
    print(f"错误: {response.error}")
else:
    print(f"成功: {response.content}")
```

常见错误：
- `Provider 不存在`：指定的 provider 未找到
- `Provider 调用失败`：调用底层 API 失败
- `测试提示词不能为空`：测试接口缺少提示词
- `请选择要测试的模型`：测试时未选择模型

## 常见问题

### Q: 为什么我的配置没有生效？
A: 检查以下几点：
1. 配置文件格式是否正确（YAML 格式）
2. 是否重启后端服务（配置在启动时加载）
3. 检查配置优先级（环境变量 > config.yaml > config.default.yaml）
4. 使用 `/api/config/raw` 接口查看实际加载的配置
5. 检查配置是否被正确保存到 `config/yaml/config.yaml`

### Q: 如何添加新的 LLM 提供商？
A: 需要：
1. 创建新的 Provider 类（继承 LLMProvider）
2. 在 adapter.py 的 register_provider_from_config 中注册
3. 在前端添加对应的类型选项
4. 更新支持的模型列表

### Q: LLMService 去哪了？
A: LLMService 已被 LLMAdapter 替代，提供更统一的管理和更好的错误处理。所有 LLM 调用现在都通过 adapter。

### Q: 为什么 LLM 状态显示"未配置"？
A: 检查：
1. `config/yaml/config.yaml` 中是否有 provider 和 model_name
2. 是否重启后端服务以加载新配置
3. 配置文件路径是否正确

## 相关文件

- 后端实现：`backend/llm_adapter/`
  - adapter.py：主适配器类
  - base.py：抽象基类和数据模型
  - providers.py：具体 Provider 实现
  - config_store.py：配置持久化
- 前端组件：`frontend/src/components/LLMConfigSelector.vue`
- 配置页面：`frontend/src/views/LLMAdapterView.vue`
- 配置文件：`backend/config/yaml/config.yaml`
- 路由配置：`backend/routes/llm_adapter.py`
- 系统配置服务：`backend/services/config_service.py`

## 版本历史

- **2025-01-03**：移除 LLMService，全面使用 LLMAdapter
- **2025-01-02**：添加模型列表支持，允许用户灵活选择模型
- **2025-01-01**：初始版本，支持 OpenAI、DeepSeek、OpenRouter

## 高级功能

### 工具调用

```python
# 定义工具
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "获取天气信息",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {"type": "string"}
                }
            }
        }
    }
]

# 调用工具
response = adapter.chat_completion(
    messages=messages,
    tools=tools
)

if response.tool_calls:
    print(f"工具调用: {response.tool_calls}")
```

### 故障转移

当某个 Provider 失败时，自动切换到其他 Provider：

```python
# 启用 Fallback
response = adapter.chat_completion(
    messages=messages,
    enable_fallback=True  # 默认值
)
```

### 统计信息

```python
# 获取所有统计
stats = adapter.get_stats()

# 获取指定 Provider 的统计
stats = adapter.get_stats("deepseek")

print(f"总请求数: {stats['total_requests']}")
print(f"成功率: {stats['success_rate']:.2%}")
print(f"平均延迟: {stats['avg_latency']:.2f}s")
print(f"总成本: ${stats['total_cost']:.4f}")
```

## 环境变量

系统会自动从环境变量读取配置：

```bash
export LLM_API_KEY="your-api-key"
export LLM_API_ENDPOINT="https://api.deepseek.com/v1"
export LLM_MODEL_NAME="deepseek-chat"
```

如果设置了这些变量，系统启动时会自动创建默认的 Provider。

## 错误处理

所有 API 调用都返回标准响应格式：

```json
{
  "success": true/false,
  "message": "描述信息",
  "data": {}  // 成功时的数据
}
```

错误示例：

```python
response = adapter.chat_completion(messages=messages)

if response.error:
    print(f"错误: {response.error}")
else:
    print(f"成功: {response.content}")
```

## 测试

运行测试：

```bash
# 运行 API 测试
python test_llm_adapter_api.py

# 运行单元测试（如果存在）
pytest tests/test_llm_adapter.py
```

## 二次开发

### 添加新的 Provider

继承 `LLMProvider` 基类：

```python
from llm_adapter.base import LLMProvider, LLMResponse
from enum import Enum

class MyProviderType(str, Enum):
    MY_PROVIDER = "my_provider"

class MyProvider(LLMProvider):
    def __init__(self, api_key: str, **kwargs):
        super().__init__(
            name="MyProvider",
            api_key=api_key,
            api_endpoint=kwargs.get("api_endpoint", "https://api.example.com"),
            **kwargs
        )

    def chat_completion(self, messages, **kwargs) -> LLMResponse:
        # 实现 API 调用逻辑
        pass

    def _get_provider_type(self):
        return MyProviderType.MY_PROVIDER

    def get_model_list(self):
        return ["model1", "model2"]

    def calculate_cost(self, input_tokens, output_tokens, model):
        return 0.0

    def is_available(self):
        return True
```

### 集成到 Adapter

```python
from llm_adapter import LLMAdapter
from my_provider import MyProvider

adapter = LLMAdapter()
provider = MyProvider(api_key="sk-xxx")
adapter.register_provider(provider)
```

## TODO

- [ ] 添加请求缓存功能
- [ ] 支持更多 Provider（Anthropic、Google 等）
- [ ] 实现请求重试机制
- [ ] 添加 WebSocket 支持
- [ ] 支持批量请求
- [ ] 添加更多负载均衡策略
- [ ] 实现成本预算限制
- [ ] 添加请求优先级队列
