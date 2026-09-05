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
| `strip_empty_llm_tiers` | 零信息 tier 条目：provider 与 model_name 均为空白（Agent Studio 对未配置档位的落盘形态） | 剔除该档位；map 剔空则整体置 null 以继承系统 LLM。半空条目（两字段仅其一非空）是真实配置错误，保留并按缺失显式报错 | 2026-08（全空 default tier 挡住系统 LLM 兜底导致 readiness 硬失败） |

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

### Provider 配置（`src/services/integrations/model-adapter-hydration.ts`）

链目标：单条 provider 条目；`loadProvidersFromDisk`（磁盘水合）与
`replaceRuntimeProviders`（运行时快照，纯内存、无持久层、无戳）共用同一组步骤，
create/update 路径复用其中的 `canonicalizeProviderConfig` / `normalizeProviderRuntimeConfig`。

| id | 归一内容 |
| --- | --- |
| `provider_api_format_alias_canonicalize` | provider_type trim/小写 + api_format 旧别名归一（openai_compatible_chat/openai_proxy → openai_chat 等） |
| `provider_legacy_field_strip` | 剥离已下沉到模型条目的 provider 级废弃字段（model/model_map/temperature 等） |
| `provider_thinking_kind_normalize` | thinking_kind 非法值剔除（回落格式默认思考形状） |
| `provider_model_entries_normalize` | models 归一为对象条目数组（非法条目丢弃、去重） |

## 其他持久化机制（不在本清单管辖，列出以免混淆）

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
