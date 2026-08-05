---
name: skill-authoring
description: 指导 Builder Agent 在 Session 工作区创建、编辑和发布 Skill Draft；本 Skill 不等同于 Skill 使用权限。
---

# Skill Draft Authoring

Skill 创建和发布只对 Agent Builder 开放。不要把它们作为普通 Agent 的工具配置，也不要把创建能力当作 `enabled_skills`。

## 工作流

1. 使用 `list_skill_drafts`（可带关键词）查找已有 Draft，或使用 `create_skill_draft` 从零创建。
2. 使用 `get_skill_draft` 将 Draft 复制到当前 Session 工作区。
3. 用文件工具编辑根目录 `SKILL.md` 以及 scripts、references、assets 等资源。
4. 调用 `publish_skill_draft`。工具会自动校验 bundle；失败时修复文件并重试，成功后按自动发布配置同步 Draft 或生成 Skill 包。
5. Skill 使用权限仍由 Agent 的 `enabled_skills` 单独配置。

Draft 工作区至少包含根目录 `SKILL.md`；资源路径例如 `scripts/check.py`、`references/schema.json` 和 `assets/template.txt`。
