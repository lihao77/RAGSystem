# 会话消息统一入口设计（盘点 + 统一消息模型）

目标形态：**一个入口，两种情况**——所有消息经同一个 ingest 进入会话；智能体只有
idle（拉起新 run）与 running（入队，由活动 run 注入或结束后补跑）两种接收情况。

## 1. 盘点结论（数字先行）

| 层 | 数量 | 明细 |
|---|---|---|
| 外部投递端点（用户） | 6 | stream、ws user_driven_change、agui、execute、execute/:agent、collaborate、rollback-and-retry（前 6 条即"六条用户通道"） |
| 外部投递端点（插件内部，走 executeSynchronously） | 3 | scheduler cron、feishu daemon、agent-builder trial |
| 服务层公共方法 | 3 | `startStream` / `executeSynchronously` / `startRollbackRetry` |
| 服务层私有汇聚点 | 1 | `sendUserMessage`（launchers.ts:393，注释自述"所有外部用户消息的唯一处理入口"） |
| 系统侧绕过汇聚点直接 `invocationService.invoke` 的位置 | 6 | mailbox root 续跑、session_followup、goal 续跑、bg 通知 idle run、挂起恢复 root、挂起恢复 child（另有 child 委派 1 处，属 agent 间机制） |
| root run 初始输入形状 | 2 | `persistUserMessage`（现场合成）/ `rootMailboxMessage`（引用已存在 mailbox 消息），run-engine.ts:108-123 互斥二选一 |
| 运行中注入路径 | 1 | refresh → `mailbox.claim` → `commitRunInput`（runtime-adapter.ts:656-821） |
| 队列 | 2 | mailbox（持久）+ `SessionNotificationQueue`（纯内存，session-notification-queue.ts） |

**关键事实**：存储层 `startOrAppendRoot`（sqlite-runtime-storage.ts:459-473 /
postgres-runtime-storage.ts:460，契约 runtime-storage.ts:514）本身就是"一个入口、
started/followup 两种情况"的实现（followup 时带 mailboxMessage fence）。**目标架构在
存储层已经存在，分裂发生在其上的服务层**——本方案的本质是把服务层 6 处直接 invoke
与 2 套队列收敛到已有的二分语义上，而不是发明新机制。

## 2. 三层现状视图

### 2.1 协议层（外部端点 → 全部最终到达 sendUserMessage）

```
POST /api/agent/stream            routes/agent/stream.ts:35      ─→ startStream            ─┐
WS user_driven_change             routes/agent/ws.ts:356          ─→ startStream            ─┤
POST /api/agui (SSE, AG-UI)       routes/agent/agui.ts:24         ─→ startStream            ─┤  followupPolicy
POST /api/agent/execute[/:agent]  routes/agent/execution.ts:46    ─→ executeSynchronously   ─┤  queue/reject
POST /api/agent/collaborate       routes/agent/execution.ts:71    ─→ sessionControl.collaborate
                                                                     → executeSynchronously   ─┤  各通道自带
POST .../rollback-and-retry       routes/agent/sessions.ts:519    ─→ startRollbackRetry     ─┘
scheduler cron                    plugins/backend-plugin-scheduler/application-runtime.ts:75
feishu daemon                     plugins/backend-plugin-daemon-feishu/application-runtime.ts:97
agent-builder trial               plugins/backend-plugin-agent-builder/trial.ts:259
```

六条用户通道差异只在：返回形状（流式句柄 / 同步结果 / SSE 协议）、followupPolicy
（agui 与 rollback-retry 为 reject，其余 queue）、同步等待（execute/collaborate 等
awaitFollowupCompletion）、附件与 ui_context 支持（同步通道恒无附件）。
selected_llm / thinking_level 三态语义六条已对齐（本次会话级设定改造的成果）。

### 2.2 服务层（系统通道，绕过 sendUserMessage 直接 invoke）

| 通道 | 位置 | 初始输入形状 | 触发源 |
|---|---|---|---|
| mailbox root 续跑 | launchers.ts:1075/1091（executionKind=`system.agent_message`） | rootMailboxMessage | `setMailboxWakeup` 回调（core-runtime-container.ts:162） |
| session_followup | launchers.ts:1329 | rootMailboxMessage（首条 user_message） | idle 检查 startSessionIdleRun |
| goal 续跑 | launchers.ts:1443（`system.goal_continuation`） | persistUserMessage（渲染合成） | idle 检查 + claimContinuation 门控 |
| bg 通知 idle run | launchers.ts:1443（`system.bg_notification`） | persistUserMessage（渲染合成） | idle 检查 + 内存队列 drain |
| 挂起恢复 root/child | resume-executor.ts:63/121（mode=resume） | 无初始输入（恢复既有 run） | pending-interaction respondAsync |
| 运行中注入 | runtime-adapter.ts:656-821 | refresh claim → commitRunInput | 活动 run 每轮之间 |

### 2.3 队列层（同一语义、两套载体）

- **mailbox**（持久）：agent 间消息、后台子任务终态、rollback 恢复补偿、**运行中的
  bg 通知**（run-engine.ts:705-727 run 启动时 enqueue，refresh 认领）、**运行中到达的
  排队用户消息**（startOrAppendRoot followup 分支）。
- **SessionNotificationQueue**（纯内存）：**idle 状态的 bg 通知**暂存
  （background-task-service.ts:535 写入，startSessionIdleRun:1434 drain）。

同一个"后台任务完成通知主智能体"语义，运行中走 mailbox、idle 走内存队列——
存储、恢复逻辑、消费代码全部两套。

## 3. 现状分裂点（问题清单）

1. **bg 通知双轨**：如上。内存队列进程重启即丢（靠 background-task-service 的
   恢复扫描兜底），且 idle/running 两条路径的时序特性不同。
2. **同一条用户消息、两种初始输入形状**：直接发送 → persistUserMessage（现场合
   成）；运行中排队、idle 后补跑 → rootMailboxMessage。首发与 session_followup 补跑
   是同构语义却走不同代码路径。run-engine.ts:167-169 还要为互斥性显式设防。
3. **系统通道各自为政**：6 处直接 invoke，各自重复"读会话设定 → resolveReadyAgent →
   状态检查 → invoke → scheduleAutoTrigger"序列（正是本次 selected_llm 改造要在
   6 处逐一接 readSessionRequestOverrides 的原因——入口不统一，每个新横切关注点
   都要改 N 处）。
4. **collaborate 绕路**：sessionControl.collaborate 构造 `ExecuteRequest` 再注入
   `deps.executeSynchronously`（execution/index.ts:216-223），本质是"一次提交多个
   task"，却借道同步执行通道的完整适配层。
5. **/execute 与 /execute/:agentName 双端点**：仅 agent 参数位置不同。

## 4. 统一消息模型

### 4.1 统一入口消息（内部形状）

所有进入主智能体会话的消息，进 ingest 前先落成同一形状：

```ts
/** 统一会话入口消息：协议端点与系统通道的唯一内部投递形状。 */
interface SessionInboundMessage {
  id: string;                     // 幂等键：用户消息=消息行 id；系统消息=来源确定性 id
  sessionId: string;

  source: {
    kind: "user" | "agent" | "system";
    userId?: string | null;       // kind=user 时为 run 用户身份；系统渠道回退会话 owner
    agentName?: string | null;    // kind=agent 时的投递方
    channel: string;              // web/api/ws/agui/cron/feishu/system（即现 originChannel）
    requestId?: string | null;    // 外部请求关联（错误帧回传、追踪）
  };

  content: MessageContentPart[];  // 与消息行 contentParts 同构（含 attachment_ref/ui_context 扩展）
  inputType: "user_message" | "agent_message" | "system_notification" | "goal_continuation";
  visibleToUser: boolean;

  overrides?: {                   // 三态：undefined=继承会话设定；null=清除；值=生效
    selectedLlm?: string | null;
    thinkingLevel?: ThinkingLevel | null;
  };

  delivery: {
    followupPolicy: "queue" | "reject";
    maintenance?: { token: string };   // rollback-and-retry 的会话维护租约
    executionKind: string;             // agent_stream/execute/rollback_and_retry/
                                       // system.agent_message/session_followup/
                                       // system.goal_continuation/system.bg_notification
  };

  metadata: Record<string, unknown>;   // trace（retry_of_seq 等）、goal_id 等来源专属线索
}
```

现有要素全部有落点：mailbox 行的 `input_type`/`sourceKind`/`visible_to_user`/
`content_parts`/`metadata` 与本模型一一对应；`SendUserMessageInput`
（launchers.ts:95-124）是其用户侧子集；`persistUserMessage`/`rootMailboxMessage`
是被它取代的两个初始输入形状。

### 4.2 唯一入口与两种情况

```ts
type IngestResult =
  | { kind: "started"; runId: string; taskId: string }
  | { kind: "queued"; messageId: string; activeRunId: string }
  | { kind: "rejected"; reason: string };

ingest(msg: SessionInboundMessage): Promise<IngestResult>;
```

内部流程（即现 sendUserMessage 的泛化，顺序不变）：

1. 校验（task/附件非空、slash 命令分流保留在用户侧适配层）；
2. overrides 三态合并 + 会话设定回写（现 launchers.ts:416-421, 559-567）；
3. **落统一队列**——全部消息类型入 mailbox（bg 通知 idle 路径从内存队列迁来）；
4. 状态分派（= 存储层 `startOrAppendRoot` 的 started/followup 二分）：
   - **idle** → 原子认领并起 run（初始输入=认领的 mailbox 消息，`rootMailboxMessage`）；
   - **running** → queue policy 留在队列（活动 run refresh 认领注入，或结束后由
     idle 检查补跑）；reject policy 返回 rejected。

注：严格说存在第三态 **suspended**（挂起）。它在本模型中归入 running 一侧处理——
不消费队列、新消息按 followupPolicy 入队，恢复后的终态触发 idle 检查消费。挂起恢复
本身（resume-executor）不是"新消息进入"，是既有 run 的继续，保持独立通道，不塞进
ingest。child 委派（scope:child）同理，属 agent 间机制。

### 4.3 队列消费调度器（idle 检查的泛化）

`startSessionIdleRun` 泛化为唯一的队列消费调度器，优先级：

```
user_message（session_followup） > agent_message（mailbox 续跑） > system_notification（bg） > goal_continuation（claim 门控生成）
```

goal 续跑的 claim/lease/maxContinuations 保护保留在生成侧（门控是否产出消息），
投递侧统一走 ingest。

## 5. 剥离清单

| # | 剥离项 | 理由 | 位置 |
|---|---|---|---|
| 1 | `SessionNotificationQueue`（内存队列） | bg 通知 idle/running 双轨；统一后仅 mailbox 一条，重启不丢、恢复逻辑一套 | services/runtime/session-notification-queue.ts 及其读写点 |
| 2 | `persistUserMessage` 初始输入形状 | 首发也走"入队+认领"，run-engine 互斥分支消除；session_followup 与首发同构 | run-engine.ts:108-114, 167-189 |
| 3 | 系统通道 6 处直接 invoke | 收敛到 ingest，横切关注点（设定读取、状态检查、autoTrigger）一处维护 | launchers.ts:1075/1091/1329/1443、resume-executor.ts:63/121 |
| 4 | collaborate 的 ExecuteRequest 绕路 | 直接循环 ingest，不再借道同步执行适配层 | execution/session-control.ts:44-99 |
| 5 | /execute 与 /execute/:agentName 双端点 | 合并为可选路径参数（外部兼容可保留旧路由转发） | routes/agent/execution.ts:46-69 |

## 6. 保留项及理由

- **协议端点多样性**（stream/WS/agui/execute/collaborate/rollback-retry）：
  SSE/WS/AG-UI/同步 HTTP 是外部需求差异，保留；判"多余"的标准是内部形状分裂，
  不是协议数量。它们此后只做协议适配 → 构造 SessionInboundMessage → ingest。
- **startStream / executeSynchronously 两个公共方法**：差异只剩返回形状（流式句柄
  vs 同步结果）与 awaitFollowupCompletion，作为 ingest 之上的返回适配器保留。
- **挂起恢复（resume）**：非消息入口，是 run 生命周期操作；交互应答
  （approval/user_input）走 pending-interaction 通道。
- **slash 命令分流**：留在用户侧适配层（命令不产生 run，ingest 不感知）。
- **rollback-and-retry 独立端点**：删消息后重发 + 维护租约语义特殊，保留端点，
  经 `delivery.maintenance` 透传进 ingest。
- **确定性 ID 机制**（mailbox_<sha256>、bg_notify_<uuid> 等）：幂等语义保留，
  统一为 SessionInboundMessage.id 的生成约定。

## 7. 迁移路径（分阶段、每阶段可独立交付与回滚）

1. **阶段 1：bg 通知双轨合一**。✅ 已实施：`BackgroundTaskService.publishCompleted`
   完成通知直投会话 mailbox（`services/runtime/background-task-notification.ts` 承载
   渲染与确定性 id `bgnotify_<task_id>`，`setAgentMailbox(store, tenantId)` 由 core
   容器绑定）；idle 检查扫 mailbox 按优先级消费（user_message > 定向唤醒 > 通知），
   claim → 渲染进 run 初始输入 → durableStarted 后 ack，失败 release 回队；
   `waitForBackgroundTask` 轮询拿到终态改经 `suppressTaskNotification`（持久化串行
   链上 settle）防二次投递；内存 `SessionNotificationQueue`、run 启动时的
   `enqueueBackgroundNotifications` 搬运、孤儿方法 `hasPendingNotifications` 全部移除。
   行为变化（预期内）：运行中到达的通知现在会被活动 root run 的 refresh 认领注入
   （此前等待 run 结束才投递）；通知持久化，重启不丢。
2. **阶段 2：ingest 收口系统通道**。✅ 已实施（会话级渠道部分）：launchers 新增
   `resolveSessionEntryPoint`（会话读取 → 会话级设定读取 → 入口 Agent readiness，
   missing/not-ready/ready 三态）与 `invokeSessionSystemRun`（设定三态生效、userId
   回退会话 owner、终态统一 scheduleAutoTrigger、可选 onFinally）两个私有助手，
   session_followup / goal 续跑 / bg 通知三分支全部改走——横切关注点此后只改一处。
   mailbox 续跑（`startAgentMailboxRun`）**刻意不并入**：它是特定已终止 run 的续接
   （agent 由目标 run 决定而非会话入口、确定性 ID、child/root 分叉、lineage 校验），
   其会话级设定读取已与助手同源（readSessionRequestOverrides），强行收口会丢
   专有 invoke 字段。resume 与 child 委派维持不并入（非消息入口）。
3. **阶段 3：persistUserMessage 退役**。首发=入队+原子认领（startOrAppendRoot 现有
   fence），run-engine 只剩 rootMailboxMessage 一种初始输入。注意保持 durableStarted
   语义与 onAccepted ACK 时序不变；commitRunInput 的 canonicalMetadata 需按
   input_type 区分，避免用户首发消息沾上 agent_message 类标记。
4. **阶段 4：collaborate/插件调用点切换 + 端点合并**（低风险收尾）。

## 8. 明确不做

- 不合并 resume 与 child 委派进 ingest（非消息入口）。
- 不改协议层对外契约（WS 帧、AG-UI、REST 形状不动，前端零感知）。
- 不引入新存储表：mailbox 已具备统一队列的全部字段
  （kind/input_type/status/target_*）。
