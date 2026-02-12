# MasterAgent 使用指南

## 概述

MasterAgent 是系统的**统一入口智能体**，能够：
- ✅ **作为所有用户请求的唯一入口**
- ✅ **智能分析任务复杂度**
- ✅ **自动分解复杂任务**
- ✅ **协调多个智能体协作**
- ✅ **整合各智能体结果**

## 核心设计理念

**统一入口架构**：所有用户请求都通过 MasterAgent 作为唯一入口，由 MasterAgent 智能决定：
- 是否需要分解任务
- 需要调用哪些专业智能体
- 如何整合多个智能体的结果

这种设计确保了：
1. **用户体验统一**：无需关心背后的智能体分工
2. **系统易扩展**：新增智能体时用户无感知
3. **智能调度**：MasterAgent 自动选择最优执行方案

## 工作原理

### 任务处理流程

```
用户提交任务
    ↓
自动路由到 MasterAgent（统一入口）
    ↓
MasterAgent 分析任务
    ↓
判断复杂度
    ↓
├─ Simple（简单）
│   → 委托给单个智能体
│   → 返回结果
│
├─ Medium（中等）
│   → 委托给单个智能体
│   → 智能体通过工具调用处理
│
└─ Complex（复杂）
    → 分解为多个子任务
    → 按顺序协调多个智能体
    → 整合所有结果
    → 生成统一答案
```

### 复杂度判断标准

| 复杂度 | 特征 | 示例 | 处理方式 |
|--------|------|------|----------|
| **Simple** | 单一查询、单一操作 | "查询2023年数据" | 委托 qa_agent |
| **Medium** | 多步骤，但单智能体可完成 | "分析数据趋势" | 委托 qa_agent（用工具） |
| **Complex** | 需要多种操作类型 | "查询、分析、可视化、生成报告" | 分解+协调多智能体 |

## 使用方式

### 方式 1: 直接调用 MasterAgent

```python
from agents import MasterAgent, QAAgent, AgentOrchestrator, AgentContext
from model_adapter import get_default_adapter
from config import get_config

# 初始化
config = get_config()
adapter = get_default_adapter()

# 创建 Orchestrator 和智能体
orchestrator = AgentOrchestrator(model_adapter=adapter)
qa_agent = QAAgent(model_adapter=adapter, config=config)
orchestrator.register_agent(qa_agent)

# 创建 MasterAgent
master_agent = MasterAgent(
    model_adapter=adapter,
    orchestrator=orchestrator,
    config=config
)

# 执行任务
context = AgentContext(session_id="user_123")
response = master_agent.execute(
    task="查询2023年各市受灾人数并分析受灾最严重的地区",
    context=context
)

# 查看结果
print(f"复杂度: {response.metadata['complexity']}")
print(f"子任务数: {response.metadata.get('subtasks_count', 0)}")
print(f"答案: {response.content}")
```

### 方式 2: 通过 Orchestrator（推荐 - 自动统一入口）

```python
from agents import QAAgent, MasterAgent, get_orchestrator, AgentContext
from model_adapter import get_default_adapter
from config import get_config

# 初始化
config = get_config()
adapter = get_default_adapter()
orchestrator = get_orchestrator(model_adapter=adapter)

# 注册所有智能体
qa_agent = QAAgent(model_adapter=adapter, config=config)
master_agent = MasterAgent(
    model_adapter=adapter,
    orchestrator=orchestrator,
    config=config
)

orchestrator.register_agent(qa_agent)
orchestrator.register_agent(master_agent)

# 执行任务（自动路由到 MasterAgent）
# 系统现在统一使用 MasterAgent 作为入口，无需关键词匹配
response = orchestrator.execute(
    task="查询数据并生成完整的分析报告"
)

print(f"路由到: {response.agent_name}")  # 始终是 master_agent
```

### 方式 3: API 调用

```bash
# MasterAgent 已自动注册为系统统一入口

# 1. 查看可用智能体
curl http://localhost:5000/api/agent/agents

# 2. 执行任务（自动路由到 MasterAgent）
# 所有请求都会通过 MasterAgent 作为统一入口
curl -X POST http://localhost:5000/api/agent/execute \
  -H "Content-Type: application/json" \
  -d '{
    "task": "查询2023年各市受灾数据并分析趋势"
  }'

# 3. 如需直接指定智能体（用于测试或特殊场景）
curl -X POST http://localhost:5000/api/agent/execute \
  -H "Content-Type: application/json" \
  -d '{
    "task": "查询数据",
    "agent": "qa_agent"
  }'
```

## 响应结构

### 简单任务响应

```json
{
  "success": true,
  "content": "查询结果...",
  "agent_name": "master_agent",
  "metadata": {
    "complexity": "simple",
    "delegated_by": "master_agent"
  }
}
```

### 复杂任务响应

```json
{
  "success": true,
  "content": "整合后的完整答案...",
  "agent_name": "master_agent",
  "data": {
    "subtasks": [
      {
        "description": "查询2023年各市受灾数据",
        "agent": "qa_agent",
        "success": true,
        "content": "查询结果...",
        "execution_time": 2.5
      },
      {
        "description": "分析受灾最严重的地区",
        "agent": "qa_agent",
        "success": true,
        "content": "分析结果...",
        "execution_time": 1.8
      }
    ],
    "total_subtasks": 2
  },
  "metadata": {
    "complexity": "complex",
    "subtasks_count": 2,
    "reasoning": "任务需要多步骤操作..."
  },
  "execution_time": 5.3
}
```

## 示例场景

### 场景 1: 简单查询

**输入:**
```
"查询2023年南宁市的洪涝灾害情况"
```

**MasterAgent 处理:**
1. 分析：simple，单一查询
2. 委托给 qa_agent
3. 返回查询结果

### 场景 2: 复杂分析报告

**输入:**
```
"生成2023年广西水灾的完整分析报告，包括：
1. 各市受灾情况统计
2. 受灾最严重的三个地区
3. 灾害发生时间趋势分析
4. 经济损失总结"
```

**MasterAgent 处理:**
1. 分析：complex，需要多个步骤
2. 分解任务：
   - 子任务1: "查询2023年各市受灾情况" → qa_agent
   - 子任务2: "统计受灾最严重的三个地区" → qa_agent
   - 子任务3: "分析灾害时间趋势" → qa_agent
   - 子任务4: "汇总经济损失" → qa_agent
3. 按顺序执行子任务
4. 整合所有结果
5. 生成完整报告

### 场景 3: 数据+可视化

**输入:**
```
"查询2020-2023年各年受灾人数并生成趋势图表"
```

**MasterAgent 处理:**
1. 分析：complex，需要查询+可视化
2. 分解任务：
   - 子任务1: "查询2020-2023年受灾人数" → qa_agent
   - 子任务2: "生成趋势折线图" → chart_agent
3. 执行子任务（子任务2依赖子任务1的数据）
4. 整合结果

## 配置和调优

### 路由架构说明

系统采用**统一入口架构**：
- 所有用户请求自动路由到 MasterAgent
- MasterAgent 分析任务并决定执行策略
- 无需配置关键词或路由规则

降级机制：
- 如果 MasterAgent 未注册，系统会降级到直接路由模式
- 直接查找能处理任务的智能体

```python
# backend/agents/orchestrator.py 核心逻辑
def route_task(self, task, context=None, preferred_agent=None):
    # 1. 如果明确指定智能体（用于测试）
    if preferred_agent:
        return self.registry.get(preferred_agent)

    # 2. 统一入口：优先使用 MasterAgent
    master_agent = self.registry.get('master_agent')
    if master_agent:
        return master_agent

    # 3. 降级方案：直接查找能处理的智能体
    return self.registry.find_capable_agents(task, context)[0]
```

### 调整任务分析提示词

在 `master_agent.py` 中修改 `TASK_ANALYSIS_PROMPT`：

```python
TASK_ANALYSIS_PROMPT = """
你是一个任务规划专家...

**判断标准：**
- simple: 单一查询、单一操作
- medium: 需要多步骤，但可以由一个智能体完成
- complex: 需要不同类型的操作（查询+分析+可视化）

针对你的领域添加特定判断规则...
"""
```

### 调整结果整合策略

在 `master_agent.py` 中修改 `RESULT_SYNTHESIS_PROMPT`：

```python
RESULT_SYNTHESIS_PROMPT = """
你是一个结果整合专家...

针对你的领域添加特定整合规则：
1. 医疗领域：突出诊断结论和建议
2. 金融领域：强调数值和风险提示
3. 灾害领域：关注时间、地点、损失等关键信息
"""
```

## 测试

### 运行测试脚本

```bash
cd backend
python test_master_agent.py
```

测试包括：
1. 简单任务处理
2. 复杂任务分解和协调
3. Orchestrator 自动路由
4. 任务分析能力

### 单元测试

```python
def test_master_agent():
    # 创建 MasterAgent
    master = MasterAgent(adapter, orchestrator, config)

    # 测试简单任务
    response = master.execute("查询数据", context)
    assert response.metadata['complexity'] == 'simple'

    # 测试复杂任务
    response = master.execute("查询并分析数据", context)
    assert response.metadata['complexity'] == 'complex'
    assert len(response.data['subtasks']) > 1
```

## 最佳实践

### 1. 任务描述清晰

✅ **好的任务描述:**
```
"查询2023年各市受灾人数，分析受灾最严重的三个地区，并生成对比图表"
```

❌ **不好的任务描述:**
```
"分析一下去年的情况"  // 太模糊
```

### 2. 合理使用依赖

当子任务有依赖关系时，MasterAgent 会自动处理：

```python
subtasks = [
    {
        "order": 1,
        "description": "查询数据",
        "agent": "qa_agent",
        "depends_on": []
    },
    {
        "order": 2,
        "description": "分析数据",
        "agent": "analysis_agent",
        "depends_on": [1]  # 依赖任务1的结果
    }
]
```

### 3. 监控性能

复杂任务会增加执行时间，监控各子任务的耗时：

```python
for subtask in response.data['subtasks']:
    print(f"{subtask['description']}: {subtask['execution_time']}s")
```

## 扩展指南

### 添加新的智能体类型

当添加新智能体（如 AnalysisAgent、ReportAgent）时：

1. 注册到 Orchestrator
2. MasterAgent 会自动识别并使用
3. 更新任务分析提示词，让 LLM 知道新智能体的能力

### 实现领域特定的 MasterAgent

为特定领域继承 MasterAgent：

```python
class MedicalMasterAgent(MasterAgent):
    """医疗领域的主协调智能体"""

    TASK_ANALYSIS_PROMPT = """
    你是一个医疗任务规划专家...
    """

    def _analyze_task(self, task, context):
        # 添加医疗领域特定的分析逻辑
        pass
```

## 常见问题

**Q: MasterAgent 什么时候会自动触发？**

A: 所有通过 `orchestrator.execute()` 的请求都会自动路由到 MasterAgent，它是系统的统一入口。

**Q: 如何绕过 MasterAgent 直接调用其他智能体？**

A: 使用 `preferred_agent` 参数：
```python
orchestrator.execute(task, preferred_agent='qa_agent')
```
或通过 API：
```bash
POST /api/agent/execute
{"task": "...", "agent": "qa_agent"}
```

**Q: MasterAgent 的 LLM 调用成本如何？**

A: 会增加调用次数：
- 1次任务分析（判断复杂度）
- N次子任务执行（每个子任务的智能体各调用）
- 1次结果整合（复杂任务）

建议：
- 使用较便宜的模型（如 DeepSeek）进行分析和整合
- 在 config.yaml 中配置不同智能体使用不同的 LLM

**Q: 如何禁用 MasterAgent？**

A: 不注册 MasterAgent 即可，系统会自动降级到直接路由：
```python
# 只注册 qa_agent，不注册 master_agent
orchestrator.register_agent(qa_agent)
# 不调用：orchestrator.register_agent(master_agent)
```

**Q: 系统如何处理简单任务，会不会增加延迟？**

A: MasterAgent 会分析任务复杂度：
- Simple/Medium 任务：直接委托给单个智能体，额外延迟很小（一次 LLM 调用）
- Complex 任务：分解和协调，但这是必要的开销


## 总结

MasterAgent 作为统一入口让系统能够：
- ✅ **统一用户体验**：所有请求通过单一入口
- ✅ **智能任务分发**：自动分析并选择最优执行方案
- ✅ **无缝扩展**：新增智能体时用户无感知
- ✅ **自动协调**：无需用户手动编排多智能体协作
- ✅ **适应不同场景**：从简单查询到复杂分析报告

现在你的系统拥有了一个智能的统一入口，能够自动处理各种复杂度的任务！🎉
