/** 写入草稿工作区的只读 schema 参考：构建者不必从历史草稿逆向工程字段与枚举。 */
export const BLUEPRINT_SCHEMA_GUIDE = `# blueprint.json Schema 说明（只读参考，勿编辑本文件）

blueprint.json 是本草稿的唯一编辑对象；manifest.json 由系统维护。编辑过程中可随时调用 validate_agent_draft 校验，发布调用 publish_agent_draft。

## 顶层字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| schema_version | 是 | 固定为 2 |
| name | 是 | 匹配 \`^[a-z0-9][a-z0-9_-]*$\`，不超过 64 字符；已发布 Team 的名称不可修改 |
| description | 是 | 不超过 1000 字符 |
| entry_agent | 是 | 必须是 agents[].name 之一 |
| agents | 是 | 1 到 20 个 Agent |

## agents[] 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| name | 是 | 同 name pattern，草稿内唯一 |
| display_name | 否 | 展示名，不超过 120 字符 |
| description | 否 | 不超过 500 字符 |
| instructions | 是 | 提示词唯一来源（1..30000 字符）。发布时派生为运行时 behavior.system_prompt；不要在 custom_params.behavior.system_prompt 里重复书写 |
| enabled | 否 | 默认 true |
| llm / llm_tiers | 否 | 模型配置。llm_tiers 形如 \`{"default": {"provider": "...", "model_name": "..."}}\`；合法 provider 与 model 枚举以 list_agent_builder_capabilities 返回的 llm_providers 为准。未配置时运行在租户默认模型上（发布校验给出警告，不阻止发布） |
| tools | 否 | 工具白名单，只能引用能力清单返回的工具名 |
| capabilities | 否 | 形如 \`{"skills": [...], "mcp": [...]}\`，只能引用能力清单返回的能力名。为 Agent 绑定 Skill 后，运行时会自动注入 activate_skill / load_skill_resource / execute_skill_script 工具——它们无需也无法写进 tools |
| delegates | 否 | 可委派的子 Agent 名单；不允许自委派与委派环 |
| goals_enabled / background_tasks | 否 | 默认 false |
| custom_params | 否 | 原样透传到运行时。custom_params.type 仅为展示标签（orchestrator / general），运行时不按它分配工具；入口与委派语义由 entry_agent 和 delegates 决定 |

## 校验语义（publish / validate 共用）

- error 级问题阻止发布：入口 Agent 缺失、delegates 引用未定义 / 自委派 / 成环、tools 或 capabilities 引用能力清单之外的名字。
- warning 级问题不阻止发布：未配置 llm_tiers / llm（将使用租户默认模型）、llm_tiers.provider 不在模型目录中。

## manifest.json 与乐观锁

- manifest.expected_revision 记录当前工作区快照所基于的草稿 revision。
- publish 以它做冲突检测：若草稿在别处已被修改（revision 更高），publish 返回 conflict；此时调用 get_agent_draft 重新拉取工作区后再继续。
- 工作区内的 publish 成功后会自动把 manifest.json 与 blueprint.json 刷新为新 revision，可直接继续编辑。
- 每次修改覆盖前，上一 revision 自动归档；管理员可经 HTTP API（GET /drafts/:id/revisions、POST /drafts/:id/rollback）查看并回滚。
- 注意：回滚产生的是编辑态草稿；若关联的线上 Team 再次被修改，同步会以线上配置重建蓝图，未重新发布的回滚内容会被覆盖。
`;
