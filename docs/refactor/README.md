# 重构与演进专题

本目录用于集中存放当前仍在维护的重构、收敛与演进专题文档，是仓库当前专题的一部分，而不是归档区。

## 当前专题文档

- `ADAPTIVE_AGENT_EXPERIENCE_PLAN.md`
  - AutoDream 记忆治理方案（2026-05-26 修订）
  - 三个 Phase：Memory candidate 状态 → AutoDream MVP（只读扫描 + Dream 报告 + 索引重建）→ Dream 工厂页面（治理入口 + 记忆浏览）
  - 工程约束：成本控制（fast tier）、增量式数据迁移、协程并发安全（asyncio.Lock）
  - 后续演进：反馈闭环、Skill 化、执行语义、评测集、权限调优、专用 Team

- `CLAUDE_CODE_ALIGNMENT_PLAN.md`
  - Claude Code 对标演进路线图
  - 定义对标范围、目标能力蓝图、分阶段执行计划与验收标准

- `TOOLING_GAP_ANALYSIS_VS_CLAUDE_CODE.md`
  - 当前项目工具体系与 Claude Code 的差异分析
  - 聚焦工具注册、执行上下文、权限、hooks、结果协议与大结果回读的差异诊断

- `RUNTIME_EXECUTION_GAPS_AND_ROADMAP.md`
  - 运行时缺陷分析与实施路线（2026-04-14，2026-04-16 已校正状态）
  - D1 工具并行、D2 后台任务自动注入、D3 文件变更回退（git snapshot）、D4 日志治理均已完成；子 Agent 重构已完成统一 invocation、durable mailbox、双向消息、并行聚合和前端投影。子 Agent 当前统一复用父 workspace，不启用 worktree 隔离。

- `AGENT_SUBAGENT_REFACTOR.md`
  - 子 Agent 重构的当前实现、消息协议、恢复边界、阶段提交和验收命令（2026-08-09）

- `TS_EVENT_ARCHITECTURE_PLAN.md`
  - TS 后端事件架构落地方案 V1（2026-06-07）
  - 当前事件关系、目标架构、Recorder + Outbox + Dispatcher + Projection 分层、分阶段迁移和验收标准
  
- `TS_EVENT_ARCHITECTURE_PLAN_V2.md` ⭐ **推荐**
  - TS 后端事件架构落地方案 V2（2026-06-07，基于实际代码约束修订）
  - 关键优化：补齐事务 facade、`event_seq`/`stream_seq` 分离、terminal path 事件矩阵、dispatcher shadow 模式、5 个渐进式 Phase
  - 相比 V1：首期范围更聚焦，实施前置风险更清晰，回滚和验收标准更具体
  
- `TS_EVENT_ARCHITECTURE_OPTIMIZATION_SUMMARY.md`
  - V1→V2 方案优化总结
  - 代码诊断过程、关键技术决策、V2 修订点、实施建议

- `TS_EVENT_ARCHITECTURE_EVALUATION.md`
  - V1 与修订后 V2 的评估结论
  - 说明初版 V2 的阻塞点，以及修订后为何可作为实施基线

## 历史归档入口

- `../archive/refactor/AGENT_FIRST_REFACTOR_PLAN.md`
  - 历史重构方案
  - 已不再作为当前主线规划文档维护，仅保留参考价值

## 维护原则

- 当前有效的重构与演进文档统一放在本目录。
- 本目录只收录仍在维护的当前专题，不放已废弃或已被替代的历史方案。
- 已废弃、已替代或只保留历史参考价值的方案应迁移到 `docs/archive/`。
- 返回仓库级主线导航时，以 `docs/README.md` 为上层入口。
