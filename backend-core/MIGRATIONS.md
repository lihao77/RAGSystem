# 数据迁移与形态归一清单

本文件是所有持久化数据治理步骤的单一登记处。**新增或退役任何步骤必须同步修改本文件**
（有清单自证测试锁定：`test/hydration-manifest.test.ts` 断言代码中注册的每个步骤 id
都出现在本文件中）。

两类步骤的语义区别（内核 `src/services/config/hydration.ts` 不区分，由本清单声明）：

- **可退役迁移**：针对特定历史形状的一次性治理。步骤保留到宣布最低支持版本为止；
  删除旧步骤 = 放弃该历史版本直接升级的用户，必须在发布说明中显式声明。
  实际生效时由持久层随数据回写记录应用戳（local：`config/agents/.migrations.json`，
  追加式，含 `applied_at`；SaaS 当前 no-op，见下）。应用戳仅用于排查审计，不参与
  "要不要执行"的决策——执行永远由数据形状驱动，因此跳版升级、备份恢复、手工编辑
  后的半迁移状态都能安全收敛。
- **形态归一层**：永久的形态守卫，同时服务加载与新建/更新路径，永不退役、无应用戳。
  对它的"删除守护"永远空转——这不是遗漏，是语义不同的另一类。

## 可退役迁移

### agent 配置（`src/services/agent/config/agent-config-hydration.ts`）

链目标：整个 teams Map，每次加载全量执行；生效时 `saveAll` 一次性回写并记戳。

| id | 针对的历史形状 | 说明 | 引入 |
| --- | --- | --- | --- |
| `strip_dangling_delegation_refs` | `enabled_agents` 引用了本 team 不存在的 agent | 剔除悬空委派引用 | 早期自愈逻辑 |
| `strip_stock_default_llm_tier` | 内置默认 team 出厂携带的示例 tier（`my`/`deepseek`/`deepseek-chat` 全等副本） | 剥除后继承系统 LLM；用户改过参数或另有档位的不动。已知限制：与出厂常量逐字段全等（含仅 default 档、空 extra_params）的手工配置也会被剥除——provider "my" 实际不存在，误伤面趋近于零 | 2026-08（对应 Oceanx 定时任务 readiness 故障） |
| `strip_empty_llm_tiers` | 零信息 tier 条目：provider 与 model_name 均为空白（Agent Studio 对未配置档位的落盘形态） | 剔除该档位；map 剔空则整体置 null 以继承系统 LLM。半空条目（两字段仅其一非空）保留——运行期 default 档引用失效回落系统 LLM（readiness 标注 fallback_reason），条目留在配置供前端标注失效 | 2026-08（全空 default tier 挡住系统 LLM 兜底导致 readiness 硬失败） |

### Skills 插件与 Builder（2026-09，直接保存 Skill）

系统尚无用户存量，本次移除 Skill 草稿时不提供草稿数据迁移、归档或恢复；同时删除草稿建表步骤。存储侧收敛：SaaS postgres 启动迁移在迁移史前缀严格校验之前先退役草稿墓碑——`DROP TABLE IF EXISTS saas_skill_drafts`，并按 `(version, name)` 形状剔除迁移史中 v3 `skill_drafts` / v4 `skill_draft_names` 两行（不剔除则跑过旧版本的库在校验处启动即崩）；本地 SQLite 打开时 `DROP TABLE IF EXISTS skill_drafts` 清理孤儿表。两者均幂等、不看版本号，对未来复用 v3/v4 版本号不生效。以下步骤仅更新 Builder 的工具配置与提示词，不处理 Skill 草稿数据。

| id | 针对的历史形状 | 说明 |
| --- | --- | --- |
| `builder_skill_direct_save` | Builder 入口仍含旧 Skill 工具名、缺少直接保存协议，或受管编写协议仍要求 Python-only/execute_skill_script，包括无版本/当前版本/半迁移状态 | `backend-plugin-agent-builder/src/skill-authoring-hydration.ts` 归一四个编写工具和受管提示词；旧执行协议收敛为 activate_skill 加通用文件/执行工具，保留受管块外的用户指令和其他工具。持久化到 behavior.skill_authoring_migration 的 id/applied_at 仅供审计，是否执行由工具/提示词形态决定。 |

Skills 旧自动发布配置不再注册；系统配置已有 `project` 已知根分组投影会忽略旧 `skills.approval`，下次 updateConfig 回写时剥离，无需版本判断。Skill 编写工具退役名同时由插件登记到既有工具名归一注册表，配置与会话快照读取沿用该永久归一能力。

## 形态归一层

### Agent 配置与会话 team 快照（`src/contracts/agent/tool-name-aliases.ts`、`config-normalize.ts`、`src/contracts/session/session.ts`）

链目标：agent 配置走 `normalizeConfig`（磁盘水合 loadTeamConfigFile 与 create/update/apply/import
写路径全量过此函数）；会话 team 快照走 `SessionTeamSnapshotSchema` 的 preprocess
（local mappers 与 SaaS conversation-repository 的读取汇点 `normalizeSessionTeamSnapshot`）。
二者均为永久归一，无应用戳。

退役工具名是**插件知识**：插件在 `BackendToolDescriptor.retired_names` 里声明历史名，
plugin-manager 注册描述符时聚合进 `tool-name-aliases` 注册表，core 不硬编码任何插件工具名
（core 自有工具的退役/托管名单见 `stripConfigManagedToolNames`）。时序由 `buildCoreApp`
保证：pluginManager.register() 先于部署容器构建（agent 配置水合发生处）。

| id | 归一内容 |
| --- | --- |
| `enabled_tools` 退役名归一（`canonicalizeEnabledToolNames` + 注册表） | 插件声明的退役名映射为现名（首个声明：执行工具插件 `execute_bash` → `execute_shell`，2026-09 更名为平台中性的 shell 执行）。配置路径保序去重；快照路径在 schema preprocess 中**逐项**改名（保留重复项、不动非字符串项——存量 revision 锚点按落库原形状计算，去重会失配致快照不可读），并当库内 `team_revision` 命中退役名形状哈希时**重锚定**为现名形状哈希——revision 恒等于 parse 结果内容的内容哈希，superRefine 单哈希严格校验不变，下游身份比较（run-engine、SaaS createSession 冲突检测）比较原文即一致 |
| `stripConfigManagedToolNames` | 剥离 runtime/config 接线托管的工具名与退役 workflow 工具名（task_* 等 core 自有工具），早于归一层长期存在 |
| 存量未锚定快照 NULL 容忍与锚定回填（`hydrateSessionTeamSnapshot` + `SessionIdentityStoragePort.anchorSessionTeamSnapshot`） | 2026-08 快照特性之前落库的会话行 `team_snapshot=NULL`。读取汇点（local mappers / SaaS conversation-repository）经 `hydrateSessionTeamSnapshot` 透传 null（`SessionInfo.team_snapshot` 可空）；首次 `ensureSession` 带运行期解析的快照触达时锚定回填（UPDATE 仅命中 NULL 行，幂等），此后恢复不可变身份比对。写入端 `normalizeSessionTeamSnapshot` 仍严格拒绝 NULL。引入于 2026-09——该形状曾让飞书机器人对旧会话的所有新消息在 `rowToSession` 处 ZodError 崩溃且只余 console.error 痕迹 |
| 存量 metadata 保留字剔除（`hydrateSessionMetadata`） | 保留字规则收紧前，自由 metadata 曾合法承载 `team`/`entry_agent` 等团队路由（今由 Session 一等字段与 team_snapshot 承载）。读取汇点与 SaaS `updateSessionMetadata` 的裸读合并处剔除保留字（其余键透传）；行在下次 metadata 回写时落盘干净形状自愈。写入端 `normalizeSessionMetadata` 仍严格拒绝保留字。引入于 2026-09——存量行的任意 metadata 合并更新曾整体崩溃（"metadata.team 是保留字段"） |

### Provider 配置（`src/services/integrations/model-adapter-hydration.ts`）

链目标：单条 provider 条目；`loadProvidersFromDisk`（磁盘水合）与
`replaceRuntimeProviders`（运行时快照，纯内存、无持久层、无戳）共用同一组步骤，
create/update 路径复用其中的 `canonicalizeProviderConfig` / `normalizeProviderRuntimeConfig`
（写入面不含下沉迁移——形状缺失/失配走 400 报错，不静默填充；加载面迁移后仍损坏
的条目拒载并记录 load_errors）。

| id | 归一内容 |
| --- | --- |
| `provider_api_format_alias_canonicalize` | provider_type trim/小写 + api_format 旧别名归一（openai_compatible_chat/openai_proxy → openai_chat 等） |
| `provider_legacy_field_strip` | 剥离已下沉到模型条目的 provider 级废弃字段（model/model_map/temperature 等；llm_engine 随 pi-ai 委托引擎退役并入剥离——该字段从未发布，无存量数据） |
| `provider_thinking_kind_normalize` | 【已退役】原"thinking_kind 非法值剔除（回落格式默认）"——思考形状下沉到模型条目（显式必达）后由 `provider_thinking_kind_sink` 取代 |
| `provider_llm_engine_normalize` | 【已退役】原"llm_engine 非法值剔除（仅 pi-ai 合法，缺省/非法回落原生适配器）"——pi-ai 委托引擎随 agent-llm 传输层迁移 provider-utils 整体移除，字段并入 `provider_legacy_field_strip` 剥离（从未发布，无存量数据） |
| `provider_headers_normalize` | 自定义请求头归一为 `Record<string, string>`（键 trim 非空、非字符串值丢弃、名字值须 HTTP 头合法——非法字符条目丢弃，防 undici 在请求构造期抛错；空表剥键）。`{session_id}` 占位符原样保留，agent-llm 调用期解析为该次会话稳定路由键（无会话上下文的辅助调用回落 provider 级稳定值，标识非头值安全字符时折叠为哈希）。非对象形状按空表收敛（手工编辑半迁移态）；create/update 写入面在 `ensureProviderRequestShape` 严格校验（非字符串值/非法字符 400） |
| `provider_endpoint_mode_normalize` | endpoint_mode 归一：full 且非 gemini 格式保留，其余（显式 base、非法值、gemini 残留）剥键回落基座语义（base 为缺省不落盘）。根因：裸域名网关（Sub2API 类）根路径是前端 SPA，base 拼装须补 /v1，full 则原样直用（根路径网关逃生通道）；gemini 不适用（URL 由 SDK 按模型名拼装）。写入面 `ensureProviderRequestShape` 值域 400（trim/小写归一后比对）+ 终局校验（gemini × full 失配、full 的方法段形状：openai_chat→`/chat/completions`、openai_resp→`/responses`、anthropic→`/messages` 结尾）400——终局校验先于归一链，防失配被静默剥弃 |
| `provider_model_entries_normalize` | models 归一为对象条目数组（非法条目丢弃、去重；条目 thinking_kind 合法值归一） |
| `provider_thinking_kind_sink` | 厂商级 thinking_kind 下沉迁移：按旧运行时推断语义等价固化进每条模型条目（toggle+子集→effort、anthropic+toggle 无子集→budget、格式默认 anthropic→budget/openai→effort、openai+budget→none、gemini→none），随后剥离厂商字段；迁移后条目仍缺失/失配 = 数据损坏，加载面拒载报错 |

## 其他持久化机制（不在本清单管辖，列出以免混淆）

- **工具图片引用（tool_result_media 扩展）**：2026-09 起工具图片（view_image/MCP/
  媒体生成等一切 ToolExecutionResult.media）经消费端注入的 ToolImageSink 存入会话附件
  通道（与用户上传同管线：持久、随会话清理、投影读取经请求变体归一化），扩展条目在
  stored_path/mime/original_name 之外**新增可选 file_id**。旧记录无 file_id，且其
  stored_path 指向的 transient 临时文件随 TTL/重启消失、不可迁移——读取侧
  （`context/extensions/tool-result-media-projector.ts`）为永久双读守卫：file_id 优先经
  附件管线读取，缺失或读取失败回退 stored_path 同步磁盘读，再失败降级为文字提示。
  无注册步骤、无应用戳（投影层读侧守卫，非持久层水合）。

- **发送请求回执**：Local `conversation-store/message-request-ops.ts` 与 SaaS
  `postgres/message-request-hydration.ts` 的永久形态守卫在加载存储时创建缺失的
  `session_message_requests` 表，并补齐半迁移记录表的 content/status/error/updated_at 列，
  不依赖 schema 版本。读取请求状态时，将存量 root 用户 mailbox 队列幂等补入回执表，
  独立补全缺失原文与时间，并保留已有合法状态（包括 consumed / failed 终态）；
  实际消费以 canonical user 消息为准，并在同一事务内由消息写入触发器固化为 consumed，
  避免回退删除消息后已消费请求重新成为排队请求；过期以 mailbox 状态为准。
  读取时也将已有 canonical user 消息或 root 用户 mailbox 的 acked 记录归一为 consumed，
  修复触发器引入前的旧回执，以及原消息已被回退删除但仍有消费记录的旧请求；归一结果持久化且幂等。
  processing 请求每 30 秒续写 updated_at；查询将超过 2 分钟未续期且没有 mailbox / canonical
  消息的孤立请求归为 failed，避免进程退出后永久处理中。
  待处理消息删除只允许 mailbox 仍为 queued、回执未终结且原文匹配时发生，
  同一事务更新 mailbox 与回执。取消保留 cancelled 回执，并将 mailbox 标为 expired / user_cancelled，
  永久归一层识别 cancelled 且不回退到 queued；加载时将半恢复状态中仍 queued 的已取消输入归为 expired，防止再次消费。
  旧记录缺少可操作标识时默认不可操作，读取按当前队列形态计算 can_manage。
  `contracts/session/message-request-status.ts` 的 `hydrateMessageRequestStatus` 同时处理
  新写入回读和恢复备份中的缺失/非法字段，非法状态收敛为 unknown，不推断成功。

- **sqlite DDL**：各插件 `src/storage/*/sqlite-migrations.ts`，编号 + 版本表
  （`ragsystem_plugin_schema_migrations`）。
- **backend-local 会话库**：`backend-local/src/adapters/local/sqlite/conversation-store/migrations.ts`，
  `PRAGMA user_version` 编号迁移（无步骤 id 注册）。v24 将 event_outbox 的时间列
  （created_at/available_at）由 CURRENT_TIMESTAMP 无 Z 文本回填为 ISO-Z，消除与
  delivered_at 等显式 ISO-Z 列的混排（GC 字符串比较与 MIN 统计依赖同构格式）。
  v25 为 `session_list_projection` 增加 `title_override` 列（LLM 生成标题的持久层落点，
  投影派生仍为首条可见消息截 30 字符兜底、override 非空时优先；无数据回填，
  存量会话维持派生标题）。SaaS 端对应变更见
  `backend-saas/src/adapters/saas/postgres/conversation-schema.ts` v12（同语义，含触发器
  重建保留 override 的函数改写）。
- **SaaS 后台任务表**：`backend-saas/src/adapters/saas/postgres/background-task-schema.ts`
  版本表 `ragsystem_background_task_schema_migrations`（编号迁移）。v2 为
  `saas_background_tasks` 增加发起者分支两列（`initiator_thread_key` /
  `initiator_child_agent_id`，nullable，`ADD COLUMN IF NOT EXISTS` 幂等）：完成通知
  按发起者分支路由、goal 门控按发起者归属收窄（§10.4 第五/六轮）。历史行为 null，
  读取侧视为 root 发起（与旧"无脑投 root/会话级忙检查"口径一致），无数据回填。
- **SaaS run 表**：`backend-saas/src/adapters/saas/postgres/run-schema.ts` 编号迁移
  （版本表 `ragsystem_run_schema_migrations`，advisory lock + 事务）。v12
  `thread-current-run-index` 为 `saas_runs` 补
  `(tenant_id, session_id, thread_key, created_at DESC, run_id DESC)` 复合索引——
  线程闸门高频查询 `getLatestThreadRun`（§10.4 第七轮）此前只能走 session 前缀
  索引过滤 thread_key，最坏扫会话全部 runs；与 local 端既有的
  `idx_runs_session_thread_created` 对齐。纯索引新增，无数据变更。
- **SaaS 文件历史表**：`backend-saas/src/adapters/saas/postgres/file-history-schema.ts`
  版本迁移（版本表 `ragsystem_file_history_schema_migrations`，advisory lock + 事务）。
  v2 为 `file_history_pending` 增加 `tracked_seq BIGINT`（nullable，
  `ADD COLUMN IF NOT EXISTS` 幂等）：编辑追踪时盖会话最大消息 seq 戳，rewind 只冲刷
  锚点之后的 pending 编辑（修复"无关回退冲掉被停止 run 工作"的事故，与 local 端
  pending.json 的 tracked_seq 字段同语义）。历史行 NULL = 永不冲刷，等下个快照
  边界归档，无数据回填。v3 将 `file_history_snapshots.message_seq` 放宽为
  BIGINT（消息 seq 为跨会话全局 BIGSERIAL，INTEGER 在 2^31 后插入即溢出；
  纯类型放宽，无数据变更）。
- **启动补齐（产品形态 ensure）**：default team 与 builder 保留 team 同模式——由**产品层**在启动时
  ensure（存在即跳过、不存在则 `applyTeamPayload` 创建落盘，用户改动永不覆盖）。仓库内两端组合层
  各持自己的产品模板（backend-local / backend-saas 的 `composition/default-team.ts`），桌面产品侧
  （Oceanx electron）另在自己的产品层补齐 Team 模板与 planning Provider；agent-builder 插件维护其
  保留 team（`team-template.ts`，版本化迁移、形态驱动）。core 的配置服务是纯机制（存取/校验/归一/
  快照），不持有任何出厂 team 内容；不存在任何 team 时读路径按"不存在"报错，无内核兜底。

## SaaS 应用戳现状

`IAgentConfigTeamStore.saveAll` 的 `appliedMigrations` 可选参数对 SaaS（postgres
jsonb 存储）当前为 no-op：不落库，审计能力仅存在于 local 装置。落 jsonb 是后续
独立小改动，接口无需再变。

### Skill 包读取（Skills 插件存储层）

永久形态守卫：Local 保持原有目录包形态，读取/写入时在同一 SQLite 锁下恢复 `.replacing-<name>` 中断替换；读取和激活返回保存目录，已移除执行快照；历史 `.runtime` 派生缓存不参与加载、不自动删除，源包目录与内容无需迁移。SaaS 读取包元数据与文件索引的事务快照；历史索引缺少 SKILL.md 时从已有 name/description/content/metadata 补齐读取内容，后续整包保存收敛。两类守卫不看 schema 版本，无应用戳。

SaaS 对象字节回收：`skill_object_garbage`（PostgreSQL schema v5）新增持久化待回收表，应用戳沿用存储层 schema migration 记录。保存/删除在持有包行排他锁的事务内，将旧对象键写入该表后替换/删除索引；读取通过 `withSnapshot` 持有共享锁直到全部字节读取完成，防止连续保存或删除破坏在途读取。对象删除成功（含已不存在）后才移除队列记录，失败记录保留并排到队尾；多实例通过 `FOR UPDATE SKIP LOCKED` 分批领取。保存/删除后、租户运行时启动时和每分钟重试，运行时销毁时停止定时器。

永久 schema 归一 `normalizeSkillObjectGarbageSchema` 位于 Skills 存储层的 `object-garbage-hydration.ts`，每次启动按表/索引是否存在补齐，不以 v5 应用戳跳过，覆盖新建库、旧草稿时代库、已去草稿库及恢复后的缺表状态；无额外应用戳。旧的内存回收队列无法从数据库恢复；上传后、排队/提交前崩溃的对象和提交结果无法确认的暂存前缀仍保留（ObjectStorage 无前缀列举能力）。成功提交即使丢失确认，旧对象的回收记录也随事务持久化。
