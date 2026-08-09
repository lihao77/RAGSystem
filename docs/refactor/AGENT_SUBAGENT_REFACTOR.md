# 子 Agent 系统重构

更新时间：2026-08-09

## 目标

子 Agent 是一次普通 Agent invocation，只增加调用树归属、线程和租约信息。父子消息使用独立 durable mailbox，不把 Agent-to-Agent 内容伪装成 root followup，也不创建 worktree。所有子 Agent 共享父 workspace；并行写入依赖任务拆分和显式并行策略控制。

## 已落地阶段

| 阶段 | 结果 | 提交 |
| --- | --- | --- |
| 1 | root/child/background/resume 统一 `AgentInvocationService` | `1ad5bdad` |
| 2 | Local SQLite v9 与 SaaS PostgreSQL durable mailbox | `3ee6afc6` |
| 3 | 每个 round boundary claim mailbox 并注入 child context | `ef2c6864` |
| 4 | 运行中父到子 `progress/request/response/result/cancel` | `0f596ed9` |
| 5 | 后台 child terminal result 精准路由到 parent invocation | `04dfd666` |
| 6 | 受控并行 fan-out、稳定顺序聚合和失败隔离 | `8aa82960` |
| 7 | `agent_message` WS/outbox 协议事件、执行树和 WorkPanel 投影 | `59f3133c` |
| 8 | claim 竞争/恢复、child 到 parent、TTL/cancel 和后台完成通知收口 | 当前阶段提交 |
| 9 | 统一协作命令、私有化分裂处理器、共享 child invocation runner、恢复语义收口 | `d6a75bca`, `e599911f`, `c1452822` |

## 消息模型

Mailbox 行由 `session_id`、来源 run/call、目标 run/call/thread/child、`kind`、关联 id、内容和租约状态组成。`kind` 固定为：

- `progress`：非终态进度
- `request`：需要目标 Agent 处理的请求
- `response`：对 request 的回复
- `result`：子 Agent 终态结果
- `cancel`：在下一 round boundary 中断目标 invocation

父向子和子向父统一使用 `agent` 工具：不传 `child_agent_id` 且提供 `agent_name` 时创建 child；传 `child_agent_id` 时向已有 child 投递 follow-up；child 上下文中省略两个目标字段时投递给直接父 Agent。请求可设置 `timeout_ms`（1 至 600000），映射为 mailbox `expires_at`。重复 terminal result 使用 `<childRunId>:terminal_result`，重复 enqueue 只接受相同 payload。

## 最终内部边界

公开协作入口只有 `agent`（创建/联系/向父汇报）和只读的 `list_child_agents`。`DelegationPort` 不再暴露 `callAgent` 或 `sendMessage`；统一入口先解析为 `create_child`、`message_child`、`message_parent` 三种命令，再进入私有处理器。

创建 child 与 idle continuation 共用 `buildChildRunInput` 和 `runChildInvocation`。两者仍明确区分 invocation 语义：suspended resume 复用原 run/call，idle continuation 复用 child/thread 但创建新 run/call；运行中的消息、child 终态结果和 parent 汇报始终使用 durable mailbox。所有 child 共享父 workspace，不创建 worktree。

## 消费和恢复

1. 消费者在事务内回收过期 lease，再按 FIFO claim；ACK/release 必须带 claim id。
2. Local 使用 SQLite 事务的单条条件 UPDATE；SaaS 使用 PostgreSQL `FOR UPDATE SKIP LOCKED`，两个实例不能领取同一消息。
3. round boundary 将消息写入目标 thread 的隐藏历史并以语义 envelope 注入模型上下文；事件发布为 `agent_message`，前端执行树按目标 invocation 去重投影。
4. 进程内唤醒丢失时，idle launcher 扫描所有 pending Agent 消息并按精确目标 run 恢复；父 run 仍 running/suspended 时不会重复启动。
5. `cancel` ACK 后 abort run controller，目标 run 统一落 `interrupted`；后台 child 的 completed/failed/interrupted 结果都走同一 terminal mailbox 路由。

## 并行边界

只有 Agent 配置 `delegation.parallel_children=true` 时，独立 `agent(agent_name=...)` 调用才会在同一模型轮次 fan-out。相同 child/resource key 仍串行；结果按原始 tool-call 顺序聚合；一个 child 失败只影响自己的 observation。共享 workspace 不提供文件级隔离，任务拆分必须避免写冲突。

## 验收

核心验证覆盖：统一 invocation、mailbox schema/claim/ack/release、Local 双实例竞争、SaaS 租户边界和 SQL 锁语义、运行中双向消息、TTL/cancel、后台终态精准路由、并行 fan-out、WS replay、执行树和前端 WorkPanel。

常用命令：

```text
npm -w @ragsystem/agent-protocol run test
npm -w @ragsystem/backend-core run typecheck:test
npm -w @ragsystem/backend-core run test -- --run
npm -w @ragsystem/backend-local run test -- --run
npm -w @ragsystem/backend-saas run test -- --run
npm -w frontend-client run test
```
