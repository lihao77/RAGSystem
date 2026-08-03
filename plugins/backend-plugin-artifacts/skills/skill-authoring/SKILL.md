---
name: skill-authoring
description: 指导 Agent 设计和提交完整的 Skill Artifact。用于需要产出可审核 Skill、整理 SKILL.md、脚本和资源时；创建能力由普通工具提供，本 Skill 不等同于 Skill 使用权限。
---

# Skill Artifact Authoring

使用 Artifact 插件的普通工具 `create_skill_artifact` 生成当前 Session 的 `kind=skill` Artifact。不要调用旧的 `create_skill_artifact.py` 或把创建能力当作 `enabled_skills` 配置。

## 工作流

1. 确定 Skill 名称、描述、SKILL.md 正文、metadata，以及所需的 scripts、references、assets 或其他资源。
2. 将资源作为 `files` 传给 `create_skill_artifact`：每个文件使用安全相对路径，并且只能提供 `content` 或 `data_base64` 之一。
3. 等待工具完成，从工具结果的 `content.artifact_id` 和 `content.artifact_revision` 读取真实值。不要猜测 ID，也不要在同一并发工具批次中提交。
4. 如果需要进入 Skill 库，再调用普通工具 `submit_skill_artifact`，把上述值分别作为 `artifact_id` 和 `expected_revision`。这只创建可审核候选，不会发布或绑定 Agent。
5. 候选发布由管理员在 Skill Library 中完成；发布后，使用权限仍由 Agent 的 `enabled_skills` 单独配置。

创建工具会自动生成根目录 `SKILL.md`。不要在 `files` 中重复提供 `SKILL.md`；资源路径例如 `scripts/check.py`、`references/schema.json` 和 `assets/template.txt`。
