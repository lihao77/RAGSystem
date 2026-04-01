# 工具 Runtime 重构总结（2026-04-01）

> **当前对标度**：~85%
>
> **当前主要剩余差距**：Hooks 系统、可观测语义统一

## 重构目标

对照 Claude Code 源码架构，修复当前工具执行链路中的设计问题，消除不必要的复杂度和耦合。

## 核心修复

### 1. 移除死代码 hooks 骨架

**问题**：`executor.py` 中的 `_run_hooks` 是空函数，但已插入 5 个执行阶段（before_permission / after_permission / before_execute / after_execute / on_error），每次工具调用白跑 5 次函数 + 5 次 dict merge，且无任何扩展点。

**修复**：完全移除 `_run_hooks` 和 `HookResult`。Claude Code 的 hooks 是真实的 shell 命令执行系统（从 settings.json 读取配置，spawn 子进程），不是空壳骨架。当前系统无 hook registry，不应在主链路调用。

### 2. ToolUseContext 改为只读输入袋

**问题**：`ToolUseContext` 在执行过程中被不断 mutate（`approval_state` / `metadata` / `arguments` / `handler_kind` 等），既是输入参数又是 mutable accumulator，违背 Claude Code 的只读模式。

**修复**：
- 移除所有在执行中 mutate 的字段（`approval_state` / `metadata` / `timeout_seconds` / `handler_kind` / `handler_name` / `exposure_decision` / `permission_decision`）
- `approval_message` 通过返回值传递，不写回 context
- `ToolUseContext` 现在是纯输入环境袋，不承载执行过程状态

### 3. 移除 executor 里的 result envelope 包装

**问题**：`_materialize_result_envelope` 在 executor 中被调用两次（正常路径 + 异常路径），且做了 `result.metadata.update()` 这种 side-effect mutation。Claude Code 的大结果预算控制通常在查询边界处理；当前系统则已将该能力收敛到 Observation 路径，而不是继续放在 executor 里。

**修复**：
- 移除 `_materialize_result_envelope` 和 `_materialize_large_payload`
- 移除 `build_tool_result_envelope` 和 `result_envelope_payload`
- `base.py` / `tool_router.py` 直接用 `result_display_text` + `result_event_payload`
- 事件链路（publisher / step_projector / frontend projector）不再传递 `result_envelope` / `result_ref` / `resource_refs` / `artifacts`，只保留 `result_preview` / `raw_result` / `approval_message`

### 4. PermissionDecision 精简为三态决策

**问题**：`PermissionDecision` 塞了 9 个字段（`visible` / `enabled_for_agent` / `caller_allowed` / `role_allowed` / `execution_allowed` / `requires_approval` / `risk_level` / `permission_mode` / `deny_reason` 等），其中很多是内部推导字段，不应暴露。

**修复**：
- 只保留 `execution_allowed` / `requires_approval` / `deny_reason` / `approval_message` / `risk_level` / `permission_mode` / `resolved_from`
- 对应 Claude Code 的 `allow | deny | ask` 三态语义
- `evaluate_tool_permission` 不再构造中间字段，直接返回最终决策

### 5. exposure 快速路径避免全量计算

**问题**：`get_tool_exposure_decision` 每次调用都走全量 `resolve_effective_tool_exposure`（遍历所有 direct / memory / skill / builtin / delegation / MCP 工具），在 `execute_tool` 热路径上有性能隐患。

**修复**：
- `get_tool_exposure_decision` 改为单工具快速查询，按来源做针对性检查（builtin → skill → memory → agent → MCP → direct）
- 全量 `resolve_effective_tool_exposure` 仅在 loader 阶段（`_resolve_tools_and_skills`）调用
- 避免每次工具执行都全量遍历

### 6. 去掉 union 签名的过渡兼容

**问题**：`execute_mcp_tool` 和 `request_user_approval_if_needed` 有 `context_or_tool_name` 这种 union 签名，类型模糊且无旧调用方。

**修复**：
- `execute_mcp_tool` 只接受 `ToolUseContext`
- `request_user_approval_if_needed` 只接受 `ToolUseContext`
- `dispatcher.py` 的 `execute_mcp_tool` 直接透传 context

## 文件改动清单

### 核心 runtime
- `tools/runtime/models.py`：精简 `PermissionDecision`，移除 `HookResult`，`ToolUseContext` 改为只读
- `tools/runtime/executor.py`：移除 `_run_hooks` / `_materialize_result_envelope`，简化主链路
- `tools/runtime/approvals.py`：只接受 `ToolUseContext`，不 mutate context
- `tools/runtime/dispatcher.py`：`execute_mcp_tool` 只接受 context
- `tools/runtime/mcp_gateway.py`：去掉 union 签名
- `tools/runtime/exposure.py`：`get_tool_exposure_decision` 改为快速路径
- `tools/permissions.py`：`evaluate_tool_permission` 精简决策字段

### 结果引用
- `tools/refs/result_references.py`：移除 `build_tool_result_envelope` / `_materialize_large_payload` / `result_envelope_payload`

### 事件链路
- `agents/core/base.py`：不再调用 `result_envelope_payload`，直接用 `result_display_text`
- `agents/implementations/orchestrator/tool_router.py`：同上
- `agents/events/publisher.py`：移除 `result_envelope` / `resource_refs` / `artifacts` 参数
- `execution/step_projector.py`：不再从 `result_envelope` 取字段

### 前端
- `frontend-client/src/utils/executionProjector.js`：移除 `result_envelope` / `result_ref` / `resource_refs` / `artifacts` 字段
- `frontend-client/src/utils/executionProjector.test.js`：同步测试数据

### 测试
- `agents/tests/test_core/test_runtime_approvals.py`：注册测试工具权限
- `agents/tests/test_core/test_step_projector.py`：移除 envelope 断言
- `agents/tests/test_core/test_tool_permissions.py`：移除 `visible` / `enabled_for_agent` 断言

## 架构对齐

| 维度 | 修复前 | 修复后（对齐 Claude Code） |
|------|--------|---------------------------|
| Hooks | 空函数骨架插入主链路 | 移除，未来需要时再加真实 registry |
| ToolUseContext | mutable accumulator | 只读输入袋 |
| 大结果落盘 | executor 里 `_materialize_result_envelope` | Observation 路径承接（`ObservationPolicy` + `LargePayloadFormatter` + `ArtifactStore`） |
| PermissionDecision | 9 个字段，内部推导暴露 | 3 态决策（allow/deny/ask） |
| Exposure 查询 | 每次全量遍历 | 单工具快速路径 |
| Result envelope | 事件链路反复拆装 | 移除，只传 preview + raw_result |

## 测试验证

所有相关测试通过：
- `test_memory_tools_are_enabled_via_effective_direct_tools` ✓
- `test_project_run_end_preserves_display_name` ✓
- `test_user_approval_event_includes_permission_mode_and_reason` ✓
- `test_permission_decision_distinguishes_exposure_and_execution` ✓

## 后续建议

1. **Hooks 系统**：当前已移除空壳，未来需要时参考 Claude Code 实现真实的 shell 命令执行 + registry
2. **可观测语义统一**：统一 direct/skill 的前端展示语义，避免暴露底层 `execute_skill_script`
3. **MCP 细粒度权限**：从 server 级进一步演进到 tool 级 override
4. **Exposure 缓存**：当前已优化为快速路径，未来可考虑在 agent_config 级别做 LRU 缓存（但要注意 MCP 工具动态性）
5. **PermissionDecision 扩展**：当前已精简为三态，未来如需更细粒度的权限元数据（如 hook 来源、classifier 结果），可通过 `resolved_from` 或新增 `metadata` 字段扩展

## 影响范围

- **向后兼容**：事件结构变化（移除 envelope 字段），前端已同步修改
- **性能提升**：移除 5 次空 hook 调用 + exposure 全量遍历，工具执行热路径更轻量
- **代码简化**：移除 ~200 行死代码（hooks / envelope / union 签名），主链路更清晰
