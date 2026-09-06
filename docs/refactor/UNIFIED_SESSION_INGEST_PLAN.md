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
- **slash 命令分流**：留在用户侧适配层（system 命令不产生 run；prompt 命令照常
  进 run）。system 命令的 echo 行不再旁路：经 `appendMailboxMessage` 以 mailbox
  信封同事务派生+settle（确定性 id `slashcmd_<invocation_id>`），与其他会话边界
  行同载体；command_result 行是命令执行的产物行，与 assistant 行同类，由执行者
  持久化，不属输入闸门范围。
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
3. **阶段 3：persistUserMessage 退役**。✅ **核验后认定已满足，形状清理刻意不做**：
   实施前细读存储层发现目标架构本就存在——`RuntimeStartOrAppendRootInput` 的初始
   输入就是 `mailboxMessage: EnqueueAgentMailboxMessageInput`（runtime-storage.ts:155-158），
   `startOrAppendRoot` started 分支同事务 `enqueueAgentMailboxMessage` +
   `settleAgentMailboxMessage`（sqlite-runtime-storage.ts:477-482 / postgres 同构），
   followup 分支入队留给活动 run（:456-458），会话消息行经 `rootMailboxConversationMessage`
   从 mailbox 形状派生——**首发与排队补跑在 persister 以下完全是同一条路径**，"首发=
   入队+原子认领"由存储事务保证（崩溃恢复语义甚至优于"先入队再另行认领"）。
   剩余的 `persistUserMessage`/`rootMailboxMessage` 双输入形状只存在于 invoke 输入层：
   合成分支必须留在 run-engine 内（run_id/task_id 在 startRun 里生成后才合入 metadata，
   先行构造会触发 sameMessageIdentity 幂等冲突），"退役"只能是把双字段换成一个字段
   加隐式合成标志——契约搅动大、纯改名无架构收益，且双形状+互斥守卫比"单字段+标志"
   更显式。canonicalMetadata 按 input_type 区分在 refresh 侧已是现状
   （runtime-adapter.ts isUserMessage 分支）。原清单第 2 项剥离据此关闭。
4. **阶段 4：collaborate/插件调用点切换 + 端点合并**。✅ 已收尾（2026-09-05）：
   - `/execute` 与 `/execute/:agentName` 处理体合一（routes/agent/execution.ts
     `handleExecute`，路径段仅作 body.agent 覆盖来源，两 URL 均保留零破坏）。
   - collaborate"绕路"核验为**正确形态不剥离**：`sessionControl → deps.executeSynchronously
     → sendUserMessage` 只有一层函数间接（注入为破依赖环），逐 task 错误隔离与同步
     结果组装正是该适配器的职责；协作任务已走唯一入口。
   - 插件调用点（scheduler/feishu/agent-builder trial）本就是 executeSynchronously
     的协议适配形态（executionKind 透传保留），无需切换。

## 8. 明确不做

- 不合并 resume 与 child 委派进 ingest（非消息入口）。
- 不改协议层对外契约（WS 帧、AG-UI、REST 形状不动，前端零感知）。
- 不引入新存储表：mailbox 已具备统一队列的全部字段
  （kind/input_type/status/target_*）。

## 9. 追加收口：单一 Agent 解析点与单一 root invoke 组装点（2026-09-05，用户推动）

阶段 2 留下的两个"会话级系统渠道助手"仍与用户路径并行存在三份 Agent 状态解析
（`resolveRunReadiness`：launchRun 与变换前各一次——同一次发送解析两遍；
`resolveSessionEntryPoint`：系统三分支；`startAgentMailboxRun` 内联）与两份 root
invoke 组装（`launchRun` 用户/foreground、`invokeSessionSystemRun` 系统/background）。
本轮收拢为：

- **`resolveExecutionAgent`**：唯一执行 Agent 解析点（agentName 显式优先、缺省回落
  会话入口 Agent；selectedLlm 覆盖 default 档）。用户发送（解析一次贯穿变换与
  invoke）、session_followup、goal/bg、mailbox 续跑（agentName 来自目标 run 记录）
  全部走它。`resolveRunReadiness`/`resolveSessionEntryPoint` 退场。
- **`invokeRootRun`**：唯一 root invoke 组装点，foreground/background 与
  user_message/system 持久化形状参数化；background 终态统一 autoTrigger（onFinally
  先行）。`launchRun`/`invokeSessionSystemRun` 与 `UnifiedRunStart*` 类型退场。
- slash 分流保持单点（本就只在 sendUserMessage），位置仍在管道最前（会话身份
  构建之后、解析之前）。
- **一处有意的行为改进**：readiness 解析失败改为快速失败——不再为注定失败的发送
  执行持久化前插件变换（旧契约为变换照跑、视觉标志缺省，但变换含可能调 LLM 的
  视觉描述，纯浪费）；`send-transform-main-model-vision.test.ts` 契约同步更新。

launchers 剩余私有方法均为职责单一的操作细节（idle 扫描/通知 claim-ack-release/
mailbox 续跑判定树/结果补投），不再承载横切口径。

## 10. 最终架构（权威记录，2026-09-05 定稿；goal 通道 09-06 改纯生产者）

### 10.0 goal 续跑 = 队列生产者（取代原"特殊直接拉起"）

goal 不再有专属 invoke 路径。`SessionMailboxConsumer` 的空闲检查在预算门控
（`GoalStore.claimContinuation`：maxContinuations/maxNoProgress/租约/generation）
通过后，向统一队列**投递一条 goal_continuation 等待行**（确定性 id
`goalcont_<goal_id>_<generation>`，内容为投递时渲染的 goal 快照 XML），投递成功
即释放认领（预算已计、工作由持久行承载）。**循环由队列本身串行化**：行被消费才
起 run，run 终态（scheduleAutoTrigger）才触发下一轮生产；已有排队 goal 行时跳过
生产（防重复投递）。消费侧 09-06 再收口为**一行一 run 的引用行消费**（§10.3-2）：
idle 系统消息不再合成随机 id 的合并行，头行直接作为 run 初始消息（闸门事务内
settle），同批伴随行经 `appendMailboxMessage` 各自物化会话消息行——goal 一次续跑
只产生一行。消费前复核 goal 活性：行排队期间 goal 被暂停/完成则 settle 跳过，
不对过期快照空跑。

### 10.1 分层总图

```
┌─ 协议适配层（纯形状转换，零业务判定）────────────────────────────┐
│ HTTP: /stream  /execute[/:agentName]  /collaborate  /rollback-retry │
│ WS:   user_driven_change        SSE: /api/agui（含 widget 复用）    │
│ 插件: scheduler cron  飞书 daemon  agent-builder 试用               │
└──────────────────────┬──────────────────────────────────────────┘
                       ↓ 全部构造 SendUserMessageInput / ExecuteRequest
┌─ 消息处理管道（launchers）───────────────────────────────────────┐
│ sendUserMessage —— 用户消息唯一流水线：                           │
│   会话定位 → slash 分流(全仓唯一点) → 设定三态合并(唯一合并点)     │
│   → 冲突预检(followupPolicy) → onAccepted ACK → 附件解析           │
│   → contentParts 组装 → 插件持久化前变换 → invokeRootRun           │
│   → durableStarted 后回写实际生效设定                             │
│ resolveExecutionAgent —— 唯一 Agent 状态解析点（§9）              │
│ invokeRootRun —— 唯一 root invoke 组装点（§9）                    │
└──────────────────────┬──────────────────────────────────────────┘
                       ↓ 一切 root run：rootMailboxMessage 形状
┌─ 统一队列（mailbox，持久）───────────────────────────────────────┐
│ 行 = 信封：input_type(user/agent/system_notification/goal)         │
│         × source_kind(user/agent/system) × visible_to_user         │
│         × 寻址(target_run_id/agent_call_id/thread_key/child_id)    │
│ 写入方：startOrAppendRoot 事务 / appendMailboxMessage(无 run 过路) │
│         / followup 入队 / publishCompleted(bgnotify_<task_id>)     │
│         / agent 间消息 / 续跑结果回投 / goal 生产(goalcont_)        │
│ 重投有界：claim 死信(AGENT_MAILBOX_MAX_DELIVERY_ATTEMPTS=20)        │
│         + 失败 release 指数退避(mailboxRetryBackoffMs)              │
└──────┬──────────────────────┬───────────────────────────────────┘
       ↓ running             ↓ idle
┌─ 消费者 ─────────────┐  ┌─ 会话空闲检查（收件人交付，唯一规则）──┐
│ 活动 run refresh：    │  │ 定向行 → 全量转发唤醒(收件人粒度)      │
│ 每轮按地址 claim →   │  │ root 无定向行(用户/通知/goal 不分      │
│ commitRunInput 落    │  │   种类) → 一个 run 全量消化:            │
│ user 行进当轮上下文  │  │   头行引用+伴随行物化+内容并入task       │
│ (批量注入当轮)       │  │ 无类别优先级、无波次——交付只看收件人    │
└──────────────────────┘  └──────────────────────────────────────┘
       ↑ 唤醒快路径（收件人粒度，不等空闲）：enqueue 即触发
       │ triggerAgentMailboxRun → startAgentMailboxRun（续接已终止收件人，
       │ 确定性 ID mailbox_<sha>、lineage 校验、结果回投父；
       │ root 续跑经 launchSystemRun → invokeRootRun 唯一组装点）
       ↑ 触发闭环兜底：core-runtime-container 启动即扫 + 60s 周期扫描
       │ listPendingSessions → triggerBgNotificationRun（崩溃后无事件源
       │ 的滞留行最多一个扫描周期被捡起）

┌─ 存储事务（会话边界消息行唯一派生源，单事务）────────────────────┐
│ startOrAppendRoot：enqueue + settle + 派生会话消息行 + 创建 run    │
│   running+queue：只 enqueue（留给 refresh / 空闲检查）              │
│   running+reject：拒绝   —— 首发与排队补跑在此以下同路径            │
│ appendMailboxMessage：无 run 过路行——enqueue + 派生会话消息行      │
│   + settle（slash 命令 echo 行、idle 批量消费的伴随行）             │
│ 执行产物行（assistant/tool/command_result/压缩摘要）由执行者持久化， │
│   非输入，不经闸门                                                    │
└──────────────────────────────────────────────────────────────────┘
```

### 10.2 声明式非入口（刻意不在统一管道上）

| 通道 | 性质 | 与统一口径的关系 |
|---|---|---|
| 挂起恢复 resume | run 生命周期操作（非新消息） | 设定读取同源（容器注入 readSessionRequestOverrides），解析直连底层 resolveReadyAgent（agentName 显式给定，无需入口回落） |
| child 委派 | agent 间机制，scope:child | 走自己的 tier 配置（会话级设定只作用于主智能体） |
| mailbox 续跑（child 分支） | 定向消息的收件人重建 | Agent 解析走 resolveExecutionAgentFor（agentName 取目标 run 记录），初始输入同为 mailbox 引用；root 分支已并入唯一组装点（见 §10.3-4），child invoke 是 run 树内机制 |

### 10.3 不变量（review 时不许再分叉的点）

1. **一个队列**：mailbox，无第二载体（内存队列已删除）；
2. **一个派生源**：一切会话边界输入行由 mailbox 信封在存储事务内派生——root run 创建只经
   startOrAppendRoot（idle/running 二分在此），无 run 的边界行（slash echo、idle 伴随行）
   经 appendMailboxMessage（同事务 enqueue+派生+settle）；执行产物行由执行者持久化，非输入；
3. **一个解析点**：resolveExecutionAgentFor（agentName 显式优先/缺省入口 Agent，readiness
   失败明确报因）；resume/slash-handler 直连底层 resolveReadyAgent 属机制同源（agentName 显式给定）；
4. **一个组装点**：invokeRootRun——用户发送（foreground）、系统渠道（background）、mailbox
   root 续跑（确定性 runId/taskId/rootCallId 与 mailboxTarget 透传）全部经它；child invoke
   是 run 树内机制，非 root 组装；
5. **一个 slash 点**：sendUserMessage 内 parseSlashCommand，管道最前折返；
6. **一个设定源**：readSessionRequestOverrides（读）+ mergeRequestOverrides（用户请求三态合并），回写即实际生效值；
7. **确定性 ID**：`bgnotify_<task_id>`、`mailbox_<sha256>`、`session_followup_<msg_id>`、
   `goalcont_<goal_id>_<generation>`、`slashcmd_<invocation_id>`，idle 消费的 requestId 由头行
   id 派生（`bg_notify_` / `goal_continue_` 前缀）——幂等与恢复的根基（run 内部 requestId/runId
   由 run-engine 生成，幂等键在 mailbox 行不在 run）；
8. **防重复双防线 + 重投有界**：工具轮询 suppress = 内存集合 + 串行链 settle；idle 消费 =
   claim → 引用行经闸门 settle（伴随行 appendMailboxMessage settle）→ 失败 release 指数
   退避（mailboxRetryBackoffMs）；claim 前死信扫（attempt_count ≥
   AGENT_MAILBOX_MAX_DELIVERY_ATTEMPTS 置 expired）封顶单行重投；
9. **触发闭环（liveness）**：事件链（run 终态 / 任务完成 / 通知入队链尾）→ scheduleAutoTrigger
   → 空闲检查为主路径；core-runtime-container 启动即扫 + 周期扫描 listPendingSessions 兜底
   ——崩溃后无事件源的滞留行最多一个扫描周期被捡起，"行驻留则终被消费"由队列自身保证。

### 10.4 实施状态

- 阶段 1+2：提交 d7bdc986；阶段 3+4 收口：79328649；单一解析/组装点：8724ffc1；
  架构定稿：f689c209；消费组件抽取：7998c412；goal 纯生产者：a3308bb9。
- **SessionMailboxConsumer 抽取已完成**（统一队列的空闲/唤醒消费组件，
  `execution/session-mailbox-consumer.ts`）：空闲检查（triggerBgNotificationRun）与
  收件人唤醒（triggerAgentMailboxRun）两个触发口、续跑判定树、通知 claim/release、
  结果回投与恢复扫描全部入住；Agent 解析经 readiness.ts 的
  resolveExecutionAgentFor（与用户发送同一口径），系统 run 经 launchSystemRun 钩子
  回到 launchers 的唯一组装点 invokeRootRun。launchers 缩至约 880 行，只剩
  用户管道 + 协议适配 + 唯一解析/组装点。两触发口不可共用同一空闲谓词（唤醒路径
  须能在 root run 运行期间拉起子 Agent 续跑，空闲检查对此早退），组件与续跑函数
  本就共享；运行中消息的另一认领方是活动 run 的 refresh（runtime-adapter）。
- **零例外收口（09-06 第二轮）**：slash echo 行经 appendMailboxMessage 入闸（消灭
  最后一条旁路直写）；idle 消费改一行一 run 引用行（goal 一次续跑一行，不再合成
  随机 id 合并行，伴随行 append 物化）；mailbox root 续跑并入 invokeRootRun（消费
  组件内平行组装退场）；队列重投有界（claim 死信 + release 退避）；触发闭环补
  容器级周期扫描（崩溃后无事件源不再滞留）；消费组件加 logger、idle 去重补
  dirty 合并、忙检查收敛 checkSessionBusy 单一口径。
- **批量消费（09-06 第三轮）**：排队用户消息一轮 run 全量补跑（头行引用 + 伴随行
  物化 + 内容并入 task，与 refresh 的批量注入同口径，消灭一条消息一个 run 的链式
  补跑）；空闲检查发现的定向消息全量转发唤醒（同收件人经触发去重由 drain 顺序
  消化，不同收件人各自唤醒，消灭一轮只转投一条）。
- **收件人交付单规则（09-06 第四轮，用户裁定）**：删除消息类别优先级与波次消费。
  空闲检查只按收件人交付：定向行全量转发唤醒（收件人运行中由其 refresh 认领、
  已终止由唤醒口重建）；root 线程无定向行（用户消息/通知/goal 不分种类）claim
  后一个 run 全量消化，执行 Kind 按批内容标注（含用户消息 → session_followup，
  含 goal → system.goal_continuation，否则 bg_notification），requestId 前缀按头行
  类型。`claimIdleMessages` 全量认领不再释放"误领"的用户行（该竞态窗口随之消失），
  `isIdleSystemMessage` 形状过滤与专门的 session_followup 分支删除。
- **goal 门控语义（09-06 第五轮，用户裁定）**：goal 续跑触发条件只有两条——该
  智能体空闲（无活动 root run；主智能体的执行形态即会话 root run）、它发起的后台
  任务无运行中者（含其工具调用的后台子 agent 委派；子智能体自主发起的后台任务
  不阻主智能体的 goal）。无第三条：无类别优先级、无额外会话级仲裁。对话定序与
  goal 循环刹车由这两条封闭——idle ⇒ 该智能体线程无并发写者；idle 门控本身串行化
  循环，GoalStore 预算上限仍是第二道闸。条件二的"发起归属"收窄已实施：
  hasRunningTasksDurable(sessionId, "root") 只统计主智能体发起的任务
  （session-business.ts，历史行 null 视为 root 发起）。
- **全量寻址（09-06 第六轮，用户裁定）**：取消"定向/无定向"两类行——所有 mailbox
  行一律带收件人地址，交付只有按收件人单一谓词。用户消息与 goal 行地址显式标为
  主智能体（root 线程**角色**，非具体实例名——team 变更后消费时照常实时解析，
  延迟绑定保留）；后台通知（bgnotify_&lt;task_id&gt;）路由给**发起者**，不再无脑投
  root 线程：发起者为子智能体时按收件人交付（其 run 运行中 refresh 认领、已终止
  走接续），发起者地址在任务 spawn 时的工具上下文捕获。原"无定向行一个 run 全量
  消化"分支改写为"地址=主智能体的行由主智能体 run 消化"（行为不变、谓词统一）。
  与第五轮 goal 门控闭环：主智能体发起的后台任务其完成通知同发主智能体，由同一
  run 消化。bgnotify 已按发起者路由（background-task-notification.ts 取
  initiator_thread_key/initiator_child_agent_id，历史行 null 回退 root）。goal 按智能体拆分归属
  （主智能体与各子智能体各自持有目标）显式推迟，以后再改（用户 09-06 确认；
  将来拆分粒度为智能体身份——agent 名或子智能体线程 id，非 run 实例）。
- **消除父子分叉（09-06 第八轮，方向性裁定，暂不实施）**：内核机制不应区分主/子
  智能体——线程是唯一机制单位，root 与 child 的差异只允许作为数据/配置存在
  （角色、消息语义、设定作用域、舞台属性），不允许作为代码路径分叉。现存分叉
  清单（收拢路线图）：(1) 两套闸门——root 走空闲检查（checkSessionBusy 三段 +
  goal 生产 + 恢复扫描 + 批量消化）、child 走线程闸门（getLatestThreadRun →
  认领 → 起续跑），触发口两个且 root 强制路由前者；(2) 认领批量 root=100 /
  child=1（应由消息答复语义决定而非分支）；(3) 会话级模型/档位设定只作用于 root；
  (4) 身份解析来源不同（root 每次从 team 快照解析入口，child 取线程 run 记录的
  agent_name）；(5) child 续跑完成回投父结果、root 无回投（应为消息协议性质而非
  分支性质）。终态：root 是"配置成入口的普通线程"——单舞台/可见性是该线程的
  属性，goal 生产与恢复扫描等全局职责挪到线程无关的组件。演进中逐步收拢，
  不要求一步到位。
- **第五/六/七轮已实施（09-06）**：全量寻址、goal 门控发起者收窄、线程闸门统一全部落码并通过三包 typecheck/test 与根目录 check:backend。实施要点：认领谓词改纯分支（sqlite/postgres 同步）；新增 getLatestThreadRun 存储查询（线程现任执行）；唤醒目标改纯线程形状（AgentMailboxWakeupTarget 去 run 字段）；replacesRunId/participantExpectedLastRunId/mailboxTargetRunId 透传/findPendingMailboxTarget 全部删除；后台任务表 v2 加发起者两列（SaaS 迁移，历史行 null 视为 root）；bgnotify 路由发起者。实施中回归修复一处热循环：纯分支认领把历史带 run 段的定向行收进主分支批次后，伴随行物化重建信封丢失溯源字段（run/call/correlation/replyTo/sent_at）致同 id 重入队被判异形状——修复为信封重建逐字段精确回传（claimedMailboxEnvelope 补全、头行/伴随行 sentAt 去掉 created_at 顶替、契约链 sentAt 放宽 string|null），backend-local 回归测试钉死。
- **线程闸门统一（09-06 第七轮，用户裁定）**：定向通道的分散检查与 run 级簿记
  全部退役，root 线程的闸门模式推广到所有线程——交付判定收敛为每线程单一存储
  事务：认领该线程在途行 + 查该线程有无活动执行；有则行留给运行中执行 refresh
  取走，无则以头行为初始输入创建下一次执行。地址一律纯线程标识（第六轮的延伸）；
  唤醒退化为直接调用闸门（无状态、可多源并发重复调用，闸门事务自身原子分出
  胜负），去重状态机降级为性能优化而非正确性依赖；replacesRunId /
  participantExpectedLastRunId / mailboxTargetRunId 透传、findPendingMailboxTarget
  过期重解析等 run 级簿记随之删除。对话上下文=线程历史，追加式存放，每次执行
  按线程键自行读取，不记录也不比较"线程当前是哪次 run"。线程→智能体身份在
  委派时记录于线程登记处（现由 getLatestThreadRun 查该线程最新 run 记录承载；
  独立线程登记表为演进方向——run 历史被清理/归档后现承载会丢身份）。
- **评审修复（09-06，三区评审后）**：子分支行转发移到 busy 早退之前（root 繁忙
  不再阻塞子分支交付——bgnotify 路由发起者后，子智能体通知在 root run 运行期
  须由线程闸门消费，否则滞留无上界）；goal 行存在性改全量查询
  `existsPending`（queued+claimed 计入，免 root 积压超 listPending 100 行窗口时
  重复生产新一代 goal 行、双计预算，sqlite/postgres 同构实现）；指向无 run 历史
  线程的滞留行认领计数后释放，走死信封顶（不再 60s 无限空转）；
  `AgentMailboxWakeupTarget` 退役死字段 sourceMessageId/correlationId（闸门恒认领
  FIFO 头行，字段无消费者）；completeAgentMailboxContinuation 竞写撞 id 回读
  复用；idle followup 竞态整批放回补测试钉死；SaaS saas_runs v12 补线程现任
  复合索引（与 local 端同构）。
