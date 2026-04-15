# 运行时缺陷分析与实施路线（2026-04-14）

> 状态更新（2026-04-15）：D2 Phase 1 已完成，系统已具备 `task_output` / `task_stop`，并支持 `task_output(block=true)` 驱动 run 内 waiting loop。本文中关于“后台任务只能启动、尚无查询/停止工具”的表述仅代表旧阶段结论；当前 D2 剩余重点是 Phase 2：后台任务完成结果的自动注入。

> 目标：沉淀当前系统在运行时/执行层相对 Claude Code 的关键差距，并给出可直接排期实施的顺序化路线。
>
> 范围：只讨论运行时、工具执行、后台任务、回退、日志与多 Agent 执行相关能力；不重复讨论已完成的 Hooks、大结果落盘、上下文压缩等能力。

---

## 0. 先说结论

当前系统的主要短板不在基础工具框架，而在**执行编排层**：

1. **工具执行完全串行**，一轮内多个独立工具不能并发。
2. **后台任务闭环当前只剩 Phase 2**，Phase 1（查询 / 停止 / 显式等待）已完成，但尚未形成“后台完成结果自动注入 Agent 语境”的闭环。
3. **Checkpoint 只覆盖对话状态，不覆盖文件变更状态**，写错文件后缺乏系统级回退手段。
4. **日志基础可用，但缺统一治理**，已有 structured logger 基础设施未真正接入。
5. **子 Agent 调用仍然串行**，无法高效做多路并发收集。
6. **超时只有单次超时控制，没有重试/熔断策略**。

**已确认不是缺陷的项**：
- 上下文压缩：**已有**，不属于当前缺口。
- Hooks：**已完成**，不再纳入本报告。
- 大结果落盘：**已完成**，不再纳入本报告。

---

## 1. 缺陷总览与优先级

| 编号 | 缺陷 | 优先级 | 当前状态 | 建议策略 |
|---|---|---:|---|---|
| D1 | 工具并行执行缺失 | P0 | 完全串行 | 先做 |
| D2 | 后台任务闭环剩余 Phase 2 | P0 | Phase 1 已完成，自动注入待补 | 与 D1 并行推进 |
| D3 | 文件变更无系统级回退 | P1 | 仅对话级回退 | 第二批 |
| D4 | 日志统一治理不足 | P1 | 基础可用但分散 | 第一批先做 |
| D5 | 子 Agent 并行缺失 | P2 | call_agent 串行 | 依赖 D1 |
| D6 | 超时重试/熔断缺失 | P2 | 只有 timeout | 第二/三批 |

---

## 2. 已验证事实

### 2.1 工具执行现状：完全串行

**关键证据**：
- `backend-fastapi/agents/core/base.py` 中 `_handle_actions()` 对 `actions` 使用串行 `for` 循环逐个调用 `execute_tool()`。
- `backend-fastapi/tools/runtime/executor.py` 的 `execute_tool()` 是**单工具同步执行入口**，没有批量接口，也没有并发调度层。
- `backend-fastapi/agents/streaming/tool_xml_parser.py` 虽然支持一轮解析多个 `<tool>`，但这些 action 进入 `_handle_actions()` 后仍然串行消费。
- `backend-fastapi/api/v1/execution.py` 已明确对非 `sequential` 模式返回“并行模式尚未实现”。

**结论**：
- 当前系统支持“一轮输出多个工具调用”，但**不支持一轮并行执行多个工具**。
- 当前实现本质是：
  `LLM 输出 -> actions 列表 -> 串行执行 -> observations 汇总 -> 下一轮推理`

---

### 2.2 后台任务现状：Phase 1 已完成，Phase 2 待补

**关键证据**：
- `backend-fastapi/tools/local/bash_tool.py` 已支持 `run_in_background=true`。
- `backend-fastapi/tools/runtime/background_tasks.py` 已具备后台任务管理器，支持：
  - 启动任务
  - 输出落盘
  - 状态记录
  - 超时结束
  - 完成事件发布
- `BACKGROUND_TASK_COMPLETED` 事件已接入 EventBus，并可经 SSE 推送到前端。
- 系统已经提供 `task_output` / `task_stop` 供 Agent 查询、显式等待与停止后台任务。

**当前剩余缺口**：
- Agent 主循环默认不会把“已完成后台任务结果”自动注入后续推理语境。
- 因此当前仍需要 Agent 显式调用 `task_output` 回收结果，或通过 `task_output(block=true)` 进入 waiting loop。

**结论**：
- 当前后台执行已经不是单纯 fire-and-forget；Phase 1 闭环已完成。
- D2 剩余重点收敛为：**后台任务完成结果的自动注入（Phase 2）**。

---

### 2.3 回退能力现状：对话级有，文件级无

**已有能力**：
- `backend-fastapi/agents/recovery/checkpoint_manager.py`：有真实的 CheckpointManager。
- `backend-fastapi/application/agent_session.py`：支持 `rollback_messages()` 与重试准备。
- `backend-fastapi/utils/versioned_yaml_store.py`：YAML 文件具备备份语义。
- `backend-fastapi/utils/backup_database.py`：SQLite 具备备份/恢复能力。

**缺失点**：
- `write_file` / `edit_file` 不会在执行前自动做文件快照。
- `execute_bash` 导致的文件系统变更没有回退记录。
- 没有类似 Claude Code `git worktree` 的隔离工作副本能力。

**结论**：
- 不能说系统“完全没有 checkpoint / rollback”。
- 更准确的说法是：
  **系统已经有对话级恢复能力，但没有文件系统级回退能力。**

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

### 2.5 子 Agent 执行现状：能力有，调度串行

**现状**：
- `call_agent` / `send_message` / `list_child_agents` 已完成子 Agent 会话能力。
- 但多个子 Agent 调用依然要经过 `_handle_actions()` 的串行执行。

**结论**：
- 子 Agent 架构已经具备，但缺“并行调度层”。
- 因此这是一个**依赖 D1 的次级缺陷**。

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

### 第一批：先做基础治理
1. **D4 日志统一治理**

### 第二批：补齐核心执行能力
2. **D1 工具并行执行**
3. **D2 后台任务闭环（Phase 2：自动完成注入）**

### 第三批：补安全兜底与稳定性
4. **D3 文件快照回退（轻量方案）**
5. **D6 超时重试/熔断**

### 第四批：基于前面能力扩展上层编排
6. **D5 子 Agent 并行**
7. **D2 后台任务闭环（Phase 2：自动完成注入）**

### 可选增强（不是当前主线首要目标）
8. **D3 文件隔离执行（git worktree 方案）**

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

## D1. 工具并行执行

### 目标
在**不破坏结果依赖语义**的前提下，让一轮中的独立工具支持并发执行。

### 核心原则
- **有依赖**：串行
- **无依赖**：并行
- 保持 observation 合并顺序稳定
- 保持 `result_N` 占位符语义正确

### 建议实施步骤
1. 在 `_handle_actions()` 中增加 action 分组逻辑：
   - 先分析 arguments 中是否引用前置 `result_N`
   - 无依赖 action 放入并行批次
   - 有依赖 action 保持串行
2. 用 `ThreadPoolExecutor` 先实现同步工具的并行执行
3. 结果完成后按原始 idx 排序，再写入 observations / `tool_results`
4. 明确禁止并行的一类工具（如显式依赖 session shell 状态的工具）

### 风险点
- event_bus 事件顺序可能乱序
- 同一 session shell/同一文件路径的工具可能相互影响
- 必须建立“可并行工具”的判定规则

### 验收标准
- 同一轮多个 `read_file/glob/grep/web_fetch` 可并发。
- 有 `result_1` 引用关系的工具仍按依赖顺序执行。
- 前端执行树顺序稳定，不因并行而混乱。

---

## D2. 后台任务闭环

## Phase 1：先让 Agent 能查、能停

### 建议新增工具
- `get_background_task_output(task_id)`
- `list_background_tasks()`
- `cancel_background_task(task_id)`

### 实施点
1. 将 `BackgroundTaskManager.get_task/get_output/cancel` 封装成 direct 工具
2. 约束工具只能读取当前 session 的任务
3. 输出结构标准化：状态、退出码、stdout/stderr 摘要、输出路径、是否完成

### 验收标准
- Agent 可以启动后台 bash 后，在后续轮次主动查询结果
- Agent 可以取消后台任务
- 前端和 Agent 看到的是同一任务状态来源

## Phase 2：让完成结果自动进入 Agent 语境

### 建议实现
1. 主循环每轮开始前检查当前 session 是否有“已完成未消费”的后台任务
2. 将完成摘要注入为 observation
3. 或引入更明确的后台任务结果消费通道

### 验收标准
- Agent 不必手动轮询，也能在后续推理中感知后台任务完成
- 同一任务不会被重复消费

---

## D3. 文件变更回退

## 方案 A：轻量文件快照（当前推荐）

### 建议实现
1. 在 `write_file` / `edit_file` 执行前：
   - 若目标文件已存在，则备份到 `transient/{session_id}/file_snapshots/`
2. 记录：
   - 原路径
   - 快照路径
   - 时间
   - tool_call_id
3. 新增工具：
   - `list_file_snapshots()`
   - `restore_file_snapshot(snapshot_id)`

### 优点
- 成本低
- 不改变现有工具接口太多
- 适合当前阶段快速落地

### 局限
- 只能回退文件级修改
- 无法完整隔离 bash 带来的目录级副作用

## 方案 B：git worktree 隔离（后续可选）

### 目标
对标 Claude Code 的 worktree/workspace 隔离思路。

### 适用场景
- 高风险改动
- 大规模重构
- 用户要求可撤销工作区

### 当前建议
- **暂不作为第一阶段主线**
- 等 D1/D2/D4 稳定后再考虑

### 验收标准（方案 A）
- 修改已有文件时自动生成快照
- Agent 或用户能恢复到某次写入前状态
- 快照目录可按 session 自动清理

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

### Phase A（建议一周内先做完）
- D4 日志统一治理

### Phase B（核心能力补齐）
- D1 工具并行执行
- D2 后台任务闭环 Phase 2

### Phase C（稳定性与安全兜底）
- D3 文件快照回退
- D6 超时重试/熔断

### Phase D（能力增强）
- D5 子 Agent 并行
- D2 后台任务闭环 Phase 2

### Phase E（高级能力，按需）
- D3 git worktree 隔离

---

## 6. 具体建议：如果只能先做 3 件事

如果近期只想投入最少成本但拿到最大收益，建议优先做：

1. **日志统一治理（D4）**
   - 成本最低
   - 立即提升所有后续工作的调试效率

2. **工具并行执行（D1）**
   - 用户体感提升最大
   - 对标 Claude Code 差距最明显

3. **后台任务闭环 Phase 1（D2）**
   - 现有后台能力才真正可用
   - 能把 `run_in_background` 从“半成品”变成可落地能力

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

当前系统已经具备较成熟的工具运行时骨架，但仍缺少 Claude Code 风格的几个关键“执行层能力”：

- **并行执行**
- **后台任务闭环**
- **文件级回退**
- **统一可观测治理**

其中最值得优先投入的，不是再扩展更多工具，而是先把这几项执行层能力补齐。因为它们直接决定了：

1. 系统运行效率
2. Agent 调用链的可控性
3. 出错后的可恢复性
4. 后续高级能力（多 Agent 并行、后台自动续接）的实现基础

**推荐主线顺序**：

`D4 日志治理 -> D1 工具并行 -> D2 后台闭环 -> D3 文件快照 -> D6 熔断重试 -> D5 子 Agent 并行`

这条顺序最稳，也最符合当前代码基的演进成本结构。
