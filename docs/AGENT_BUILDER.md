# Agent Builder

本文保留 Agent Builder 的插件实现和使用细节。

Agent Builder 将自然语言中的 Agent 需求转换为可审查、可校验、可发布的运行时 Team。安装插件后，每个租户会得到一个可激活的 `agent-builder` Team；它本身是一支负责构建 Team 的工作团队，而不是注入所有业务 Team 的普通工具。

```text
安装插件 -> 激活 agent-builder Team -> 调研/设计/评估/调优 -> Session 工作区草稿 -> publish 工具校验并同步 -> 可选自动 Release
```

它是 RAGSystem 后端插件，不生成或安装新的后端代码。模型负责提出结构化方案，平台负责能力校验、权限控制、版本化和运行时物化。

## 能力分层

- Agent Builder 插件：管理 Draft、校验、Release 和 Team 物化，是控制面。
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

Builder Team 的工具包括能力盘点、`list_agent_drafts`、`get_agent_draft`、`create_agent_draft` 和 `publish_agent_draft`。`list_agent_drafts` 接受可选关键词；`get` 或 `create` 会把 `manifest.json` 与 `blueprint.json` 放到当前 Session 工作区，模型使用文件工具编辑，`publish` 负责校验、同步和按配置自动发布。独立的 update、validate、approve 工具不对 Agent 暴露。Skill 使用同样的 `list_skill_drafts`、`get_skill_draft`、`create_skill_draft`、`publish_skill_draft` 工作流。

### 2. 在 Builder Team 中创建草稿

用户可以直接描述目标、参与角色、允许使用的工具或外部系统以及验收条件。例如：

```text
请为客户支持场景构建一个 Agent Team：入口 Agent 负责分流，
订单 Agent 查询订单，知识 Agent 检索售后政策。先创建可审查草稿，不要直接上线。
```

Builder 入口 Agent 会在调研和设计完成后调用 `create_agent_draft`，然后直接编辑工作区中的 `blueprint.json`。`publish_agent_draft` 读取本地文件并重新校验；校验失败时不修改系统 Draft，成功后先同步 Draft，开启自动发布时再生成 Release。工具不会生成后端插件代码，也不会自动激活 Team。

如果调研发现某段领域流程值得复用，编排 Agent 调用 `create_skill_draft`，编辑工作区中的 `SKILL.md`、脚本和资源后调用 `publish_skill_draft`。Skills 插件会校验完整 bundle；失败时不更新系统 Draft，成功后按自动发布配置发布到 Skill 库。发布不会自动修改任何 Agent 的 `enabled_skills`。

Blueprint v1 包含：

- 包名、描述和入口 Agent
- 每个 Agent 的指令、模型配置、工具、Skill、MCP Server 和委派关系
- Goal 与后台任务开关
- 验收用例及期望包含的结果

租户成员可以创建 Draft；发布权限不随模型工具下放。

### 自动审批

租户 Owner 可以在 `/system-config` 的 Agent Builder 审批和 Skills 审批配置组中开启：

- `agent_builder.approval.auto_publish_releases`：Agent Draft 通过结构、能力和委派拓扑校验后自动发布为新的不可变 Release。
- `skills.approval.auto_publish_candidates`：Skill Draft 完成 bundle 和 `SKILL.md` 校验后自动发布到 Skill 库。

两个开关默认关闭。自动审批不会绕过校验、覆盖已有版本或自动激活 Agent Team；新 Agent Release 仍需单独激活。关闭开关后恢复人工校验和发布流程。每次自动发布仍保留 Draft/Release revision，便于追踪和回滚。

审批字段由各自插件注册到统一的系统配置页面；卸载对应插件后，其业务配置不再参与运行。旧版 `automation.*` 字段会在读取时兼容，但新配置应使用插件所属的配置组。

### 3. 管理员发布

管理员仍可通过现有 HTTP API 直接发布 Draft。Agent 工具不提供独立校验或审批入口，`publish` 会自动检查：

- Blueprint 结构和入口 Agent
- Agent、工具、Skill、MCP Server 引用
- 未定义的委派目标、自委派和委派环
- 是否提供验收用例；当前缺失验收用例是警告，不阻止发布

草稿修改使用 `revision` 做乐观并发控制。已发布 Draft 再次编辑时会创建新的 Draft 版本；旧 Release 保持不变。

只有租户管理员可以调用发布接口。发布会重新校验 Draft，并依次物化：

1. Team 和 Agent 配置
2. 每个 Agent 的 Skill 绑定
3. 每个 Agent 的 MCP Server 绑定
4. 不可变 Release 快照

任一步骤失败都会尝试回滚本次 Team、Skill、MCP 和 Release 变更。
如果目标版本 Team 名称已被手工占用，发布会返回冲突，不会覆盖既有 Team。

Skill 发布由 Skills 插件单独负责，入口为 Builder 的 `publish_skill_draft` 或 `/api/skills/drafts/:id/publish`。已发布 Skill 的工作区修改会先形成待发布 Draft，自动发布开启时替换现有用户 Skill 包；删除正式 Skill 后，原 Draft 会恢复为可编辑状态。

每次发布使用唯一的 `runtime_team_name`：

```text
<package_name>--v<version>

support-team--v1
support-team--v2
```

该名称是运行时版本边界。发布 v2 不会原地修改 v1；管理员在 Team Builder 中激活所需版本，现有 Agent 运行时继续复用原生 ReAct、工具权限、审批、沙箱、Hooks 和委派机制。Release JSON 本身不可修改，但当前版本的既有 Agent 配置接口仍允许管理员对物化 Team 做人工细调，因此需要严格审计时应把 Release Team 视为发布后的配置快照，并通过新 Draft 发布后续版本。

## API

所有接口位于 `/api/agent-builder`。读取和创建 Draft 需要租户成员身份，发布需要租户管理员身份。

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/drafts` | 列出 Draft |
| `GET` | `/drafts/:id` | 获取 Draft |
| `POST` | `/drafts` | 创建 Draft |
| `PUT` | `/drafts/:id` | 按 `expected_revision` 更新 Draft |
| `POST` | `/drafts/:id/validate` | 校验 Draft |
| `POST` | `/drafts/:id/publish` | 按 `expected_revision` 发布 Release |
| `GET` | `/releases` | 列出 Release，可按 `package_name` 过滤 |
| `GET` | `/releases/:id` | 获取 Release |

## 存储与部署边界

Draft 和 Release 当前保存在租户 `dataRoot` 下：

```text
<data-root>/agent-builder/drafts/*.json
<data-root>/agent-builder/releases/<package_name>/v*.json
```

Local 与 SaaS 都使用该文件系统 Store。SaaS 的 `dataRoot` 按租户隔离，但当前的文件写入和进程内串行队列不支持多实例并发写入，也没有数据库事务或跨节点锁。因此此版本适合单实例部署；多实例 SaaS 需要将 Store 替换为 PostgreSQL 实现，并为发布和版本号分配增加数据库事务。

运行会话目前通过唯一 Team 名称间接固定 Release 版本，Session 记录尚未保存显式的 `release_id` 和 `version`。

## 当前范围

- 已实现结构、引用和委派拓扑校验。
- 验收用例会随 Blueprint 保存，但尚未自动执行完整 Eval。
- 不允许模型生成、安装或热加载后端插件代码。
- 新 Tool 仍需由受信任的开发和部署流程实现；外部能力优先通过 MCP 接入，领域流程优先通过 Skill 复用。

插件由 `backend-local/backend.plugins.yaml` 和 `backend-saas/backend.plugins.yaml` 中的 `@ragsystem/backend-plugin-agent-builder/module.js` 启用，依赖 Artifacts、MCP 与 Skills 插件先完成装载。发布生成的业务 Team 与 `agent-builder` 相互独立；管理员可在 Team 列表中激活任意一个版本，Builder Team 仍保留用于下一轮构建。
