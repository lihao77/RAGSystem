# MasterAgent V2 使用指南

## 概述

MasterAgent V2 是主协调智能体的增强版本，提供了更强大的任务分解、执行和恢复能力。

## 核心特性

### 1. 三种执行模式

| 模式 | 适用场景 | 特点 |
|------|---------|------|
| **DirectAnswer** | 简单对话、闲聊 | 直接 LLM 回答，无需调用其他智能体 |
| **StaticPlan** | 复杂任务 | 预定义 DAG，支持依赖关系和并行执行 |
| **HybridPlan** | 超复杂任务 | 宏观静态 + 微观动态，适合不确定性高的任务 |

### 2. 增强的上下文管理

- **任务结果缓存**: 自动存储和管理任务结果
- **智能摘要**: 大数据自动摘要，减少 token 消耗
- **依赖数据传递**: 自动注入依赖任务的结果
- **执行统计**: 记录 LLM 调用、工具调用等统计信息

### 3. 失败恢复机制

| 策略 | 说明 | 适用场景 |
|------|------|---------|
| **retry** | 重试任务（指数退避） | 临时性错误 |
| **skip** | 跳过任务 | 可选任务 |
| **use_cache** | 使用缓存结果 | 有历史数据 |
| **ask_llm** | 询问 LLM 替代方案 | 可降级的任务 |
| **abort** | 中止整个流程 | 关键任务失败 |

## 快速开始

### 1. 启用 V2

在初始化 `AgentLoader` 时设置 `use_v2=True`:

```python
from agents.agent_loader import load_agents_from_config

agents = load_agents_from_config(
    llm_adapter=llm_adapter,
    system_config=system_config,
    orchestrator=orchestrator,
    use_v2=True  # 启用 V2
)
```

### 2. 使用 V2

```python
# 获取 MasterAgent V2 实例
master_agent = agents.get('master_agent_v2')

# 同步执行
response = master_agent.execute(task="查询数据并分析", context=context)

# 异步流式执行（推荐）
async for event in master_agent.execute_stream(task="查询数据并分析", context=context):
    print(event)
```

## 执行模式详解

### 模式 1: DirectAnswer

**适用场景**:
- 简单对话: "你好", "今天天气怎么样"
- 通用问答: "介绍一下你自己"
- 无需调用工具的任务

**示例**:
```python
task = "你好"
response = master_agent.execute(task, context)
# LLM 分析后直接返回答案
```

**流程**:
1. 任务分析 → 判断为 `direct_answer` 模式
2. LLM 直接生成回答
3. 返回结果

---

### 模式 2: StaticPlan

**适用场景**:
- 多步骤任务: "查询数据 → 分析 → 生成报告"
- 依赖关系明确
- 可并行执行的子任务

**示例**:
```python
task = "查询南宁2023年洪涝灾害数据，并进行分析和可视化"

# LLM 分析后生成如下计划：
# task_1: 查询数据 (qa_agent)
# task_2: 分析数据 (generic_agent, depends_on: [task_1])
# task_3: 生成图表 (workflow_agent, depends_on: [task_2])
```

**流程**:
1. 任务分析 → 生成子任务 DAG
2. 拓扑排序 → 分层执行
3. 自动依赖数据注入
4. 失败自动恢复

**配置示例**:
```json
{
  "mode": "static_plan",
  "execution_strategy": "parallel",
  "subtasks": [
    {
      "id": "task_1",
      "description": "查询南宁2023年洪涝灾害数据",
      "agent": "qa_agent",
      "depends_on": [],
      "estimated_complexity": 3,
      "optional": false,
      "fallback_strategy": "retry"
    },
    {
      "id": "task_2",
      "description": "分析灾害数据的时空特征",
      "agent": "generic_agent",
      "depends_on": ["task_1"],
      "estimated_complexity": 4,
      "optional": false,
      "fallback_strategy": "ask_llm"
    },
    {
      "id": "task_3",
      "description": "生成灾害分布图表",
      "agent": "workflow_agent",
      "depends_on": ["task_2"],
      "estimated_complexity": 3,
      "optional": true,
      "fallback_strategy": "skip"
    }
  ]
}
```

---

### 模式 3: HybridPlan

**适用场景**:
- 超复杂任务，部分可预规划，部分需动态决策
- 不确定性高的探索性任务
- 需要反馈循环的任务

**示例**:
```python
task = "研究某个灾害事件，先查询基础数据，再根据结果动态决定下一步分析方向"

# LLM 生成混合计划：
# Stage 1 (static): 查询基础数据
# Stage 2 (dynamic): 根据数据特征动态决策分析方向
# Stage 3 (static): 生成最终报告
```

**流程**:
1. 任务分析 → 生成阶段 (Stages)
2. 逐阶段执行:
   - **Static Stage**: 预定义任务 DAG
   - **Dynamic Stage**: ReAct 循环，LLM 动态决策调用哪个智能体
3. 阶段间依赖管理
4. 失败恢复

**配置示例**:
```json
{
  "mode": "hybrid_plan",
  "stages": [
    {
      "stage_id": "stage_1",
      "name": "数据收集",
      "type": "static",
      "description": "收集基础数据",
      "depends_on": [],
      "subtasks": [
        {
          "id": "task_1_1",
          "description": "查询历史数据",
          "agent": "qa_agent",
          "depends_on": []
        }
      ]
    },
    {
      "stage_id": "stage_2",
      "name": "动态分析",
      "type": "dynamic",
      "description": "根据数据特征动态分析",
      "depends_on": ["stage_1"],
      "max_rounds": 5,
      "available_agents": ["generic_agent", "workflow_agent"],
      "goal": "深入分析灾害的时空特征和影响"
    },
    {
      "stage_id": "stage_3",
      "name": "报告生成",
      "type": "static",
      "description": "整合分析结果并生成报告",
      "depends_on": ["stage_2"],
      "subtasks": [
        {
          "id": "task_3_1",
          "description": "生成可视化报告",
          "agent": "workflow_agent",
          "depends_on": []
        }
      ]
    }
  ]
}
```

## 流式事件说明

V2 提供丰富的流式事件，实时反馈执行进度：

### 通用事件

| 事件类型 | 说明 | 字段 |
|---------|------|------|
| `task_analysis_start` | 开始分析任务 | `message` |
| `task_analysis_complete` | 分析完成 | `mode`, `reasoning` |
| `execution_plan` | 执行计划 | `plan_summary` |
| `execution_complete` | 执行完成 | `stats` |
| `error` | 错误 | `content` |

### StaticPlan 事件

| 事件类型 | 说明 | 字段 |
|---------|------|------|
| `layer_start` | 开始执行一层任务 | `layer`, `task_count`, `tasks` |
| `layer_complete` | 完成一层任务 | `layer` |
| `subtask_start` | 开始子任务 | `task_id`, `agent`, `description` |
| `subtask_end` | 完成子任务 | `task_id`, `success`, `result_summary` |
| `subtask_recovered` | 子任务恢复成功 | `task_id`, `strategy`, `content` |

### HybridPlan 事件

| 事件类型 | 说明 | 字段 |
|---------|------|------|
| `stage_start` | 开始阶段 | `stage_id`, `stage_name`, `stage_type` |
| `stage_complete` | 完成阶段 | `stage_id`, `stage_name`, `output_summary` |
| `dynamic_round_start` | 动态阶段轮次开始 | `round`, `max_rounds` |
| `dynamic_thought` | 动态阶段思考 | `round`, `thought` |
| `dynamic_action` | 动态阶段行动 | `round`, `agent`, `task` |
| `dynamic_complete` | 动态阶段完成 | `stage_output` |

## 失败恢复示例

### 示例 1: 重试策略

```python
# 任务配置
{
  "id": "task_1",
  "description": "查询数据",
  "agent": "qa_agent",
  "fallback_strategy": "retry"
}

# 执行流程：
# 1. 首次执行失败（网络错误）
# 2. 等待 2 秒后重试
# 3. 第二次执行成功
```

### 示例 2: 询问 LLM 替代方案

```python
# 任务配置
{
  "id": "task_2",
  "description": "生成图表",
  "agent": "chart_agent",
  "fallback_strategy": "ask_llm"
}

# 执行流程：
# 1. chart_agent 执行失败（不可用）
# 2. 询问 LLM 是否有替代方案
# 3. LLM 建议使用 workflow_agent 完成
# 4. 使用 workflow_agent 重新执行，成功
```

### 示例 3: 跳过可选任务

```python
# 任务配置
{
  "id": "task_3",
  "description": "发送通知",
  "agent": "notification_agent",
  "optional": true,
  "fallback_strategy": "skip"
}

# 执行流程：
# 1. notification_agent 执行失败
# 2. 因为是可选任务，直接跳过
# 3. 继续执行后续任务
```

## 性能优化

### 1. 并行执行

StaticPlan 支持并行执行无依赖的任务：

```json
{
  "execution_strategy": "parallel",
  "subtasks": [
    {"id": "task_1", "agent": "agent1", "depends_on": []},
    {"id": "task_2", "agent": "agent2", "depends_on": []},
    {"id": "task_3", "agent": "agent3", "depends_on": ["task_1", "task_2"]}
  ]
}
```

执行顺序：
- Layer 0: `task_1` 和 `task_2` 并行执行
- Layer 1: `task_3` 等待依赖完成后执行

### 2. 智能摘要

大数据自动摘要，减少 token 消耗：

```python
# 自动触发摘要（数据 > 500 tokens）
context.store_task_result(
    task_id="task_1",
    data=large_data,
    auto_summarize=True  # 自动摘要
)

# 获取依赖数据（自动使用摘要）
dep_data = context.get_dependency_data(
    depends_on=["task_1"],
    max_tokens=2000  # 超过阈值自动使用摘要
)
```

### 3. 结果缓存

启用缓存避免重复计算：

```python
# 任务配置
{
  "fallback_strategy": "use_cache"
}

# 如果任务失败，自动查找缓存结果
```

## 监控和调试

### 1. 查看执行统计

```python
response = master_agent.execute(task, context)

stats = response.data['stats']
print(f"LLM 调用次数: {stats['total_llm_calls']}")
print(f"工具调用次数: {stats['total_tool_calls']}")
print(f"总 tokens: {stats['total_tokens']}")
print(f"失败任务: {stats['failed_tasks']}")
print(f"跳过任务: {stats['skipped_tasks']}")
```

### 2. 查看执行路径

```python
execution_path = stats['execution_path']
for step in execution_path:
    print(f"{step['timestamp']}: {step['type']} - {step}")
```

### 3. 流式监控

```python
async for event in master_agent.execute_stream(task, context):
    event_type = event['type']

    if event_type == 'subtask_start':
        print(f"开始任务: {event['description']}")
    elif event_type == 'subtask_end':
        print(f"完成任务: {event.get('result_summary', '')[:100]}")
    elif event_type == 'error':
        print(f"错误: {event['content']}")
```

## 与 V1 的对比

| 特性 | V1 | V2 |
|------|----|----|
| 执行模式 | 简单分解 + 顺序执行 | 三种模式（DirectAnswer, StaticPlan, HybridPlan） |
| 依赖管理 | 手动传递 | 自动注入依赖数据 |
| 并行执行 | ❌ | ✅ |
| 失败恢复 | ❌ | ✅ 多种策略 |
| 上下文管理 | 基础 | 增强（缓存、摘要、统计） |
| 流式执行 | 有限支持 | 完整支持 |
| 动态执行 | ❌ | ✅ HybridPlan 动态阶段 |

## 迁移指南

### 从 V1 迁移到 V2

1. **修改初始化代码**:

```python
# V1
agents = load_agents_from_config(
    llm_adapter, system_config, orchestrator
)

# V2
agents = load_agents_from_config(
    llm_adapter, system_config, orchestrator,
    use_v2=True  # 启用 V2
)
```

2. **更新上下文（可选）**:

```python
# V1
context = AgentContext(session_id="test")

# V2（推荐使用增强上下文）
context = EnhancedAgentContext(
    session_id="test",
    llm_adapter=llm_adapter
)
```

3. **使用流式执行（推荐）**:

```python
# V2 流式执行
async for event in master_agent.execute_stream(task, context):
    # 处理事件
    pass
```

## 常见问题

### Q1: 什么时候用 V2？

**A**: 如果你的任务符合以下特征之一，推荐使用 V2：
- 需要复杂的任务分解和依赖管理
- 需要并行执行提高效率
- 需要失败恢复机制
- 需要详细的执行监控

### Q2: V2 的性能如何？

**A**: V2 在以下方面优于 V1：
- **并行执行**: 无依赖任务可并行，减少总执行时间
- **智能摘要**: 自动摘要大数据，减少 token 消耗
- **失败恢复**: 避免整个流程失败，提高成功率

### Q3: V1 和 V2 可以共存吗？

**A**: 可以。通过 `use_v2` 参数控制：
```python
# 使用 V1
agents_v1 = load_agents_from_config(..., use_v2=False)

# 使用 V2
agents_v2 = load_agents_from_config(..., use_v2=True)
```

### Q4: 如何调试执行计划？

**A**: 使用流式执行查看详细事件：
```python
async for event in master_agent.execute_stream(task, context):
    print(json.dumps(event, indent=2, ensure_ascii=False))
```

## 最佳实践

### 1. 任务描述要清晰

❌ 不推荐:
```python
task = "处理数据"
```

✅ 推荐:
```python
task = "查询南宁2023年洪涝灾害数据，分析时空分布特征，并生成可视化报告"
```

### 2. 合理设置失败策略

- 关键任务: `fallback_strategy="abort"`
- 可选任务: `fallback_strategy="skip"`
- 临时性错误: `fallback_strategy="retry"`
- 可降级任务: `fallback_strategy="ask_llm"`

### 3. 利用并行执行

将无依赖的任务标记为并行：
```json
{
  "execution_strategy": "parallel"
}
```

### 4. 监控执行统计

定期检查 `stats` 了解系统性能：
```python
stats = response.data['stats']
if stats['failed_tasks']:
    logger.warning(f"有 {len(stats['failed_tasks'])} 个任务失败")
```

## 总结

MasterAgent V2 是一个强大的任务协调引擎，提供了：
- ✅ 三种执行模式，自动选择最优策略
- ✅ DAG 调度，支持依赖和并行
- ✅ 失败恢复，提高鲁棒性
- ✅ 增强上下文，智能管理数据
- ✅ 流式执行，实时反馈进度

适合复杂的多智能体协作场景。
