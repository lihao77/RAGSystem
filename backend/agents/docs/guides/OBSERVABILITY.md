# 智能体系统可观测性指南

## 概述

RAGSystem 智能体系统提供完整的可观测性支持，包括结构化日志、性能指标收集和前端监控面板。

## 核心组件

### 1. 结构化日志系统

**位置**: `backend/agents/logging/`

**功能**:
- JSON 格式日志输出
- 上下文绑定（agent_name, session_id, trace_id）
- 性能指标记录（duration_ms, token_usage）
- 多级别日志（debug, info, warning, error）

**使用示例**:

```python
from agents.logging import get_logger

# 创建日志器并绑定上下文
logger = get_logger("qa_agent", session_id="abc-123", trace_id="xyz-789")

# 记录事件
logger.info("tool_call", tool_name="query_kg", duration_ms=1234, status="success")

# 计时操作
with logger.timed_operation("tool_call", tool_name="query_kg"):
    result = execute_tool(...)
```

**配置**:

```python
from agents.logging import configure_logging

# 配置全局日志系统
configure_logging(
    log_level="INFO",
    json_output=True,
    log_file="logs/agent.log"
)
```

### 2. 性能指标收集器

**位置**: `backend/agents/monitoring/`

**功能**:
- 自动订阅事件总线
- 收集智能体执行指标
- 工具调用统计
- 错误分布分析

**指标类型**:

1. **智能体指标** (AgentMetrics):
   - 总调用次数 (total_calls)
   - 成功率 (success_rate)
   - 平均耗时 (avg_duration_ms)
   - 平均 Token 消耗 (avg_tokens)
   - 工具使用统计 (tool_usage)
   - 错误分布 (error_distribution)

2. **工具指标** (ToolMetrics):
   - 调用次数
   - 成功/失败次数
   - 平均/最小/最大耗时

3. **系统指标** (SystemMetrics):
   - 总智能体数量
   - 总调用次数
   - 整体成功率
   - 平均耗时

**使用示例**:

```python
from agents.monitoring import MetricsCollector

# 初始化（在 orchestrator 初始化时自动完成）
metrics_collector = MetricsCollector()
metrics_collector.subscribe_to_events(event_bus)

# 获取指标
agent_metrics = metrics_collector.get_agent_metrics("qa_agent")
system_metrics = metrics_collector.get_all_metrics()

# 重置指标
metrics_collector.reset_metrics("qa_agent")  # 重置单个智能体
metrics_collector.reset_metrics()  # 重置所有
```

### 3. 性能指标 API

**端点**: `/api/agent/metrics`

**获取所有指标**:
```bash
GET /api/agent/metrics

Response:
{
  "success": true,
  "data": {
    "total_agents": 3,
    "total_calls": 156,
    "avg_duration_ms": 2340.5,
    "overall_success_rate": 0.94,
    "agents": {
      "qa_agent": {
        "total_calls": 89,
        "success_rate": 0.95,
        "avg_duration_ms": 2100.3,
        "tool_usage": {
          "query_knowledge_graph_with_nl": 45,
          "search_knowledge_graph": 30,
          "find_causal_chain": 14
        },
        "error_distribution": {
          "LLMError": 3,
          "ToolExecutionError": 2
        }
      }
    }
  }
}
```

**获取单个智能体指标**:
```bash
GET /api/agent/metrics?agent_name=qa_agent
```

**重置指标**:
```bash
POST /api/agent/metrics/reset
Content-Type: application/json

{
  "agent_name": "qa_agent"  // 可选
}
```

## 日志格式

### 标准日志格式

```json
{
  "timestamp": "2026-02-23T10:30:45.123Z",
  "level": "info",
  "event": "tool_call",
  "agent_name": "qa_agent",
  "session_id": "abc-123",
  "trace_id": "xyz-789",
  "tool_name": "query_knowledge_graph_with_nl",
  "duration_ms": 1234,
  "status": "success",
  "token_usage": 450
}
```

### 关键事件

1. **RUN_START**: 智能体开始执行
2. **RUN_END**: 智能体执行结束
3. **CALL_TOOL_START**: 工具调用开始
4. **CALL_TOOL_END**: 工具调用结束
5. **ERROR**: 错误发生

## 最佳实践

### 1. 日志记录

```python
# ✅ 好的做法：使用结构化日志
logger.info("tool_call_success",
    tool_name="query_kg",
    duration_ms=1234,
    result_count=10
)

# ❌ 避免：使用字符串拼接
logger.info(f"Tool {tool_name} succeeded in {duration_ms}ms")
```

### 2. 性能监控

```python
# ✅ 使用计时上下文管理器
with logger.timed_operation("complex_operation", operation_type="analysis"):
    result = perform_analysis()

# ✅ 手动记录性能指标
start_time = time.time()
result = execute_tool(...)
duration_ms = int((time.time() - start_time) * 1000)
logger.info("tool_completed", duration_ms=duration_ms)
```

### 3. 错误追踪

```python
# ✅ 记录完整错误上下文
try:
    result = execute_tool(...)
except Exception as e:
    logger.error("tool_execution_failed",
        tool_name=tool_name,
        error_type=type(e).__name__,
        error_message=str(e),
        exc_info=True
    )
```

## 故障排查

### 问题：日志未输出 JSON 格式

**解决方案**:
```python
# 确保已配置 JSON 输出
configure_logging(json_output=True)
```

### 问题：指标收集器未初始化

**解决方案**:
检查 orchestrator 初始化日志，确认看到：
```
✓ 性能指标收集器已初始化并订阅事件总线
```

如果未看到，检查：
1. `structlog` 是否已安装
2. 事件总线是否正常工作

### 问题：指标 API 返回 503

**原因**: 指标收集器未初始化

**解决方案**:
1. 重启后端服务
2. 检查日志中的初始化错误
3. 确认 `requirements.txt` 中包含 `structlog>=23.1.0`

## 依赖项

```txt
# requirements.txt
structlog>=23.1.0  # 结构化日志
```

安装依赖:
```bash
cd backend
pip install -r requirements.txt
```

## 相关文档

- [错误处理指南](ERROR_HANDLING.md)
- [权限控制指南](PERMISSIONS.md)
- [Agent 总览](../../README.md)
