# Skills

`backend/agents/skills/` 提供 Agent 的 Skill 加载与执行能力。

## 当前文件

- `skill_loader.py`
  - 扫描并加载 Skill
- `skill_environment.py`
  - Skill 执行环境与隔离策略
- `*/SKILL.md`
  - 具体 Skill 定义文件（如存在）

## 当前行为

- Skill 通过 `SKILL.md` 暴露说明和资源入口
- Agent 是否可用某个 Skill，由 `agent_configs.yaml` 的 `skills.enabled_skills` 控制
- 当 `auto_inject=true` 时，系统会自动注入：
  - `activate_skill`
  - `load_skill_resource`
  - `execute_skill_script`

## 说明

- Skills 是 Agent 能力层的一部分，不单独暴露 HTTP API
- Skill 的主入口和资源以磁盘文件为准
- 当前仓库不再内置旧图谱型 Skill 示例
