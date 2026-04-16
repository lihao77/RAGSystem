# 重构与演进专题

本目录用于集中存放当前仍在维护的重构、收敛与演进专题文档，是仓库当前专题的一部分，而不是归档区。

## 当前专题文档

- `CLAUDE_CODE_ALIGNMENT_PLAN.md`
  - Claude Code 对标演进路线图
  - 定义对标范围、目标能力蓝图、分阶段执行计划与验收标准

- `TOOLING_GAP_ANALYSIS_VS_CLAUDE_CODE.md`
  - 当前项目工具体系与 Claude Code 的差异分析
  - 聚焦工具注册、执行上下文、权限、hooks、结果协议与大结果回读的差异诊断

- `RUNTIME_EXECUTION_GAPS_AND_ROADMAP.md`
  - 运行时缺陷分析与实施路线（2026-04-14，2026-04-16 已校正状态）
  - D1 工具并行、D2 后台任务自动注入、D3 文件变更回退（git worktree 隔离）、D4 日志治理均已完成；当前主线剩余子 Agent 并行（D5）与超时熔断（D6）

## 历史归档入口

- `../archive/refactor/AGENT_FIRST_REFACTOR_PLAN.md`
  - 历史重构方案
  - 已不再作为当前主线规划文档维护，仅保留参考价值

## 维护原则

- 当前有效的重构与演进文档统一放在本目录。
- 本目录只收录仍在维护的当前专题，不放已废弃或已被替代的历史方案。
- 已废弃、已替代或只保留历史参考价值的方案应迁移到 `docs/archive/`。
- 返回仓库级主线导航时，以 `docs/README.md` 为上层入口。
