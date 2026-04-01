# Claude Code 对标演进路线图

本文档用于定义当前项目在工具运行时、权限模型、生命周期机制、结果协议与前端执行展示上的后续收敛方向。

## 1. 背景与目标

当前仓库已经完成一轮以 Agent 为中心的架构收敛：

- 本地工具统一迁移到 `@tool()` 注册链路
- `ToolRegistry` 已成为运行时唯一读模型
- `tools/runtime/executor.py` 已收口 direct tool / MCP tool 执行主链
- Skill 已收敛为 system tools + script + artifact 协议
- MCP 已形成“外部展开、内部单 gateway”模型
- 前端已形成 `execution.step` + artifact 渲染链
- memory 已落地为“索引注入 + 按需读取”的轻量模型

因此，本次对标不是推倒重来，而是在现有基础上继续收敛语义、补齐运行时核心对象、权限分层、hooks 与大结果回读闭环。

目标是建立一套更统一的工具运行时语义，使 direct / skill / builtin / agent / MCP 能力共享一致的暴露、执行、审批、观测和结果回读模型。

## 2. 当前基础与已完成能力

以下能力已构成后续演进的稳定基础，应直接复用：

### 2.1 工具注册与读模型

- `backend-fastapi/tools/decorators.py`
  - `@tool()` 已成为本地工具统一注册入口
- `backend-fastapi/tools/tool_registry.py`
  - `ToolRegistry` 已统一输出 direct / skill / builtin / agent / MCP 工具视图

### 2.2 运行时执行链

- `backend-fastapi/tools/runtime/executor.py`
  - 已收口审批、timeout、handler 分发、MCP gateway 转发与结果规范化
- `backend-fastapi/tools/runtime/dispatcher.py`
  - 已成为本地工具 handler 与 MCP gateway 的统一分发入口

### 2.3 Skill 与 Artifact

- `backend-fastapi/tools/local/skill_tools.py`
  - Skill 已收敛为激活、资源加载、脚本执行与 artifact 协议桥接
- `backend-fastapi/tools/artifacts/visualization_artifact_manager.py`
  - 已具备 artifact 持久化与修订能力

### 2.4 MCP 运行时

- `backend-fastapi/tools/runtime/mcp_gateway.py`
  - MCP 已完成“外部展开、内部 gateway”
- 对 Agent 而言仍暴露 `mcp__<server>__<tool>`，因此 prompt contract 与现有工具面保持稳定

### 2.5 前端执行展示链

- `frontend-client/src/utils/executionProjector.js`
  - `execution.step` 已成为前端执行树唯一事实来源
- `frontend-client/src/components/VisualizationLoader.vue`
  - 已具备 artifact 拉取与渲染链路

### 2.6 Memory 模型

- `backend-fastapi/services/agent_api_runtime_service.py`
  - 已在上下文构建阶段注入 MEMORY 索引头部并提供按需读取入口
- `backend-fastapi/services/memory_store.py`
  - 已具备 Markdown MemoryStore、多 scope 索引与条目重建能力

## 3. 对标范围与非目标

### 3.1 对标范围

本轮对标关注以下能力域：

- 工具注册与暴露模型
- 工具执行上下文
- 权限与审批分层
- 生命周期 hooks
- 可观测与结果协议
- 大结果持久化与标准回读
- 前端执行树与工具语义对齐

### 3.2 非目标

本轮不做以下事项：

- 不重写现有 Agent 主循环
- 不推翻现有 `@tool()` 注册体系
- 不改变现有 MCP 对外展开命名
- 不回退已完成的 Skill 化与 artifact 化收敛
- 不为了兼容旧路径增加新的双轨模型

## 4. 目标能力蓝图

目标形态可以概括为“统一工具分类 + 统一执行上下文 + 统一结果协议 + 统一策略管线”：

### 4.1 统一 Tool Universe

所有可执行能力都应进入同一运行时宇宙：

- direct tools
- document tools
- builtin tools
- agent delegation tools
- skill system tools
- MCP tools

统一后，ToolRegistry 与运行时不再只是在“合同层面”并列这些能力，而是能在暴露、授权、执行、可观测、结果持久化上共享一致语义。

### 4.2 统一 ToolUseContext

引入 Claude Code 风格的厚上下文对象，统一承载：

- session / run / workspace / agent / caller
- permission mode / policy decision / approval state
- observability fields / call tree / parent_call_id
- artifact store / result store / managed paths
- hooks 上下文

这样 hooks、权限分层、大结果物化与前端可观测协议都能挂在同一个运行时核心对象上，而不是散落在 executor、dispatcher、approval、path resolution 与前端 projector 之间。

### 4.3 统一策略与审批管线

当前系统已经具备 approval gate，但仍偏向“是否审批”的单点判定。目标形态应升级为统一策略管线：

- visible tools：Agent 当前可见哪些工具
- executable tools：运行时当前允许执行哪些工具
- approval required：当前调用是否需要用户确认
- auto-accept：当前调用是否可自动通过
- hook mutation：hooks 是否允许变更参数、阻断执行或补充审计信息

### 4.4 统一结果协议

工具调用应稳定产出结构化协议，而不仅是统一 dataclass：

- progress
- approval
- result summary
- raw result ref
- artifact ref
- large payload materialization ref
- retry / error classification

前端执行树应展示“工具语义节点”，而不是过度暴露“底层脚本调用细节”。

## 5. 关键差距摘要

当前项目与 Claude Code 风格相比，关键差距主要集中在以下方面：

1. 缺少统一的厚 `ToolUseContext`
2. 缺少“工具暴露权限”和“执行权限”的双层模型
3. hooks 尚未成为工具生命周期一等机制
4. direct / skill / MCP / agent 虽已同宇宙化，但仍未形成完整统一协议
5. progress / result / approval 仍未收敛为完整结构化协议
6. 大结果物化与标准回读闭环仍不稳定
7. 前端执行树对 skill / direct tool 的观测语义仍可能存在错位

## 6. 分阶段执行计划

### Phase 0：文档建档与索引收口

目标：先建立单一信息源。

范围：

- 新建 `docs/refactor/CLAUDE_CODE_ALIGNMENT_PLAN.md`
- 新建 `docs/refactor/TOOLING_GAP_ANALYSIS_VS_CLAUDE_CODE.md`
- 更新 `docs/README.md`
- 更新 `docs/refactor/README.md`
- 在以下文档补充相关规划引用：
  - `backend-fastapi/docs/architecture.md`
  - `backend-fastapi/docs/tools.md`
  - `frontend-client/docs/architecture.md`

验收：

- 文档入口统一可达
- 主规划与差异分析职责清晰分离
- 三份架构文档都能指向本路线图

### Phase 1：工具体系语义收敛

目标：先清理现有不一致，再扩展运行时。

重点工作：

- 合并 direct tool 启用推导真源
  - 当前存在重复逻辑：
    - `backend-fastapi/agents/config/loader.py`
    - `backend-fastapi/tools/permissions.py`
- 统一 memory 工具默认启用语义与文档表述
- 明确 `risk_level` 与 `requires_approval` 的职责边界
- 统一 direct tool / skill / builtin / agent 在可观测层的展示口径

涉及文档回写：

- `backend-fastapi/docs/architecture.md`
- `backend-fastapi/docs/tools.md`
- `frontend-client/docs/architecture.md`

### Phase 2：引入统一 ToolUseContext 与协议模型

目标：建立 Claude Code 风格的工具运行时核心对象。

重点工作：

- 为 executor / dispatcher / approvals / artifact / path resolution 提供统一上下文对象
- 统一 session、run、workspace、agent、caller、parent_call_id、tool_call_id 等字段承载方式
- 将 observability、artifact store、result store 与 managed path 访问收口到该对象
- 为 hooks 和结果物化提供统一挂载点

涉及关键模块：

- `backend-fastapi/tools/runtime/executor.py`
- `backend-fastapi/tools/runtime/dispatcher.py`
- `backend-fastapi/tools/runtime/approvals.py`
- `backend-fastapi/tools/paths/path_resolution.py`
- `backend-fastapi/tools/contracts/`

### Phase 3：权限与生命周期升级

目标：把“审批”升级为“策略管线”。

重点工作：

- 区分工具可见面与执行授权面
- 引入更明确的 policy decision 结构
- 增加 before/after/error 等生命周期 hooks
- 使 auto-accept、approval、hook decision、policy decision 进入同一判定链

涉及关键模块：

- `backend-fastapi/tools/permissions.py`
- `backend-fastapi/tools/runtime/approvals.py`
- `backend-fastapi/tools/runtime/executor.py`
- 后续新增的 hooks 模块

### Phase 4：统一 Tool Universe 与结果回读闭环

目标：完成 Claude Code 风格工具宇宙收口。

重点工作：

- 为现有 direct / skill / builtin / agent / MCP 能力进一步统一执行协议
- 建立大结果物化 + 标准引用 + 前端回读展示闭环
- 让执行树展示逻辑反映“工具语义”，而不是仅显示底层 `execute_skill_script`

涉及关键模块：

- `backend-fastapi/tools/runtime/executor.py`
- `backend-fastapi/tools/local/skill_tools.py`
- `backend-fastapi/tools/artifacts/visualization_artifact_manager.py`
- `frontend-client/src/utils/executionProjector.js`
- `frontend-client/src/components/VisualizationLoader.vue`

## 7. 文档同步策略

后续每完成一个阶段，都必须同步回写架构事实，而不是只更新规划文档。

### 7.1 必须回写的文档

- `backend-fastapi/docs/architecture.md`
- `backend-fastapi/docs/tools.md`
- `frontend-client/docs/architecture.md`

### 7.2 回写原则

- Phase 0：先补引用入口，不提前写成“已完成”
- Phase 1 以后：每完成一个阶段，再把对应事实写回架构正文
- 若某阶段改变术语或语义边界，必须同步更新前后端文档中的同名表述
- 差异分析文档负责解释“为什么改”，架构文档负责描述“当前真实系统是什么”

## 8. 验收标准

路线图建档完成后，应满足以下标准：

### 8.1 文档层面

- 仓库级与 refactor 级索引均可找到本路线图
- 三份架构文档均提供相关规划引用入口
- 主规划文档只负责蓝图、阶段、验收与同步策略，不与差异分析混写

### 8.2 内容层面

- 明确区分“已完成基础”“可复用基础”“差距”“后续阶段”
- 每个阶段都能映射到具体模块与文档回写范围
- 不将现有系统写成推倒重来，而是写成基于当前成果继续演进

### 8.3 后续执行层面

- 路线图可直接拆分为后续开发任务
- 各阶段输入输出边界明确
- 后续实现完成后，可依据本路线图逐阶段核对架构文档、工具实现与前端展示是否同步收敛
