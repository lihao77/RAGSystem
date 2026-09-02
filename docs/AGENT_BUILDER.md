# Agent Builder

本文保留 Agent Builder 的插件实现和使用细节。

Agent Builder 将自然语言中的 Agent 需求转换为可审查、可校验、可发布的运行时 Team。安装插件后，每个租户会得到一个可激活的 `agent-builder` Team；它本身是一支负责构建 Team 的工作团队，而不是注入所有业务 Team 的普通工具。

```text
安装插件 -> 激活 agent-builder Team -> 调研/设计/评估/调优 -> Session 工作区草稿 -> publish 工具校验并同步 -> 可选自动发布到 Team
```

它是 RAGSystem 后端插件，不生成或安装新的后端代码。模型负责提出结构化方案，平台负责能力校验、权限控制和运行时物化。

## 能力分层

- Agent Builder 插件：管理 Draft、校验和 Team 物化，是控制面。
- Skills 插件：管理 Skill Draft 工作区，独立保存完整 Skill bundle，并负责校验、发布和管理正式 Skill。
- Skill：承载可复用的领域知识、流程和脚本，由 Blueprint 引用；`enabled_skills` 只表示 Agent 可以使用已发布 Skill。
- MCP：连接外部系统和远程工具服务，由 Blueprint 引用。
- 原生工具：承载宿主运行时中稳定、受权限约束的操作能力。
- ReAct 与委派运行时：执行发布后的 Agent Team，不由 Builder 重复实现。

因此 Builder 不在 Skill、MCP 和原生实现之间三选一。它将三类能力作为可绑定资源，并在发布前确认引用真实存在。Skill 草稿工具只在 Builder 编排 Agent 中提供，不进入普通 Agent 的工具配置通道；`enabled_skills` 仍只表示 Agent 可以使用已发布 Skill。

## 使用流程

### 1. 安装并激活 Builder Team

在 `backend-local/backend.plugins.yaml` 或 `backend-saas/backend.plugins.yaml` 中启用插件。租户运行时第一次初始化时，插件只在缺失时补种 `agent-builder` Team，不会覆盖用户已经修改的同名 Team，也不会改变当前生效 Team。

用户从 Team 列表激活 `agent-builder`，然后返回聊天页与 Builder Team 对话。它包含一个编排入口 Agent，以及需求调研、能力调研、Agent 架构、评估和优化五个专职 Agent。入口 Agent 会按工作流委派这些子 Agent，汇总结果后创建或更新一个 Draft。管理员仍可直接进入 Agent 配置页修改当前 Team，不需要经过 Builder Draft 流程。

Builder Team 的工具包括能力盘点、`list_agent_drafts`、`get_agent_draft`、`create_agent_draft`、`validate_agent_draft`、`try_agent_draft` 和 `publish_agent_draft`。`list_agent_drafts` 接受可选关键词，默认返回摘要字段（不含蓝图全文），需要全文时传 `include_blueprint=true` 或用 `get_agent_draft`；`get` 或 `create` 会把 `manifest.json`、`blueprint.json` 与只读的 `blueprint.schema.md`（字段必填性、枚举、manifest 乐观锁机制说明）放到当前 Session 工作区，模型使用文件工具编辑，`validate_agent_draft` 随时返回与 publish 同款的校验报告而不发布，`publish` 负责校验、同步和按配置自动发布（返回中直接回 `team_name` 与激活提示）。独立的 update、approve 工具不对 Agent 暴露。Skill 使用同样的 `list_skill_drafts`、`get_skill_draft`、`create_skill_draft`、`publish_skill_draft` 工作流；`publish_skill_draft` 的返回含 `available_for_binding`，发布成功即确认已进入能力清单，无需二次查询。

`try_agent_draft` 是发布前的试用运行（练车场，非门禁）：把当前工作区蓝图物化到一次性暂存 Team（`staging-` 前缀，用完即删），对每条输入做一次无头端到端运行，返回观察报告——入口 Agent 的回答、`expect_contains` 期望片段的命中与缺失、实际委派了哪些子 Agent、挂起/失败状态。输入默认取蓝图 `acceptance` 用例，单次调用最多 5 条（每条都是真实模型调用）；试用会话同样即用即删。Builder 的试用协议要求把报告当设计证据而非门槛：从失败观察改进 instructions/工具/委派设计，小改动后复用先前观察而非重跑相同样本；报告不理想也可以在向用户说明剩余风险后继续发布。

### 2. 在 Builder Team 中创建草稿

用户可以直接描述目标、参与角色、允许使用的工具或外部系统以及验收条件。例如：

```text
请为客户支持场景构建一个 Agent Team：入口 Agent 直接处理常见咨询和简单查询，
订单 Agent 承接深度订单核算，知识 Agent 负责售后政策的大范围检索。
先创建可审查草稿，不要直接上线。
```

Builder 团队产出蓝图时遵循统一的团队设计规范：入口 Agent 直接面对用户，必须是全团队能力最强的通才，绑定足以独立完成常规请求的工具（通常是子 Agent 工具的超集），并在提示词中写明优先自己直接解决；委派只用于真正受益的子任务——可并行的独立子任务、会淹没主上下文的大范围探索、深度专业化子流程、需要隔离视角的复核，其余（简单问答、几步工具调用内能完成的事、需要完整对话上下文的综合判断）一律入口 Agent 自己干。纯路由式入口 Agent 是反模式：每轮多一跳委派开销，子 Agent 失败时整队无法服务用户。`blueprint.schema.md` 中的「团队设计规范」章节随每次草稿工作区刷新下发；校验对仅有委派而自身无工具/能力的入口 Agent 给出 `router_only_entry_agent` 警告。

构建的先天优势来自**域探索协议**：构建出来的团队必须知道通用团队不知道的东西。构建输入必须包含真实样本请求、领域文档、知识库材料或相关系统访问；设计前先用运行时既有能力实际跑通代表性样本，记录卡点、缺失信息和重复出现的人工步骤——这些实证发现才是团队的领域先验。拿不到样本时 Builder 会明确说明并保守设计，不编造领域事实。先验按**经验分层**沉淀到三个载体：会变的行为与角色方向进各 Agent 的 `instructions`（整体重写蒸馏，不追加堆砌）；不变的领域知识（术语表、流程规范、数据格式、系统操作步骤）沉淀为 Skill 草稿供跨团队复用；真实样本与失败修复固化为 `acceptance` 验收用例，构成回归防线。

Builder 入口 Agent 会在调研和设计完成后调用 `create_agent_draft`，然后直接编辑工作区中的 `blueprint.json`。`publish_agent_draft` 读取本地文件并重新校验；校验失败时不修改系统 Draft，成功后先同步 Draft，开启自动发布时再创建或更新对应 Team。工具不会生成后端插件代码，也不会自动激活 Team。

如果调研发现某段领域流程值得复用，编排 Agent 调用 `create_skill_draft`，编辑工作区中的 `SKILL.md`、脚本和资源后调用 `publish_skill_draft`。Skills 插件会校验完整 bundle；失败时不更新系统 Draft，成功后按自动发布配置发布到 Skill 库。发布不会自动修改任何 Agent 的 `enabled_skills`。

Blueprint（schema v2）包含：

- 包名、描述和入口 Agent
- 每个 Agent 的指令、模型配置、工具、Skill、MCP Server 和委派关系
- Goal 与后台任务开关
- `acceptance` 验收用例：每条含真实样本请求或失败修复场景（`case`）、期望输出包含的片段（`expect_contains`）与来源标记（`source`：`sample` 探索样本 / `regression` 实际观察到的失败（含试用期与线上）修复后补录）；用例必须源自实证，缺失时校验给出 `missing_acceptance_cases` 警告

租户成员可以创建 Draft；发布权限不随模型工具下放。

### 自动审批

租户 Owner 可以在 `/system-config` 的 Agent Builder 审批和 Skills 审批配置组中调整：

- `agent_builder.approval.auto_publish_candidates`：Agent Draft 通过结构、能力和委派拓扑校验后自动发布到对应 Team。
- `skills.approval.auto_publish_candidates`：Skill Draft 完成 bundle 和 `SKILL.md` 校验后自动发布到 Skill 库。

两个开关默认开启：Draft 校验通过即发布生效，不进入人工审核。自动审批不会绕过校验，也不会自动激活 Agent Team。新 Draft 首次发布时不会覆盖同名的既有 Team；已经关联 Team 的 Draft 可以重新发布到原 Team。需要审核门禁的租户可关闭开关，恢复人工校验和发布流程，Draft 使用 `revision` 进行并发控制。

审批字段由各自插件注册到统一的系统配置页面；卸载对应插件后，其业务配置不再参与运行。

### 3. 管理员发布

管理员仍可通过现有 HTTP API 直接发布 Draft。Agent 工具不提供独立校验或审批入口，`publish` 会自动检查：

- Blueprint 结构和入口 Agent
- Agent、工具、Skill、MCP Server 引用
- 未定义的委派目标、自委派和委派环
- 是否提供验收用例；缺失验收用例（`missing_acceptance_cases`）是警告，不阻止发布
- 入口 Agent 仅有委派而自身无任何工具/能力（`router_only_entry_agent`，警告级，不阻止发布）

草稿修改使用 `revision` 做乐观并发控制。已发布 Draft 可以获取到 Session 工作区继续编辑；编辑后仍使用同一个 Draft，并可重新发布到原 Team。

只有租户管理员可以调用发布接口。发布会重新校验 Draft，并依次物化：

1. Team 和 Agent 配置
2. 每个 Agent 的 Skill 绑定
3. 每个 Agent 的 MCP Server 绑定
任一步骤失败都会尝试回滚本次 Team、Skill 和 MCP 变更。
新 Draft 首次发布使用 Blueprint 名称作为 Team 名称。如果同名 Team 已经存在，发布会返回冲突；只有草稿已通过 `source_team_name` 关联该 Team 时，重新发布才会更新它。

Skill 发布由 Skills 插件单独负责，入口为 Builder 的 `publish_skill_draft` 或 `/api/skills/drafts/:id/publish`。已发布 Skill 的工作区修改会先形成待发布 Draft，自动发布开启时替换现有用户 Skill 包；删除正式 Skill 后，原 Draft 会恢复为可编辑状态。Draft 可以单独删除而不影响正式 Skill；管理员再次编辑，或 Builder 用同名 `create_skill_draft` 继续开发时，系统会从正式 bundle 重建完整 Draft。

管理员直接修改 Team 配置时，插件会把线上配置同步回同一个 `published` Draft（蓝图中 `instructions` 是提示词唯一来源，`custom_params.behavior.system_prompt` 不再双写）。删除 Team 后，如果关联 Draft 仍存在，它会清空 `source_team_name` 并恢复为可编辑的 `draft`；草稿也可以单独删除，不影响线上 Team。线上 Team 后续再次被修改时，系统会重新创建一份 `published` Draft。

通过 HTTP API 新建或重命名 Team 时，名称须匹配 `^[a-z0-9][a-z0-9_-]*$` 且不超过 64 字符（与蓝图命名一致）；存量不规范名称仍可正常读取。`PUT /drafts/:id` 保存草稿时会即时执行蓝图校验并把报告随草稿持久化，不必等到发布时刻。校验还包含四个警告级检查：Agent 未配置 `llm_tiers`/`llm`（将运行在租户默认模型上）、`llm_tiers` 引用了模型目录之外的 provider（合法 provider 与模型枚举经能力清单 `llm_providers` 字段暴露）、入口 Agent 仅有委派而自身无工具/能力（`router_only_entry_agent`），以及缺少验收用例（`missing_acceptance_cases`）。

**版本历史与回滚**：每次 Draft 修改覆盖前，上一 revision 会归档到 `<data-root>/agent-builder/drafts/.revisions/<draft_id>/`。`POST /drafts/:id/rollback` 按 `expected_revision` + `to_revision` 把历史蓝图恢复为新的当前 revision（编辑态，revision 继续递增，历史档保留）；回滚后如需上线，走正常发布流程。

## API

所有接口位于 `/api/agent-builder`。读取和创建 Draft 需要租户成员身份，发布需要租户管理员身份。

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/drafts` | 列出 Draft |
| `GET` | `/drafts/:id` | 获取 Draft |
| `POST` | `/drafts` | 创建 Draft |
| `PUT` | `/drafts/:id` | 按 `expected_revision` 更新 Draft（保存即校验并持久化报告） |
| `POST` | `/drafts/:id/publish` | 按 `expected_revision` 发布到 Team |
| `GET` | `/drafts/:id/revisions` | 列出已归档的历史 revision |
| `POST` | `/drafts/:id/rollback` | 按 `expected_revision` + `to_revision` 回滚到历史版本 |

## 存储与部署边界

Draft 当前保存在租户 `dataRoot` 下：

```text
<data-root>/agent-builder/drafts/*.json
```

Local 与 SaaS 都使用该文件系统 Store。SaaS 的 `dataRoot` 按租户隔离，但当前的文件写入和进程内串行队列不支持多实例并发写入，也没有数据库事务或跨节点锁。因此当前实现适合单实例部署；多实例 SaaS 需要将 Store 替换为 PostgreSQL 实现，并为 Draft 更新和发布增加数据库事务。

## 当前范围

- 已实现结构、引用和委派拓扑校验。
- 验收用例随 Blueprint 的 `acceptance` 字段保存（`source` 区分探索样本与失败补录）。`try_agent_draft` 已可在发布前对验收用例做无头试运行（观察报告，非门禁）；批量自动执行全量 Eval 与按结果分级发布仍是后续计划。
- 不允许模型生成、安装或热加载后端插件代码。
- 新 Tool 仍需由受信任的开发和部署流程实现；外部能力优先通过 MCP 接入，领域流程优先通过 Skill 复用。

插件由 `backend-local/backend.plugins.yaml` 和 `backend-saas/backend.plugins.yaml` 中的 `@ragsystem/backend-plugin-agent-builder/module.js` 启用，依赖 Artifacts、MCP 与 Skills 插件先完成装载。发布生成的业务 Team 与 `agent-builder` 相互独立；管理员可在 Team 列表中激活目标 Team，Builder Team 仍保留用于下一轮构建。
