# 智能体系统设计方案

## 设计目标

构建一个灵活、可扩展的智能体系统，支持：
1. 单智能体执行（QA Agent、Chart Agent 等）
2. 多智能体协作（智能体间相互调用）
3. 统一的接口和生命周期管理
4. 工具系统集成
5. 上下文管理和记忆机制

## 架构设计

### 1. 核心组件

```
agents/
├── base.py                    # BaseAgent 基类
├── orchestrator.py           # AgentOrchestrator 智能体编排器
├── context.py                # AgentContext 上下文管理
├── registry.py               # AgentRegistry 智能体注册表
├── qa_agent.py               # QAAgent 问答智能体
├── chart_agent.py            # ChartAgent 图表智能体（重构）
├── visualization_agent.py    # VisualizationAgent 可视化智能体
└── __init__.py
```

### 2. BaseAgent 基类设计

所有智能体继承 `BaseAgent`，提供统一接口：

```python
class BaseAgent(ABC):
    """智能体基类"""

    # 智能体元信息
    name: str                    # 智能体名称
    description: str             # 智能体描述
    capabilities: List[str]      # 能力列表

    # 依赖
    model_adapter: ModelAdapter      # Model 适配器
    tools: List[Tool]            # 可用工具列表

    # 生命周期方法
    @abstractmethod
    async def execute(
        self,
        task: str,
        context: AgentContext
    ) -> AgentResponse:
        """执行任务"""
        pass

    def can_handle(self, task: str) -> bool:
        """判断是否能处理该任务"""
        pass

    def before_execute(self, context: AgentContext):
        """执行前钩子"""
        pass

    def after_execute(self, result: AgentResponse):
        """执行后钩子"""
        pass
```

### 3. 智能体类型设计

#### 3.1 QAAgent (问答智能体)
```python
class QAAgent(BaseAgent):
    """
    知识图谱问答智能体

    职责：
    - 理解用户问题
    - 调用知识图谱工具
    - 生成自然语言答案
    - 多轮对话管理

    工具：
    - query_knowledge_graph_with_nl
    - search_knowledge_graph
    - get_entity_relations
    - execute_cypher_query
    - analyze_temporal_pattern
    - find_causal_chain
    - compare_entities
    - aggregate_statistics
    """

    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        # 1. 理解问题
        # 2. 调用工具（Function Calling）
        # 3. 多轮对话
        # 4. 生成答案
        pass
```

#### 3.2 ChartAgent (图表智能体)
```python
class ChartAgent(BaseAgent):
    """
    图表生成智能体

    职责：
    - 分析数据结构
    - 选择合适的图表类型
    - 生成 ECharts 配置

    工具：
    - generate_chart (内置方法)
    """

    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        # 1. 从上下文获取数据
        # 2. 分析数据特征
        # 3. 生成图表配置
        pass
```

#### 3.3 VisualizationAgent (可视化智能体)
```python
class VisualizationAgent(BaseAgent):
    """
    知识图谱可视化智能体

    职责：
    - 查询图谱数据
    - 生成可视化布局
    - 返回可视化配置

    工具：
    - get_entity_relations
    - search_knowledge_graph
    """
```

### 4. AgentOrchestrator (编排器)

负责智能体的选择、调度和协作：

```python
class AgentOrchestrator:
    """
    智能体编排器

    功能：
    1. 智能体注册和发现
    2. 任务路由（选择最合适的智能体）
    3. 多智能体协作
    4. 上下文管理
    5. 结果聚合
    """

    def __init__(self):
        self.agents: Dict[str, BaseAgent] = {}
        self.registry = AgentRegistry()

    def register_agent(self, agent: BaseAgent):
        """注册智能体"""
        self.agents[agent.name] = agent
        self.registry.register(agent)

    def route_task(self, task: str, context: AgentContext) -> BaseAgent:
        """
        任务路由 - 选择最合适的智能体

        策略：
        1. 关键词匹配
        2. LLM 智能分类
        3. 置信度评分
        """
        pass

    async def execute(
        self,
        task: str,
        context: AgentContext = None
    ) -> AgentResponse:
        """
        执行任务

        流程：
        1. 选择智能体
        2. 执行任务
        3. 处理结果
        4. 多智能体协作（如需要）
        """
        pass

    async def collaborate(
        self,
        agents: List[BaseAgent],
        task: str,
        context: AgentContext
    ) -> AgentResponse:
        """多智能体协作"""
        pass
```

### 5. AgentContext (上下文)

管理智能体执行上下文：

```python
class AgentContext:
    """
    智能体上下文

    包含：
    - 用户信息
    - 会话历史
    - 中间结果
    - 共享数据
    """

    session_id: str                          # 会话 ID
    user_id: Optional[str]                   # 用户 ID
    conversation_history: List[Message]      # 对话历史
    intermediate_results: Dict[str, Any]     # 中间结果
    shared_data: Dict[str, Any]              # 共享数据

    def add_message(self, role: str, content: str):
        """添加消息到历史"""
        pass

    def get_history(self, limit: int = 10) -> List[Message]:
        """获取历史消息"""
        pass

    def store_result(self, key: str, value: Any):
        """存储中间结果"""
        pass

    def get_result(self, key: str) -> Any:
        """获取中间结果"""
        pass
```

### 6. 使用示例

#### 单智能体调用
```python
# 初始化编排器
orchestrator = AgentOrchestrator()

# 注册智能体
orchestrator.register_agent(QAAgent())
orchestrator.register_agent(ChartAgent())

# 执行任务
context = AgentContext(session_id="session_123")
response = await orchestrator.execute(
    task="查询2023年南宁市的洪涝灾害情况",
    context=context
)
```

#### 多智能体协作
```python
# 场景：用户问"展示2023年各市的受灾人数对比"
# 需要 QAAgent 查询数据 + ChartAgent 生成图表

# 1. 编排器自动选择 QAAgent
qa_response = await qa_agent.execute(
    task="查询2023年各市的受灾人数",
    context=context
)

# 2. QAAgent 完成后，数据存入 context
context.store_result("query_data", qa_response.data)

# 3. 编排器判断需要生成图表，调用 ChartAgent
chart_response = await chart_agent.execute(
    task="生成受灾人数对比柱状图",
    context=context
)

# 4. 返回综合结果
final_response = AgentResponse(
    success=True,
    data={
        "answer": qa_response.content,
        "chart": chart_response.data
    }
)
```

### 7. 路由策略

编排器如何选择智能体：

#### 7.1 基于关键词的路由
```python
ROUTING_RULES = {
    "qa": {
        "keywords": ["查询", "什么", "为什么", "如何", "多少"],
        "agent": "QAAgent"
    },
    "chart": {
        "keywords": ["图表", "可视化", "展示", "对比", "趋势"],
        "agent": "ChartAgent"
    },
    "visualization": {
        "keywords": ["关系图", "知识图谱", "网络图"],
        "agent": "VisualizationAgent"
    }
}
```

#### 7.2 基于 LLM 的智能路由
```python
# 使用 LLM 分类用户意图
system_prompt = """
你是一个任务分类器，根据用户输入选择合适的智能体：
- QAAgent: 问答、查询、信息检索
- ChartAgent: 生成图表、数据可视化
- VisualizationAgent: 知识图谱可视化
"""

classification = model_adapter.classify(task, system_prompt)
selected_agent = classification['agent']
```

### 8. 多智能体协作模式

#### 8.1 串行协作
```
User Question
    ↓
QAAgent (查询数据)
    ↓
ChartAgent (生成图表)
    ↓
Final Response
```

#### 8.2 并行协作
```
User Question
    ├→ QAAgent (查询文本答案)
    └→ ChartAgent (生成图表)
    ↓
合并结果
    ↓
Final Response
```

#### 8.3 循环协作（未来支持）
```
User Question
    ↓
QAAgent
    ↓
判断是否需要更多信息
    ↓ Yes
ChartAgent 生成可视化
    ↓
QAAgent 基于可视化深度分析
    ↓
Final Response
```

## 实现计划

### Phase 1: 基础设施（1-2天）
- [ ] BaseAgent 基类
- [ ] AgentContext 上下文
- [ ] AgentResponse 响应模型
- [ ] AgentRegistry 注册表

### Phase 2: 核心智能体（2-3天）
- [ ] QAAgent (迁移现有 graphrag 逻辑)
- [ ] 重构 ChartAgent 继承 BaseAgent
- [ ] 测试单智能体功能

### Phase 3: 编排器（2-3天）
- [ ] AgentOrchestrator 基础实现
- [ ] 任务路由策略
- [ ] 多智能体串行协作

### Phase 4: 集成和优化（1-2天）
- [ ] 重构 API 路由使用新系统
- [ ] 前端适配
- [ ] 性能优化

### Phase 5: 高级功能（未来）
- [ ] 多智能体并行协作
- [ ] 智能体记忆系统
- [ ] 自主规划能力
- [ ] 工具动态注册

## 技术细节

### 异步支持
使用 `async/await` 支持异步执行：
```python
async def execute(self, task: str, context: AgentContext) -> AgentResponse:
    # 异步调用 LLM
    response = await self.model_adapter.chat_completion_async(...)
    return response
```

### 错误处理
统一的错误处理机制：
```python
try:
    result = await agent.execute(task, context)
except AgentExecutionError as e:
    logger.error(f"智能体执行失败: {e}")
    return ErrorResponse(message=str(e))
```

### 可观测性
记录智能体执行日志：
```python
class AgentLogger:
    def log_execution(self, agent: str, task: str, duration: float, result: AgentResponse):
        logger.info(f"[Agent={agent}] Task={task} Duration={duration}s Success={result.success}")
```

## 总结

这个设计方案具有以下优势：

1. **可扩展性** - 新增智能体只需继承 BaseAgent
2. **灵活性** - 支持单智能体和多智能体模式
3. **解耦** - 智能体之间通过编排器通信，互不依赖
4. **统一接口** - 所有智能体遵循相同的生命周期和接口
5. **渐进式迁移** - 可以逐步将现有功能迁移到新架构

下一步建议从 **Phase 1** 开始实现基础设施。
