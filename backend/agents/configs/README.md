# Agent 配置文件

当前 Agent 配置保存在：

- `backend/agents/configs/agent_configs.yaml`

示例文件：

- `backend/agents/configs/agent_configs.yaml.example`

## 当前行为

- 文件不存在时，`AgentConfigManager` 会创建一个空配置文件框架
- 用户自定义 Agent 从这里加载
- `master_agent_v2` 仍由系统强制装载，但如果这里存在同名配置，会优先使用其中字段

## 管理方式

推荐通过 API 或前端页面管理：

- 页面：管理端 `/agent-config`
- `GET /api/agent-config/configs`
- `GET /api/agent-config/configs/<agent_name>`
- `PUT /api/agent-config/configs/<agent_name>`
- `PATCH /api/agent-config/configs/<agent_name>`
- `DELETE /api/agent-config/configs/<agent_name>`
- `GET /api/agent-config/presets`
- `GET /api/agent-config/tools`
- `GET /api/agent-config/skills`
- `GET /api/agent-config/mcp-servers`

## 结构

顶层结构：

```yaml
agents:
  qa_agent:
    agent_name: qa_agent
    display_name: QA Agent
    enabled: true
    llm:
      provider: test
      provider_type: deepseek
      model_name: deepseek-chat
    tools:
      enabled_tools:
        - query_knowledge_graph_with_nl
    skills:
      enabled_skills: []
      auto_inject: true
    mcp:
      enabled_servers: []
    custom_params:
      type: react
metadata:
  version: "1.0"
```
