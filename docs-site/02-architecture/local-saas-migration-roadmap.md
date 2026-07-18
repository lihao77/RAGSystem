---
status: planned
audience: architect, developer, operator
source: backend-ts/src/main.ts, backend-ts/src/app.ts, backend-ts/src/services/runtime, backend-ts/src/adapters
verified_at: 2026-07-18
---

# Local 与 SaaS 分离迁移路线

本文给出从当前 Local-first/Memory Hybrid 后端迁移到“共享核心 + Local 运行时 + SaaS 运行时”的完整路线。它描述的是实施基线，不把计划中的能力当成已经上线的事实。

## 1. 结论

现阶段不拆成两个仓库，也不复制两套业务代码。目标是在同一 monorepo 内形成三个稳定边界：

```text
                    shared core
       contracts / domain / application / protocol
                         |
             deployment composition ports
                  /                  \
       Local composition          SaaS composition
       SQLite + filesystem        PostgreSQL + object storage
       process-local runtime      multi-instance runtime
```

共享核心定义业务语义；Local 和 SaaS 只维护各自的基础设施适配、生命周期和安全策略。只有当两个 composition 已经可以独立构建、测试和发布后，才评估是否拆成两个物理项目。

## 2. 当前基线

截至 2026-07-18，Memory 已完成第一个纵向切片，启动行为如下：

| 启动配置 | Memory | 其他业务状态 | 运行形态 |
|---|---|---|---|
| 默认或 `STORAGE_MODE=sqlite` | 本地文件 | SQLite/本地文件 | Local |
| `STORAGE_MODE=postgres` | PostgreSQL | SQLite/本地文件 | Hybrid，单节点 |

PostgreSQL Memory 已覆盖 repository、application、tools、Agent context 和治理路由。`main.ts` 创建一个 `SaaSMemoryRuntimeHandle`，`app.ts` 将同一个 provider 注入治理路由和默认 Tenant Runtime。

以下能力仍是 Local-first，不能因为 Memory 使用 PostgreSQL 就宣称已经支持完整 SaaS：

- ControlStore、租户目录、用户和系统设置；
- conversation、session、message、run、pending interaction 和 durable outbox；
- knowledge、vector、上传文件、artifact 和 workspace 文件；
- Agent/Team 配置、skill、MCP 配置和 provider 配置；
- 进程内 realtime hub、后台任务、daemon 和 runtime registry；
- 宿主机文件工具、Bash 和 code execution。

::: warning 当前限制
Hybrid 模式仍依赖本机 SQLite 和目录，不能进行无状态横向扩容，也不能让多个后端实例安全共享全部租户状态。
:::

## 3. 目标边界

### 3.1 永久共享

| 层 | 共享内容 | 约束 |
|---|---|---|
| Contracts | repository、event、identity、execution、storage ports | 不依赖 Fastify、SQLite、PostgreSQL 或文件系统 |
| Domain | 实体、值对象、状态机、权限和不变量 | 不读取环境变量，不打开连接 |
| Application | command/query service、事务用例、治理流程 | 只依赖 contracts |
| Agent core | execution、context pipeline、tool schema、SDK adapter | 通过 runtime bindings 消费部署能力 |
| Protocol | HTTP DTO、WebSocket/AG-UI event、共享 npm packages | Local/SaaS 对外语义一致 |
| Test contract | repository contract suite、租户隔离和协议兼容测试 | 每个 adapter 必须通过同一套测试 |

### 3.2 Local 专属

- SQLite stores、sqlite-vec 和本地迁移；
- filesystem Memory、artifact、workspace、upload 和配置文件；
- `LocalTenantRuntimeRegistry` 与进程内事件/后台任务；
- 宿主机 Bash、文件操作和本地 code execution；
- Desktop/单机启动、备份和恢复。

### 3.3 SaaS 专属

- PostgreSQL repositories、schema migration、连接池和事务；
- 对象存储、外部向量服务或 PostgreSQL 向量 adapter；
- SaaS identity、组织/成员关系、配额、审计和密钥管理；
- 分布式队列、worker、租约、幂等和 realtime backplane；
- sandbox/remote execution、网络出口策略和租户资源限制；
- 多实例 readiness、滚动发布和在线迁移。

### 3.4 依赖规则

```text
routes -> application -> domain/contracts
                         ^
Local adapters ----------|
SaaS adapters -----------|

main-local -> Local composition -> shared routes/application
main-saas  -> SaaS composition  -> shared routes/application
```

禁止 shared core import `adapters/local` 或 `adapters/saas`。禁止路由根据 `STORAGE_MODE` 分支选择数据库；选择只能发生在 composition root。

## 4. 建议目录终态

迁移期间可以保持现有路径，边界稳定后再机械移动：

```text
backend-ts/src/
├── core/
│   ├── contracts/
│   ├── domain/
│   ├── application/
│   └── agent/
├── adapters/
│   ├── local/
│   │   ├── sqlite/
│   │   ├── filesystem/
│   │   └── process-runtime/
│   └── saas/
│       ├── postgres/
│       ├── object-storage/
│       ├── queue/
│       └── remote-runtime/
├── interfaces/
│   ├── http/
│   ├── websocket/
│   └── workers/
└── composition/
    ├── local/
    └── saas/
```

目录移动不是前置条件。优先让依赖方向正确，再处理路径和包名，避免“大搬家但边界没有变化”。

## 5. 数据域迁移矩阵

| 数据域 | 当前来源 | SaaS 目标 | 顺序 | 切换单位 |
|---|---|---|---:|---|
| Memory | 文件；Hybrid 可用 PostgreSQL | PostgreSQL | 已开始 | tenant |
| Control/Identity | 系统 SQLite（已置于异步 port 后） | PostgreSQL control plane | 2，进行中 | deployment |
| Session/Conversation | tenant SQLite | PostgreSQL | 3 | tenant |
| Run/Interaction/Outbox | tenant SQLite | PostgreSQL + worker | 3-4 | tenant |
| Realtime/Background | 进程内 | durable queue + pub/sub | 4 | deployment |
| Resource/Artifact/File | 本地目录 | object storage + metadata DB | 5 | tenant/bucket prefix |
| Knowledge/Vector | sqlite-vec + 本地 blob | SaaS vector adapter + object storage | 6 | knowledge base |
| Agent/Team/Skill config | YAML/目录 | versioned config repository | 7 | tenant |
| MCP/Provider secrets | YAML/env | secret manager + encrypted metadata | 7 | tenant/integration |
| Code execution | 宿主机/本地进程 | sandbox/remote execution | 8 | run |

## 6. 分阶段实施

每个阶段都必须同时交付 contracts、Local adapter、SaaS adapter、composition、迁移工具、可观测性和测试，不能只提交数据库实现。

### Phase 0：冻结边界和建立护栏

目标：防止迁移期间继续产生部署耦合。

工作项：

1. 建立 `DeploymentRuntime`/resolver 契约，明确 HTTP、Agent、daemon 和 worker 获取 tenant service 的统一方式。
2. 禁止 `saasMemoryRuntime + 未声明能力的自定义 Local registry` 组合，消除 routes 和 Agent 的 split-brain。
3. 为 runtime handle 使用共享 `closePromise`，确定关闭顺序、并发关闭和失败语义。
4. 给 repository ports 建立 contract test，Local 与 SaaS adapter 使用相同 fixtures。
5. 建立架构检查：shared core 不得 import `node:sqlite`、`pg`、`node:fs` 或部署 adapter。
6. 固化租户上下文：tenant ID 必须来自认证上下文，不能由业务 payload 覆盖。

验收：错误组合启动即失败；每个请求只解析一次 tenant runtime；Local 全量测试保持通过。

### Phase 1：完成 Memory 纵向切片

目标：把当前“可运行”Memory Hybrid 收口为可长期复用的切片模板。

已完成：

- Memory repository ports、Local filesystem adapter 和 revision；
- PostgreSQL schema、executor、repository 和 migration；
- tenant-bound `MemoryApplication`；
- SaaS tools、context、治理路由和启动注入；
- 无缓存 tenant facade，治理 resolver 不再创建并提前释放伪 lease；
- runtime handle 共享并发 `closePromise`，非法自定义 composition 启动即失败；
- 真实 PostgreSQL E2E 接入 CI，覆盖 tool、governance、query、context 和重启持久化；
- filesystem entry importer 支持显式来源 dataRoot、dry-run、幂等和冲突报告。
- Memory scope 治理已区分个人与共享：session/user/workspace 直接发布，team/agent 进入共享审核；
- Memory 管理页已覆盖个人、共享、待审核、历史、详情、撤回、批准、拒绝和归档；
- 通用 entry API 对 admin/owner 仍执行个人数据隔离，不暴露其他用户的个人 Memory；
- PostgreSQL schema version 4 幂等迁移旧个人 publish candidates，并保留 approved 审计记录；
- Hybrid SaaS Docker 已完成 workspace 包打包、sqlite-vec Linux 原生依赖探针和真实租户 Runtime 冒烟。

剩余工作：

1. 继续覆盖连接中断和更强的并发/故障注入；当前 tenant 隔离、事务批准和真实 PostgreSQL E2E 已建立。
2. 为 SQLite memory candidates 提供独立 importer；filesystem importer 只迁移 entry。
3. 增加按 tenant 的 `memory_backend` 切换和回滚开关；稳定后再删除双读/影子校验代码。

验收：同一 tenant 的 route/tool/context 命中同一 repository；Local 与 PostgreSQL contract tests 等价；迁移可重复执行且条目数、revision 和内容校验一致。

### Phase 2：迁移 Control Plane、Identity 与 Tenant Directory

目标：移除 SaaS 启动对单机 ControlStore 的依赖，为多实例提供统一租户来源。

已完成的第一批：

- 建立异步 `ControlPlane` 组合 ports，覆盖 tenant、human user、membership、settings、auth session、audit、health 和 provisioning；
- SQLite adapter 保持当前生产数据源，并为安装、创建租户、邀请成员和移除成员提供原子操作；
- IdentityProvider、Session token 撤销检查、HTTP hook 和 WebSocket 预校验已异步化；
- auth/admin/platform/bootstrap/readyz 不再直接访问 `ControlStore.db` 或控制 SQLite 事务；
- tenant runtime registry 通过 `TenantDirectory` 验证和枚举租户；
- 平台身份由路由 composition 显式选择，不再由 provider 检查 URL；
- tenant 管理路由强制 path tenant 与当前身份 tenant 一致，跨租户请求必须先切换租户；
- readiness 校验实际 Control schema version，而不是固定报告 migration 正常。
- 安装在提交前验证目标认证 profile，避免缺少 session secret 时留下半安装状态；
- 平台状态修改与 audit 在同一 SQLite 事务内提交，Local 默认身份初始化也使用幂等原子 provisioning；
- suspended tenant 的普通 Runtime acquire 被拒绝，平台检查使用独立的 privileged acquire；
- 非同源 ControlPlane/legacy Bot-Widget store 组合启动即失败，并明确资源关闭所有权。

当前仍未切换的数据源：Control Plane、Bot 和 Widget 凭证继续位于同一个 `control.db`。Bot 用户、membership、bot config 和 widget app 之间存在外键关系，因此不能只把 human user/tenant 单独切到 PostgreSQL。

工作项：

1. ~~从 ControlStore 抽出 tenant、user、membership、role、settings、session revocation ports。~~
2. ~~保留 SQLite Control adapter。~~ 增加 PostgreSQL Control adapter 和事务 migration。
3. 将 tenant provisioning 设计为幂等状态机：creating -> active -> suspended -> deleting。
4. password/OIDC identity 统一映射到 tenant membership；所有控制面操作写审计记录。
5. 迁移 widget credential、session revocation 和系统设置，密钥只存引用或密文。
6. `/readyz` 检查 control DB schema、连接和 migration 状态。

验收：两个后端实例能看到一致的租户、用户和撤销状态；不存在通过扫描本地 tenant 目录发现租户的 SaaS 路径。

### Phase 3：迁移 Conversation、Run、Interaction 与 Outbox

目标：把 Agent 执行的事实来源迁入 PostgreSQL，这是 SaaS 多实例的关键路径。

工作项：

1. 按聚合拆分 session/message/run/run-step/resource/pending-interaction/outbox ports，消除对具体 `ConversationStore` 类的依赖。
2. PostgreSQL schema 全表带 tenant key；唯一约束包含 tenant 边界。
3. 保证“业务状态变更 + outbox append”处于同一数据库事务。
4. 为 event ID、client request ID、run resume 和 approval resolution 建立幂等约束。
5. 将查询分页改为稳定 cursor，避免跨实例下 offset 漂移。
6. 提供 SQLite -> PostgreSQL tenant 导入器，支持先快照、后增量追平。

验收：任一实例可继续另一个实例创建的 session/run；进程崩溃不会产生已提交状态但缺少 outbox 的窗口；跨租户主键碰撞测试通过。

### Phase 4：分布式事件、后台任务与 Runtime 生命周期

目标：去除 SaaS 对进程内 hub、timer、daemon 和粘性会话的依赖。

工作项：

1. Outbox dispatcher 使用数据库 claim/lease、`SKIP LOCKED` 或等价机制，支持多 worker 竞争。
2. 引入 queue/pub-sub adapter；Realtime hub 只作为连接节点的投影，不再是事实来源。
3. WebSocket/SSE 使用 durable cursor 回放，断线后从 outbox/event log 恢复。
4. background task、scheduled daemon 和 notification 改为 durable job，定义重试、死信和取消。
5. `SaaSRuntimeProvider` 只缓存轻量 facade；实现 TTL/LRU、租户关闭和进程关闭协议。
6. 增加 worker readiness、lag、lease contention、dead-letter 指标。

验收：至少两个 API 实例和两个 worker 下无重复副作用；杀死任一实例后 run、approval 和事件流可恢复。

### Phase 5：对象存储与工作区抽象

目标：清除 SaaS 业务路径对宿主机 `dataRoot` 的依赖。

工作项：

1. 定义 BlobStore、ArtifactStore、WorkspaceStore、FileHistory ports。
2. Local adapter 继续使用目录；SaaS adapter 使用 S3 兼容对象存储和 PostgreSQL metadata。
3. key 必须由服务端生成并包含 tenant namespace；拒绝路径穿越和跨租户 key。
4. 上传采用 presigned URL 或流式写入，记录 checksum、size、content type 和 retention。
5. 资源删除采用 tombstone + 异步清理，处理数据库与对象存储的非原子性。
6. 文档工具依赖 Workspace port，不直接调用 `fs`。

验收：SaaS API 容器使用只读根文件系统仍可运行；对象泄漏、孤儿 metadata 和跨租户访问有周期审计。

### Phase 6：Knowledge 与 Vector

目标：让知识库可横向扩展，同时保留 Local 的 sqlite-vec 体验。

工作项：

1. 细化 vector、knowledge config、document metadata 和 source blob contracts。
2. Local 保留 sqlite-vec；SaaS 选择并实现一个生产 adapter，例如 pgvector 或外部向量服务。
3. embedding/extraction 改为 durable jobs，写入幂等 document/chunk version。
4. 统一 filter 语义，所有检索自动注入 tenant/knowledge-base scope。
5. 建立 reindex、dimension/model 变更和蓝绿索引流程。
6. 提供 sqlite-vec -> SaaS vector 的导入与召回对比报告。

验收：相同 fixture 在两个 adapter 上满足协议级结果；模型升级可在线重建并原子切换索引版本。

### Phase 7：配置、Skill、MCP、Provider 与 Secret

目标：将“本机 YAML 即事实来源”限制在 Local 模式。

工作项：

1. 为 Agent/Team/SystemConfig/Skill 建立带版本和 ETag 的 repository ports。
2. Local adapter 继续读写 YAML；SaaS adapter 使用 PostgreSQL metadata + 对象存储内容。
3. secret 使用外部 secret manager 或 envelope encryption，API 永不返回明文。
4. MCP/provider 连接按 tenant 建立、限额和回收；禁止共享可变客户端泄漏身份。
5. 配置变更发布 version event，使多实例 cache 失效。
6. 管理端加入审计、回滚和 staged rollout。

验收：配置修改在所有实例可见且有版本冲突保护；日志、事件和数据库普通列不出现 secret 明文。

### Phase 8：Execution、网络与安全隔离

目标：SaaS 不执行宿主机命令，不把 Local 安全假设带入生产。

工作项：

1. 定义 ExecutionProvider、WorkspaceMount、NetworkPolicy 和 Cancellation ports。
2. Local 使用 process adapter；SaaS 使用容器 sandbox 或 remote executor。
3. 每次 run 设置 CPU、内存、磁盘、时长、进程数和网络出口限制。
4. tool permission 与 deployment capability 合并判定；未提供的能力不注册。
5. artifact 通过对象存储交换，不挂载 API 节点本地目录。
6. 记录不可抵赖审计：actor、tenant、tool、policy decision、resource usage。

验收：SaaS profile 下无法构造宿主机执行路径；sandbox 逃逸、SSRF、secret exposure 和资源耗尽测试纳入发布门禁。

### Phase 9：拆分 Composition 与发布产物

目标：在不复制 shared core 的前提下，让两种模式独立构建和部署。

工作项：

1. 建立 `main-local` 和 `main-saas`，分别只 import 自己的 adapters。
2. 将 `buildApp` 改为接收完整 `DeploymentRuntime`，不再接受零散可选依赖。
3. Local bundle 不要求 PostgreSQL/queue/object storage；SaaS bundle 不加载 sqlite-vec、宿主机执行和 filesystem stores。
4. 分别提供 Docker image、desktop package、配置 schema 和启动探针。
5. CI 建立 shared、Local、SaaS 三组测试和依赖方向检查。
6. 保持 HTTP/WS/protocol compatibility suite 对两种 composition 复用。

验收：两个入口可独立安装、构建、启动和升级；任一 adapter 变更不会迫使另一模式加载其运行时依赖。

### Phase 10：数据迁移、灰度与最终切换

目标：把已有 Local/Hybrid 租户迁入完整 SaaS，而不是只支持新租户。

迁移流程：

```text
inventory -> preflight -> snapshot -> bulk copy -> checksum
          -> incremental catch-up -> write freeze -> final delta
          -> switch routing -> observe -> retire old source
```

工作项：

1. inventory 输出每个 tenant 的 schema version、数据量、文件量、checksum 和不兼容项。
2. 每个 importer 都使用 migration ID、checkpoint 和幂等 upsert，可中断续跑。
3. 大域使用 bulk copy + 增量追平；最终切换只需要短写冻结。
4. 切换按 tenant feature flag，不使用一次性全局开关。
5. 灰度顺序：内部租户 -> 测试租户 -> 小租户 -> 大租户。
6. 观察期保留旧数据只读，不立即删除；达到保留期后再执行可审计清理。

验收：迁移前后 counts、关系、checksum、抽样语义和权限一致；回滚演练成功；备份恢复和灾难恢复目标达标。

## 7. 每个切片的标准交付模板

后续迁移 Conversation、Knowledge 等域时，统一按以下顺序实施：

1. 盘点调用者和当前事务边界。
2. 抽取最小 contract，补共享 contract tests。
3. 让现有 Local 实现适配 contract，证明行为未变。
4. 建立 domain/application service，移除 route/tool 对 store 的直接依赖。
5. 实现 SaaS adapter、schema migration 和隔离约束。
6. 在 SaaS composition 注入 route、Agent、worker 和治理入口。
7. 增加 importer、shadow compare、metrics 和回滚开关。
8. 完成 E2E、故障注入和多租户测试后再切流。
9. 稳定观察后删除临时双写/双读路径。

任何切片如果只完成第 5 步，都不能标记为“已迁移”。

## 8. 测试与发布门禁

### 必须持续通过

- shared core 单元测试和 adapter contract tests；
- Local 全量回归及历史数据兼容测试；
- SaaS PostgreSQL/对象存储/queue 集成测试；
- route/tool/context/worker 使用同一 tenant application 的 composition tests；
- 跨租户读写、缓存污染和 ID 碰撞测试；
- transaction rollback、进程终止、连接中断和重复投递测试；
- migration dry-run、重复运行、断点续传和 rollback rehearsal；
- 两实例以上的 concurrency/E2E 测试。

### 关键可观测指标

| 类别 | 指标 |
|---|---|
| 数据库 | pool saturation、query latency、transaction retry、migration version |
| Runtime | active tenant facade、eviction、acquire latency、close failure |
| Outbox/Queue | pending、oldest age、claim conflict、retry、dead letter |
| Migration | copied rows/bytes、checkpoint、checksum mismatch、lag |
| 隔离 | denied cross-tenant access、missing tenant context、policy violation |
| Storage | orphan objects、failed cleanup、upload/download errors |

## 9. 回滚原则

1. schema 采用 expand -> migrate -> switch -> contract，禁止同一发布先删旧列。
2. route flag、repository flag 和 migration state 分离；配置回滚不能伪造数据回滚。
3. 单一数据域在任一时刻只能有一个写入权威，避免长期双主。
4. 需要双写时必须有 event ID/operation ID、失败补偿队列和差异审计。
5. 切回 Local 前确认新写入已经反向同步；否则只能停止写入并人工处置。
6. 旧来源在观察期只读保留，清理由独立、可审计任务完成。

## 10. 里程碑与完成定义

| 里程碑 | 包含阶段 | 可声明的能力 |
|---|---|---|
| M1 Memory Hybrid | Phase 0-1 | Memory 可选 PostgreSQL，仍是单节点 Hybrid |
| M2 Shared State | Phase 2-3 | 控制面和 Agent 事实状态可跨实例共享 |
| M3 Distributed Runtime | Phase 4 | API/worker 可横向扩展并恢复事件 |
| M4 Stateless SaaS API | Phase 5-8 | API 节点无本地持久状态，执行受隔离 |
| M5 Independent Products | Phase 9 | Local/SaaS 独立产物，共享核心 |
| M6 Production Cutover | Phase 10 | 现有租户完成迁移、回滚和灾备验收 |

“完整 SaaS”至少要求 M4；“Local/SaaS 已分离”要求 M5。只有 Memory 使用 PostgreSQL时只能称为 M1 Hybrid。

## 11. 推荐的近期批次

为保持改动可审查，接下来按以下批次推进：

1. Memory 并发/故障 E2E 与 SQLite candidate importer。
2. ~~Control/Identity ports 和 SQLite adapter 回归，不切换生产路径。~~
3. PostgreSQL Control adapter、tenant provisioning、Bot/Widget 关系域和审计。
4. Conversation contracts 拆分与 Local adapter contract tests。
5. PostgreSQL session/message/run/outbox 首个纵向切片。

每批只迁移一个明确边界并独立提交；不在同一批同时移动目录、改协议和切换数据源。
