# LLM 重试机制重构说明

> 完成时间：2026-02-23
> 重构原因：统一重试逻辑，避免重复和不一致

---

## 问题分析

### 原有设计的问题

1. **重试逻辑分散**
   - `DeepSeekProvider`: 有重试（固定延迟 1s）
   - `OpenAIProvider`: 没有重试
   - `Agent 层`: 也实现了重试（指数退避）

2. **重复重试**
   - 如果使用 DeepSeekProvider，会重试 3×3=9 次
   - Agent 重试 3 次，每次 Provider 又重试 3 次

3. **行为不一致**
   - OpenAI 只重试 3 次（Agent 层）
   - DeepSeek 重试 9 次（Agent 层 + Provider 层）

4. **架构混乱**
   - 重试逻辑应该在哪一层？
   - 业务层（Agent）不应该关心网络重试细节

---

## 重构方案

### 设计原则

**重试应该在 Provider 层统一实现**，原因：
- ✅ 更接近网络层，能捕获所有网络错误
- ✅ 所有 Provider 行为一致
- ✅ Agent 层不需要关心底层重试细节
- ✅ 符合单一职责原则（网络层处理网络问题）

### 架构设计

```
┌─────────────────────────────────────────┐
│           Agent 层                       │
│  - 业务逻辑                              │
│  - 不关心重试                            │
│  - 直接调用 model_adapter.chat_completion()│
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│        ModelAdapter 层                   │
│  - 路由到具体 Provider                   │
│  - 不处理重试                            │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│         AIProvider 基类                  │
│  ✨ chat_completion() - 统一重试包装器   │
│     - 指数退避（1s, 2s, 4s）            │
│     - 默认重试 3 次                      │
│     - 所有子类自动继承                   │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│         具体 Provider                    │
│  ✨ _do_chat_completion() - 实际请求     │
│     - 只做一次 API 调用                  │
│     - 不包含重试逻辑                     │
└─────────────────────────────────────────┘
```

---

## 实现细节

### 1. AIProvider 基类（backend/model_adapter/base.py）

```python
class AIProvider(ABC):
    def __init__(self, ...):
        self.retry_attempts = kwargs.get("retry_attempts", 3)
        self.retry_delay = kwargs.get("retry_delay", 1.0)

    @abstractmethod
    def _do_chat_completion(self, ...) -> ModelResponse:
        """子类实现实际请求（不含重试）"""
        pass

    def chat_completion(self, ...) -> ModelResponse:
        """统一重试包装器（所有子类自动继承）"""
        for attempt in range(self.retry_attempts):
            try:
                response = self._do_chat_completion(...)

                if not response.error:
                    return response

                # 指数退避
                wait_time = self.retry_delay * (2 ** attempt)
                time.sleep(wait_time)

            except Exception as e:
                if attempt == self.retry_attempts - 1:
                    return ModelResponse(error=str(e))

                wait_time = self.retry_delay * (2 ** attempt)
                time.sleep(wait_time)

        return response
```

### 2. 具体 Provider 实现

**OpenAIProvider**（backend/model_adapter/providers.py）
```python
class OpenAIProvider(AIProvider):
    def _do_chat_completion(self, ...) -> ModelResponse:
        """实际 API 调用（不含重试）"""
        try:
            response = requests.post(...)
            return ModelResponse(content=...)
        except Exception as e:
            return ModelResponse(error=str(e))
```

**DeepSeekProvider**（backend/model_adapter/providers.py）
```python
class DeepSeekProvider(AIProvider):
    def _do_chat_completion(self, ...) -> ModelResponse:
        """实际 API 调用（移除了原有的重试循环）"""
        try:
            response = requests.post(...)
            return ModelResponse(content=...)
        except Exception as e:
            return ModelResponse(error=str(e))
```

### 3. Agent 层调用

**ReActAgent**（backend/agents/implementations/react/agent.py）
```python
# 直接调用，不需要关心重试
response = self.model_adapter.chat_completion(
    messages=managed_messages,
    provider=llm_config.get('provider'),
    model=llm_config.get('model_name'),
    ...
)

# 检查错误
if response.error:
    return AgentResponse(success=False, error=response.error)
```

---

## 修改文件清单

| 文件 | 修改内容 | 行数变化 |
|------|---------|---------|
| `backend/model_adapter/base.py` | 添加 `chat_completion()` 重试包装器<br>添加 `_do_chat_completion()` 抽象方法 | +110 |
| `backend/model_adapter/providers.py` | `OpenAIProvider`: `chat_completion` → `_do_chat_completion`<br>`DeepSeekProvider`: 移除重试循环<br>`OpenRouterProvider`: `chat_completion` → `_do_chat_completion` | -50 |
| `backend/agents/core/base.py` | 移除 `call_llm_with_retry()` 方法 | -75 |
| `backend/agents/implementations/react/agent.py` | 恢复直接调用 `model_adapter.chat_completion()` | -15 |

---

## 测试验证

### 单元测试

```python
def test_provider_retry():
    """测试 Provider 层统一重试"""
    class MockProvider(AIProvider):
        def __init__(self):
            super().__init__(
                name="test",
                api_key="test",
                api_endpoint="http://test",
                retry_attempts=3,
                retry_delay=0.1
            )
            self.call_count = 0

        def _do_chat_completion(self, **kwargs):
            self.call_count += 1
            if self.call_count < 2:
                return ModelResponse(error='API Error')
            return ModelResponse(content='Success')

    provider = MockProvider()
    response = provider.chat_completion(messages=[...])

    assert response.error is None
    assert response.content == 'Success'
    assert provider.call_count == 2  # 第一次失败，第二次成功
```

### 集成测试

运行 `backend/test_phase1_fixes.py` 中的 `test_llm_retry_mechanism()`

---

## 效果对比

### 重构前

| Provider | Agent 重试 | Provider 重试 | 总重试次数 |
|----------|-----------|--------------|-----------|
| OpenAI   | 3 次      | 0 次         | 3 次      |
| DeepSeek | 3 次      | 3 次         | 9 次      |

### 重构后

| Provider | Agent 重试 | Provider 重试 | 总重试次数 |
|----------|-----------|--------------|-----------|
| OpenAI   | 0 次      | 3 次         | 3 次      |
| DeepSeek | 0 次      | 3 次         | 3 次      |
| 所有     | 0 次      | 3 次         | 3 次      |

---

## 优势总结

1. **行为一致**：所有 Provider 都有相同的重试行为
2. **避免重复**：不会出现 9 次重试的情况
3. **职责清晰**：网络层处理网络问题，业务层专注业务逻辑
4. **易于维护**：重试逻辑集中在基类，修改一处即可
5. **可配置**：通过 `retry_attempts` 和 `retry_delay` 参数灵活配置

---

## 配置示例

```yaml
# backend/model_adapter/configs/providers.yaml
providers:
  my_provider:
    name: my_provider
    provider_type: openai
    api_key: sk-xxx
    api_endpoint: https://api.example.com
    retry_attempts: 5      # 自定义重试次数
    retry_delay: 2.0       # 自定义初始延迟（秒）
```

重试延迟计算：`wait_time = retry_delay * (2 ** attempt)`
- 第 1 次重试：2.0s
- 第 2 次重试：4.0s
- 第 3 次重试：8.0s
- 第 4 次重试：16.0s

---

**总结**：通过将重试逻辑统一到 Provider 基类，实现了更清晰的架构、一致的行为和更好的可维护性。
