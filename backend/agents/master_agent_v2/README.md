# MasterAgent V2

增强的主协调智能体，支持 DAG 调度和混合模式执行。

## 📦 目录结构

```
master_agent_v2/
├── __init__.py                      # 模块初始化
├── master_agent_v2.py               # 主协调智能体
├── enhanced_context.py              # 增强的上下文管理
├── execution_plan.py                # 执行计划抽象
├── failure_handler.py               # 失败处理器
├── hybrid_scheduler.py              # 混合调度器
├── test_master_agent_v2.py          # 单元测试
├── MASTER_AGENT_V2_GUIDE.md         # 详细使用指南
├── MASTER_AGENT_V2_README.md        # 架构说明
├── TEST_GUIDE.md                    # 测试指南
└── README.md                        # 本文件
```

## 🚀 快速开始

### 1. 导入模块

```python
from agents.master_agent_v2 import MasterAgentV2, EnhancedAgentContext
```

### 2. 创建实例

```python
# 初始化
master_v2 = MasterAgentV2(
    llm_adapter=llm_adapter,
    orchestrator=orchestrator
)
```

### 3. 执行任务

```python
# 同步执行
response = master_v2.execute(task, context)

# 异步流式执行
async for event in master_v2.execute_stream(task, context):
    print(event)

# 同步流式执行（兼容 Flask）
for event in master_v2.stream_execute(task, context):
    yield event
```

## 📚 核心特性

### 三种执行模式

1. **DirectAnswer**: 简单对话，直接回答
2. **StaticPlan**: 复杂任务，预定义 DAG
3. **HybridPlan**: 超复杂任务，宏观静态 + 微观动态

### 增强功能

- ✅ 自动任务分析和模式选择
- ✅ 智能依赖管理和数据传递
- ✅ 并行执行支持
- ✅ 多种失败恢复策略
- ✅ 流式事件反馈
- ✅ 执行统计和监控

## 🔧 集成到项目

### 修改 agent_loader.py

```python
# 在 agent_loader.py 中导入
from .master_agent_v2 import MasterAgentV2

# 注册到类型表
AGENT_TYPES = {
    'master': MasterAgent,
    'master_v2': MasterAgentV2,  # 添加 V2
    ...
}
```

### 启用 V2

```python
# 加载智能体时启用 V2
agents = load_agents_from_config(
    llm_adapter=llm_adapter,
    system_config=system_config,
    orchestrator=orchestrator,
    use_v2=True  # 启用 V2
)
```

## 🧪 运行测试

### 单元测试

```bash
cd backend/agents/master_agent_v2
python test_master_agent_v2.py
```

### 集成测试

```bash
cd backend
python test_master_agent_v2_integration.py
```

## 📖 文档

- **MASTER_AGENT_V2_GUIDE.md** - 详细使用指南和最佳实践
- **MASTER_AGENT_V2_README.md** - 架构说明和 API 参考
- **TEST_GUIDE.md** - 测试使用指南

## 🐛 调试

### 启用详细日志

```python
import logging
logging.basicConfig(level=logging.DEBUG)
```

### 查看执行统计

```python
response = master_v2.execute(task, context)
stats = response.data['stats']
print(f"LLM 调用: {stats['total_llm_calls']}")
print(f"工具调用: {stats['total_tool_calls']}")
```

### 流式监控

```python
async for event in master_v2.execute_stream(task, context):
    if event['type'] == 'error':
        print(f"错误: {event['content']}")
    elif event['type'] == 'subtask_start':
        print(f"开始任务: {event['description']}")
```

## 🔄 版本历史

- **v2.0.0** (2025-01-07)
  - 首次发布
  - 支持三种执行模式
  - 增强的上下文管理
  - 失败恢复机制
  - 流式执行支持

## 📝 注意事项

1. **依赖项**: 确保所有依赖的基础模块正确导入
2. **异步环境**: `execute_stream` 需要在异步环境中运行
3. **向后兼容**: `stream_execute` 提供同步接口兼容现有代码
4. **性能**: 异步版本性能更优，建议新代码使用

## 🤝 贡献

欢迎提交 Issue 和 PR！

## 📄 许可

MIT License
