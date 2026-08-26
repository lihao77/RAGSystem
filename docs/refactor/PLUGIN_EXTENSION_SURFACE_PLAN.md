# Core 向插件开放的能力路线（Plugin Extension Surface Roadmap）

> 创建时间：2026-08-26
> 状态：提案文档，未进入实施
> 范围：backend-core 插件扩展面演进——生命周期事件闭环、基础能力端口、总线语义、UI 贡献
> 前置：实体生命周期事件（`session/agent/team deleted`、`team renamed`）与记忆级联清理已落地（backend-core `entity-lifecycle-events.ts`，commit `735a0ffd`）

## 背景

插件系统现有扩展面：10 个注册面（`BackendPluginContext`）+ 约 15 个租户运行时端口（`BackendPluginRuntimeContext`）+ 9 个 run 管线钩子（agent-sdk `HookRegistry`）+ 7 个应用事件，合计 40+ 条缝。

2026-08 与 pi-mono（`packages/coding-agent/src/core/extensions/types.ts`，ExtensionAPI 34 个 typed 事件、全量约 112 条缝）做了对照。结论：

- **缝的数量不是设计信号**，任何可扩展系统按同等粒度都能数出这个量级；
- pi 事件中约三分之一是带决策结果的拦截缝（block/cancel/replace），与 agent-sdk `HookDecision` 独立收敛到同一模式，互为旁证；
- pi 的密集缝（provider 请求级、消息终结改写、终端输入、host chrome 替换）属于"扩展即产品"的单机 TUI 形态，多租户后端不开是对的；
- 对照发现两条我们确实缺的缝：**会话流内渲染贡献**与**插件间总线**，加上既有评估中的生命周期闭环缺口，构成本路线。

## 开缝判据

新缝只按以下四条开，不追覆盖率：

1. **领域闭环**：会产生孤儿数据的实体，其删除/改名必须有事件。
2. **绕路证据**：出现 `console.warn`、私有 `setInterval`、payload 里塞可变容器当返回通道等 workaround，才开对应端口。
3. **契约宿主所有**：每条缝走已验证的四件套——契约文件 + 类型守卫 + 逐 handler 错误隔离 + 租户语义（payload 带 tenantId）。
4. **永久兼容负债**：按"一旦有插件用上就收不回"评估；拿不准的进 Phase 4 观察区。

---

## Phase 1：生命周期事件闭环（建议下一步立即做）

### 1.1 `workspace.deleted`

- **动机**：记忆插件有 workspace scope（`memory/users/<id>/workspaces/<key>`），`SessionApplication.removeWorkspace`（`contracts/session/session-application.ts:70`，local/saas 两个实现）删除 workspace 后记忆永久孤儿。workspace 分区键由 workspace root 归一化而来（`getWorkspaceMemoryKey`），可被同名重建，**对账清扫不安全**，事件是唯一可靠途径。
- **契约**：`WORKSPACE_DELETED_EVENT = "workspace.deleted"`，payload `{ tenantId, workspaceId, workspaceKey }`。workspaceKey 在发射点用与记忆分区一致的归一化规则计算，消费方不重复推导。
- **发射点**：local/saas 的 `removeWorkspace` 实现删除成功后发布（与 session.deleted 从核心服务发布不同：removeWorkspace 的实现在两个部署的 wrapper 上，需保持两处一致，或评估下沉到共享层）。
- **消费**：memory `purge({ scope: "workspace", ... })`——local 删 `memory/users/<id>/workspaces/<key>` 目录，postgres 按分区键三表删除。capability 的 `MemoryPurgeInput` 增补 workspace 分支。

### 1.2 `tenant.deleted`

- **动机**：control-plane 已有 `removeTenant?`（`contracts/control-plane/ports.ts:96`），但租户数据目录（`tenantsRoot/<tenantId>/`：记忆、SQLite、workspace 文件）无任何回收路径。SaaS 形态硬需求。
- **契约**：`TENANT_DELETED_EVENT = "tenant.deleted"`，payload `{ tenantId }`。
- **发射与顺序**：`removeTenant` 确认后、由宿主在**关闭该租户运行时之后**发布；订阅方不得再 `registry.acquire` 该租户。local 形态可直接清目录级数据；memory 的消费语义是删除整个租户记忆根（local）/ `DELETE ... WHERE tenant_id`（postgres）。
- **开放问题**：SaaS 多实例下执行 removeTenant 的实例与持有租户数据的实例可能不同，进程内总线不可靠。方案候选：控制面任务队列 + 各实例认领清理，或本事件仅作为单实例语义、跨实例清理走 control-plane 的一致性任务。**实施前必须定案。**

### 1.3 `user.deleted`（暂缓，记录判据）

control-plane 当前没有用户删除端口（2026-08-26 核对），没有删除路径就没有孤儿，不开缝。SaaS 用户删除落地时与 `user.deleted` 事件一起做，消费方为 memory 的 user/workspace 两个 scope 的 purge。

### 1.4 logger 注入

- **动机**：`BackendPluginRuntimeContext` 没有 logger（只有 applications 上下文有），记忆插件在 `memory-store.ts` 直接 `console.warn`。
- **方案**：runtime context 增加 `readonly logger`，backend-local/saas 组合层传入（构造租户容器时 logger 就在手边）；记忆插件替换裸 `console.warn`。半天工作量。

---

## Phase 2：插件间总线与请求-响应语义

- **现状**：应用事件总线只有宿主→插件单向；插件互通只能经 capability 依赖（静态、编译期）；`session.origins.resolve` 用 payload 里塞可变 `Map` 当返回通道（`routes/agent/sessions.ts` + scheduler 消费），是在 fire-and-forget 总线上硬凑 RPC。
- **方案**（对照 pi `events: EventBus`，30 行实现的带错误隔离插件间通信）：
  1. `PluginEventRegistrar` 增加受限 `emit`：事件名强制 `plugin:<pluginId>:` 前缀，宿主盖章防伪造；handler 错误隔离与现有 emit 相同。
  2. 总线增加 `collect(event, payload): Promise<result[]>` 请求-响应语义，收编 origins-resolve 的 Map 回传写法。宿主侧 `emit` 保持现状。
- **边界**：明确为进程内 best-effort，不落 outbox；SaaS 跨实例场景文档注明不可达。
- **验收**：scheduler 的 `session.origins.resolve` 订阅改造为 `collect` 语义，作为唯一参考实现。

## Phase 3：会话流内渲染贡献（plugin-ui-sdk apiVersion 2）

- **现状**：`plugin_event` 下行帧前端默认忽略未知事件（`plugins/backend-plugin.ts` 契约注释），插件 UI 只有独立路由视图（`PluginUiManifest.views`）+ 事件快照（`PluginUiEvents.latest`）；对照 pi 的 `registerMessageRenderer/registerEntryRenderer`（扩展在消息流原位渲染自己的内容类型）。
- **缺口**：以会话为中心的产品里，插件无法在自己的消息位置渲染内容（进度条、任务卡片、审批面板），只能靠前端写死。
- **方案**：`PluginUiManifest` 增加 `transcriptRenderers` 声明（`plugin_event` 的 event 名 → bundle 内渲染 entry）；宿主 dispatcher 收到帧时查表挂载插件 bundle 的微型组件；沙箱与安全约束沿用现有（bundle 同源伺服、`data` 按不可信数据处理、不与宿主共享 Vue 实例）。apiVersion 升 2，向后兼容。
- **影响面**：frontend-client 的 PluginViewHost、`packages/plugin-ui-sdk` 契约、`plugins/backend-plugin.ts` 的 UI manifest 类型。
- **价值场景**：memory 提取进度、scheduler 任务卡片、pet 类插件的会话内交互。

## Phase 4：观察区（记录判据，触发后再做）

| 候选缝 | 触发条件 |
| --- | --- |
| 共享调度能力（`scheduling.register`） | 出现第 3 个自造 `setInterval` 的插件（现有：memory 对账、transient resources、outbox GC） |
| 插件健康/诊断贡献（`health?()`） | 宿主需要聚合插件健康（如 Oceanx 诊断导出要包含插件状态） |
| Provider 目录贡献（声明式，凭据归宿主） | 出现插件需要注册模型/端点的真实需求，且与租户级 provider 治理的冲突有解 |
| 声明式上下文资源（`resources_discover` 等价） | 第 2 个插件需要向 run 注入上下文且命令式 `round.before` 出现重复样板 |
| 插件存储抽象 + `migrate(fromVersion)` 契约 | 第 3 个自带 SQLite/Postgres 双实现的插件出现（现有：memory） |

---

## 排期建议

- Phase 1.1 / 1.2 / 1.4 一批实施（1.2 需先定案跨实例语义），延续已验证的四件套模式与上游先行、Oceanx 同步的交付流程。
- Phase 2、3 各自独立成批，Phase 2 先行（改动小、收编存量 workaround）。
- 统一验收标准：契约文件 + 类型守卫测试 + emit 错误隔离测试 + memory 消费方级联测试（照 `entity-cascade.test.mjs` 模式）+ 相关文档同步。

## 附录：与 pi-mono 的事件层映射（摘要）

| pi 事件 | ragsystem 等价 |
| --- | --- |
| `before_agent_start` / `agent_start` / `agent_end` / `agent_settled` | `run.before` / `run.after` / `run.finally`（agent-sdk HookRegistry） |
| `turn_start` / `turn_end` | `round.before` / `round.after` |
| `tool_call` / `tool_result` / `tool_execution_*` | `tool.before` / `tool.gate` / `tool.after` / `tool.error` |
| `context`（返回注入消息） | `round.before` 的 `additionalContext` |
| `session_start` / `session_shutdown` 等 session 族 | 无逐条等价；实体生命周期事件覆盖删除/改名维度 |
| `before_provider_request/headers`、`after_provider_response` | 不开（agent-llm 内部，凭据安全边界） |
| `message_end`（终结改写） | 不开（内核消息完整性） |
| `input`、UI 替换族（footer/editor/theme） | 不开（终端形态专属；web 产品宿主 chrome 归宿主） |
| `registerProvider` | Phase 4 观察区（声明式子集） |
| `registerMessageRenderer` / `registerEntryRenderer` | Phase 3 |
| `events: EventBus`（插件间） | Phase 2 |
