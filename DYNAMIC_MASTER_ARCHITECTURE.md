# 动态 Master AI 架构设计

## 🎯 愿景

**Master AI 作为项目经理，动态管理和调度 Sub-Agents，根据执行结果实时调整策略。**

---

## 📊 架构对比

### 当前架构：静态 DAG
```
用户任务
  ↓
Master AI 分析 → 生成完整 DAG 计划
  ↓
DAG Executor 机械执行（Master 不参与）
  ↓
Master AI 整合结果
  ↓
返回答案
```

**问题**：
- ❌ Master 只在开始/结束时参与
- ❌ 无法根据中间结果调整策略
- ❌ Sub-agent 失败只能重试，不能换方案
- ❌ 无法动态增加子任务

### 目标架构：动态管理
```
用户任务
  ↓
┌─────────────────────────────────────┐
│         Master AI (项目经理)        │
│                                     │
│  while 未完成:                      │
│    1. 评估当前状态                  │
│    2. 决定下一步行动                │
│    3. 调度 Sub-Agent 执行           │
│    4. 评估执行结果                  │
│    5. 调整策略（如需要）            │
└─────────────────────────────────────┘
         ↓ 动态调度 ↓
   ┌─────┴─────┬─────┴─────┐
Sub-Agent1  Sub-Agent2  Sub-Agent3
   ↓           ↓           ↓
 结果 ────→ Master AI ←──── 结果
           (评估 & 决策)
              ↓
        继续/完成/调整
```

**优势**：
- ✅ Master 全程监控和决策
- ✅ 可以根据结果动态调整
- ✅ 失败可以换策略/换 agent
- ✅ 可以动态增加/减少任务
- ✅ 像人类 PM 一样管理

---

## 🏗️ 核心设计

### 1. Master AI 的职责

```python
class DynamicMasterAgent:
    """
    动态管理型 Master Agent

    职责：
    1. 任务分解（初始 + 动态）
    2. Sub-Agent 调度
    3. 结果评估
    4. 策略调整
    5. 最终整合
    """

    def execute_dynamic(self, task: str, context: AgentContext):
        # 初始化
        self.task_context = TaskContext(
            original_task=task,
            current_goal="分析任务需求",
            completed_steps=[],
            available_agents=self.get_available_agents(),
            accumulated_knowledge={}
        )

        # 动态执行循环
        max_iterations = 20  # 防止死循环
        for iteration in range(max_iterations):
            # 1. 决策下一步
            next_action = self.decide_next_action(self.task_context)

            if next_action.type == "COMPLETE":
                break

            # 2. 执行行动
            result = self.execute_action(next_action)

            # 3. 评估结果
            evaluation = self.evaluate_result(result)

            # 4. 更新上下文
            self.task_context.update(
                completed_steps=[...],
                accumulated_knowledge={...},
                current_goal=evaluation.next_goal
            )

            # 5. 流式输出进度
            yield {
                'type': 'master_decision',
                'iteration': iteration,
                'action': next_action.to_dict(),
                'result': result.to_dict(),
                'next_goal': evaluation.next_goal
            }

        # 最终整合
        final_answer = self.synthesize_final_answer(self.task_context)
        yield {'type': 'final_answer', 'content': final_answer}
```

### 2. 决策机制

Master AI 的核心是**决策循环**，每次决策时：

```python
def decide_next_action(self, context: TaskContext) -> Action:
    """
    动态决策下一步行动

    Args:
        context: 当前任务上下文

    Returns:
        Action: 下一步行动（调用 sub-agent、完成任务、调整策略等）
    """

    # 构建决策提示词
    prompt = f"""
    你是一个项目经理，正在协调多个专业智能体完成任务。

    原始任务：{context.original_task}
    当前目标：{context.current_goal}

    已完成步骤：
    {self._format_completed_steps(context.completed_steps)}

    积累的知识：
    {self._format_knowledge(context.accumulated_knowledge)}

    可用智能体：
    {self._format_available_agents(context.available_agents)}

    请决定下一步行动：

    1. 如果任务已经完成 → 返回 "COMPLETE"
    2. 如果需要调用 sub-agent → 指定 agent 和具体任务
    3. 如果需要调整策略 → 说明原因和新策略
    4. 如果信息不足 → 决定获取什么信息

    以 JSON 格式返回：
    {{
      "action_type": "CALL_AGENT|COMPLETE|ADJUST_STRATEGY|GATHER_INFO",
      "reasoning": "决策理由",
      "agent_name": "如果是 CALL_AGENT，指定 agent",
      "subtask": "具体子任务描述",
      "expected_output": "期望输出",
      "next_goal": "完成后的下一个目标"
    }}
    """

    # 调用 LLM 决策
    response = self.llm_adapter.chat_completion(
        messages=[
            {"role": "system", "content": "你是一个擅长动态规划和资源调度的项目经理。"},
            {"role": "user", "content": prompt}
        ],
        temperature=0.3  # 决策需要一定创造性，但不能太随机
    )

    # 解析决策
    decision = json.loads(response.content)
    return Action.from_dict(decision)
```

### 3. 结果评估

每次 Sub-Agent 执行后，Master 评估结果：

```python
def evaluate_result(self, action: Action, result: AgentResponse) -> Evaluation:
    """
    评估 Sub-Agent 的执行结果

    Args:
        action: 原始行动
        result: 执行结果

    Returns:
        Evaluation: 评估结果（是否满足预期、下一步建议等）
    """

    prompt = f"""
    你派遣了 {action.agent_name} 执行任务："{action.subtask}"
    期望输出：{action.expected_output}

    实际结果：
    - 成功：{result.success}
    - 内容：{result.content[:500]}...
    - 数据：{result.data}

    请评估：
    1. 结果是否满足预期？
    2. 是否需要重试（换个 agent 或调整任务描述）？
    3. 是否需要额外的子任务来补充信息？
    4. 下一步应该做什么？

    以 JSON 格式返回：
    {{
      "meets_expectation": true|false,
      "quality_score": 0-10,
      "needs_retry": true|false,
      "retry_suggestion": "如果需要重试，建议的策略",
      "needs_additional_subtask": true|false,
      "additional_subtask": "如果需要，描述额外的子任务",
      "next_goal": "下一步的目标",
      "reasoning": "评估理由"
    }}
    """

    response = self.llm_adapter.chat_completion(
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2  # 评估需要客观
    )

    return Evaluation.from_dict(json.loads(response.content))
```

### 4. 上下文管理

```python
@dataclass
class TaskContext:
    """任务上下文（动态更新）"""
    original_task: str                    # 原始任务
    current_goal: str                     # 当前目标
    completed_steps: List[Step]           # 已完成步骤
    available_agents: List[str]           # 可用智能体
    accumulated_knowledge: Dict[str, Any] # 积累的知识
    retry_count: Dict[str, int]           # 重试计数

    def update(self, **kwargs):
        """动态更新上下文"""
        for key, value in kwargs.items():
            setattr(self, key, value)

    def add_step(self, step: Step):
        """添加完成的步骤"""
        self.completed_steps.append(step)
        # 提取知识
        if step.result.data:
            self.accumulated_knowledge.update(step.result.data)

    def get_summary(self) -> str:
        """获取当前进度摘要"""
        return f"""
        原始任务：{self.original_task}
        当前目标：{self.current_goal}
        已完成步骤：{len(self.completed_steps)}
        积累知识：{len(self.accumulated_knowledge)} 项
        """

@dataclass
class Step:
    """执行步骤"""
    action: Action           # 行动
    result: AgentResponse    # 结果
    evaluation: Evaluation   # 评估
    timestamp: float         # 时间戳

@dataclass
class Action:
    """行动"""
    action_type: str         # CALL_AGENT, COMPLETE, ADJUST_STRATEGY, GATHER_INFO
    reasoning: str           # 决策理由
    agent_name: Optional[str]
    subtask: Optional[str]
    expected_output: Optional[str]
    next_goal: str

@dataclass
class Evaluation:
    """评估结果"""
    meets_expectation: bool
    quality_score: int       # 0-10
    needs_retry: bool
    retry_suggestion: Optional[str]
    needs_additional_subtask: bool
    additional_subtask: Optional[str]
    next_goal: str
    reasoning: str
```

---

## 🔄 执行流程示例

### 示例：复杂查询任务

**用户任务**："分析广西2023年自然灾害情况，生成可视化报告"

```
迭代 1:
  Master 决策: "先获取灾害数据"
  → 调用 qa_agent("查询广西2023年所有自然灾害事件")
  → 结果：找到洪涝、台风、干旱等灾害
  Master 评估: "数据充足，下一步统计分析"

迭代 2:
  Master 决策: "统计各类灾害的数量和影响"
  → 调用 qa_agent("统计各类灾害的频次和影响范围")
  → 结果：洪涝12次、台风5次、干旱3次
  Master 评估: "统计完成，但缺少时序信息"

迭代 3:
  Master 决策: "补充时序数据以便可视化"
  → 调用 qa_agent("查询每类灾害的时间分布")
  → 结果：获得月度分布数据
  Master 评估: "数据完整，可以生成图表"

迭代 4:
  Master 决策: "生成可视化图表"
  → 调用 chart_agent("生成灾害统计图表")
  → 结果：生成 ECharts 配置
  Master 评估: "图表生成成功，准备撰写报告"

迭代 5:
  Master 决策: "整合所有信息，生成报告"
  → 调用 master_agent（自己）("基于数据和图表生成分析报告")
  → 结果：完整报告
  Master 评估: "任务完成"
  → ACTION: COMPLETE
```

### 对比：静态 DAG 方式

```
一次性生成计划：
  Task 1: 查询灾害数据（qa_agent）
  Task 2: 统计分析（qa_agent）
  Task 3: 生成图表（chart_agent）
  Task 4: 整合报告（master_agent）

问题：
  ❌ 如果 Task 1 结果不理想，无法调整 Task 2
  ❌ 如果发现缺少时序数据，无法动态增加查询
  ❌ 如果图表生成失败，只能重试，不能换策略
```

---

## 💡 高级特性

### 1. 自适应重试

```python
def handle_failure(self, action: Action, result: AgentResponse):
    """智能处理失败"""

    # 分析失败原因
    failure_analysis = self.analyze_failure(action, result)

    if failure_analysis.reason == "wrong_agent":
        # 换一个 agent 重试
        alternative_agent = self.find_alternative_agent(action.subtask)
        return Action(
            action_type="CALL_AGENT",
            agent_name=alternative_agent,
            subtask=action.subtask,
            reasoning=f"原 agent 失败，尝试 {alternative_agent}"
        )

    elif failure_analysis.reason == "unclear_task":
        # 调整任务描述
        refined_subtask = self.refine_task_description(action.subtask, result.error)
        return Action(
            action_type="CALL_AGENT",
            agent_name=action.agent_name,
            subtask=refined_subtask,
            reasoning="任务描述不清晰，重新描述"
        )

    elif failure_analysis.reason == "missing_dependency":
        # 先完成依赖任务
        dependency_task = self.identify_dependency(action.subtask)
        return Action(
            action_type="CALL_AGENT",
            agent_name=dependency_task.agent,
            subtask=dependency_task.description,
            reasoning="需要先完成依赖任务"
        )
```

### 2. 并行优化

```python
def identify_parallelizable_actions(self, context: TaskContext) -> List[Action]:
    """
    识别可并行执行的行动

    动态管理不意味着放弃并行！
    Master 可以同时调度多个独立的 sub-agent
    """

    prompt = f"""
    当前目标：{context.current_goal}

    请判断：是否可以同时执行多个子任务来加速？

    如果可以，列出所有可并行的子任务。

    返回 JSON:
    {{
      "can_parallelize": true|false,
      "parallel_actions": [
        {{"agent": "...", "subtask": "..."}},
        ...
      ]
    }}
    """

    response = self.llm_adapter.chat_completion(...)
    decision = json.loads(response.content)

    if decision['can_parallelize']:
        # 并行调度
        return [Action.from_dict(a) for a in decision['parallel_actions']]
    else:
        # 单个任务
        return [self.decide_next_action(context)]
```

### 3. 知识积累

```python
class KnowledgeBase:
    """动态知识库"""

    def __init__(self):
        self.entities = {}      # 提取的实体
        self.facts = []         # 发现的事实
        self.relationships = [] # 关系
        self.statistics = {}    # 统计数据

    def extract_from_result(self, result: AgentResponse):
        """从结果中提取知识"""
        # 调用 NER 提取实体
        # 调用 RelationExtractor 提取关系
        # 存储到知识库

    def query(self, question: str):
        """查询知识库"""
        # 从已有知识中查找答案
        # 避免重复查询
```

---

## 📊 对比总结

| 维度 | 静态 DAG | 动态管理 |
|------|---------|---------|
| **计划方式** | 一次性规划 | 边执行边规划 |
| **Master 参与度** | 20%（开始+结束） | 100%（全程） |
| **适应能力** | 无 | 强（实时调整） |
| **失败恢复** | 简单重试 | 换策略/换 agent |
| **知识利用** | 无 | 持续积累和利用 |
| **并行能力** | 强（预设） | 中（动态识别） |
| **LLM 调用** | 少（2-3次） | 多（每迭代1-2次） |
| **执行效率** | 高 | 中 |
| **灵活性** | 低 | 高 |
| **成本** | 低 | 中 |
| **复杂任务** | 一般 | 强 |

---

## 🎯 推荐方案：混合模式

**最优解**：根据任务类型选择模式

```python
class HybridMasterAgent:
    """混合模式 Master Agent"""

    def execute(self, task: str, context: AgentContext):
        # 1. 初步分析
        analysis = self.quick_analysis(task)

        if analysis.is_simple:
            # 简单任务：直接委托
            return self.delegate_to_agent(analysis.agent)

        elif analysis.is_predictable:
            # 可预测的复杂任务：静态 DAG（高效）
            # 例如："查询A、查询B、对比AB"
            return self.execute_static_dag(analysis.plan)

        elif analysis.is_uncertain:
            # 不确定性高的任务：动态管理（灵活）
            # 例如："分析XX情况并生成报告"（中间结果未知）
            return self.execute_dynamic(task, context)

        else:
            # 默认：动态管理
            return self.execute_dynamic(task, context)
```

---

## 🚀 实施路线

### 阶段 1：验证可行性（1-2 天）
- [ ] 实现 `DynamicMasterAgent` 的核心循环
- [ ] 测试简单场景（2-3 步的动态决策）
- [ ] 评估 LLM 决策质量

### 阶段 2：完善功能（3-5 天）
- [ ] 实现结果评估机制
- [ ] 实现自适应重试
- [ ] 实现知识积累
- [ ] 实现并行优化

### 阶段 3：集成（2-3 天）
- [ ] 与现有系统集成
- [ ] 前端流式显示决策过程
- [ ] 性能优化

### 阶段 4：对比测试（1-2 天）
- [ ] 对比静态 DAG vs 动态管理
- [ ] 评估成本、效率、质量
- [ ] 决定默认模式

---

## 🎓 核心理念

> **Master AI 不应该是"分析师 + 整合员"，而应该是"项目经理"——全程参与、动态调整、持续优化。**

这个架构将 Master AI 从"工具调用者"提升到"智能协调者"，使其真正具备**管理复杂任务**的能力。
