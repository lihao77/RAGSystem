---
name: team-generation
description: 根据任务目标生成并应用 team 配置方案，输出 team 协议并由系统桥接持久化。
---

## 能力说明

本 Skill 用于根据用户目标、角色分工和约束条件，生成一套新的 team 配置方案。

生成结果不是直接写文件，而是输出标准 `team` 协议，由 `execute_skill_script` 自动桥接到系统的 team 配置管理器中完成持久化。

## 使用原则

- 仅在用户明确要求“自动生成 team / 自动组 team / 根据目标创建 team 配置”时使用。
- 若用户没有给出足够约束，先基于最常见协作形态生成最小可用 team。
- 第一版只输出完整 team 配置，不输出 patch / merge 差量。
- 生成结果应尽量少而完整，不为兼容旧配置保留多余字段。
- `team.agents` 中每个 agent 配置都必须是完整、可校验的 `AgentConfig` payload。
- 最少要自动补全：`display_name`、`description`、`default_entry`、`custom_params.behavior.system_prompt`。

## 推荐流程

1. 明确团队目标：这个 team 是为了解决什么问题。
2. 明确角色拆分：哪些 agent 需要保留、哪些要新增、谁是默认入口。
3. 优先提供 `roles` 而不是手写完整 `agents`，由脚本自动生成完整 AgentConfig。
4. 调用脚本输出标准 `team` 协议。
5. 由系统自动持久化为普通 team 配置。

## 配置文件位置

team 配置位于运行时数据根下的 `config/agents/`：

- team 索引文件：`{DATA_ROOT}/config/agents/team_index.yaml`
- team 配置目录：`{DATA_ROOT}/config/agents/teams/`

其中默认 `DATA_ROOT = ~/.ragsystem`，若显式设置 `RAG_DATA_ROOT`，则以上路径随之切换。

如果需要由 agent 自主读取、对比或直接修改 team 配置，直接访问这两个位置即可。

建议最少关注：
- `agents.<agent_name>.display_name`
- `agents.<agent_name>.description`
- `agents.<agent_name>.default_entry`
- `agents.<agent_name>.custom_params.behavior.system_prompt`

约束：
- 同一个 team 中只能有一个 `default_entry=true`
- 修改后应重新读取文件并确认 YAML 结构未损坏

## 可用脚本

### generate_team.py - 生成并应用 team 配置协议

**功能**：
- 接收 team 名称、team 目标、角色列表或完整 agents payload
- 自动补全每个 agent 的 `display_name`、`description`、`default_entry` 和 `custom_params.behavior.system_prompt`
- 输出标准 `team` 协议
- 不直接写文件，由系统自动应用

**参数**：
- `--team-name`（必填）：目标 team 名称
- `--team-goal`（推荐）：team 总体目标
- `--roles`（推荐）：角色列表 JSON；每项可包含 `role`、`display_name`、`responsibility`、`system_prompt`、`is_entry`、`tools`、`skills`、`delegation`
- `--agents`（可选）：完整 agents payload 的 JSON 字符串；只有你已经掌握完整配置时才直接传
- `--source-team`（可选）：来源 team 名称，仅作记录与应用时参考
- `--reason`（可选）：生成该 team 的原因说明；未传 `team-goal` 时会作为目标兜底

**输出协议**：
```json
{
  "success": true,
  "summary": "已生成 team payload",
  "data": {
    "team_name": "custom-team",
    "reason": "用于专项任务编排"
  },
  "team": {
    "action": "create_or_replace",
    "team_name": "custom-team",
    "source_team": "default",
    "agents": {
      "orchestrator_agent": {
        "agent_name": "orchestrator_agent",
        "enabled": true,
        "default_entry": true,
        "llm_tiers": {
          "default": {
            "provider": "dmx",
            "provider_type": "openai_chat",
            "model_name": "gpt-5.4"
          }
        }
      }
    }
  }
}
```

**调用示例（推荐 roles 模式）**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "team-generation",
    "script_name": "generate_team.py",
    "arguments": [
      "--team-name", "math-coach-team",
      "--team-goal", "围绕数学专项学习规划与答疑提供协同辅导",
      "--source-team", "default",
      "--roles", "[{\"role\": \"主编排教练\", \"agent_name\": \"orchestrator_agent\", \"responsibility\": \"负责理解用户需求、路由任务与整合答案\", \"is_entry\": true, \"delegation\": [\"planner_agent\", \"qa_agent\"]}, {\"role\": \"规划专家\", \"agent_name\": \"planner_agent\", \"responsibility\": \"负责阶段计划、任务拆解和复盘安排\"}, {\"role\": \"答疑专家\", \"agent_name\": \"qa_agent\", \"responsibility\": \"负责专项知识点讲解与例题答疑\"}]"
    ]
  }
}
```

**调用示例（高级 agents 模式）**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "team-generation",
    "script_name": "generate_team.py",
    "arguments": [
      "--team-name", "math-coach-team",
      "--team-goal", "用于数学专项学习规划",
      "--source-team", "default",
      "--agents", "{\"orchestrator_agent\": {\"agent_name\": \"orchestrator_agent\", \"enabled\": true, \"default_entry\": true, \"llm_tiers\": {\"default\": {\"provider\": \"dmx\", \"provider_type\": \"openai\", \"model_name\": \"gpt-5.4\"}}}}"
    ]
  }
}
```
