# 智能体系统错误处理指南

## 概述

RAGSystem 智能体系统提供完整的错误处理机制，包括自动重试、错误分类和检查点恢复。

## 核心组件

### 1. 错误分类系统

**位置**: `backend/agents/errors/`

**功能**:
- 区分可重试错误和不可重试错误
- 自动识别错误类型
- 提供推荐的重试配置

**错误类型**:

1. **RetryableError**: 可重试错误
   - 网络错误 (ConnectionError)
   - 超时错误 (TimeoutError)
   - 临时故障

2. **NonRetryableError**: 不可重试错误
   - 参数错误 (ValueError, ValidationError)
   - 权限错误 (PermissionError)
   - 配置错误 (ConfigurationError)

3. **RateLimitError**: 速率限制错误（需更长退避时间）

**使用示例**:

```python
from agents.errors import ErrorClassifier, ErrorType

# 分类错误
error_type = ErrorClassifier.classify(exception)

# 判断是否可重试
if ErrorClassifier.is_retryable(exception):
    # 重试逻辑
    pass

# 获取推荐的重试配置
retry_config = ErrorClassifier.get_retry_config(exception)
# 返回: {"max_retries": 3, "backoff_factor": 2.0, "timeout": 30.0}
```

**错误识别规则**:

```python
# 1. 基于异常类型
isinstance(error, ConnectionError)  # → RETRYABLE
isinstance(error, ValueError)       # → NON_RETRYABLE
isinstance(error, RateLimitError)   # → RETRYABLE_WITH_BACKOFF

# 2. 基于错误消息模式
"rate limit" in str(error)          # → RETRYABLE_WITH_BACKOFF
"connection timeout" in str(error)  # → RETRYABLE
"invalid parameter" in str(error)   # → NON_RETRYABLE
```

### 2. 重试装饰器

**位置**: `backend/utils/retry_decorator.py`

**功能**:
- 自动重试失败的操作
- 指数退避策略
- 超时控制
- 重试回调

**使用示例**:

```python
from utils.retry_decorator import retry_on_failure

@retry_on_failure(
    max_retries=3,
    backoff_factor=2.0,
    retry_on=(ConnectionError, TimeoutError),
    timeout=30.0
)
def execute_tool(tool_name, arguments):
    # 工具执行逻辑
    result = call_external_api(...)
    return result
```

**参数说明**:

- `max_retries`: 最大重试次数（默认 3）
- `backoff_factor`: 退避因子（默认 2.0）
  - 第 1 次重试等待: 2^0 = 1 秒
  - 第 2 次重试等待: 2^1 = 2 秒
  - 第 3 次重试等待: 2^2 = 4 秒
- `retry_on`: 可重试的异常类型元组
- `timeout`: 总超时时间（秒）
- `on_retry`: 重试回调函数

**异步版本**:

```python
from utils.retry_decorator import retry_async

@retry_async(max_retries=3, backoff_factor=2.0)
async def async_tool_call():
    result = await call_async_api(...)
    return result
```

### 3. 检查点恢复系统

**位置**: `backend/agents/recovery/`

**功能**:
- 在关键节点保存执行状态
- 从失败点恢复执行
- 自动清理过期检查点

**使用示例**:

```python
from agents.recovery import CheckpointManager

# 初始化
checkpoint_manager = CheckpointManager()

# 保存检查点
checkpoint_id = checkpoint_manager.save_checkpoint(
    session_id="abc-123",
    agent_name="qa_agent",
    round=3,
    messages=[...],
    metadata={"task": "分析数据"}
)

# 加载检查点
checkpoint = checkpoint_manager.load_checkpoint(checkpoint_id)

# 获取最新检查点
latest = checkpoint_manager.get_latest_checkpoint(
    session_id="abc-123",
    agent_name="qa_agent"
)

# 清理过期检查点（7 天前）
deleted_count = checkpoint_manager.cleanup_old_checkpoints(days=7)
```

**检查点数据结构**:

```python
{
    "checkpoint_id": "abc-123_qa_agent_r3",
    "session_id": "abc-123",
    "agent_name": "qa_agent",
    "round": 3,
    "messages": [
        {"role": "user", "content": "..."},
        {"role": "assistant", "content": "..."}
    ],
    "metadata": {"task": "分析数据"},
    "created_at": "2026-02-23T10:30:45Z"
}
```

### 4. 恢复 API

**端点**: `/api/agent/sessions/<session_id>/recover`

**从检查点恢复**:

```bash
POST /api/agent/sessions/abc-123/recover
Content-Type: application/json

{
  "checkpoint_id": "abc-123_qa_agent_r3",  // 可选
  "agent_name": "qa_agent",                // 可选
  "user_id": "user-001"                    // 可选
}

Response:
{
  "success": true,
  "data": {
    "checkpoint_id": "abc-123_qa_agent_r3",
    "round": 3,
    "answer": "...",
    "success": true,
    "agent_name": "qa_agent"
  }
}
```

**列出检查点**:

```bash
GET /api/agent/sessions/abc-123/checkpoints?agent_name=qa_agent&limit=10

Response:
{
  "success": true,
  "data": {
    "checkpoints": [
      {
        "checkpoint_id": "abc-123_qa_agent_r3",
        "session_id": "abc-123",
        "agent_name": "qa_agent",
        "round": 3,
        "created_at": "2026-02-23T10:30:45Z"
      }
    ]
  }
}
```

## 错误处理策略

### 1. 工具调用错误

```python
from agents.errors import ToolExecutionError, ErrorClassifier
from utils.retry_decorator import retry_on_failure

@retry_on_failure(
    max_retries=3,
    backoff_factor=2.0,
    retry_on=(ConnectionError, TimeoutError)
)
def execute_tool(tool_name, arguments):
    try:
        result = _execute_tool_impl(tool_name, arguments)
        return result
    except Exception as e:
        # 分类错误
        if ErrorClassifier.is_retryable(e):
            # 可重试错误，抛出以触发重试
            raise
        else:
            # 不可重试错误，包装后抛出
            raise ToolExecutionError(
                tool_name=tool_name,
                message=str(e),
                original_error=e
            )
```

### 2. LLM 调用错误

```python
from agents.errors import LLMError, RateLimitError

@retry_on_failure(
    max_retries=3,
    backoff_factor=5.0,  # 更长的退避时间
    retry_on=(RateLimitError, ConnectionError)
)
def call_llm(messages, provider):
    try:
        response = model_adapter.chat_completion(
            messages=messages,
            provider=provider
        )
        return response
    except Exception as e:
        if "rate limit" in str(e).lower():
            raise RateLimitError(retry_after=60)
        elif "connection" in str(e).lower():
            raise ConnectionError(str(e))
        else:
            raise LLMError(
                provider=provider,
                message=str(e),
                original_error=e
            )
```

### 3. 智能体执行错误

```python
from agents.recovery import CheckpointManager

def execute_agent(task, context):
    checkpoint_manager = CheckpointManager()

    for round in range(max_rounds):
        try:
            # 保存检查点
            checkpoint_manager.save_checkpoint(
                session_id=context.session_id,
                agent_name=self.name,
                round=round,
                messages=context.messages,
                metadata={"task": task}
            )

            # 执行推理
            result = self._execute_round(task, context)

            if result.is_final:
                return result

        except Exception as e:
            logger.error(f"执行失败（轮次 {round}）: {e}")

            # 判断是否可恢复
            if ErrorClassifier.is_retryable(e):
                # 可重试，继续下一轮
                continue
            else:
                # 不可重试，抛出错误
                raise
```

## 最佳实践

### 1. 错误分类

```python
# ✅ 好的做法：使用自定义异常类
from agents.errors import ValidationError, PermissionError

if not arguments.get("entity_id"):
    raise ValidationError("缺少必需参数: entity_id")

if not has_permission(user, tool_name):
    raise PermissionError(
        resource=tool_name,
        action="execute",
        message="用户无权执行此工具"
    )

# ❌ 避免：使用通用异常
raise Exception("参数错误")
```

### 2. 重试策略

```python
# ✅ 好的做法：根据错误类型调整重试配置
retry_config = ErrorClassifier.get_retry_config(error)

@retry_on_failure(**retry_config)
def execute_with_adaptive_retry():
    pass

# ✅ 好的做法：为不同操作使用不同的重试配置
@retry_on_failure(max_retries=3, backoff_factor=2.0)  # 快速重试
def query_database():
    pass

@retry_on_failure(max_retries=3, backoff_factor=5.0)  # 慢速重试
def call_external_api():
    pass
```

### 3. 检查点管理

```python
# ✅ 好的做法：在关键节点保存检查点
def execute_complex_task():
    # 阶段 1
    result1 = execute_phase1()
    save_checkpoint(round=1, data=result1)

    # 阶段 2
    result2 = execute_phase2(result1)
    save_checkpoint(round=2, data=result2)

    # 阶段 3
    result3 = execute_phase3(result2)
    return result3

# ✅ 好的做法：定期清理过期检查点
checkpoint_manager.cleanup_old_checkpoints(days=7)
```

## 故障排查

### 问题：重试未生效

**原因**: 异常类型不在 `retry_on` 列表中

**解决方案**:
```python
# 检查异常类型
print(type(exception))

# 添加到 retry_on
@retry_on_failure(
    retry_on=(ConnectionError, TimeoutError, YourCustomError)
)
```

### 问题：检查点恢复失败

**原因**: 检查点数据损坏或不存在

**解决方案**:
```python
# 检查检查点是否存在
checkpoint = checkpoint_manager.load_checkpoint(checkpoint_id)
if not checkpoint:
    logger.error(f"检查点不存在: {checkpoint_id}")

# 使用最新检查点
latest = checkpoint_manager.get_latest_checkpoint(session_id)
```

### 问题：无限重试

**原因**: 错误被错误分类为可重试

**解决方案**:
```python
# 检查错误分类
error_type = ErrorClassifier.classify(exception)
print(f"错误类型: {error_type}")

# 如果分类错误，手动抛出不可重试异常
if should_not_retry:
    raise NonRetryableError(str(exception))
```

## 依赖项

无额外依赖（使用 Python 标准库）

## 相关文档

- [可观测性指南](OBSERVABILITY.md)
- [权限控制指南](PERMISSIONS.md)
- [智能体系统设计](AGENT_SYSTEM_DESIGN.md)
