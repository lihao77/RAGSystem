# MasterAgent V2 架构说明

## 项目结构

```
backend/agents/
├── master_agent_v2.py          # MasterAgent V2 主类
├── enhanced_context.py         # 增强的上下文管理
├── execution_plan.py           # 执行计划抽象
├── failure_handler.py          # 失败处理器
├── hybrid_scheduler.py         # 混合调度器
├── agent_loader.py             # 智能体加载器（已更新支持 V2）
├── test_master_agent_v2.py     # 测试用例
├── MASTER_AGENT_V2_GUIDE.md    # 详细使用指南
└── MASTER_AGENT_V2_README.md   # 本文件
```

## 核心组件

### 1. MasterAgentV2 (master_agent_v2.py)

主协调智能体，负责：
- 任务分析和模式选择
- 执行计划创建
- 调度器调用
- 流式事件转发

**三种执行模式**:
- `DirectAnswer`: 简单对话，直接 LLM 回答
- `StaticPlan`: 复杂任务，预定义 DAG
- `HybridPlan`: 超复杂任务，宏观静态 + 微观动态

### 2. EnhancedAgentContext (enhanced_context.py)

增强的上下文管理器，提供：
- 任务结果存储和摘要
- 阶段输出管理
- 依赖数据传递
- 执行统计

**关键方法**:
```python
# 存储任务结果（自动摘要）
context.store_task_result(task_id, data, auto_summarize=True)

# 获取依赖数据（自动使用摘要）
dep_data = context.get_dependency_data(depends_on=['task_1'])

# 记录统计
context.increment_llm_calls()
context.increment_tool_calls()
```

### 3. ExecutionPlan (execution_plan.py)

执行计划抽象，包含：
- `ExecutionMode`: 执行模式枚举
- `FallbackStrategy`: 失败降级策略
- `TaskNode`: 任务节点
- `Stage`: 执行阶段（混合模式）
- `DirectAnswerPlan`: 直接回答计划
- `StaticExecutionPlan`: 静态 DAG 计划
- `HybridExecutionPlan`: 混合模式计划

**示例**:
```python
# 创建静态计划
plan = StaticExecutionPlan(
    subtasks=[...],
    strategy="parallel"
)

# 验证计划
if plan.validate():
    print("计划有效")
```

### 4. FailureHandler (failure_handler.py)

失败处理器，支持多种恢复策略：
- `retry`: 重试（指数退避）
- `skip`: 跳过任务
- `use_cache`: 使用缓存
- `ask_llm`: 询问 LLM 替代方案
- `abort`: 中止流程

**示例**:
```python
handler = FailureHandler(orchestrator, master_agent)
response = handler.handle_failure(task_node, context, error)
```

### 5. HybridScheduler (hybrid_scheduler.py)

混合调度器，负责：
- 执行三种模式的计划
- 任务 DAG 调度（拓扑排序）
- 流式事件生成
- 失败恢复调用

**流程**:
```
execute_plan()
├── DirectAnswerPlan → _execute_direct_answer()
├── StaticExecutionPlan → _execute_static_plan()
│   ├── 拓扑排序
│   ├── 逐层执行
│   └── 失败处理
└── HybridExecutionPlan → _execute_hybrid_plan()
    ├── 逐阶段执行
    ├── Static Stage → _execute_stage_static()
    └── Dynamic Stage → _execute_stage_dynamic()
```

## 数据流图

```
用户任务
    ↓
MasterAgentV2.execute_stream()
    ↓
_analyze_task_v2() → LLM 分析 → 返回 JSON
    ↓
create_execution_plan() → 创建 ExecutionPlan
    ↓
HybridScheduler.execute_plan()
    ↓
┌─────────────┬─────────────┬─────────────┐
│ DirectAnswer│ StaticPlan  │ HybridPlan  │
│             │             │             │
│ LLM 直接    │ DAG 调度    │ 阶段执行    │
│ 回答        │ 并行/串行   │ 静态+动态   │
└─────────────┴─────────────┴─────────────┘
    ↓
流式事件 (AsyncGenerator)
    ↓
前端实时显示
```

## 执行流程示例

### 场景: "查询数据并分析"

```
1. 任务分析
   ├─ LLM: "这是一个复杂任务，需要 StaticPlan"
   └─ 输出: {"mode": "static_plan", "subtasks": [...]}

2. 创建执行计划
   ├─ task_1: 查询数据 (qa_agent)
   └─ task_2: 分析数据 (generic_agent, depends_on: [task_1])

3. 拓扑排序
   ├─ Layer 0: [task_1]
   └─ Layer 1: [task_2]

4. 执行 Layer 0
   ├─ 调用 qa_agent
   ├─ 获取结果并存储
   └─ 自动摘要（如果数据 > 500 tokens）

5. 执行 Layer 1
   ├─ 获取依赖数据 (task_1 的结果)
   ├─ 注入到任务描述
   ├─ 调用 generic_agent
   └─ 存储结果

6. 返回最终结果
   └─ 包含: content, plan_summary, stats
```

## 失败恢复示例

### 场景: task_2 执行失败

```
1. task_2 执行失败 (generic_agent 不可用)
   ↓
2. FailureHandler.handle_failure()
   ├─ 策略: ask_llm
   ├─ LLM 分析: "可以用 react_agent 替代"
   └─ 使用 react_agent 重新执行
   ↓
3. 执行成功
   └─ 标记为 recovered，继续执行后续任务
```

## 配置示例

### 启用 V2

```python
# app.py 或初始化文件
from agents.agent_loader import load_agents_from_config

agents = load_agents_from_config(
    llm_adapter=llm_adapter,
    system_config=system_config,
    orchestrator=orchestrator,
    use_v2=True  # 🚨 启用 V2
)
```

### 任务配置 (StaticPlan)

```json
{
  "mode": "static_plan",
  "execution_strategy": "parallel",
  "subtasks": [
    {
      "id": "task_1",
      "description": "查询数据",
      "agent": "qa_agent",
      "depends_on": [],
      "fallback_strategy": "retry"
    },
    {
      "id": "task_2",
      "description": "分析数据",
      "agent": "generic_agent",
      "depends_on": ["task_1"],
      "fallback_strategy": "ask_llm"
    }
  ]
}
```

### 任务配置 (HybridPlan)

```json
{
  "mode": "hybrid_plan",
  "stages": [
    {
      "stage_id": "stage_1",
      "name": "数据收集",
      "type": "static",
      "subtasks": [...]
    },
    {
      "stage_id": "stage_2",
      "name": "动态探索",
      "type": "dynamic",
      "max_rounds": 5,
      "available_agents": ["generic_agent", "react_agent"],
      "goal": "根据数据特征动态分析"
    }
  ]
}
```

## API 参考

### MasterAgentV2.execute_stream()

异步流式执行（推荐）

**参数**:
- `task` (str): 用户任务
- `context` (AgentContext): 上下文

**返回**:
- `AsyncGenerator[Dict[str, Any], None]`: 事件流

**事件类型**:
- `task_analysis_start`: 开始分析
- `task_analysis_complete`: 分析完成
- `execution_plan`: 执行计划
- `subtask_start`: 子任务开始
- `subtask_end`: 子任务结束
- `stage_start`: 阶段开始
- `stage_complete`: 阶段完成
- `chunk`: 内容块
- `error`: 错误
- `execution_complete`: 执行完成

### EnhancedAgentContext

**方法**:
```python
# 存储任务结果
store_task_result(task_id, data, success=True, auto_summarize=True)

# 获取依赖数据
get_dependency_data(depends_on, max_tokens=2000)

# 存储阶段输出
store_stage_output(stage_id, stage_name, output, tasks_completed)

# 记录统计
increment_llm_calls(tokens=0)
increment_tool_calls()

# 获取摘要
get_summary() -> Dict[str, Any]
```

## 测试

运行测试用例：

```bash
cd backend/agents
python test_master_agent_v2.py
```

测试内容：
- ✅ 直接回答模式
- ✅ 静态 DAG 计划
- ✅ 流式执行
- ✅ 增强上下文
- ✅ 执行计划验证
- ✅ 失败处理

## 性能对比

| 指标 | V1 | V2 |
|------|----|----|
| 任务分解准确度 | 中 | 高 |
| 并行执行 | ❌ | ✅ |
| 失败恢复 | ❌ | ✅ |
| Token 消耗 | 高 | 低（自动摘要） |
| 执行可见性 | 低 | 高（流式事件） |
| 复杂任务支持 | 有限 | 强大（HybridPlan） |

## 迁移建议

### 兼容性

- V1 和 V2 可以共存
- 通过 `use_v2` 参数切换
- API 保持兼容

### 迁移步骤

1. **测试 V2**:
   ```python
   agents_v2 = load_agents_from_config(..., use_v2=True)
   ```

2. **对比结果**:
   ```python
   # V1
   response_v1 = agents_v1['master_agent'].execute(task, context)

   # V2
   response_v2 = agents_v2['master_agent_v2'].execute(task, context)
   ```

3. **逐步切换**:
   - 先在测试环境使用 V2
   - 确认无问题后切换生产环境

## 未来计划

- [ ] 支持更多失败恢复策略
- [ ] 优化 LLM 调用（缓存、批处理）
- [ ] 支持自定义调度器
- [ ] 增加执行可视化界面
- [ ] 支持分布式执行

## 常见问题

**Q: V2 是否会替代 V1？**
A: 短期内共存，长期可能替代。V2 提供更强大的功能，但 V1 更轻量。

**Q: V2 的性能开销如何？**
A: 任务分析会多一次 LLM 调用（约 0.5-1 秒），但并行执行和失败恢复可以弥补。

**Q: 如何调试 V2？**
A: 使用流式执行查看详细事件，或检查 `response.data['stats']`。

## 贡献

欢迎提交 Issue 和 PR！

## 许可

MIT License

---

**文档版本**: 1.0
**最后更新**: 2025-01-07
**作者**: Claude Code
