# Agent 系统完整指南

本文档详细介绍 RAGSystem 的 Agent 系统架构、工作流程和使用方法。

## 重要说明

⚠️ **关于旧版 `qa_agent.py` (QAAgent 类)**

从 2026-01-06 起，系统已废弃独立的 `QAAgent` 类和 `GenericAgent`，统一使用 **ReActAgent**：

- ✅ **推荐使用**: `type: react` (ReActAgent) - 支持并行工具调用、可解释性强
- ❌ **已废弃**: `type: qa` (QAAgent) - 旧的专用类，已从 `agent_loader.py` 移除
- ❌ **已废弃**: `type: generic` (GenericAgent) - 已移除

**迁移指南**: 如果你的配置中仍在使用 `type: qa` 或 `type: generic`，请改为：
```yaml
custom_params:
  type: react
  behavior:
    max_rounds: 10
    system_prompt: "..."
```

## 目录

- [系统架构](#系统架构)
- [核心组件](#核心组件)
- [工作流程](#工作流程)
- [配置指南](#配置指南)
- [Agent 类型](#agent-类型)
- [工具调用机制](#工具调用机制)
- [最佳实践](#最佳实践)
- [故障排查](#故障排查)

---

## 系统架构

### 整体架构图

```
用户请求
    ↓
API Layer (routes/agent.py)
    ↓
AgentOrchestrator (orchestrator.py)
    ↓
MasterAgent V2 (master_agent_v2/) - 统一入口
    ↓
任务分析 & 分解
    ↓
    ├─→ 简单任务 → 委托给单个 Agent
    ├─→ 复杂任务 → 多 Agent 协作
    └─→ 通用对话 → MasterAgent V2 自己处理
    ↓
Specialized Agents (qa_agent, emergency_plan_agent, etc.)
    ↓
工具调用 (tools/)
    ↓
返回结果
```

### 三层架构

1. **路由层** (`routes/agent.py`)
   - 接收 HTTP 请求
   - 参数验证
   - 会话管理
   - 结果封装

2. **编排层** (`orchestrator.py` + `master_agent_v2/`)
   - 任务路由
   - 智能体选择
   - 多智能体协调
   - 结果整合

3. **执行层** (`react_agent.py`, etc.)
   - 具体任务执行
   - 工具调用
   - 多轮对话
   - 结果生成

---

## 核心组件

### 1. MasterAgent V2 (统一入口)

**职责**：
- 作为所有用户请求的唯一入口
- 分析任务复杂度
- 自动任务分解与编排（将 Agent 当作工具，ReAct 模式）
- 智能体协调
- 结果整合

**关键特性**：
```python
# 任务分析
def _analyze_task(task, context) -> Dict:
    """
    返回格式：
    {
        "complexity": "simple|medium|complex",
        "needs_multiple_agents": true|false,
        "reasoning": "分析理由",
        "subtasks": [
            {
                "description": "子任务描述",
                "agent": "智能体名称",
                "order": 1,
                "depends_on": []
            }
        ]
    }
    """
```

**决策逻辑**：
1. **simple + single agent** → 委托给指定 Agent
2. **complex + multiple agents** → 多 Agent 协作
3. **无需特定 Agent** → 自己处理通用对话

**配置位置**：
- 硬编码在 `agent_loader.py` 的 `_load_system_master_agent_v2()` 方法中
- 不可由用户配置（系统核心组件）

### 2. AgentOrchestrator (编排器)

**职责**：
- Agent 注册与管理
- 任务路由
- Agent 生命周期管理

**关键方法**：
```python
# 注册 Agent
orchestrator.register_agent(agent)

# 执行任务
response = orchestrator.execute(
    task="查询南宁洪涝灾害",
    context=context,
    preferred_agent="qa_agent"  # 可选
)

# 多 Agent 协作
results = orchestrator.collaborate(
    tasks=[
        {"task": "查询数据", "agent": "qa_agent"},
        {"task": "生成图表", "agent": "chart_agent"}
    ],
    mode="sequential"  # 或 "parallel"
)
```

### 3. AgentRegistry (注册表)

**职责**：
- 维护 Agent 实例
- 提供查询接口
- 管理 Agent 元数据

**使用示例**：
```python
# 获取 Agent
agent = registry.get("qa_agent")

# 列出所有 Agent
agents = registry.list_agents()

# 查找能处理任务的 Agent
capable_agents = registry.find_capable_agents(task, context)
```

### 4. AgentLoader (动态加载器)

**职责**：
- 从 YAML 配置加载 Agent
- 自动创建实例
- 工具过滤
- 依赖注入

**加载流程**：
```
读取 agent_configs.yaml
    ↓
解析配置 (AgentConfig)
    ↓
确定 Agent 类型 (react)
    ↓
过滤工具 (enabled_tools)
    ↓
创建实例
    ↓
注册到 Orchestrator
```

### 5. ConfigManager (配置管理器)

**职责**：
- 读写 Agent 配置
- 配置验证
- 热加载支持

**API**：
```python
# 获取配置
config = config_manager.get_config("qa_agent")

# 保存配置
config_manager.set_config(config, save=True)

# 删除配置
config_manager.delete_config("qa_agent", save=True)

# 获取所有配置
all_configs = config_manager.get_all_configs()
```

---

## 工作流程

### 完整请求流程

#### 1. 用户发起请求

```http
POST /api/agent/stream
Content-Type: application/json

{
  "task": "对比南宁和桂林2020年的洪涝灾害情况",
  "session_id": "optional-session-id"
}
```

#### 2. API 层处理

```python
# routes/agent.py
@agent_bp.route('/stream', methods=['POST'])
def stream_execute():
    # 1. 获取参数
    task = data.get('task')
    session_id = data.get('session_id')

    # 2. 获取 Orchestrator
    orchestrator = _get_orchestrator()

    # 3. 创建上下文
    context = AgentContext(session_id=session_id or uuid.uuid4())

    # 4. 获取 MasterAgent V2 并执行
    master_agent = orchestrator.agents.get('master_agent_v2')
    for event in master_agent.stream_execute(task, context):
        yield f"data: {json.dumps(event)}\n\n"
```

#### 3. MasterAgent V2 分析任务

```python
# master_agent_v2/master_v2.py
def stream_execute(task, context):
    # 1. 分析任务
    analysis = self._analyze_task(task, context)
    # {
    #   "complexity": "medium",
    #   "needs_multiple_agents": false,
    #   "subtasks": [{
    #     "agent": "qa_agent",
    #     "description": "对比两个城市的洪涝灾害数据"
    #   }]
    # }

    # 2. 发送思考过程
    yield {"type": "thought", "content": analysis['reasoning']}

    # 3. 根据复杂度选择执行方式
    if analysis['needs_multiple_agents']:
        yield from self._stream_collaborate(task, context, analysis)
    else:
        yield from self._stream_delegate_to_single_agent(task, context, analysis)
```

#### 4. 委托给专业 Agent

```python
# master_agent_v2/master_v2.py
def _stream_delegate_to_single_agent(task, context, analysis):
    # 1. 提取智能体名称
    preferred_agent = analysis['subtasks'][0]['agent']  # "qa_agent"

    # 2. 发送状态更新
    yield {"type": "agent_start", "agent": preferred_agent}

    # 3. 调用 Orchestrator 执行
    response = self.orchestrator.execute(
        task=task,
        context=context,
        preferred_agent=preferred_agent
    )

    # 4. 返回结果
    yield {"type": "chunk", "content": response.content}
    yield {"type": "done", "session_id": context.session_id}
```

#### 5. Agent 执行任务

**5a. ReAct Agent 执行流程**

```python
# react_agent.py
def execute(task, context):
    messages = [
        {"role": "system", "content": self._build_system_prompt()},
        {"role": "user", "content": task}
    ]

    rounds = 0
    while rounds < self.max_rounds:
        rounds += 1

        # 调用 LLM (JSON mode)
        response = self.llm_adapter.chat_completion(
            messages=messages,
            response_format={"type": "json_object"}
        )

        # 解析 JSON
        output = json.loads(response.content)
        # {
        #   "thought": "需要查询两个城市的数据...",
        #   "actions": [
        #     {"tool": "query_knowledge_graph_with_nl",
        #      "arguments": {"question": "南宁2020年洪涝灾害"}},
        #     {"tool": "query_knowledge_graph_with_nl",
        #      "arguments": {"question": "桂林2020年洪涝灾害"}}
        #   ]
        # }

        # 检查最终答案
        if output.get('final_answer'):
            return AgentResponse(success=True, content=output['final_answer'])

        # 执行工具（支持并行）
        if output.get('actions'):
            observations = []
            for action in output['actions']:
                result = execute_tool(action['tool'], action['arguments'])
                observation = self._format_observation(result)
                observations.append(observation)

            # 将结果反馈给 LLM
            messages.append({
                "role": "user",
                "content": f"工具执行结果：\n{combined_observations}"
            })
            continue

    # 达到最大轮数，强制生成答案
    return self._generate_final_answer(messages)
```

**5b. (已废弃) Generic Agent 执行流程**

GenericAgent 已从系统中移除。请使用 ReActAgent。

#### 6. 工具执行

```python
# tools/tool_executor.py
def execute_tool(tool_name, arguments):
    # 1. 查找工具函数
    tool_func = TOOL_FUNCTIONS.get(tool_name)

    # 2. 执行工具
    try:
        result = tool_func(**arguments)
        return {
            "success": True,
            "data": result
        }
    except Exception as e:
        logger.error(f"工具 {tool_name} 执行失败: {e}")
        return {
            "success": False,
            "error": str(e)
        }

# 示例：查询知识图谱
def query_knowledge_graph_with_nl(question: str):
    # 1. 生成 Cypher
    generator = get_cypher_generator()
    cypher = generator.generate(question, graph_schema)

    # 2. 执行查询
    results = execute_cypher(cypher)

    # 3. 生成答案
    answer = generate_answer_from_query_results(question, results, cypher)

    return {"answer": answer, "cypher": cypher, "results": results}
```

#### 7. 结果返回

```python
# 最终结果格式
{
    "success": true,
    "data": {
        "answer": "根据查询结果，南宁2020年...",
        "agent_name": "qa_agent",
        "execution_time": 5.2,
        "tool_calls": [
            {
                "tool_name": "query_knowledge_graph_with_nl",
                "arguments": {"question": "南宁2020年洪涝灾害"},
                "result": {...}
            }
        ],
        "metadata": {
            "rounds": 2,
            "reasoning_steps": [...]
        }
    }
}
```

---

## 配置指南

### Agent 配置文件结构

```yaml
# agents/configs/agent_configs.yaml
agents:
  qa_agent:
    # 基本信息
    agent_name: qa_agent                    # Agent 唯一标识
    display_name: 知识图谱问答智能体         # 显示名称
    description: 专门查询广西洪涝灾害知识图谱  # 描述
    enabled: true                           # 是否启用

    # LLM 配置
    llm:
      provider: test2                       # Provider 名称
      model_name: deepseek-chat             # 模型名称
      temperature: 0.3                      # 温度 (0-1)
      max_tokens: 4096                      # 最大 token 数
      top_p: null                           # Top-p 采样
      timeout: 60                           # 超时时间（秒）
      retry_attempts: 3                     # 重试次数

    # 工具配置
    tools:
      enabled_tools:                        # 启用的工具列表
      - query_knowledge_graph_with_nl       # 自然语言查询
      - search_knowledge_graph              # 结构化搜索
      - get_entity_relations                # 实体关系
      - execute_cypher_query                # Cypher 查询
      - analyze_temporal_pattern            # 时序分析
      - find_causal_chain                   # 因果链
      - compare_entities                    # 实体对比
      - aggregate_statistics                # 聚合统计
      - get_spatial_neighbors               # 空间邻居
      - get_graph_schema                    # 图谱结构

    # 自定义参数
    custom_params:
      type: react                           # Agent 类型: react
      behavior:
        max_rounds: 10                      # 最大推理轮数
        system_prompt: |                    # 系统提示词
          你是一个知识图谱问答助手...

          **核心原则**：
          1. 循序渐进思考
          2. 优先使用 query_knowledge_graph_with_nl
          3. 禁止猜测或编造数据

metadata:
  updated_at: '2026-01-06T15:30:00.000000'
  version: '1.0'
```

### 配置参数详解

#### 1. 基本信息

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agent_name` | string | ✅ | Agent 唯一标识，用于路由和注册 |
| `display_name` | string | ✅ | 前端显示的名称 |
| `description` | string | ✅ | Agent 功能描述，用于 MasterAgent 分析 |
| `enabled` | boolean | ✅ | 是否启用，false 则不加载 |

#### 2. LLM 配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `provider` | string | 系统配置 | LLM Provider 名称 |
| `model_name` | string | 系统配置 | 模型名称 |
| `temperature` | float | 0.3 | 温度，控制随机性 (0-1) |
| `max_tokens` | int | 4096 | 最大生成 token 数 |
| `top_p` | float | null | Top-p 采样 |
| `timeout` | int | 60 | 请求超时时间（秒）|
| `retry_attempts` | int | 3 | 失败重试次数 |

#### 3. 工具配置

**enabled_tools**：
- 列表类型，指定该 Agent 可以使用的工具
- 如果为空或不配置，则启用所有工具
- 工具名称必须与 `tools/function_definitions.py` 中定义的一致

**可用工具列表**：
```python
# 基础检索工具
- query_knowledge_graph_with_nl  # 自然语言查询（推荐）
- search_knowledge_graph          # 结构化搜索
- get_entity_relations            # 实体关系网络
- execute_cypher_query            # 直接执行 Cypher
- get_graph_schema                # 获取图谱结构

# 高级分析工具
- analyze_temporal_pattern        # 时序趋势分析
- find_causal_chain               # 因果链路追踪
- compare_entities                # 多实体对比
- aggregate_statistics            # 聚合统计
- get_spatial_neighbors           # 空间邻居查询

# 应急预案工具
- query_emergency_plan            # 查询应急预案
```

#### 4. 自定义参数 (custom_params)

**type**：Agent 类型
- `react`: 使用 ReAct 推理模式，支持并行工具调用（推荐）

**behavior.max_rounds**：
- 最大推理轮数，防止无限循环
- 推荐值：10-15

**behavior.system_prompt**：
- Agent 的系统提示词
- 定义 Agent 的角色、能力和行为规范
- 支持多行文本

---

## Agent 类型

### ReActAgent (推荐，JSON Mode)

**特点**：
- ✅ 显示完整推理过程 (thought)
- ✅ 支持并行工具调用
- ✅ 简单的消息格式（user/assistant）
- ✅ 模型无关（任何支持 JSON mode 的模型）
- ✅ 易于调试
- ❌ 需要模型支持 JSON mode
- ❌ 可能需要更多 prompt engineering

**适用场景**：
- 需要可解释性的场景
- 需要并行执行多个独立查询
- 复杂的多步骤推理任务
- **推荐用于生产环境** ⭐

**配置示例**：
```yaml
custom_params:
  type: react
  behavior:
    max_rounds: 10
    system_prompt: |
      你是一个知识图谱问答助手...

      **核心原则**：
      1. 循序渐进思考
      2. 可以一次调用多个独立的工具
```

**执行流程**：
```
用户问题
  ↓
LLM 分析 (JSON mode)
  ↓
返回 JSON:
{
  "thought": "需要查询南宁和桂林...",
  "actions": [
    {"tool": "query_kg", "arguments": {...}},
    {"tool": "query_kg", "arguments": {...}}
  ]
}
  ↓
并行执行多个工具 ⚡
  ↓
将所有结果反馈给 LLM
  ↓
LLM 继续分析或给出答案
  ↓
返回最终答案
```

**输出格式**：
```json
{
  "thought": "当前的思考过程",
  "actions": [
    {
      "tool": "工具名称",
      "arguments": {"参数名": "参数值"}
    }
  ],
  "final_answer": "最终答案（如果有）"
}
```

### MasterAgent (特殊)

**特点**：
- 系统级 Agent，不可配置
- 作为统一入口
- 负责任务分析和分解
- 协调其他 Agent

**不适用于**：
- 直接处理具体业务逻辑
- 工具调用

---

## 工具调用机制

### 工具定义

所有工具在 `tools/function_definitions.py` 中定义：

```python
TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "query_knowledge_graph_with_nl",
            "description": "使用自然语言查询知识图谱...",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "自然语言问题"
                    }
                },
                "required": ["question"]
            }
        }
    },
    # ... 更多工具
]
```

### 工具实现

工具函数在 `tools/tool_executor.py` 中实现：

```python
def query_knowledge_graph_with_nl(question: str):
    """自然语言查询知识图谱"""
    try:
        # 1. 获取图谱 schema
        schema = get_graph_schema()

        # 2. 生成 Cypher 查询
        generator = get_cypher_generator()
        cypher = generator.generate(question, schema)

        # 3. 执行查询
        results = execute_cypher(cypher)

        # 4. 生成自然语言答案
        answer = generate_answer_from_query_results(
            question, results, cypher
        )

        return {
            "success": True,
            "data": {
                "answer": answer,
                "cypher": cypher,
                "result_count": len(results)
            }
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }
```

### 添加新工具

#### 步骤 1：定义工具

在 `tools/function_definitions.py` 中添加：

```python
{
    "type": "function",
    "function": {
        "name": "my_new_tool",
        "description": "工具的详细描述，LLM 会根据这个描述决定是否使用",
        "parameters": {
            "type": "object",
            "properties": {
                "param1": {
                    "type": "string",
                    "description": "参数1的描述"
                },
                "param2": {
                    "type": "integer",
                    "description": "参数2的描述"
                }
            },
            "required": ["param1"]  # 必填参数
        }
    }
}
```

#### 步骤 2：实现工具函数

在 `tools/tool_executor.py` 中实现：

```python
def my_new_tool(param1: str, param2: int = 10):
    """
    工具的具体实现

    Args:
        param1: 参数1
        param2: 参数2（可选）

    Returns:
        dict: {"success": bool, "data": any} 或 {"success": bool, "error": str}
    """
    try:
        # 实现逻辑
        result = do_something(param1, param2)

        return {
            "success": True,
            "data": result
        }
    except Exception as e:
        logger.error(f"my_new_tool 执行失败: {e}")
        return {
            "success": False,
            "error": str(e)
        }

# 注册到工具映射
TOOL_FUNCTIONS = {
    # ... 现有工具
    "my_new_tool": my_new_tool,
}
```

#### 步骤 3：配置 Agent 使用

在 `agent_configs.yaml` 中启用：

```yaml
agents:
  my_agent:
    tools:
      enabled_tools:
      - my_new_tool
      - query_knowledge_graph_with_nl
      # ... 其他工具
```

---

## 最佳实践

### 1. Agent 配置

#### ✅ 推荐做法

```yaml
# 使用 ReAct 模式（更好的可解释性）
custom_params:
  type: react
  behavior:
    max_rounds: 10
    system_prompt: |
      你是一个专门的 XXX 助手。

      **核心原则**：
      1. 明确你的职责范围
      2. 列出你可以做什么
      3. 说明限制条件

      **重要提示**：
      - 禁止编造数据
      - 工具失败时说明原因

# 只启用必要的工具
tools:
  enabled_tools:
  - tool1
  - tool2
  # 不要启用不相关的工具

# 合理的超时和重试
llm:
  timeout: 60
  retry_attempts: 3
```

#### ❌ 避免的做法

```yaml
# 不要使用过于模糊的 system_prompt
system_prompt: "你是一个助手"  # ❌ 太模糊

# 不要启用所有工具
tools:
  enabled_tools: []  # ❌ 空列表会加载所有工具

# 不要设置过大的 max_rounds
behavior:
  max_rounds: 100  # ❌ 太大，可能导致浪费
```

### 2. 工具设计

#### ✅ 推荐做法

```python
def good_tool(query: str, limit: int = 10):
    """
    ✅ 好的工具设计：
    - 清晰的函数签名
    - 详细的文档字符串
    - 合理的默认值
    - 统一的返回格式
    - 完善的错误处理
    """
    try:
        results = do_query(query, limit)

        return {
            "success": True,
            "data": {
                "results": results,
                "count": len(results)
            }
        }
    except ValueError as e:
        return {"success": False, "error": f"参数错误: {e}"}
    except Exception as e:
        logger.error(f"工具执行失败: {e}", exc_info=True)
        return {"success": False, "error": f"执行失败: {e}"}
```

#### ❌ 避免的做法

```python
def bad_tool(x):  # ❌ 参数名不清晰
    # ❌ 没有文档
    # ❌ 没有错误处理
    result = do_something(x)
    return result  # ❌ 返回格式不统一
```

### 3. 系统提示词

#### ✅ 推荐做法

```yaml
system_prompt: |
  你是一个知识图谱问答助手。

  **你的职责**：
  1. 查询广西洪涝灾害知识图谱
  2. 分析灾害数据和趋势
  3. 提供可靠的历史信息

  **你可以使用的工具**：
  - query_knowledge_graph_with_nl: 自然语言查询（推荐优先使用）
  - search_knowledge_graph: 结构化搜索

  **重要原则**：
  1. 禁止编造数据 - 如果查询无结果，明确告知
  2. 优先使用 query_knowledge_graph_with_nl
  3. 可以多次调用工具补充信息
  4. 工具失败时，分析原因并调整策略

  **数据说明**：
  - 知识图谱覆盖 2016-2023 年数据
  - 损失数据可能分散在不同节点中
```

#### ❌ 避免的做法

```yaml
system_prompt: "你是助手，回答用户问题"  # ❌ 太简单
```

### 4. 错误处理

#### ✅ 推荐做法

```python
# 在 Agent 级别
try:
    response = agent.execute(task, context)
    if not response.success:
        logger.error(f"Agent 执行失败: {response.error}")
        return error_response(response.error)
    return success_response(response.content)
except Exception as e:
    logger.error(f"未预期的错误: {e}", exc_info=True)
    return error_response("系统错误，请稍后重试")

# 在工具级别
def safe_tool_call(tool_name, arguments):
    try:
        return execute_tool(tool_name, arguments)
    except Exception as e:
        logger.error(f"工具 {tool_name} 失败: {e}")
        return {
            "success": False,
            "error": f"工具执行失败: {str(e)}"
        }
```

### 5. 性能优化

#### 并行工具调用 (ReAct Agent)

```json
{
  "thought": "需要查询多个城市的数据，这些查询是独立的",
  "actions": [
    {"tool": "query_kg", "arguments": {"question": "南宁数据"}},
    {"tool": "query_kg", "arguments": {"question": "桂林数据"}},
    {"tool": "query_kg", "arguments": {"question": "柳州数据"}}
  ]
}
```

**效果**：
- 串行：3 轮 × 每轮 5 秒 = 15 秒
- 并行：1 轮 × 5 秒 = 5 秒 ⚡

#### 工具过滤

```yaml
# 只启用必要的工具，减少 prompt 长度
tools:
  enabled_tools:
  - query_knowledge_graph_with_nl  # 必要
  - get_graph_schema                # 必要
  # 不要加载用不到的工具
```

---

## 故障排查

### 常见问题

#### 1. Agent 未加载

**症状**：
```
WARNING:AgentOrchestrator:指定的智能体 'qa_agent' 不可用
```

**排查步骤**：
1. 检查配置文件 `agent_configs.yaml` 中 `enabled: true`
2. 检查配置位置（必须在 `agents:` 节点下）
3. 检查 `type` 配置是否正确（`generic` 或 `react`）
4. 查看启动日志中的加载信息

#### 2. 工具调用失败

**症状**：
```
ERROR:tools.tool_executor:执行工具 get_entity_relations 失败:
got an unexpected keyword argument 'relation_types'
```

**原因**：参数名称错误

**解决方案**：
- ReAct Agent：检查工具参数定义是否详细
- 查看 `tools/function_definitions.py` 中的参数定义
- 确保 LLM 能看到参数说明

#### 3. 达到最大轮数

**症状**：
```
WARNING:Agent.qa_agent:已达到最大轮数 10，强制生成最终答案
```

**原因**：
- LLM 一直在调用工具，没有给出最终答案
- 工具返回结果不符合预期，LLM 反复尝试

**解决方案**：
1. 增加 `max_rounds`（但不要超过 15）
2. 优化 `system_prompt`，明确要求 LLM 及时给出答案
3. 检查工具返回格式是否正确

#### 4. JSON 解析失败

**症状**：
```
ERROR:agents.react_agent:无法解析 LLM 响应: Expecting value: line 1 column 1
```

**原因**：
- LLM 没有返回 JSON 格式
- 返回了 markdown 代码块包裹的 JSON

**解决方案**：
- 检查是否使用了 `response_format={"type": "json_object"}`
- 在 prompt 中强调"只返回 JSON，不要有其他内容"
- 添加 JSON 提取逻辑（已在 ReAct Agent 中实现）

#### 5. DeepSeek API 400 错误

**症状**：
```
ERROR:llm_adapter.providers:DeepSeek API 400 错误详情:
Missing `reasoning_content` field
```

**原因**：
- 使用了 `deepseek-reasoner` 模型但缺少特殊字段
- 消息格式不符合要求

**解决方案**：
- 使用 `deepseek-chat` 而不是 `deepseek-reasoner`
- 或实现对 `reasoning_content` 字段的支持

### 调试技巧

#### 1. 启用详细日志

```python
# app.py
logging.basicConfig(level=logging.DEBUG)
```

#### 2. 查看 Agent 执行轨迹

```python
# 查看推理步骤
response = agent.execute(task, context)
if response.metadata and 'reasoning_steps' in response.metadata:
    for step in response.metadata['reasoning_steps']:
        print(json.dumps(step, ensure_ascii=False, indent=2))
```

#### 3. 测试单个 Agent

```python
# test_react_agent.py
from agents import load_agents_from_config, AgentContext

agents = load_agents_from_config(adapter, config, orchestrator)
qa_agent = agents['qa_agent']

context = AgentContext(session_id="test")
response = qa_agent.execute("测试问题", context)

print(f"成功: {response.success}")
print(f"内容: {response.content}")
print(f"工具调用: {len(response.tool_calls)}")
```

#### 4. 检查工具定义

```python
# 查看 Agent 可用的工具
from tools.function_definitions import get_tool_definitions

tools = get_tool_definitions()
for tool in tools:
    name = tool['function']['name']
    desc = tool['function']['description']
    params = tool['function']['parameters']['properties'].keys()
    print(f"{name}: {list(params)}")
```

---

## 相关文档

- **架构设计**: `UNIFIED_ENTRY_ARCHITECTURE.md` - 统一入口架构详解
- **使用指南**: `USAGE_GUIDE.md` - 快速开始和 API 使用
- **Master Agent**: `MASTER_AGENT_GUIDE.md` - MasterAgent 详细说明
- **工具对比**: `TOOL_CALLING_COMPARISON.md` - Function Calling vs ReAct

---

## 附录

### A. API 端点列表

```
GET  /api/agent/agents              # 列出所有智能体
POST /api/agent/execute              # 执行任务（自动路由）
POST /api/agent/stream               # 流式执行（推荐）
POST /api/agent/execute/<agent_name> # 执行指定智能体
POST /api/agent/collaborate          # 多智能体协作
POST /api/agent/agents/create        # 创建智能体
DELETE /api/agent/agents/delete/<name> # 删除智能体
GET  /api/agent/health               # 健康检查
```

### B. 配置文件位置

```
agents/
├── configs/
│   └── agent_configs.yaml       # Agent 配置文件
├── __init__.py                  # 导出接口
├── base.py                      # BaseAgent 基类
├── master_agent_v2/             # MasterAgent V2 统一入口
├── generic_agent.py             # (已废弃) GenericAgent 实现
├── react_agent.py               # ReActAgent 实现
├── orchestrator.py              # 编排器
├── agent_loader.py              # 动态加载器
├── config_manager.py            # 配置管理器
└── README.md                    # 本文档
```

### C. 术语表

| 术语 | 说明 |
|------|------|
| Agent | 智能体，能够执行特定任务的自主实体 |
| MasterAgent V2 | 主协调智能体，系统统一入口（master_agent_v2） |
| Orchestrator | 编排器，负责 Agent 路由和协调 |
| Function Calling | OpenAI 的工具调用机制 |
| ReAct | Reasoning + Acting，推理与行动结合的模式 |
| Tool | 工具，Agent 可以调用的函数 |
| Context | 上下文，包含会话历史和状态 |
| Round | 轮次，一次 LLM 调用到下次调用之间 |

---

## 更新日志

- **2026-01-06**: 初始版本
  - 完整的 Agent 系统文档
  - ReAct Agent 实现
  - 并行工具调用支持
  - 移除 task_patterns 机制

---

## 延伸阅读

- **事件总线**：`docs/event-bus/README.md` — 事件发布/订阅、SSE 流式输出、会话级事件总线
- **智能上下文**：`docs/SMART_CONTEXT_MANAGEMENT.md`、`docs/MASTER_AGENT_CONTEXT_CONFIG.md` — 上下文压缩与 Master V2 配置

如有问题或建议，请联系开发团队或提交 Issue。
