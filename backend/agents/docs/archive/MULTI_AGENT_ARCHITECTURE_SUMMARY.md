# 当前多智能体架构总结

## 一、整体架构

```
用户请求 (API)
      ↓
AgentOrchestrator（编排器）
      ↓
route_task() → 优先返回 MasterAgent V2（统一入口）
      ↓
MasterAgent V2.execute(task, context)
      ↓
ReAct 循环：thought → actions（工具 / 调用其他 Agent）→ observation → ...
      ↓
├─ 调用工具 (tool_executor)：query_knowledge_graph_with_nl、search_knowledge_graph 等
└─ 调用子 Agent (AgentExecutor)：invoke_agent_qa_agent、invoke_agent_workflow_agent 等
      ↓
子 Agent（如 ReActAgent）执行：自己的 ReAct + 工具调用
      ↓
结果回传 MasterAgent V2 → 整合 → 最终答案
```

- **统一入口**：所有请求先到 Orchestrator，再路由到 **MasterAgent V2**，由它决定是直接答、调工具还是调其他 Agent。
- **Agent 即工具**：其他 Agent 以 `invoke_agent_<name>` 的形式作为 Master 的“工具”，由 LLM 在 ReAct 中动态选择并调用。

---

## 二、核心组件

### 1. AgentOrchestrator（编排器）

| 职责 | 说明 |
|------|------|
| 注册与管理 | `register_agent(agent)`，内部使用 `AgentRegistry` 存 `name → BaseAgent` |
| 任务路由 | `route_task(task, context, preferred_agent)`：指定则用指定 Agent，否则用 `master_agent_v2`，缺失时降级为 `find_capable_agents` |
| 执行入口 | `execute(task, context, preferred_agent)`：创建/使用 context、添加用户消息、路由、执行 Agent、把结果写回 context 并返回 |
| 协作入口 | `collaborate(tasks, context, mode='sequential')`：按任务列表串行执行（并行未实现） |

- 单例：`get_orchestrator(model_adapter)`。
- 路由策略：**优先 MasterAgent V2**，无则按能力降级。

### 2. MasterAgent V2（统一入口与编排者）

| 特性 | 说明 |
|------|------|
| 身份 | 继承 `BaseAgent`，名称为 `master_agent_v2`，作为所有用户请求的入口 Agent |
| 决策方式 | **ReAct**：每轮输出 `thought`、`actions`（工具或 `invoke_agent_*`）、可选 `final_answer` |
| 工具来源 | 工具 = 普通工具（无） + **动态 Agent 工具**：`get_agent_tools(orchestrator.agents)` 生成 `invoke_agent_<name>`，排除自身 |
| 上下文 | 自带 `ContextManager`（token 预算、滑动窗口等），子 Agent 调用时使用 `context.fork()` 派生子上下文 |
| 子 Agent 调用 | 通过 `AgentExecutor.execute_agent(agent_name, task, context, context_hint)`，传 `task` + 可选 `context_hint`，子上下文共享 `session_id` 与 `blackboard` |
| 结果合并 | 子 Agent 返回后 `context.merge(child_context, response)`，只合并结果元数据，不合并子对话历史 |

- 配置：行为参数来自 `agent_config.custom_params.behavior`（如 `max_rounds`、`max_context_tokens`），系统 Master 由 `agent_loader` 加载，非用户 YAML 配置。

### 3. AgentExecutor（子 Agent 执行器）

- 归属：MasterAgent V2 持有，用于执行“调用其他 Agent”的 action。
- 功能：
  - `execute_agent(agent_name, task, context, context_hint)`：非流式，`task`（+ `context_hint` 拼到 task 后）和 `context` 传给子 Agent，返回 `{ success, data, error }`。
  - `execute_agent_stream(...)`：流式，若子 Agent 支持 `execute_stream` 则透传事件，最后再给一条标准化结果。
- 子 Agent 从 `orchestrator.agents.get(agent_name)` 获取。

### 4. AgentRegistry（注册表）

- 存储：`_agents: Dict[str, BaseAgent]`。
- 方法：`register(agent)`、`unregister(name)`、`get(name)`、`list_agents()`、`find_capable_agents(task, context)`（按 `can_handle` 筛选）。

### 5. AgentContext（执行上下文）

| 内容 | 说明 |
|------|------|
| session_id / user_id | 会话与用户标识 |
| conversation_history | 当前 Agent 的对话历史（子 Agent fork 后独立） |
| blackboard | 键值共享存储，fork 后父子**共享同一引用**，用于跨 Agent 共享状态 |
| metadata | run_id、parent_call_id、task_order 等，子 Agent 调用时注入 |
| fork() | 子上下文：新 history，共享 session_id、blackboard、parent 引用 |
| merge(child, result) | 将子任务结果元数据写回当前 context，不合并子 history |

### 6. 专业 Agent（如 qa_agent、workflow_agent）

- 实现：多为 **ReActAgent**（`type: react`），从 `agent_configs.yaml` 经 `AgentLoader` 加载。
- 能力：各自有 `available_tools`（如 KG 查询、工作流等），在收到 Master 的 `task`（+ 可选 `context_hint`）后独立做 ReAct 与工具调用。
- 注册顺序：先注册专业 Agent，最后注册 MasterAgent V2，以便 Master 能通过 `get_agent_tools(registry._agents)` 拿到所有 `invoke_agent_*`。

---

## 三、数据流与调用链

1. **请求进入**：`POST /api/agent/execute` 或 `/stream` → 创建/复用 `AgentContext`，`context.add_message('user', task)`。
2. **路由**：`orchestrator.execute(task, context)` → `route_task()` → 返回 `master_agent_v2`。
3. **Master 执行**：MasterAgent V2 的 `execute(task, context)` 进入 ReAct 循环：
   - 用 `ContextManager` 管理历史与 token；
   - 每轮 LLM 输出 `thought` + `actions`；
   - 若 action 为 `invoke_agent_*`：解析出 `agent_name`，`context.fork()` → `AgentExecutor.execute_agent(agent_name, task, context, context_hint)` → 子 Agent 执行 → `context.merge(...)`，观察结果拼成 observation；
   - 若为普通工具：走 `tool_executor.execute_tool(...)`，观察结果同理；
   - 直到出现 `final_answer` 或达到 `max_rounds`。
4. **子 Agent 内**：子 Agent（如 ReActAgent）在自己的上下文中做自己的 ReAct 与工具调用，结果通过 `AgentResponse` 返回给 Executor，再被格式化为 Master 的 observation。

---

## 四、配置与加载

- **专业 Agent**：`backend/agents/configs/agent_configs.yaml` 定义，由 `AgentLoader` 加载为 ReActAgent 等实例，在应用启动时（或 reload 时）`register_agent(agent)` 注册到 Orchestrator。
- **MasterAgent V2**：由 `agent_loader._load_system_master_agent_v2()` 构建，并注入当前 `orchestrator`，最后注册，保证在注册表中可被 `route_task` 优先返回。

---

## 五、小结表

| 层次 | 组件 | 作用 |
|------|------|------|
| 入口 | API (routes/agent.py) | 接收请求，会话管理，调用 Orchestrator |
| 路由 | AgentOrchestrator | 注册表、路由（优先 Master V2）、execute/collaborate |
| 编排 | MasterAgent V2 | 统一入口，ReAct，把其他 Agent 当工具调用 |
| 执行 | AgentExecutor | 执行 `invoke_agent_*`，调用子 Agent |
| 执行 | 专业 Agent (ReActAgent 等) | 接收 task/context_hint，各自工具与 ReAct |
| 支撑 | AgentRegistry | 存储与查找 Agent |
| 支撑 | AgentContext / ContextManager | 会话历史、token 控制、fork/merge、黑板 |

整体上，这是一套 **统一入口 + 动态编排** 的多智能体架构：用户只面对一个入口，由 MasterAgent V2 通过 ReAct 自主决定是否以及如何调用哪些子 Agent 和工具，子 Agent 通过上下文隔离与黑板共享协作。
