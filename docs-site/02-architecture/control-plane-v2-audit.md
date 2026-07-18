# Control Plane v2 审计与边界

本文记录 PostgreSQL Control Plane core 完成后的剩余依赖、Bot/Widget 迁移边界和 secret 设计。它是实施门禁，不表示 PostgreSQL Bot/Widget 或多实例 Daemon 已经上线。

本页第 1 节保留 ports 抽取前的消费者基线，便于检查迁移覆盖面。当前这些服务器消费者已改用 `BotRepository` 或 `WidgetCredentialRepository`，Local 通过 SQLite adapters 兼容；只允许 composition root、Local adapters 和 Local CLI 创建 legacy stores。

## 1. Legacy 消费者基线

### ControlStore

| 消费者 | 直接能力 | 应替换的 port |
|---|---|---|
| `app.ts`、`fastify-context.ts` | 创建/装饰/关闭 store，向 Widget 透传 `.db` | composition 只接收 `ControlPlane`、`BotDirectory`、`BotConfigRepository`、`WidgetCredentialRepository` |
| `routes/bots.ts` | Bot CRUD、owner 校验、config 更新 | `BotAdministration` + `BotAuthorization` |
| `services/daemon/daemon-service.ts` | runtime config、enabled Bot、cron task CRUD/due scan | `BotRuntimeRepository` + `BotScheduleRepository` |
| `routes/agent/sessions.ts` | owner 的 Bot 列表和 membership | `BotDirectory` + 现有 `MembershipDirectory` |
| `routes/session-owner.ts` | Bot-owner 关系 | `BotAuthorization` |
| `routes/platform.ts` | 全局 Bot 查询和 reload | `BotDirectory`；reload 保持 runtime command，不进入 repository |
| `cli/widget-app.ts` | 创建 SQLite control store 并共享 `.db` | 使用同一 composition factory，不单独选择数据库 |
| `SqliteControlPlaneAdapter` | Local adapter 内部同步 store | 合法的 adapter 内部依赖，切换 PG 后不进入 SaaS composition |

`routes/bots.ts` 还通过 Bot 用户调用 `updateUser`。Bot identity、owner、tenant membership 和 Bot config 必须由一个聚合 command 原子创建/删除，不能由路由分别写 User port 与 Bot port。

### WidgetCredentialStore

| 消费者 | 直接能力 | 应替换的 port |
|---|---|---|
| `routes/widget-apps.ts` | app CRUD、secret rotation、token revoke、audit | `WidgetAppRepository`、`WidgetTokenRepository`、`WidgetAuditRepository` |
| `runtime/jwt-service.ts` | credential verify、tenant lookup、JTI record/revoke | 窄化的 `WidgetCredentialVerifier` + `WidgetTokenRegistry` |
| `identity/widget-identity-provider.ts` | app key 到 tenant | `WidgetAppDirectory` |
| `app.ts`、`route-assembly.ts` | 生命周期、pruning 和具体 store 透传 | `WidgetControlPlane` facade + lifecycle handle |
| `cli/widget-app.ts` | 与 SQLite `.db` 绑定 | 复用应用 composition |

Widget app secret 当前只存 SHA-256 hash，这是不可逆凭证，迁移时原样搬运 hash/prefix，不进入可解密 secret envelope。

## 2. Bot/Widget ports 后仍存在的分歧

上述 ports 已完成，但解除消费者对同步 SQLite API 的依赖不等于完整 SaaS：

1. `DaemonService` 的 scheduler、cron history、消息去重、飞书长连接都在进程内。多实例会重复领取 cron、重复启动长连接并产生重复副作用。
2. webhook `route_token -> tenant/bot` registry 是进程内映射。任意实例接收 webhook 时未必拥有相同 runtime state。
3. Conversation、Run、Outbox、Knowledge、Provider/MCP 配置仍是 tenant 本地 SQLite/文件。Control PG 创建的 tenant 不会让这些数据跨实例可见。
4. Bot 删除与 tenant SQLite 中既有 session/resource 不在同一事务，必须定义保留、软删除或异步清理策略。
5. Widget JWT 签名 key 来自进程环境。所有实例必须共享同一 key ring，并支持 `kid` 轮换；仅把 app/token 行迁入 PG 不解决签名一致性。
6. Widget token pruning timer 在每个实例运行。迁移后应使用数据库批量 claim/delete 或独立 worker，不能依赖单进程定时器语义。
7. Provider API key、MCP environment secret、reranker API key 和 Bot 第三方凭证分散在 YAML、tenant SQLite 和 control SQLite，尚无统一审计或轮换边界。

因此生产开放 `CONTROL_STORAGE_MODE=postgres` 至少要求：执行并核对 SQLite importer/checkpoint、Daemon leader/lease 或 durable job、共享 JWT key ring，以及 composition 中不存在 legacy SQLite fallback。当前 runtime、v3 importer、cron claim 和 Widget key ring 已具备；Conversation 等迁移可后续进行，部署仍必须标记为 Hybrid 并明确 route-token 跨实例解析与 sticky/单实例限制。

## 3. Third-party secret envelope

第三方可解密凭证与登录密码、Widget app secret 必须分开处理：

- password 使用抗暴力 password hash；Widget app secret 使用 verifier hash；两者都不可解密。
- Feishu `app_secret`、verification token、encoding AES key，以及未来 Provider/MCP credentials 需要运行时取回，使用 envelope encryption 或外部 secret reference。
- `app_id`、secret prefix、provider name 等非秘密元数据可明文保存。

建议统一值类型：

```text
SecretLocator =
  | { kind: "external"; provider: "vault"|"aws-sm"|"gcp-sm"|"azure-kv"; locator; version? }
  | { kind: "envelope"; envelope_id }
```

Envelope 行至少包含：

| 字段 | 要求 |
|---|---|
| `id`, `tenant_id` | 服务端生成；所有读取必须同时绑定 tenant |
| `purpose`, `resource_type`, `resource_id`, `field_name` | 构成授权和审计上下文 |
| `algorithm`, `envelope_version` | 首版建议 AES-256-GCM；禁止无认证加密 |
| `key_provider`, `key_id`, `key_version` | 标识 KEK，不保存 KEK 明文 |
| `encrypted_data_key`, `ciphertext`, `nonce`, `auth_tag` | 二进制列；data key 每个 secret 独立生成 |
| `aad_digest` | AAD 至少覆盖 tenant/purpose/resource/field/schema version，防跨行替换 |
| `created_at`, `rotated_at`, `disabled_at` | 支持轮换、撤销和审计 |

Secret API 必须使用 `set` / `clear` / `unchanged` 三态，不能继续把 `***` 当作存储协议。读 API 只返回 `configured`、reference kind、key version 和更新时间；任何列表、audit detail、exception、日志或 metrics 都不得返回 ciphertext 之外的秘密材料。Resolver 应按 tenant、resource、purpose 授权，解密值只在调用栈内短暂存在；如需缓存，必须有短 TTL、容量上限和 rotation 主动失效。

外部 secret manager reference 是 SaaS 首选。数据库 envelope 是兼容部署路径，但必须要求独立 master key/KMS；不能用 `SESSION_JWT_SECRET`、`WIDGET_JWT_SECRET` 或数据库连接密码派生 KEK。

## 4. PostgreSQL migration v2 边界

v1 保持 core 表：tenant、user、membership、auth session、settings、platform audit。v2 作为一个关系域加入：

- `control_bot_configs`、`control_bot_cron_tasks`；Bot user 继续引用 v1 `control_users`；
- `control_widget_apps`、`control_widget_tokens`、`control_widget_audit`；
- `control_secret_envelopes` 或规范化的 external reference；
- Bot config 中只保存 secret reference，route token 保存唯一查找 digest，并在需要恢复原 token 时保存独立 envelope reference；
- tenant、owner、bot、widget app 的 FK 和唯一约束全部在 PG 内成立。

v2 **不包含** Provider YAML、MCP config、Knowledge reranker key、Conversation/Run/Outbox。这些属于 tenant runtime migration，不能借 Control migration 偷渡。v2 也不自动解决 cron 多 worker claim；若同批开放多实例 Daemon，需增加 lease/attempt/idempotency schema，或继续只允许单 leader。

SQLite 导入流程要求：

1. preflight 校验 v1 tenant/user/membership 已存在且 ID/owner 一致；
2. maintenance window 或可证明的增量追平，禁止长期双写；
3. Widget verifier hash/prefix 原样迁移；Bot 可解密明文必须在迁移进程内立即 envelope 加密；缺少 KMS/master key 时整批失败；
4. 每条源记录计算 canonical checksum，重复导入相同内容跳过，不同内容报 conflict；
5. migration version、数据导入 checkpoint 和业务 audit 分开记录；DDL 成功不代表数据导入完成；
6. 切换前比较每 tenant 的 Bot/Widget/task/token 数量、FK、route digest 和随机抽样解密；
7. rollback 依赖只读 SQLite 快照和切换前停止新写入，不实现 PG 向下 migration。

## 5. 测试门禁

当前 core contract/E2E 未覆盖以下风险：

- SQLite/PG Bot port contract parity：原子 create/delete、owner/tenant 边界、config patch、cron due/claim；
- SQLite/PG Widget parity：secret verify/rotate、Origin、JTI revoke/prune、audit pagination和跨租户 404；
- composition architecture test：SaaS 不得 import/create `ControlStore` 或 `WidgetCredentialStore`，CLI 也必须使用同一 factory；
- v1 -> v2 fresh/idempotent/concurrent migration、history drift、DDL rollback和旧 SQLite importer conflict；
- envelope round-trip、tamper/auth-tag、错误 AAD、跨 tenant/resource substitution、key rotation和 external reference outage；
- API/日志/审计快照中无 plaintext secret；mask sentinel 不会覆盖原 secret；
- 两实例立即看到 Bot/Widget revoke；同一 cron 只有一个 claim；webhook 任意实例可解析 route digest；
- readiness 只有在 schema v2、数据导入完成且 secret resolver 可用时才 ready。

完成这些测试前，生产部署应继续把 `CONTROL_STORAGE_MODE=postgres` 视为未完成切换，不得仅凭 schema readiness 宣称迁移完成。
