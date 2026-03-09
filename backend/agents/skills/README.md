# Skills

`backend/agents/skills/` 提供 Agent Skills 的加载和执行支持。

## 当前文件

- `skill_loader.py`：扫描和加载 Skill
- `skill_environment.py`：Skill 运行环境
- 本目录下的 `*.md`：Skill 相关补充说明

## 当前行为

- Skill 通过 `SKILL.md` 暴露元数据和主说明
- Agent 是否可用某个 Skill，由 `agent_configs.yaml` 中 `skills.enabled_skills` 控制
- 如果 `auto_inject=true`，`AgentLoader` 会自动补充 Skills 系统工具

## 与 AgentLoader 的关系

`backend/agents/config/loader.py` 会：

- 读取 `enabled_skills`
- 调用 `get_skill_loader().load_all_skills()`
- 过滤可用 Skill
- 在需要时追加 `activate_skill`、`load_skill_resource`、`execute_skill_script`

## 说明

- Skills 是 Agent 子系统的一部分，不单独暴露 HTTP API
- 当前能力以 `skill_loader.py` 和 `AgentLoader` 的实现为准
