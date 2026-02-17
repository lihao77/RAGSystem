# 智能体配置系统使用指南

## 概述

智能体配置系统允许为每个智能体单独配置 LLM 参数、工具设置和自定义参数，而不是都使用系统全局配置。

### 核心特性

- ✅ **独立配置**：每个智能体可以使用不同的 LLM Provider 和模型
- ✅ **配置优先级**：智能体配置 > 系统配置 > 默认配置
- ✅ **持久化**：配置保存在 YAML 文件中
- ✅ **预设模板**：提供快速、平衡、精确等预设配置
- ✅ **动态更新**：通过 API 动态修改配置无需重启
- ✅ **工具控制**：精确控制每个智能体可以使用哪些工具

## 配置架构

### 配置文件位置

```
backend/
  ├── agents/
  │   ├── configs/
  │   │   └── agent_configs.yaml  # 智能体配置文件
  │   ├── config_manager.py
  │   └── agent_config.py
```

### 配置结构

```yaml
agents:
  qa_agent:
    agent_name: qa_agent
    display_name: 问答智能体
    description: 知识图谱问答智能体
    enabled: true
    llm:
      provider: deepseek        # 使用 DeepSeek
      model_name: deepseek-chat
      temperature: 0.2          # 低温度，更确定性
      max_tokens: 4096
    tools:
      enabled_tools:
        - query_kg
        - semantic_search
      tool_settings:
        query_kg:
          max_results: 20
    custom_params:
      max_rounds: 5  # 最大对话轮数

  master_agent:
    agent_name: master_agent
    display_name: 主协调智能体
    enabled: true
    llm:
      temperature: 0.0          # 任务分析需要确定性
      max_tokens: 2000
    custom_params:
      analysis_temperature: 0.0
      synthesis_temperature: 0.3
```

## API 使用

### 基础 URL

```
http://localhost:5000/api/agent-config
```

### 1. 列出所有配置

```bash
GET /api/agent-config/configs

# 响应
{
  "success": true,
  "data": {
    "qa_agent": {...},
    "master_agent": {...}
  },
  "message": "共有 2 个智能体配置"
}
```

### 2. 获取特定智能体配置

```bash
GET /api/agent-config/configs/qa_agent

# 响应
{
  "success": true,
  "data": {
    "agent_name": "qa_agent",
    "llm": {
      "provider": "deepseek",
      "temperature": 0.2,
      ...
    },
    ...
  }
}
```

### 3. 完整更新配置

```bash
PUT /api/agent-config/configs/qa_agent
Content-Type: application/json

{
  "agent_name": "qa_agent",
  "enabled": true,
  "llm": {
    "provider": "openai",
    "model_name": "gpt-4",
    "temperature": 0.3
  }
}
```

### 4. 部分更新配置

```bash
PATCH /api/agent-config/configs/qa_agent
Content-Type: application/json

{
  "llm": {
    "temperature": 0.5
  },
  "enabled": true
}
```

### 5. 应用预设配置

```bash
POST /api/agent-config/configs/qa_agent/preset
Content-Type: application/json

{
  "preset": "fast"  # fast | balanced | accurate | creative | cheap
}
```

**可用预设：**

| 预设 | 说明 | 配置 |
|------|------|------|
| `fast` | 快速响应模式 | temperature=0.1, max_tokens=2048 |
| `balanced` | 平衡模式（推荐） | temperature=0.5, max_tokens=4096 |
| `accurate` | 精确模式 | temperature=0.1, max_tokens=8192 |
| `creative` | 创意模式 | temperature=0.9, max_tokens=4096 |
| `cheap` | 经济模式 | provider=deepseek, temperature=0.5 |

### 6. 导出配置

```bash
# 导出为 YAML
GET /api/agent-config/configs/qa_agent/export?format=yaml

# 导出为 JSON
GET /api/agent-config/configs/qa_agent/export?format=json
```

### 7. 导入配置

```bash
POST /api/agent-config/configs/qa_agent/import?format=yaml
Content-Type: application/x-yaml

agent_name: qa_agent
enabled: true
llm:
  provider: deepseek
  temperature: 0.3
```

### 8. 验证配置

```bash
GET /api/agent-config/configs/qa_agent/validate

# 响应
{
  "success": true,
  "data": {
    "valid": true,
    "error": null
  }
}
```

### 9. 删除配置

```bash
DELETE /api/agent-config/configs/qa_agent
```

### 10. 列出预设

```bash
GET /api/agent-config/presets

# 响应
{
  "success": true,
  "data": {
    "fast": {...},
    "balanced": {...},
    ...
  }
}
```

## 代码集成

### 1. 在智能体中使用配置

```python
from agents import BaseAgent, AgentContext, AgentResponse, get_config_manager
from config import get_config

class MyAgent(BaseAgent):
    def __init__(self, model_adapter, system_config=None):
        # 加载智能体配置
        config_manager = get_config_manager()
        agent_config = config_manager.get_config('my_agent')

        # 如果没有配置，使用系统配置
        if system_config is None:
            system_config = get_config()

        # 初始化
        super().__init__(
            name='my_agent',
            description='我的智能体',
            model_adapter=model_adapter,
            agent_config=agent_config,      # 智能体独立配置
            system_config=system_config     # 系统配置（降级）
        )

    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        # 获取 LLM 配置（优先使用智能体配置）
        llm_config = self.get_llm_config()

        # 调用 LLM
        response = self.model_adapter.chat_completion(
            messages=[{"role": "user", "content": task}],
            provider=llm_config.get('provider'),
            model=llm_config.get('model_name'),
            temperature=llm_config.get('temperature'),
            max_tokens=llm_config.get('max_tokens')
        )

        # 获取自定义参数
        max_rounds = self.get_custom_param('max_rounds', default=3)

        # 检查工具是否启用
        if self.is_tool_enabled('query_kg'):
            # 使用工具
            tool_setting = self.get_tool_setting('query_kg', 'max_results', default=10)

        return AgentResponse(success=True, content=response.content)
```

### 2. 初始化时加载配置

```python
# backend/routes/agent.py
from agents import get_config_manager, ReActAgent

def _get_orchestrator():
    config = get_config()
    adapter = get_default_adapter()
    config_manager = get_config_manager()

    orchestrator = get_orchestrator(model_adapter=adapter)

    # 创建 ReActAgent 并加载配置
    qa_config = config_manager.get_config('qa_agent')
    qa_agent = ReActAgent(
        model_adapter=adapter,
        system_config=config,
        agent_config=qa_config  # 传入智能体配置
    )
    orchestrator.register_agent(qa_agent)

    # 创建 MasterAgent 并加载配置
    master_config = config_manager.get_config('master_agent')
    master_agent = MasterAgent(
        model_adapter=adapter,
        orchestrator=orchestrator,
        system_config=config,
        agent_config=master_config  # 传入智能体配置
    )
    orchestrator.register_agent(master_agent)

    return orchestrator
```

### 3. 配置优先级

```python
# BaseAgent.get_llm_config() 的优先级逻辑：

# 1. 智能体独立配置（最高优先级）
if self.agent_config and self.agent_config.llm.provider:
    provider = self.agent_config.llm.provider

# 2. 系统配置（降级）
elif self.system_config:
    provider = self.system_config.llm.provider

# 3. 默认值（最终降级）
else:
    provider = None
```

## 使用场景

### 场景 1: 为不同智能体配置不同模型

```yaml
agents:
  qa_agent:
    llm:
      provider: openai
      model_name: gpt-4-turbo      # 问答使用 GPT-4
      temperature: 0.2

  master_agent:
    llm:
      provider: deepseek
      model_name: deepseek-chat    # 协调使用 DeepSeek（便宜）
      temperature: 0.0

  chart_agent:
    llm:
      provider: openai
      model_name: gpt-3.5-turbo    # 图表生成使用 3.5（够用且快）
      temperature: 0.5
```

### 场景 2: 动态调整智能体参数

```bash
# 用户反馈：ReActAgent 回答太死板
curl -X PATCH http://localhost:5000/api/agent-config/configs/qa_agent \
  -H "Content-Type: application/json" \
  -d '{"llm": {"temperature": 0.5}}'

# 用户反馈：MasterAgent 任务分析不准确
curl -X PATCH http://localhost:5000/api/agent-config/configs/master_agent \
  -H "Content-Type: application/json" \
  -d '{
    "llm": {
      "model_name": "gpt-4",
      "temperature": 0.0
    }
  }'
```

### 场景 3: 快速切换模式

```bash
# 开发测试：使用 cheap 模式
curl -X POST http://localhost:5000/api/agent-config/configs/qa_agent/preset \
  -H "Content-Type: application/json" \
  -d '{"preset": "cheap"}'

# 生产环境：使用 balanced 模式
curl -X POST http://localhost:5000/api/agent-config/configs/qa_agent/preset \
  -H "Content-Type: application/json" \
  -d '{"preset": "balanced"}'

# 重要演示：使用 accurate 模式
curl -X POST http://localhost:5000/api/agent-config/configs/qa_agent/preset \
  -H "Content-Type: application/json" \
  -d '{"preset": "accurate"}'
```

### 场景 4: 禁用特定工具

```bash
# 只允许 ReActAgent 使用语义搜索，禁用 Cypher 查询
curl -X PATCH http://localhost:5000/api/agent-config/configs/qa_agent \
  -H "Content-Type: application/json" \
  -d '{
    "tools": {
      "enabled_tools": ["semantic_search"],
      "tool_settings": {
        "semantic_search": {"top_k": 5}
      }
    }
  }'
```

### 场景 5: A/B 测试不同配置

```python
# 备份当前配置
import requests

# 导出配置 A
response = requests.get('http://localhost:5000/api/agent-config/configs/qa_agent/export?format=yaml')
config_a = response.text

# 应用配置 B
requests.patch('http://localhost:5000/api/agent-config/configs/qa_agent', json={
    "llm": {"temperature": 0.7}
})

# 测试...

# 恢复配置 A
requests.post('http://localhost:5000/api/agent-config/configs/qa_agent/import?format=yaml',
              data=config_a,
              headers={'Content-Type': 'application/x-yaml'})
```

## 配置管理最佳实践

### 1. 配置版本控制

```bash
# 导出所有配置进行备份
curl http://localhost:5000/api/agent-config/configs > backup_$(date +%Y%m%d).json
```

### 2. 环境配置分离

```yaml
# development
agents:
  qa_agent:
    llm:
      provider: deepseek  # 开发用便宜模型
      temperature: 0.5

# production
agents:
  qa_agent:
    llm:
      provider: openai    # 生产用高质量模型
      model_name: gpt-4
      temperature: 0.2
```

### 3. 监控配置变化

```python
# 在配置更新时记录日志
logger.info(f"智能体 '{agent_name}' 配置已更新: {changes}")
```

### 4. 配置验证

```bash
# 在应用配置前先验证
curl http://localhost:5000/api/agent-config/configs/qa_agent/validate
```

## 故障排查

### 问题 1: 智能体没有使用配置的 LLM

**原因**：智能体未正确加载配置

**解决**：
```python
# 确保在智能体初始化时传入 agent_config
agent_config = get_config_manager().get_config('qa_agent')
qa_agent = ReActAgent(
    model_adapter=adapter,
    agent_config=agent_config  # 必须传入
)
```

### 问题 2: 配置文件不生效

**原因**：配置管理器使用了缓存

**解决**：
```python
# 重新加载配置
config_manager._load_configs()
```

### 问题 3: 配置无法保存

**原因**：配置目录没有写权限

**解决**：
```bash
chmod 755 backend/config/agents/
```

## 总结

智能体配置系统提供了：

- ✅ **灵活性**：每个智能体独立配置
- ✅ **可控性**：精确控制 LLM 和工具
- ✅ **易用性**：REST API + 预设模板
- ✅ **可维护性**：YAML 配置 + 版本控制
- ✅ **动态性**：无需重启即可更新

现在你可以为不同智能体配置不同的 LLM，实现精细化的性能和成本控制！🎉
