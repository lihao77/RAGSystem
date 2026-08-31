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
- **启动补齐**：桌面产品侧（Oceanx electron）按 ensure 语义补齐 Team 模板与
  planning Provider，属产品组合层，不在共享树内。

## SaaS 应用戳现状

`IAgentConfigTeamStore.saveAll` 的 `appliedMigrations` 可选参数对 SaaS（postgres
jsonb 存储）当前为 no-op：不落库，审计能力仅存在于 local 装置。落 jsonb 是后续
独立小改动，接口无需再变。
