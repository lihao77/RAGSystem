# LLM Adapter

LLM Adapter 是一个统一的大语言模型调用适配器，提供统一的接口来管理和调用不同的 LLM 服务。

## 功能特性

### 核心功能
- **多 Provider 支持**：支持 OpenAI、DeepSeek、OpenRouter 等主流 LLM 服务
- **统一接口**：所有 Provider 使用相同的 API 接口
- **智能路由**：支持轮询、随机、健康优先等多种负载均衡策略
- **故障转移**：自动切换到可用的 Provider
- **请求统计**：实时监控请求成功率、延迟、成本等
- **动态配置**：支持运行时添加、删除、修改 Provider

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
    model="anthropic/claude-3-sonnet-20240229"
)
```

支持特性：
- 支持多种模型
- 自动价格匹配
- Fallback 支持

支持的模型：
- anthropic/claude-3-sonnet
- anthropic/claude-3-opus
- anthropic/claude-3-haiku
- openai/gpt-4
- google/gemini-pro

## 快速开始

### 基础使用

```python
from llm_adapter import LLMAdapter, get_default_adapter
from llm_adapter.providers import DeepSeekProvider

# 方式 1：使用默认适配器
adapter = get_default_adapter()

# 方式 2：创建新的适配器
adapter = LLMAdapter()

# 注册 Provider
provider = DeepSeekProvider(
    api_key="your-api-key",
    model="deepseek-chat"
)
adapter.register_provider(provider)

# 发送请求
messages = [
    {"role": "user", "content": "你好，请介绍一下自己"}
]
response = adapter.chat_completion(messages=messages)

print(f"回复: {response.content}")
print(f"延迟: {response.latency:.2f}s")
print(f"成本: ${response.cost:.6f}")
```

### 使用负载均衡

```python
# 设置负载均衡策略
adapter.set_load_balancer("round_robin")  # 轮
adapter.set_load_balancer("random")       # 随机
adapter.set_load_balancer("health")       # 健康优先

# 自动选择最佳 Provider
response = adapter.chat_completion(messages=messages)
```

### 从配置创建 Provider

```python
config = {
    "provider_type": "openai",
    "name": "My-OpenAI",
    "api_key": "sk-xxx",
    "model": "gpt-3.5-turbo",
    "temperature": 0.7,
    "max_tokens": 4096,
    "timeout": 30,
    "retry_attempts": 3,
    "supports_function_calling": True
}

adapter.register_provider_from_config(config)
```

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
    "model": "deepseek-chat"
  }'

# 测试 Provider
curl -X POST http://localhost:5000/api/llm-adapter/test \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "你好，请介绍一下自己"
  }'
```

### 前端管理界面

访问 `/llm-adapter` 页面，可以：
- 查看所有 Provider 列表
- 添加新的 Provider
- 编辑 Provider 配置
- 删除 Provider
- 设置活动 Provider
- 测试 Provider
- 查看统计信息
- 设置负载均衡策略

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
