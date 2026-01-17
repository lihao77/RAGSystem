# 智能体插件化系统使用指南

## 概述

智能体插件化系统允许你通过**配置文件**定义新的智能体，无需编写代码。

### 核心特性

- ✅ **配置驱动**：通过 YAML 配置定义智能体
- ✅ **无需编码**：不需要编写 Python 代码
- ✅ **热加载**：重启服务即可加载新智能体
- ✅ **灵活配置**：自定义系统提示、工具列表、行为参数

## 快速开始

### 1. 创建新智能体配置

编辑 `backend/agents/configs/agent_configs.yaml`，添加新智能体：

```yaml
agents:
  # 你的自定义智能体
  my_agent:
    agent_name: my_agent
    display_name: 我的智能体
    description: 这是一个自定义智能体
    enabled: true
    llm:
      temperature: 0.3
      max_tokens: 4096
    tools:
      enabled_tools:
        - query_knowledge_graph_with_nl
        - search_knowledge_graph
    custom_params:
      type: react  # 使用 ReAct 模板
      behavior:
        system_prompt: "你是一个专门做XX的智能体..."
        max_rounds: 10
        auto_execute_tools: true
```

### 2. 重启后端服务

```bash
# 停止后端
Ctrl+C

# 重新启动
python app.py
```

### 3. 验证智能体已加载

查看后端日志：
```
INFO - 已注册智能体: my_agent
INFO - Orchestrator 初始化成功，已加载 3 个智能体
```

### 4. 使用新智能体

通过 API 使用：
```bash
curl -X POST http://localhost:5000/api/agent/execute \
  -H "Content-Type: application/json" \
  -d '{
    "query": "你的问题",
    "session_id": "test_session"
  }'
```

新智能体会自动参与任务处理。

## 智能体类型

### 1. ReAct Agent

适用场景：
- ✅ 标准的查询任务
- ✅ 需要调用工具的任务
- ✅ 需要并行工具调用的场景
- ✅ 需要可解释推理过程的场景

配置示例：
```yaml
my_agent:
  agent_name: my_agent
  custom_params:
    type: react  # 使用通用模板
    behavior:
      system_prompt: "..."
      max_rounds: 10
      auto_execute_tools: true
```

### 2. 专用 Agent（如 Master）

适用场景：
- ❌ 需要特殊初始化逻辑
- ❌ 需要复杂的执行流程
- ❌ 需要访问特殊资源

这些智能体仍需要通过代码实现。

## 配置详解

### 基本信息

```yaml
agent_name: my_agent        # 唯一标识（必填）
display_name: 我的智能体      # 显示名称
description: 智能体描述       # 功能描述
enabled: true               # 是否启用
```

### LLM 配置

```yaml
llm:
  provider: deepseek        # Provider（可选）
  model_name: deepseek-chat # 模型名称（可选）
  temperature: 0.3          # 温度 (0-2)
  max_tokens: 4096          # 最大 tokens
  timeout: 30               # 超时时间（秒）
  retry_attempts: 3         # 重试次数
```

### 工具配置

```yaml
tools:
  enabled_tools:            # 启用的工具列表
    - query_knowledge_graph_with_nl
    - search_knowledge_graph
    - analyze_temporal_pattern
```

**留空表示启用所有工具。**

### 行为配置（Generic Agent）

```yaml
custom_params:
  type: generic
  behavior:
    # 系统提示（定义智能体的角色和行为）
    system_prompt: |
      你是一个专业的XX智能体。
      你的职责是：
      1. ...
      2. ...

    # 最大对话轮数
    max_rounds: 10

    # 是否自动执行工具调用
    auto_execute_tools: true

    # 任务匹配模式（可选）
    task_patterns:
      - "关键词1"
      - "关键词2"
```

#### system_prompt

定义智能体的角色、职责和行为准则。

**最佳实践**：
- ✅ 明确角色定位
- ✅ 列出具体职责
- ✅ 说明回答要求
- ✅ 使用清晰的结构

**示例**：
```yaml
system_prompt: |
  你是一个设施监控专家智能体。

  职责：
  1. 监控设施状态变化
  2. 分析异常模式
  3. 提供预警建议

  回答要求：
  - 基于实际数据
  - 突出异常信息
  - 提供具体建议
```

#### max_rounds

限制对话轮数，防止无限循环。

**建议值**：
- 简单查询：3-5 轮
- 标准任务：10-15 轮
- 复杂分析：20-30 轮

#### auto_execute_tools

是否自动执行 LLM 返回的工具调用。

- `true`：自动执行（推荐）
- `false`：手动执行（需要额外代码）

#### task_patterns（可选）

限制智能体只处理特定类型的任务。

**示例**：
```yaml
task_patterns:
  - "设施"        # 包含"设施"的问题
  - "监控"        # 包含"监控"的问题
  - "facility"   # 英文关键词
```

**不配置则处理所有任务。**

## 实际案例

### 案例 1：设施异常检测智能体

```yaml
facility_monitor:
  agent_name: facility_monitor
  display_name: 设施监控
  description: 监控设施状态，发现异常模式
  enabled: true
  llm:
    temperature: 0.1  # 低温度，确保准确
    max_tokens: 4096
  tools:
    enabled_tools:
      - search_knowledge_graph
      - get_entity_relations
      - analyze_temporal_pattern
  custom_params:
    type: react
    behavior:
      system_prompt: |
        你是一个设施监控专家。
        专注于发现设施的异常状态和模式。
      max_rounds: 15
      auto_execute_tools: true
      task_patterns: ["设施", "监控", "状态", "异常"]
```

### 案例 2：应急预案助手

```yaml
emergency_assistant:
  agent_name: emergency_assistant
  display_name: 应急助手
  description: 查询应急预案，提供应急建议
  enabled: true
  llm:
    temperature: 0.0  # 极低温度，确保准确
    max_tokens: 8192  # 大 token，支持长预案
  tools:
    enabled_tools:
      - query_emergency_plan
  custom_params:
    type: react
    behavior:
      system_prompt: |
        你是应急预案专家。
        根据情况查询预案，提供可执行的应急措施。
      max_rounds: 5
      auto_execute_tools: true
```

### 案例 3：快速查询助手

```yaml
quick_query:
  agent_name: quick_query
  display_name: 快速查询
  description: 提供快速、简洁的查询结果
  enabled: true
  llm:
    provider: deepseek  # 使用快速模型
    temperature: 0.1
    max_tokens: 1024    # 限制输出长度
  tools:
    enabled_tools:
      - search_knowledge_graph
  custom_params:
    type: react
    behavior:
      system_prompt: "你是快速查询助手，提供简洁的答案。"
      max_rounds: 3      # 快速响应
      auto_execute_tools: true
```

## 高级功能

### 1. 注册自定义智能体类

如果通用模板无法满足需求，可以编写自定义智能体类并注册：

```python
# my_custom_agent.py
from agents import BaseAgent, AgentContext, AgentResponse

class MyCustomAgent(BaseAgent):
    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        # 自定义逻辑
        return AgentResponse(success=True, content="...")

# 注册类型
from agents import register_agent_type
register_agent_type('my_custom', MyCustomAgent)
```

然后在配置中使用：
```yaml
my_agent:
  custom_params:
    type: my_custom  # 使用自定义类
```

### 2. 禁用智能体

临时禁用智能体：
```yaml
my_agent:
  enabled: false  # 不会被加载
```

### 3. 切换 Provider

为不同智能体配置不同的 LLM：
```yaml
expensive_agent:
  llm:
    provider: openai
    model_name: gpt-4

cheap_agent:
  llm:
    provider: deepseek
    model_name: deepseek-chat
```

## 最佳实践

### 1. 明确智能体职责

每个智能体应该有清晰的职责边界：

✅ **好的设计**：
- `facility_monitor`：专注设施监控
- `emergency_assistant`：专注应急预案
- `data_analyst`：专注数据分析

❌ **不好的设计**：
- `general_agent`：什么都做（太模糊）

### 2. 合理配置工具

只启用必要的工具：

✅ **好的配置**：
```yaml
# 应急助手只需要查预案
tools:
  enabled_tools: [query_emergency_plan]
```

❌ **不好的配置**：
```yaml
# 启用所有工具（浪费）
tools:
  enabled_tools: []  # 空列表 = 全部启用
```

### 3. 优化系统提示

系统提示是智能体行为的核心：

✅ **好的提示**：
```yaml
system_prompt: |
  你是设施监控专家。

  职责：
  1. 监控设施状态
  2. 识别异常模式

  回答要求：
  - 基于数据
  - 突出异常
```

❌ **不好的提示**：
```yaml
system_prompt: "你是一个AI助手"  # 太模糊
```

### 4. 设置合理的轮数限制

根据任务复杂度设置：

- 简单查询：3-5 轮
- 标准任务：10-15 轮
- 复杂分析：20-30 轮

### 5. 使用任务模式过滤

避免智能体处理不相关的任务：

```yaml
task_patterns:
  - "设施"      # 只处理设施相关问题
  - "监控"
```

## 故障排查

### 问题 1：智能体没有加载

**检查**：
1. 配置文件语法是否正确（YAML）
2. `enabled: true` 是否设置
3. 查看后端日志是否有错误

### 问题 2：智能体不执行任务

**检查**：
1. `task_patterns` 是否过于严格
2. `can_handle` 方法是否正确
3. Orchestrator 是否正确路由任务

### 问题 3：工具调用失败

**检查**：
1. 工具名称是否正确
2. `auto_execute_tools: true` 是否设置
3. 工具是否在 `enabled_tools` 中

## 总结

智能体插件化系统让你可以：

- ✅ 无需编码即可创建新智能体
- ✅ 通过配置精确控制智能体行为
- ✅ 快速迭代和测试不同配置
- ✅ 为不同场景定制专用智能体

**开始尝试吧！** 🚀
