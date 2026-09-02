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
| acceptance | 否 | 验收用例数组（最多 50 条）。每条形如 \`{"case": "真实样本请求或失败修复场景（1..2000 字符）", "expect_contains": ["期望输出包含的片段（每条 1..500 字符，最多 20 条，可省略）"], "source": "sample" | "regression"}\`；\`expect_contains\` 与 \`source\` 可省略，默认 \`[]\` 与 \`"sample"\`。用例必须源自构建前探索的真实样本或实际观察到的失败（含试用期观察与线上失败），不得凭空编造；缺失时校验给出 missing_acceptance_cases 警告 |

## agents[] 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| name | 是 | 同 name pattern，草稿内唯一 |
| display_name | 否 | 展示名，不超过 120 字符 |
| description | 否 | 不超过 500 字符 |
| instructions | 是 | 提示词唯一来源（1..30000 字符）。发布时派生为运行时 behavior.system_prompt；不要在 custom_params.behavior.system_prompt 里重复书写 |
| enabled | 否 | 默认 true |
| llm / llm_tiers | 否 | 模型配置。llm_tiers 形如 \`{"default": {"provider": "...", "model_name": "..."}}\`；provider 写模型目录里 provider 的 name 或 key（以 list_agent_builder_capabilities 返回的 llm_providers 为准），provider_type 可省略——发布/试运行物化时会按模型目录自动回填。未配置时运行在租户默认模型上（发布校验给出警告，不阻止发布） |
| tools | 否 | 工具白名单，只能引用能力清单返回的工具名 |
| capabilities | 否 | 形如 \`{"skills": [...], "mcp": [...]}\`，只能引用能力清单返回的能力名。为 Agent 绑定 Skill 后，运行时会自动注入 activate_skill / load_skill_resource / execute_skill_script 工具——它们无需也无法写进 tools |
| delegates | 否 | 可委派的子 Agent 名单；不允许自委派与委派环 |
| goals_enabled / background_tasks | 否 | 默认 false |
| custom_params | 否 | 原样透传到运行时。custom_params.type 仅为展示标签（orchestrator / general），运行时不按它分配工具；入口与委派语义由 entry_agent 和 delegates 决定 |

## 团队设计规范

- 入口 Agent 直接面对用户，必须是全团队**能力最强的通才**：给它绑定足以独立完成常规请求的工具与能力（通常是子 Agent 工具的超集），并在 instructions 中写明「优先自己直接解决」。
- 委派只用于真正受益的子任务：可并行的独立子任务、会淹没主上下文的大范围探索、深度专业化子流程、需要隔离视角的复核。
- 其余一律入口 Agent 自己干：简单问答、几步工具调用内能完成的事、需要完整对话上下文的综合判断。不要把每一轮请求都转发给子 Agent。
- **禁止纯路由入口 Agent**：只分流不干活、自身无任何工具/能力的入口 Agent 会触发 router_only_entry_agent 警告——每轮多一跳委派开销，且子 Agent 失败时整队无法服务用户。

### 经验分层（团队先天优势的来源）

构建出来的团队必须知道通用团队不知道的东西，先验按三层沉淀，各归其位：

- **会变的行为与角色方向 → agents[].instructions**：整体重写蒸馏，不要追加堆砌（上限 30000 字符，膨胀会劣化表现）。
- **不变的领域知识 → Skill 草稿**：术语表、流程规范、数据格式、系统操作步骤走 create_skill_draft 沉淀为 Skill，跨团队复用；不要内联进提示词。
- **犯过的错与真实样本 → acceptance 验收用例**：探索阶段的真实样本原样入册（source: sample），实际观察到的失败（含试用期与线上）修复后补录（source: regression），构成回归防线。
- 先验只能来自实证：构建前先向用户要真实样本请求、领域文档、知识库材料或系统访问，实际跑通代表性样本并记录卡点；拿不到样本时明确说明并保守设计，**禁止编造领域事实**。

## 校验语义（publish / validate 共用）

- error 级问题阻止发布：入口 Agent 缺失、delegates 引用未定义 / 自委派 / 成环、tools 或 capabilities 引用能力清单之外的名字。
- warning 级问题不阻止发布：未配置 llm_tiers / llm（将使用租户默认模型）、llm_tiers.provider 不在模型目录中、入口 Agent 仅委派而自身无工具/能力（router_only_entry_agent）、缺少验收用例（missing_acceptance_cases）。

## manifest.json 与乐观锁

- manifest.expected_revision 记录当前工作区快照所基于的草稿 revision。
- publish 以它做冲突检测：若草稿在别处已被修改（revision 更高），publish 返回 conflict；此时调用 get_agent_draft 重新拉取工作区后再继续。
- 工作区内的 publish 成功后会自动把 manifest.json 与 blueprint.json 刷新为新 revision，可直接继续编辑。
- 每次修改覆盖前，上一 revision 自动归档；管理员可经 HTTP API（GET /drafts/:id/revisions、POST /drafts/:id/rollback）查看并回滚。
- 注意：回滚产生的是编辑态草稿；若关联的线上 Team 再次被修改，同步会以线上配置重建蓝图，未重新发布的回滚内容会被覆盖。
`;
