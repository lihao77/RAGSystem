# ExecutionMode 简化重构方案

## 🎯 目标

将 Master Agent V2 的执行模式从 4 种简化为 2 种：
- **SIMPLE**: 单智能体直接回答
- **DAG**: 所有多智能体任务（统一用 DAG 执行器）

## 📊 现状问题

### 当前架构
```python
class ExecutionMode(Enum):
    SIMPLE = "simple"       # 单智能体
    SEQUENTIAL = "sequential"  # 顺序执行
    PARALLEL = "parallel"     # 并行执行
    DAG = "dag"             # 完整 DAG
```

### 问题分析

1. **执行逻辑冗余**
   - SEQUENTIAL、PARALLEL、DAG 都使用同一个 `DAGExecutor`
   - 执行算法完全相同（拓扑排序 + 并行执行）
   - 区分模式只是语义标签，无实际执行差异

2. **LLM 分析负担**
   - LLM 需要判断 4 种模式，增加错误率
   - 提示词复杂（113-142 行示例）
   - 边界模糊（"2个独立任务" 是 PARALLEL 还是 DAG？）

3. **代码维护成本**
   - 多处需要处理 4 种模式的判断
   - 未来添加新模式需要修改多个文件

4. **用户体验无收益**
   - 用户不理解 SEQUENTIAL vs PARALLEL vs DAG
   - 前端只需要**显示图**，不需要告诉用户"这是 PARALLEL 模式"

## ✅ 重构方案

### 1. 简化 ExecutionMode

**修改文件**: `backend/agents/master_agent_v2/execution_plan.py`

```python
class ExecutionMode(Enum):
    """执行模式"""
    SIMPLE = "simple"  # 单智能体直接回答
    DAG = "dag"        # 多智能体 DAG 执行（自动检测并行能力）
```

### 2. 简化任务分析提示词

**修改文件**: `backend/agents/master_agent_v2/master_agent_v2.py`

```python
TASK_ANALYSIS_PROMPT = """你是一个任务规划专家。分析用户的任务，判断是单任务还是多任务。

可用智能体：
{agents_info}

请分析以下任务：
"{task}"

你需要判断：
1. 是单智能体任务（simple）还是多智能体任务（dag）
   - simple: 单个智能体可以直接完成
   - dag: 需要多个智能体协作（系统会自动分析依赖关系）

2. 子任务分解（仅在 dag 模式）
   - 每个子任务必须指定使用的智能体
   - 明确标注依赖关系（depends_on 使用任务 ID）

请以 JSON 格式返回：
{{
  "mode": "simple|dag",
  "reasoning": "你的分析理由",
  "subtasks": [
    {{
      "id": "task_1",
      "order": 1,
      "description": "子任务描述",
      "agent_name": "智能体名称",
      "depends_on": []  // 依赖的任务 ID 列表
    }}
  ]
}}

**重要规则：**
- simple 模式：subtasks 只有 1 个元素
- dag 模式：subtasks 有多个元素，系统会自动识别可并行任务
- 如果是问候/闲聊，agent_name 设为 "master_agent_v2"

**示例1：单任务**
输入: "查询南宁2023年洪涝灾害数据"
输出:
{{
  "mode": "simple",
  "reasoning": "单一查询任务，qa_agent 可以直接完成",
  "subtasks": [
    {{
      "id": "task_1",
      "order": 1,
      "description": "查询南宁2023年洪涝灾害数据",
      "agent_name": "qa_agent",
      "depends_on": []
    }}
  ]
}}

**示例2：多任务（自动并行）**
输入: "查询广西2023年和2024年的台风数据，并对比分析"
输出:
{{
  "mode": "dag",
  "reasoning": "需要查询两年数据，然后对比，系统会自动并行执行查询",
  "subtasks": [
    {{
      "id": "task_1",
      "order": 1,
      "description": "查询广西2023年台风数据",
      "agent_name": "qa_agent",
      "depends_on": []
    }},
    {{
      "id": "task_2",
      "order": 2,
      "description": "查询广西2024年台风数据",
      "agent_name": "qa_agent",
      "depends_on": []
    }},
    {{
      "id": "task_3",
      "order": 3,
      "description": "对比分析2023和2024年台风数据",
      "agent_name": "qa_agent",
      "depends_on": ["task_1", "task_2"]
    }}
  ]
}}

只返回 JSON，不要有其他内容。
"""
```

### 3. 简化执行逻辑

**修改文件**: `backend/agents/master_agent_v2/master_agent_v2.py`

**之前** (第 251-260 行):
```python
if plan.mode == ExecutionMode.SIMPLE:
    # 单智能体，直接返回结果
    if plan.subtasks and plan.subtasks[0].result:
        task_result = enhanced_ctx.get_task_result(plan.subtasks[0].id)
        final_content = task_result.content if task_result else "执行完成"
    else:
        final_content = "任务执行完成"
else:
    # 多智能体，整合结果
    final_content = self._synthesize_results(task, enhanced_ctx)
```

**之后** (保持不变，因为逻辑已经是二分的):
```python
# 无需修改，已经是 SIMPLE vs 其他
```

**之前** (第 364-377 行):
```python
if plan.mode != ExecutionMode.SIMPLE and len(plan.subtasks) > 1:
    # 整合结果
    for chunk in self._synthesize_results_stream(task, enhanced_ctx):
        yield {'type': 'chunk', 'content': chunk.get('content', '')}
else:
    # 单智能体
    if plan.subtasks and plan.subtasks[0].result:
        task_result = enhanced_ctx.get_task_result(plan.subtasks[0].id)
        if task_result:
            yield {'type': 'chunk', 'content': str(task_result.content)}
```

**之后** (保持不变):
```python
# 无需修改，已经是 SIMPLE vs 其他
```

### 4. 前端自动分析图特征

**修改文件**: `frontend-client/src/components/ExecutionPlanCard.vue`（已移除，无需修改）

前端如果需要显示图的特征，可以自己分析：

```javascript
// 分析 DAG 图的并行度
const graphStats = computed(() => {
  if (!props.plan.dag) return null;

  const layers = calculateLayers(props.plan.dag.nodes, props.plan.dag.edges);
  const maxParallel = Math.max(...layers.map(l => l.length));
  const hasParallel = maxParallel > 1;

  return {
    hasParallel,
    maxParallel,
    totalNodes: props.plan.dag.nodes.length,
    layerCount: layers.length
  };
});
```

显示示例：
```vue
<div class="graph-info">
  <span v-if="graphStats.hasParallel">
    最多 {{ graphStats.maxParallel }} 个任务并行
  </span>
  <span v-else>
    顺序执行 {{ graphStats.totalNodes }} 个任务
  </span>
</div>
```

## 📋 修改检查清单

### 后端修改

- [ ] `backend/agents/master_agent_v2/execution_plan.py`
  - [ ] 简化 `ExecutionMode` 枚举（第 23-28 行）

- [ ] `backend/agents/master_agent_v2/master_agent_v2.py`
  - [ ] 更新 `TASK_ANALYSIS_PROMPT`（第 38-147 行）
  - [ ] 验证执行逻辑（第 251-260、364-377 行）已经是二分，无需修改

- [ ] `backend/agents/master_agent_v2/dag_executor.py`
  - [ ] 无需修改（已经统一处理所有 DAG）

### 前端修改

- [ ] ~~`frontend-client/src/components/ExecutionPlanCard.vue`~~
  - **已移除**，无需修改

- [ ] `frontend-client/src/views/ChatViewV2.vue`
  - [ ] 验证兼容性（V1 兼容事件使用 `complexity` 字段）

### 测试

- [ ] 单任务测试（"查询南宁洪涝灾害"）
- [ ] 多任务顺序测试（"先查询A，再查询B，最后对比"）
- [ ] 多任务并行测试（"同时查询2023和2024年数据"）
- [ ] 问候/闲聊测试（"你好"）

## 🎯 预期收益

### 代码简化
- ExecutionMode 枚举：4 种 → 2 种（减少 50%）
- 提示词示例：3 个 → 2 个
- 判断逻辑：无需修改（已经是二分）

### LLM 效率
- 分析复杂度降低
- 错误率减少（边界更清晰）
- Token 消耗减少（提示词更短）

### 用户体验
- 用户无感知变化（图本身就说明了依赖关系）
- 前端可以自由展示图的特征（并行度、层数等）

### 可维护性
- 模式定义清晰：单任务 vs 多任务
- 代码逻辑统一：除了 SIMPLE，其他都走 DAG
- 未来扩展简单：只需在 DAG 执行器内优化

## ⚠️ 风险评估

### 兼容性风险：低
- 后端修改仅影响 `ExecutionMode` 枚举
- 前端已移除 `ExecutionPlanCard`，无依赖
- V1 兼容事件使用 `complexity` 字段，不受影响

### 测试覆盖：中
- 需要测试所有原有 SEQUENTIAL/PARALLEL/DAG 场景
- 验证 LLM 能正确分析任务

### 回滚成本：低
- 修改集中在少数文件
- 可以保留旧代码作为备份

## 📅 实施计划

### 第一阶段：后端重构（1-2小时）
1. 修改 `execution_plan.py`
2. 修改 `master_agent_v2.py` 提示词
3. 运行单元测试

### 第二阶段：集成测试（1小时）
1. 测试各种任务场景
2. 验证前端显示正常
3. 性能对比测试

### 第三阶段：监控观察（1-2天）
1. 观察 LLM 分析准确率
2. 收集用户反馈
3. 必要时微调提示词

## 🎓 总结

这次重构的核心理念：
1. **用户不需要知道执行模式的技术细节**
2. **图本身就是最好的说明**
3. **简化后端逻辑，降低维护成本**
4. **保持执行效率和用户体验不变**

从 4 种模式 → 2 种模式，是对架构的**去冗余优化**，而不是功能削减。
