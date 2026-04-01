# 当前项目工具体系与 Claude Code 的差异分析

本文档用于分析当前项目工具体系与 Claude Code 风格工具运行时之间的差异，并为后续 `CLAUDE_CODE_ALIGNMENT_PLAN.md` 提供事实依据。

## 1. 分析范围与对照口径

本分析只聚焦工具体系，不讨论模型能力、产品定位或 UI 风格。

对照口径采用 Claude Code 风格的六个能力域：

1. 工具注册与暴露
2. 工具执行上下文
3. 权限与审批
4. 生命周期 hooks
5. 可观测与结果协议
6. 大结果持久化与回读

分析结论基于以下现有代码与文档：

- `backend-fastapi/docs/tools.md`
- `backend-fastapi/tools/tool_registry.py`
- `backend-fastapi/tools/runtime/executor.py`
- `backend-fastapi/tools/permissions.py`
- `backend-fastapi/tools/local/skill_tools.py`
- `backend-fastapi/agents/config/loader.py`
- `backend-fastapi/services/agent_api_runtime_service.py`
- `backend-fastapi/services/memory_store.py`
- `frontend-client/src/utils/executionProjector.js`
- `frontend-client/src/components/VisualizationLoader.vue`

## 2. 当前项目工具体系概览

### 2.1 统一注册面已经形成

当前本地工具已经收敛到 `@tool()` 体系，`ToolRegistry` 作为唯一读模型输出不同来源的工具视图：

- direct / document
- skill
- builtin
- agent
- MCP（通过 adapter / registry 接入）

对应事实：

- `backend-fastapi/tools/tool_registry.py`
- `backend-fastapi/docs/tools.md`

### 2.2 执行主链已经收口

工具执行已经存在统一入口 `execute_tool()`，并完成以下步骤：

- 审批判定
- timeout 处理
- handler 分发
- MCP gateway 转发
- 结果规范化

对应事实：

- `backend-fastapi/tools/runtime/executor.py`

### 2.3 Skill 与 Artifact 已有稳定基础

Skill 已不再直接以大而散的 direct tool 暴露，而是经由 skill system tools + script + artifact 协议运行。

对应事实：

- `backend-fastapi/tools/local/skill_tools.py`
- `backend-fastapi/docs/tools.md`

### 2.4 前端已具备执行树与 Artifact 展示基础

前端当前已形成：

- `execution.step` 单一事实源
- 执行树 projector
- artifact 拉取与可视化渲染链

对应事实：

- `frontend-client/src/utils/executionProjector.js`
- `frontend-client/src/components/VisualizationLoader.vue`

## 3. Claude Code 工具体系特征抽象

从工程抽象上看，Claude Code 风格工具体系具备以下特征：

### 3.1 统一 Tool Universe

不同来源的能力共享同一工具宇宙，而不是在提示词、权限、展示、结果语义上各走各路。

### 3.2 厚 ToolUseContext

工具调用不是只收到 arguments，而是收到完整运行时上下文，例如：

- 当前会话与工作目录
- 调用方身份
- 权限模式
- 审批状态
- 输出物化位置
- 观测字段与调用树信息

### 3.3 双层权限模型

Claude Code 风格会区分：

- 这个工具是否应该暴露给模型
- 这个工具在当前调用条件下是否允许执行

审批只是执行层判定链的一部分，不等于全部权限语义。

### 3.4 生命周期 hooks 是一等机制

工具前后会有统一 hooks 入口，用于：

- 审计
- 变更参数
- 阻断执行
- 结果后处理

### 3.5 统一结果协议与大结果回读闭环

大结果不会只以内存 observation 存在，而是会稳定物化、引用、回读，并与前端展示协议保持一致。

## 4. 差异分类总表

| 能力域 | 当前状态 | 结论 |
|---|---|---|
| 工具注册与暴露 | 已基本统一到 `@tool()` + `ToolRegistry` | 已完成 |
| 工具执行上下文 | 仍以散落参数传递为主 | 明显缺口 |
| 权限与审批 | 有统一 approval gate，但仍偏单层 | 可复用基础 + 明显缺口 |
| 生命周期 hooks | 缺少一等机制 | 明显缺口 |
| 可观测与结果协议 | 已有 execution.step、ToolExecutionResult、artifact | 可复用基础 |
| 大结果持久化与回读 | artifact 较稳定，通用大结果闭环仍不足 | 明显缺口 |
| direct / skill / MCP 语义收敛 | 已同宇宙但仍有展示和语义分层问题 | 收敛问题 |

## 6. 当前收敛状态更新（2026-04-01）

本轮已按“最少代码、无兼容层扩散”的原则推进一版收敛式升级：

- P1：新增 `tools/runtime/exposure.py`，loader 与 permissions 共享同一工具暴露真源，direct/memory/skill/builtin/delegation/MCP 暴露语义不再分散推导
- P2：`execute_tool()` 内部统一先构造 `ToolUseContext`，dispatcher / approval / MCP gateway 改为围绕 context 取数
- P3：权限已升级为结构化 `PermissionDecision`，并补入轻量 hooks phase 骨架，审批只负责 approval 子阶段
- P4：结果协议新增 `result_envelope` / `result_ref` / `resource_refs` / `artifacts` / `approval_message`，大结果支持落盘后回注引用；`step_projector.py` 与 `frontend-client/src/utils/executionProjector.js` 已同步消费统一 envelope

仍可继续完善的点：

- hooks 目前是首版骨架，尚未引入可配置 registry / priority / per-tool pattern 过滤
- `ToolUseContext` 已成为 runtime 主承载，但尚未覆盖更细粒度遥测与 stop-reason 语义
- 大结果回读闭环已具备通用 `result_ref`，但专门的 raw result 读取 API/UX 还可以继续细化


### 5.1 工具注册与暴露

#### 已完成

- `@tool()` 已成为本地工具统一注册入口
- `ToolRegistry` 已是统一读模型
- direct / skill / builtin / agent / MCP 已在 registry 视角下进入同一 universe

对应事实：

- `backend-fastapi/tools/tool_registry.py:17`
- `backend-fastapi/docs/tools.md:66`

#### 评价

这一部分已经基本收敛，不应推倒重来，后续重点是把同一工具分类继续推进到权限、可观测与结果协议。

### 5.2 工具执行上下文

#### 可复用基础

当前执行入口已经会传入：

- `agent_config`
- `event_bus`
- `user_role`
- `caller`
- `session_id`
- `run_id`
- `cancel_event`
- `parent_call_id`
- `current_agent_name`
- `tool_call_id`

对应事实：

- `backend-fastapi/tools/runtime/executor.py:67`

#### 明显缺口

这些字段仍是分散参数，尚未形成统一 `ToolUseContext`：

- executor 负责一部分
- dispatcher 注入一部分
- approvals 读取一部分
- path resolution 与 artifact 再各自读取一部分

结果是：

- 工具调用上下文不够稳定
- hooks 无明确承接点
- 结果物化与观测字段难以统一扩展

#### 结论

这是当前对标 Claude Code 的核心缺口之一，应列为高优先级。

### 5.3 权限与审批

#### 已完成 / 可复用基础

当前系统已经具备：

- `check_tool_permission()` 授权检查
- `request_user_approval_if_needed()` 审批等待
- 全局权限模式
- risk level 驱动审批判定

对应事实：

- `backend-fastapi/tools/permissions.py:212`
- `backend-fastapi/tools/runtime/executor.py:70`
- `backend-fastapi/docs/tools.md:296`

#### 明显缺口

当前仍缺少双层模型：

1. **工具暴露权限**：模型当前应该看到什么工具
2. **执行权限**：即使模型看到了，当前调用条件下是否允许执行

现在两者部分混在：

- loader 负责把哪些工具注入 Agent
- permissions 再判断是否允许执行
- 但两套语义没有统一 policy object 承接

另外，`risk_level` 与“是否需要审批”之间虽有映射，但还没有明确抽象出独立 decision 结构，因此后续引入 auto-accept、hooks 或更复杂策略时容易继续耦合。

#### 收敛问题

direct tool 启用推导逻辑目前存在重复：

- `backend-fastapi/agents/config/loader.py:256`
- `backend-fastapi/tools/permissions.py:143`

这说明“工具是否对 Agent 生效”的语义仍未收口。

### 5.4 生命周期 hooks

#### 明显缺口

当前系统几乎没有 Claude Code 风格的工具生命周期 hooks 一等机制。

现状是：

- 有审批前置 gate
- 有结果规范化
- 有部分 artifact 后处理
- 但没有统一 before / after / error hook 管线

这会限制后续能力：

- 审计难以统一插入
- 参数重写缺少合法挂点
- 工具结果后处理逻辑容易散落在 skill、artifact、前端兼容代码中

#### 结论

这是 Phase 3 的重点缺口。

### 5.5 可观测与结果协议

#### 已完成 / 可复用基础

当前系统已经具备多项重要基础：

- `ToolExecutionResult`
- `execution.step`
- artifact 持久化与前端渲染
- raw result preview 与部分大结果引用字段

对应事实：

- `backend-fastapi/docs/tools.md:260`
- `frontend-client/src/utils/executionProjector.js:1`

#### 明显缺口

当前协议仍未完全统一：

- progress / approval / result / artifact / raw result ref 还不是同一稳定协议族
- direct tool 与 skill tool 的可观测语义仍可能分层
- 前端某些场景下看到的仍是底层脚本调用，而不是用户真正理解的“工具语义节点”

#### 收敛问题

direct tool / skill 在可观测语义上仍有两层：

- 运行时可能看到 `execute_skill_script`
- 但产品层更希望看到具体技能语义或工具语义

这需要在执行协议与 projector 投影层继续收敛。

### 5.6 大结果持久化与回读

#### 可复用基础

当前已有两块基础较好：

1. artifact 持久化
   - `backend-fastapi/tools/artifacts/visualization_artifact_manager.py`
2. memory 的“索引注入 + 按需读取”模型
   - `backend-fastapi/services/agent_api_runtime_service.py`
   - `backend-fastapi/services/memory_store.py`

这说明项目已经具备“轻索引 + 按需展开 + 落盘引用”的思路。

#### 明显缺口

但通用工具大结果仍缺少稳定闭环：

- 哪些结果应该物化没有统一规则
- 物化后的标准引用协议仍不统一
- 前端如何回读、下载或展开结果仍主要依赖具体子域实现

#### 结论

这是后续统一结果协议时必须一起解决的能力域。

## 6. 四类结论归纳

### 6.1 已完成

- `@tool()` 已成为统一注册入口
- `ToolRegistry` 已成为统一读模型
- runtime 执行链已经清晰存在
- Skill 已收敛为 system tools + script + artifact
- MCP 已实现“外部展开、内部 gateway”
- 前端已有 `execution.step` 与 artifact 渲染链

### 6.2 可复用基础

- memory 的“索引注入 + 按需读取”模型
- artifact 持久化机制
- approval 事件链与前端审批 UI
- session / run / workspace 边界与现有 observability 字段

### 6.3 明显缺口

- 缺少厚 `ToolUseContext`
- 缺少工具暴露权限与执行权限的双层模型
- 缺少 hooks 一等机制
- 缺少完整统一的结果协议
- 缺少通用大结果物化与标准回读闭环
- MCP 接入仍主要停留在当前抽象层，尚未进入更统一的工具运行时模型

### 6.4 收敛问题

- direct tool 启用推导重复
  - `backend-fastapi/agents/config/loader.py`
  - `backend-fastapi/tools/permissions.py`
- memory 工具默认启用语义在文档与配置语义上仍可能漂移
  - `backend-fastapi/docs/tools.md`
  - `backend-fastapi/docs/architecture.md`
- direct tool / skill 的可观测语义仍有两层
- MCP 权限仍偏 server 级
- `risk_level` 与 `requires_approval` 存在潜在脱节

## 7. 优先级建议

### P0：先做文档收口

先建立单一信息源，避免后续讨论继续散落在聊天记录与临时结论里。

### P1：先解决收敛问题

优先处理当前系统内部已经出现的不一致：

- direct tool 启用推导真源
- memory 工具启用语义
- risk / approval 语义边界
- skill / direct tool 可观测口径

理由：这些问题不解决，后续再引入更厚的运行时对象只会把歧义固化。

### P2：再引入统一 ToolUseContext

这是后续 hooks、权限分层、结果物化与统一协议的承载点，应作为运行时升级核心。

### P3：再升级权限与 hooks

权限与 hooks 需要建立在统一上下文上，否则只能继续通过分散参数和局部 if/else 追加逻辑。

### P4：最后统一结果回读闭环与工具语义展示

当运行时与策略模型收口后，再统一前端展示与结果回读，会更稳定也更少返工。

## 8. 与主规划文档的关系

本文档负责回答两个问题：

1. 当前系统已经具备什么
2. 当前系统离 Claude Code 风格还差什么

对应的执行路线、阶段拆分、验收标准与文档同步策略，统一放在：

- `docs/refactor/CLAUDE_CODE_ALIGNMENT_PLAN.md`

两者应保持分工清晰：

- 本文档是诊断
- 主规划文档是路线图
