# 重构与演进专题

本目录用于集中存放当前仍在维护的重构、收敛与演进专题文档，是仓库当前专题的一部分，而不是归档区。

## 当前专题文档

### Agent 体验与工具体系

- `ADAPTIVE_AGENT_EXPERIENCE_PLAN.md`
  - AutoDream 记忆治理方案（2026-05-26 修订）
  - 三个 Phase：Memory candidate 状态 → AutoDream MVP（只读扫描 + Dream 报告 + 索引重建）→ Dream 工厂页面（治理入口 + 记忆浏览）
  - 工程约束：成本控制（fast tier）、增量式数据迁移、进程内并发安全
  - 后续演进：反馈闭环、Skill 化、执行语义、评测集、权限调优、专用 Team

- `AGENT_SUBAGENT_REFACTOR.md`
  - 子 Agent 重构的当前实现、消息协议、恢复边界、阶段提交和验收命令（2026-08-09）

- `CLAUDE_CODE_ALIGNMENT_PLAN.md`
  - Claude Code 对标演进路线图
  - 定义对标范围、目标能力蓝图、分阶段执行计划与验收标准

- `TOOLING_GAP_ANALYSIS_VS_CLAUDE_CODE.md`
  - 当前项目工具体系与 Claude Code 的差异分析
  - 聚焦工具注册、执行上下文、权限、hooks、结果协议与大结果回读的差异诊断
  - 已并入原 `REMAINING_GAPS.md` 的有效残余（权限扩展点、流程可视化、集成测试）

- `TS_TOOL_SYSTEM_REFACTOR_PLAN.md`
  - TS 端智能体工具体系重构方案（Tool-centric · Zod · 输入校验/并发调度/权限三层合议）

- `OBSERVATION_VS_PREVIEW.md`
  - observation（面向 LLM）与 preview（面向前端）两个结果视角的概念区分

- `RENDERING_CONTRACT_NOTES.md`
  - 前端渲染边界契约：chart.echarts 呈现、Artifact V2 空间资产、`map_*` host tool 约定

### 事件与运行时架构

- `SESSION_LIST_ORIGIN_WORKSPACE_PLAN.md`
  - 会话列表来源、时间排序与 Workspace 升级方案（Clean Break）

- `TS_EVENT_ARCHITECTURE_PLAN_V2.md` ⭐ **推荐**
  - TS 后端事件架构落地方案 V2（2026-06-07，基于实际代码约束修订）
  - 关键优化：补齐事务 facade、`event_seq`/`stream_seq` 分离、terminal path 事件矩阵、dispatcher shadow 模式、5 个渐进式 Phase

- `TS_EVENT_ARCHITECTURE_OPTIMIZATION_SUMMARY.md`
  - V1→V2 方案优化总结
  - 代码诊断过程、关键技术决策、V2 修订点、实施建议

- `TS_EVENT_ARCHITECTURE_EVALUATION.md`
  - V1 与修订后 V2 的评估结论
  - 说明初版 V2 的阻塞点，以及修订后为何可作为实施基线

## 历史归档入口

以下文档已迁移至 `../archive/refactor/`，仅保留参考价值：

- `AGENT_FIRST_REFACTOR_PLAN.md` — 历史重构方案
- `TS_EVENT_ARCHITECTURE_PLAN.md` — 事件架构落地方案 V1（已被 V2 取代）
- `RUNTIME_EXECUTION_GAPS_AND_ROADMAP.md` — 运行时缺陷修复路线（D1–D4 均已完成）
- `TS_BACKEND_FULL_MIGRATION_PLAN.md` — Python→TS 后端全量迁移计划（迁移已完成）
- `TASK_TODO_TOOLS_MIGRATION.md` — Task/Todo 工具移植方案（已落地）
- `RUNTIME_REFACTOR_SUMMARY.md` / `TOOL_WORKFLOW.md` / `TOOL_WORKFLOW_COMPARISON.md` / `TOOL_PROMPT_REFACTOR.md` — Python 后端时代的工具运行时文档
- `REMAINING_GAPS.md` — 工具体系剩余差距清单（有效残余已并入 TOOLING_GAP_ANALYSIS）
- `EVENT_BUS_OPTIMIZATION_PLAN.md` — Event Bus 优化计划（针对已移除的 Python 后端事件总线）

## 维护原则

- 当前有效的重构与演进文档统一放在本目录。
- 本目录只收录仍在维护的当前专题，不放已废弃或已被替代的历史方案。
- 已废弃、已替代或只保留历史参考价值的方案应迁移到 `docs/archive/`。
- 返回仓库级主线导航时，以 `docs/README.md` 为上层入口。
