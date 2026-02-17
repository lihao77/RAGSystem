# 统一入口架构说明

## 架构概述

系统采用 **MasterAgent 统一入口架构**，所有用户请求都通过 MasterAgent 作为唯一入口点。

## 设计理念

### 为什么选择统一入口？

1. **用户体验一致**
   - 用户无需了解背后的智能体分工
   - 无论简单还是复杂任务，使用方式相同
   - 降低使用门槛

2. **系统易于扩展**
   - 新增智能体时用户无感知
   - 不需要修改路由规则或关键词
   - MasterAgent 自动发现并使用新智能体

3. **智能调度**
   - 由 MasterAgent 统一分析任务
   - 自动选择最优执行方案
   - 避免路由规则冲突

4. **可维护性强**
   - 单一入口点便于监控和日志
   - 路由逻辑集中在 MasterAgent
   - 易于调试和优化

## 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                         用户请求                              │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    AgentOrchestrator                         │
│                    (路由层 - 统一入口)                        │
└─────────────────────────────────────────────────────────────┘
                              ↓
                     优先路由到 MasterAgent
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                      MasterAgent                             │
│                   (主协调智能体 - 入口点)                     │
│                                                              │
│  1. 分析任务复杂度                                            │
│  2. 决定执行策略：                                            │
│     - Simple: 委托单个智能体                                  │
│     - Complex: 分解并协调多个智能体                           │
└─────────────────────────────────────────────────────────────┘
                              ↓
                    根据分析结果分发任务
                              ↓
        ┌─────────────┬───────────────┬─────────────┐
        ↓             ↓               ↓             ↓
   ┌────────┐   ┌────────┐      ┌────────┐    ┌────────┐
   │ReActAgent │   │ChartAgt│  ... │Analysis│    │Report  │
   │        │   │        │      │Agent   │    │Agent   │
   └────────┘   └────────┘      └────────┘    └────────┘
        ↓             ↓               ↓             ↓
   使用工具      生成图表          分析数据        生成报告
        ↓             ↓               ↓             ↓
   Neo4j/        Charts/          Tools/         LLM
   ChromaDB      Plotly           Pandas
                              ↓
┌─────────────────────────────────────────────────────────────┐
│              MasterAgent 整合结果                             │
│              (对于复杂任务)                                    │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                        返回用户                               │
└─────────────────────────────────────────────────────────────┘
```

## 路由逻辑

### AgentOrchestrator.route_task()

```python
def route_task(self, task, context=None, preferred_agent=None):
    """
    任务路由 - 统一入口策略

    优先级：
    1. preferred_agent（如果明确指定） - 用于测试或特殊场景
    2. MasterAgent（统一入口） - 默认路由
    3. 降级方案（如果 MasterAgent 未注册） - 直接查找能处理的智能体
    """

    # 1. 如果明确指定智能体（用于测试）
    if preferred_agent:
        agent = self.registry.get(preferred_agent)
        if agent and agent.can_handle(task, context):
            return agent

    # 2. 统一入口：优先使用 MasterAgent
    master_agent = self.registry.get('master_agent')
    if master_agent:
        return master_agent

    # 3. 降级方案：如果没有 MasterAgent
    capable_agents = self.registry.find_capable_agents(task, context)
    if capable_agents:
        return capable_agents[0]

    return None
```

### MasterAgent.can_handle()

```python
def can_handle(self, task, context=None):
    """
    MasterAgent 作为统一入口，处理所有任务
    """
    return True  # 接受所有任务
```

### MasterAgent.execute()

```python
def execute(self, task, context):
    """
    执行流程：
    1. 分析任务复杂度 (_analyze_task)
    2. 根据复杂度选择执行策略：
       - Simple/Medium: 委托给单个智能体 (_delegate_to_single_agent)
       - Complex: 分解并协调多个智能体 (_coordinate_multiple_agents)
    3. 返回结果（复杂任务会整合多个智能体的结果）
    """
    analysis = self._analyze_task(task, context)

    if analysis['complexity'] in ['simple', 'medium']:
        return self._delegate_to_single_agent(task, context, analysis)
    else:
        return self._coordinate_multiple_agents(task, context, analysis)
```

## 任务执行流程

### 简单任务示例

**用户请求**：`"查询2023年南宁市的洪涝灾害情况"`

```
1. Orchestrator.execute(task)
   ↓
2. route_task() → 返回 MasterAgent
   ↓
3. MasterAgent.execute(task)
   ↓
4. _analyze_task() → complexity='simple'
   ↓
5. _delegate_to_single_agent() → 委托给 ReActAgent
   ↓
6. ReActAgent.execute() → 查询知识图谱
   ↓
7. 返回结果给用户
```

### 复杂任务示例

**用户请求**：`"查询2023年各市受灾人数，分析最严重的三个地区，并生成对比图表"`

```
1. Orchestrator.execute(task)
   ↓
2. route_task() → 返回 MasterAgent
   ↓
3. MasterAgent.execute(task)
   ↓
4. _analyze_task() → complexity='complex'
   ↓
5. _coordinate_multiple_agents()
   ↓
6. 分解为子任务：
   子任务1: "查询2023年各市受灾人数" → ReActAgent
   子任务2: "分析最严重的三个地区" → ReActAgent (依赖子任务1)
   子任务3: "生成对比图表" → ChartAgent (依赖子任务2)
   ↓
7. 按顺序执行子任务
   ↓
8. _synthesize_results() → 整合所有结果
   ↓
9. 返回统一答案给用户
```

## 降级机制

如果 MasterAgent 未注册（例如在测试环境或简化部署），系统会自动降级：

```python
# 降级逻辑在 Orchestrator.route_task() 中
if master_agent is None:
    # 直接查找能处理任务的智能体
    capable_agents = self.registry.find_capable_agents(task, context)
    return capable_agents[0] if capable_agents else None
```

## 特殊场景：直接指定智能体

在某些场景下可能需要绕过 MasterAgent：

### 1. 测试场景
```python
# 直接测试 ReActAgent
response = orchestrator.execute(
    task="测试查询",
    preferred_agent='qa_agent'
)
```

### 2. API 调用
```bash
# 通过 API 指定智能体
curl -X POST http://localhost:5000/api/agent/execute \
  -d '{"task": "...", "agent": "qa_agent"}'
```

### 3. 性能优化
```python
# 已知简单任务，跳过分析阶段
response = orchestrator.execute(
    task="简单查询",
    preferred_agent='qa_agent'
)
```

## 配置和初始化

### 1. 系统启动时

```python
# backend/routes/agent.py
def _get_orchestrator():
    # 创建 Orchestrator
    orchestrator = get_orchestrator(model_adapter=adapter)

    # 注册专业智能体
    qa_agent = ReActAgent(model_adapter=adapter, config=config)
    orchestrator.register_agent(qa_agent)

    # 注册 MasterAgent（必须在最后注册）
    master_agent = MasterAgent(
        model_adapter=adapter,
        orchestrator=orchestrator,  # 传入 orchestrator 引用
        config=config
    )
    orchestrator.register_agent(master_agent)

    return orchestrator
```

### 2. 注册顺序重要性

- **先注册专业智能体**（ReActAgent, ChartAgent 等）
- **后注册 MasterAgent**（需要访问其他智能体）

原因：MasterAgent 需要通过 `orchestrator.list_agents()` 发现其他智能体。

## 监控和调试

### 查看路由决策

```python
import logging
logging.basicConfig(level=logging.INFO)

# 执行任务时会输出路由日志：
# INFO - AgentOrchestrator - 使用 MasterAgent 作为统一入口
# INFO - MasterAgent - [MasterAgent] 开始分析任务: ...
# INFO - MasterAgent - [MasterAgent] 任务复杂度: simple, 需要多智能体: False
# INFO - MasterAgent - [MasterAgent] 任务较简单，委托给单个智能体
```

### 查看性能指标

```python
response = orchestrator.execute(task)

print(f"总执行时间: {response.execution_time}s")
print(f"路由到智能体: {response.agent_name}")
print(f"任务复杂度: {response.metadata.get('complexity')}")

if 'subtasks' in response.data:
    for subtask in response.data['subtasks']:
        print(f"子任务: {subtask['description']}")
        print(f"  智能体: {subtask['agent']}")
        print(f"  耗时: {subtask['execution_time']}s")
```

## 扩展新智能体

添加新智能体非常简单，无需修改路由逻辑：

```python
# 1. 创建新智能体
class ReportAgent(BaseAgent):
    def __init__(self, model_adapter, config):
        super().__init__(
            name='report_agent',
            description='生成分析报告的智能体',
            capabilities=['report_generation', 'data_summary']
        )
        self.model_adapter = model_adapter
        self.config = config

    def execute(self, task, context):
        # 实现报告生成逻辑
        pass

# 2. 在系统启动时注册
orchestrator = _get_orchestrator()
report_agent = ReportAgent(model_adapter=adapter, config=config)
orchestrator.register_agent(report_agent)  # 在 master_agent 之前注册

# 3. MasterAgent 会自动发现并使用新智能体
# 无需修改任何路由代码！
```

## 优势总结

| 特性 | 传统多入口架构 | 统一入口架构 (MasterAgent) |
|------|---------------|--------------------------|
| **用户体验** | 需要选择合适的入口 | 统一入口，自动分发 |
| **路由逻辑** | 分散在各处，难维护 | 集中在 MasterAgent |
| **扩展性** | 需要修改路由规则 | 自动发现新智能体 |
| **智能调度** | 基于关键词匹配 | LLM 智能分析 |
| **多智能体协作** | 需要手动编排 | 自动分解和协调 |
| **可维护性** | 路由规则容易冲突 | 单一入口，易调试 |
| **监控** | 多个入口难以统一监控 | 单一入口便于监控 |

## 迁移指南

如果从旧架构迁移到统一入口架构：

### 1. 旧代码（关键词路由）

```python
# ❌ 旧方式：通过关键词匹配
routing_rules = {
    'qa': {'keywords': ['查询', '什么', ...], ...},
    'chart': {'keywords': ['图表', '可视化', ...], ...}
}
```

### 2. 新代码（统一入口）

```python
# ✅ 新方式：统一入口
orchestrator.execute(task)  # 自动路由到 MasterAgent
```

### 3. API 调用变化

```bash
# ❌ 旧方式：需要猜测使用哪个智能体
POST /api/agent/execute/qa_agent
POST /api/agent/execute/chart_agent

# ✅ 新方式：统一入口
POST /api/agent/execute  # 自动分析并选择
```

## 总结

统一入口架构通过 MasterAgent 提供了：
- ✅ **简单统一**的用户体验
- ✅ **智能自动**的任务分发
- ✅ **无缝透明**的扩展能力
- ✅ **集中可控**的监控管理

这是一个面向未来的、可扩展的智能体系统架构！🎉
