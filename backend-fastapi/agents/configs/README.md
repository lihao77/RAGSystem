# Agent 配置文件

当前 Agent 配置保存在：

- `backend/agents/configs/agent_configs.yaml`

示例文件：

- `backend/agents/configs/agent_configs.yaml.example`

## 当前行为

- 文件不存在时，`AgentConfigManager` 会创建一个空配置文件框架
- 用户自定义 Agent 从这里加载
- `orchestrator_agent` 仍作为默认兜底入口装载，但如果这里存在同名配置，会优先使用其中字段
- 可以通过 `default_entry: true` 指定其他默认入口 Agent；`custom_params.default_entry: true` 仍兼容旧配置
- 显式传入的 `preferred_agent` 优先级更高

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
    default_entry: false
    llm:
      provider: test
      provider_type: deepseek
      model_name: deepseek-chat
    tools:
      enabled_tools:
        - read_document
        - extract_structured_data
        - generate_chart
        - execute_code
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
