# 运行时缺陷分析与实施路线（2026-04-14）

> 状态更新（2026-04-16）：经代码复审，D1（工具并行执行）与 D2（后台任务完成结果自动注入）均已完成。`BaseAgent._handle_actions()` 已按 `result_N` 依赖分批，并在批次内使用 `ThreadPoolExecutor` 并行执行；后台任务完成后也已通过 session 通知队列与 waiting loop 自动注入 Agent observation。本文其余内容若仍将 D1 / D2 标记为待做，均属于过期结论，已在本次更新中修正。

> 状态更新（2026-04-16）：D3（文件变更回退）已完成并再次收敛。对齐 Claude Code 分层设计：入口 agent 直接在用户原目录操作（不创建 worktree），并在**用户消息提交时**把当前文件状态锚定到该条用户消息的 `snapshot_commit`；非 git 目录就地 `git init`，session 清理时移除。用户执行对话回退时，系统直接读取目标用户消息的 `snapshot_commit` 并自动 `git reset --hard`，不再依赖 run 结束 snapshot 或 assistant `run_id` 反查。Worktree 基础设施保留给 D5 子 Agent 并行隔离。核心模块：`utils/worktree.py`。

> 目标：沉淀当前系统在运行时/执行层相对 Claude Code 的关键差距，并给出可直接排期实施的顺序化路线。
>
> 范围：只讨论运行时、工具执行、后台任务、回退、日志与多 Agent 执行相关能力；不重复讨论已完成的 Hooks、大结果落盘、上下文压缩等能力。

---

## 0. 先说结论

当前系统的主要剩余短板已经收敛到**执行编排层的后半段能力**：

1. **工具并行执行已完成**，`BaseAgent._handle_actions()` 已支持按 `result_N` 依赖分批，并在批次内并行执行。
2. **后台任务闭环已完成**，后台任务完成结果已可通过 session 通知队列与 waiting loop 自动注入 Agent 语境。
3. **文件变更回退已完成**，采用用户消息锚点 + git snapshot 的设计：用户消息提交时绑定 `snapshot_commit`，对话回退时自动恢复到该锚点。
4. **日志主线治理已完成**，后续更偏向降噪与体验优化，而不是补主线缺口。
5. **子 Agent 调度仍缺专门的并行能力确认与专项验收**，虽然已受益于工具层并行调度，但仍值得单独作为上层编排能力评估。
6. **超时只有单次超时控制，没有重试/熔断策略**。

**已确认不是缺陷的项**：
- 上下文压缩：**已有**，不属于当前缺口。
- Hooks：**已完成**，不再纳入本报告。
- 大结果落盘：**已完成**，不再纳入本报告。
- D1 工具并行执行：**已完成**。
- D2 后台任务自动注入：**已完成**。
- D3 文件变更回退：**已完成**（用户消息锚点 + git snapshot）。

---

## 1. 缺陷总览与优先级

| 编号 | 缺陷 | 优先级 | 当前状态 | 建议策略 |
|---|---|---:|---|---|
| D1 | 工具并行执行 | - | 已完成 | 转为已交付能力，保留验收结论 |
| D2 | 后台任务闭环 | - | 已完成（含自动注入） | 转为已交付能力，保留闭环说明 |
| D3 | 文件变更无系统级回退 | - | 已完成（用户消息锚点 + git snapshot） | 转为已交付能力 |
| D4 | 日志统一治理 | - | 主线治理已完成 | 后续仅做降噪/体验优化 |
| D5 | 子 Agent 并行能力专项收口 | P1 | 需补专项验证与文档收口 | 在 D3 之后推进 |
| D6 | 超时重试/熔断缺失 | P1 | 只有 timeout | 与 D5 同批或随后推进 |

---

## 2. 已验证事实

### 2.1 工具执行现状：已支持依赖分批并行

**关键证据**：
- `backend-fastapi/agents/core/base.py` 中 `_build_execution_batches()` 会按 `result_N` 依赖对 actions 分批。
- 同文件 `_handle_actions()` 对单个批次使用 `ThreadPoolExecutor` 并行执行，并在批次之间保持串行。
- `_execute_single_action()` 在并发执行时通过 `threading.Lock()` 保护共享结果与历史记录。
- `backend-fastapi/tools/runtime/executor.py` 仍是**单工具执行入口**；并行调度发生在 agent core 层，而非 runtime executor 批量 API。

**结论**：
- 当前系统已支持“同一轮多个独立工具并行执行”。
- 当前实现本质是：
  `LLM 输出 -> actions 列表 -> 依赖分批 -> 批次内并行执行 -> observations 稳定合并 -> 下一轮推理`

---

### 2.2 后台任务现状：闭环已完成

**关键证据**：
- `backend-fastapi/tools/local/bash_tool.py` 已支持 `run_in_background=true`。
- `backend-fastapi/tools/runtime/background_tasks.py` 已具备后台任务管理器，支持：
  - 启动任务
  - 输出落盘
  - 状态记录
  - 超时结束
  - 完成事件发布
  - session 级完成通知入队
  - session 空闲时自动触发通知消费
- `BACKGROUND_TASK_COMPLETED` 事件已接入 EventBus，并可经 SSE 推送到前端。
- 系统已经提供 `task_output` / `task_stop` 供 Agent 查询、显式等待与停止后台任务。
- `backend-fastapi/agents/core/base.py` 中 `_drain_pending_notifications()` 会在 run 开始、每轮开始和工具执行后消费 session 通知队列并注入 observation。
- 同文件 `_run_waiting_loop()` / `_append_waiting_observation()` 会对等待中的后台任务做即时唤醒与 observation 注入。

**结论**：
- 当前后台执行已经不是单纯 fire-and-forget，而是具备查询、停止、显式等待与自动注入的完整闭环。
- 自动注入采用“session 通知队列 + waiting loop 定向消费”实现，而不是全局 completed/unconsumed 扫描；差异在实现形态，不在能力闭环。

---

### 2.3 回退能力现状：已完成（git snapshot 回退，对齐 Claude Code 分层）

**已落地能力**：
- `backend-fastapi/utils/worktree.py`：拆分为 Snapshot 层（通用）+ Worktree 层（保留给 D5 子 Agent 并行）。
- `backend-fastapi/services/agent_api_runtime_service.py`：`_get_session_workspace_root` 调用 `ensure_git_snapshot` 启用回退能力，不再创建 worktree 或重定向 workspace。
- `backend-fastapi/services/agent_execution_service.py`：用户消息提交时先稳定当前 git 状态，再将 `snapshot_commit` 直接写入用户消息 metadata。
- `backend-fastapi/application/agent_session.py`：对话回退时直接读取目标用户消息上的 `snapshot_commit` 自动恢复文件；session 删除时自动清理 snapshot 元数据（若为 agent 创建的 .git 则一并清理）。

**核心机制**：
- 入口 agent 直接在用户原目录操作，不创建 worktree
- 已有 git repo → 直接利用 git 做 snapshot
- 非 git 目录 → 就地 `git init`，session 清理时移除 `.git`
- 用户消息提交时：若当前 workspace 有未提交变更，先提交一个 snapshot，再把当时 `HEAD` 写入该条用户消息的 `snapshot_commit`
- 对话回退时：直接读取目标用户消息的 `snapshot_commit` 自动执行 `git reset --hard`
- Worktree 基础设施保留给 D5 子 Agent 并行隔离

**验收结论**：
- 对齐 Claude Code 分层设计：回退层（FileHistory）与隔离层（Worktree）分离。
- 主对话在原目录操作，用户消息直接携带文件锚点；对话回退时消息状态与文件状态自动联动恢复。

---

### 2.4 日志系统现状：基础健康，但缺统一治理

**好的部分**：
- 大部分代码遵循 `logger = logging.getLogger(__name__)`。
- 核心模块（tools/runtime、hooks、services、daemon）日志命名总体规范。
- 已新增统一日志入口 `backend-fastapi/core/logging_config.py`，启动入口已统一初始化 logging。
- `execution/observability.py` 与 `middleware/logging.py` 已作为 request/run 级日志上下文真源复用。

**主要问题**：
1. 历史上 `main.py` 使用最简单的 `logging.basicConfig(level=logging.INFO)`，且注释掉了按环境变量调级的版本；现已收敛到统一入口。
2. 历史悬空的 `structured_logger.py` 已删除，避免形成第二套日志主线。
3. 运行时核心路径与独立脚本中的 `traceback.print_exc()` / `print()` 已基本收敛到 logger。
4. `agents/core/base.py` 的模块级 logger / `self.logger` 混用已收敛为实例 logger 主线。
5. 当前剩余工作更偏向日志降噪与体验优化，而非主线治理缺失。

**结论**：
- D4 主线治理已完成：统一 logging 入口、`LOG_LEVEL` 恢复、运行时核心与脚本输出已收敛、悬空 `structured_logger` 已移除。
- 后续如继续投入，应聚焦脚本模式下的降噪与更细粒度观测，而不是再建设第二套日志体系。

---

### 2.5 子 Agent 执行现状：会话能力已完成，并已受益于工具层并行

**现状**：
- `call_agent` / `send_message` / `list_child_agents` 已完成子 Agent 会话能力。
- `BaseAgent._handle_actions()` 已具备按依赖分批的并行调度能力，因此多个无依赖 agent 类工具调用在运行时调度层不再天然受限于串行 for 循环。
- 当前仍缺针对多 `call_agent` 并发场景的专项验收与文档口径收口。

**结论**：
- 子 Agent 能力基础已经具备，运行时底层并行能力也已就位。
- 当前更准确的剩余问题不是“完全缺少并行”，而是**缺少子 Agent 并行的专项收口与验收结论**。

---

### 2.6 超时控制现状：只有 timeout，没有恢复策略

**现状**：
- `execute_tool()` 已有单次 timeout 控制。
- 超时/失败后直接错误返回，没有：
  - 幂等重试
  - 熔断
  - 健康状态记忆
  - 失败降级策略

**结论**：
- 当前系统能“停止一次失败”，但不能“管理持续失败”。

---

## 3. 实施路线总览

推荐实施顺序如下：

### 当前主线
1. **D5 子 Agent 并行专项收口**
2. **D6 超时重试 / 熔断**

### 已完成能力（不再列入实施主线）
- D1 工具并行执行
- D2 后台任务闭环（含自动完成注入）
- D3 文件变更回退（git worktree 隔离）
- D4 日志主线治理

---

## 4. 每项的推荐实施方案

## D4. 日志统一治理（建议最先做）

### 为什么先做
- 改动小、收益高。
- 后续做并行、后台任务、熔断时会显著提升可观测性和调试效率。

### 建议实施内容
1. 新增统一日志配置模块，如：`backend-fastapi/core/logging_config.py`
2. 在启动入口统一初始化 logging，而不是散落 `basicConfig`
3. 恢复并启用 `LOG_LEVEL` 环境变量
4. 收敛悬空的 `agents/logging/structured_logger.py`，统一到标准 logging 主线
5. 全局替换：
   - `traceback.print_exc()` -> `logger.error(..., exc_info=True)`
   - 运行时 `print()` -> logger
6. 清理 `agents/core/base.py` 中模块级 logger / `self.logger` 混用问题
7. 复用 `execution/observability.py` 与 `middleware/logging.py`，统一 request/run 级日志上下文

### 验收标准
- 日志格式统一，至少包含时间、级别、logger 名、消息。
- `LOG_LEVEL` 可配置并生效。
- 运行时核心模块与独立验证脚本不再使用 `print()` 和 `traceback.print_exc()`。
- 历史悬空的 `structured_logger.py` 已删除/合并，不再保留第二套日志入口。

---

## D1. 工具并行执行（已完成）

### 已落地实现
1. `BaseAgent._build_execution_batches()` 会分析 arguments 中的 `result_N` 依赖并构建执行批次。
2. `BaseAgent._handle_actions()` 对无依赖批次使用 `ThreadPoolExecutor` 并行执行。
3. 结果完成后按原始 idx 排序，再写入 observations / `tool_calls_history`，保证展示顺序稳定。
4. `execute_tool()` 仍保持单工具执行入口；并行调度统一放在 agent core 层完成。

### 当前边界
- 代码中尚未形成显式的 tool-level `concurrency_safe` 元数据体系，当前主要依靠依赖分批与执行层约束。

### 验收结论
- 同一轮多个无依赖工具可并发。
- 有 `result_1` 引用关系的工具仍按依赖顺序执行。
- observation 与执行历史顺序保持稳定。

---

## D2. 后台任务闭环（已完成）

### Phase 1：Agent 能查、能停、能显式等待

### 已落地能力
- 已提供 `task_output` / `task_stop`。
- 已支持 `task_output(block=true)` 驱动 run 内 waiting loop。
- 后台任务状态、输出路径、退出码与完成状态已统一由后台任务管理器提供。

### Phase 2：完成结果自动进入 Agent 语境

### 已落地能力
1. 后台任务完成时，`background_tasks.py::_publish_completed()` 会将 payload 写入 session 通知队列。
2. `BaseAgent._drain_pending_notifications()` 会在 run 开始、每轮开始和工具执行后自动消费通知并注入 observation。
3. 对正在等待的后台任务，`_run_waiting_loop()` / `_append_waiting_observation()` 会通过事件唤醒 + poll 兜底即时注入结果。
4. session 空闲时还会触发自动通知消费，避免结果长期滞留。

### 验收结论
- Agent 不必手动轮询，也能在后续推理中感知后台任务完成。
- 等待中的后台任务可被即时唤醒并注入 observation。
- 同一任务的自动通知与 waiting loop 路径已做区分，避免重复消费。

---

## D3. 文件变更回退（已完成）

### 实际落地方案：git snapshot 回退，对齐 Claude Code 分层设计

**核心设计**：
- 回退层（Snapshot）与隔离层（Worktree）分离
- 入口 agent 直接在用户原目录操作，不创建 worktree
- 用户消息提交时绑定 `snapshot_commit` 作为文件回退锚点
- 非 git 目录就地 `git init`，session 清理时移除 `.git`
- 对话回退时自动读取目标用户消息的 `snapshot_commit` 执行恢复
- Worktree 基础设施保留给 D5 子 Agent 并行隔离

**已落地模块**：
- `utils/worktree.py`：Snapshot 层（`ensure_git_snapshot` / `create_snapshot` / `get_head_commit` / `snapshot_enabled`）+ Worktree 层（保留）
- `services/agent_api_runtime_service.py`：`ensure_git_snapshot` 启用回退，不重定向 workspace
- `services/agent_execution_service.py`：用户消息提交时绑定 `snapshot_commit`
- `application/agent_session.py`：对话回退时按用户消息 `snapshot_commit` 自动恢复；session 删除时 `cleanup_snapshot`

### 验收结论
- 对齐 Claude Code 分层：主对话在原目录操作 + 用户消息携带文件锚点
- git repo / 非 git 目录 / 系统默认目录均支持
- 对话回退时消息与文件可自动联动恢复

---

## D6. 超时重试 / 熔断

### 建议原则
- **只对幂等工具自动重试**：如 `read_file`、`glob`、`grep`、`web_fetch`
- **非幂等工具默认不重试**：如 `write_file`、`edit_file`、`execute_bash`

### 建议实现
1. 在工具契约里增加 `idempotent` 元数据
2. `execute_tool()` 增加可选重试逻辑：
   - 超时/瞬时错误时重试 1 次
3. 维护简单的失败计数器：
   - 连续失败 N 次进入熔断窗口
4. 熔断期间返回清晰错误，避免无意义重复调用

### 验收标准
- 幂等工具在瞬时失败时可自动恢复
- 持续失败不会无限重试
- Agent 看到的错误消息包含“已熔断/暂不可用”语义

---

## D5. 子 Agent 并行

### 依赖
- 必须建立在 D1 工具并行执行能力之上

### 建议实现
1. 将多个无依赖 `call_agent` 调用纳入并行批次
2. 统一聚合子 Agent 结果
3. 保留每个子 Agent 的会话与事件上下文隔离

### 验收标准
- 单轮多个 `call_agent` 可并发
- 子 Agent 结果可稳定回收并按既定顺序进入主 Agent observation
- 某个子 Agent 失败不影响其他子 Agent 结果回收

---

## 5. 推荐落地排期

### Phase A（已完成）
- D3 文件变更回退（git worktree 隔离）

### Phase B（当前主线）
- D5 子 Agent 并行专项收口
- D6 超时重试/熔断

---

## 6. 具体建议：下一步做 2 件事

1. **子 Agent 并行专项收口（D5）**
   - 底层并行能力已具备
   - 现在更需要把 agent 级并行入口、验收与文档口径补齐

2. **超时重试 / 熔断（D6）**
   - 直接提升持续失败场景下的稳定性
   - 能减少 Agent 在坏状态下的无效重复调用

---

## 7. 本报告与现有文档的关系

本报告是对当前 `docs/refactor/` 系列文档的补充，重点补足此前未系统展开的运行时执行差距：

- 对 `TOOLING_GAP_ANALYSIS_VS_CLAUDE_CODE.md` 的补充：
  - 原文更偏工具体系总览
  - 本文更偏执行编排层的工程实施路线
- 对 `REMAINING_GAPS.md` 的补充：
  - 原文未显式纳入“工具并行执行 / 后台任务闭环 / 文件回退 / 日志治理 / 子 Agent 并行 / 熔断”这一组问题
  - 本文给出了优先级和实施顺序

---

## 8. 最终结论

当前系统已经具备较成熟的工具运行时骨架，其中以下执行层能力已完成：

- **并行执行**
- **后台任务闭环**
- **统一日志主线治理**
- **文件变更回退**（git worktree 隔离）

当前仍值得优先投入的，已经收敛为：

- **子 Agent 并行专项收口**
- **超时重试 / 熔断**

因为这些问题直接决定了：

1. 多 Agent 编排能力的上层可验证性
2. 持续失败场景下的稳定性
3. 高风险任务的可控性

**推荐主线顺序**：

`D5 子 Agent 并行专项收口 -> D6 熔断重试`

这条顺序更符合当前代码基的真实完成状态，也能避免继续围绕已完成的 D1 / D2 / D3 / D4 重复投入。
