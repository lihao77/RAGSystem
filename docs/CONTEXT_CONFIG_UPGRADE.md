# 智能体上下文配置升级说明

## 升级日期
2026-02-24

## 升级概述

本次升级规范化了 LLM 配置中的 token 相关参数，明确区分**单次输出限制**和**模型上下文窗口**，解决了之前 `max_tokens` 语义混淆的问题。

## 问题背景

### 升级前的问题

1. **语义混淆**：`max_tokens` 既用于表示单次输出限制，又被误用于计算上下文预算
2. **缺少上下文窗口配置**：无法配置模型真实的上下文窗口大小（如 GPT-4 的 128K）
3. **上下文预算计算不准确**：使用输出 token 限制来估算上下文预算，严重低估可用空间

### 业界标准语义

- **max_completion_tokens** / **max_output_tokens**：单次生成的最大 token 数（输出长度限制）
- **max_context_tokens** / **context_window**：模型支持的最大上下文窗口（输入+输出总长度）

## 升级内容

### 1. 后端配置模型（AgentLLMConfig）

**文件**：`backend/agents/config/models.py`

**新增字段**：
```python
class AgentLLMConfig(BaseModel):
    max_tokens: Optional[int]  # 已废弃，向后兼容
    max_completion_tokens: Optional[int]  # 单次输出的最大 token 数
    max_context_tokens: Optional[int]  # 模型支持的最大上下文窗口
```

**配置优先级**：
1. `max_completion_tokens` > `max_tokens`（输出限制）
2. Agent配置 > ModelAdapter Provider配置 > 系统默认（上下文窗口）

### 2. ModelAdapter Provider 配置

**文件**：`backend/model_adapter/base.py`

**新增属性**：
```python
class AIProvider:
    def __init__(self, ...):
        self.max_completion_tokens = kwargs.get("max_completion_tokens") or self.max_tokens
        self.max_context_tokens = kwargs.get("max_context_tokens")
```

**配置示例**（`providers.yaml`）：
```yaml
my_deepseek:
  name: my
  provider_type: deepseek
  max_completion_tokens: 4096      # 单次输出限制
  max_context_tokens: 128000       # DeepSeek V3: 128K
```

### 3. Agent 配置

**文件**：`backend/agents/configs/agent_configs.yaml`

**配置示例**：
```yaml
agents:
  qa_agent:
    llm:
      provider: test
      provider_type: deepseek
      max_completion_tokens: 4096    # 单次输出限制
      max_context_tokens: 128000     # 模型上下文窗口
    custom_params:
      behavior:
        max_context_tokens: 80000    # 可选：显式指定对话历史预算
```

### 4. 上下文预算计算逻辑

**文件**：`backend/agents/implementations/react/agent.py`

**新逻辑**：
```python
# 1. 获取输出 token 限制
model_max_completion_tokens = llm_config.get('max_tokens', 4096)

# 2. 获取上下文窗口
model_context_window = llm_config.get('max_context_tokens')

# 3. 计算上下文预算
if model_context_window:
    # 预算 = 上下文窗口 * 0.9 - system_prompt(2000) - 输出空间
    context_token_budget = int(model_context_window * 0.9) - 2000 - model_max_completion_tokens
    context_token_budget = max(context_token_budget, 4000)
else:
    # 兜底：使用输出 token 的 3 倍
    context_token_budget = model_max_completion_tokens * 3

# 4. 用户可显式覆盖
max_context_tokens = behavior_config.get('max_context_tokens', context_token_budget)
```

### 5. 前端界面更新

#### Agent 配置界面（LLMConfigSelector.vue）

**新增字段**：
- 输出Token限制（`max_completion_tokens`）
- 上下文窗口（`max_context_tokens`）
- 最大Token(旧)（`max_tokens`，已禁用）

#### ModelAdapter 配置界面（ModelAdapterView.vue）

**新增字段**：
- 输出Token限制（`max_completion_tokens`）
- 上下文窗口（`max_context_tokens`）
- 最大Token(旧)（`max_tokens`，已禁用）

## 配置示例

### 常见模型的上下文窗口配置

```yaml
# DeepSeek V3
max_completion_tokens: 4096
max_context_tokens: 128000

# GPT-4 Turbo
max_completion_tokens: 4096
max_context_tokens: 128000

# Claude 3.5 Sonnet
max_completion_tokens: 8192
max_context_tokens: 200000

# GPT-4o
max_completion_tokens: 16384
max_context_tokens: 128000
```

### 上下文预算计算示例

| 模型 | 上下文窗口 | 输出限制 | 计算后预算 | 利用率 |
|------|-----------|---------|-----------|--------|
| DeepSeek V3 | 128000 | 4096 | 109104 | 85.2% |
| Claude 3.5 | 200000 | 8192 | 169808 | 84.9% |
| 未配置 | - | 4096 | 12288 | 75.0% |

## 向后兼容性

### 旧配置自动迁移

1. **Agent 配置**：
   - 旧的 `max_tokens` 会自动映射到 `max_completion_tokens`
   - 未配置 `max_context_tokens` 时使用兜底计算

2. **ModelAdapter 配置**：
   - 旧的 `max_tokens` 会自动映射到 `max_completion_tokens`
   - 未配置 `max_context_tokens` 时返回 `null`，由 Agent 使用兜底逻辑

3. **前端界面**：
   - 旧配置会自动同步到新字段
   - 旧的 `max_tokens` 字段显示为禁用状态

## 迁移步骤

### 1. 更新 ModelAdapter Provider 配置

编辑 `backend/model_adapter/configs/providers.yaml`：

```yaml
my_deepseek:
  name: my
  provider_type: deepseek
  # 添加新字段
  max_completion_tokens: 4096
  max_context_tokens: 128000
  # 保留旧字段（可选，会自动同步）
  max_tokens: 4096
```

### 2. 更新 Agent 配置

编辑 `backend/agents/configs/agent_configs.yaml`：

```yaml
agents:
  qa_agent:
    llm:
      # 添加新字段
      max_completion_tokens: 4096
      max_context_tokens: 128000
```

### 3. 重启后端

```bash
cd backend
python app.py
```

### 4. 验证配置

运行测试脚本：

```bash
cd backend
python test_context_config.py
```

预期输出：
```
✅ 所有测试通过！
```

## 测试验证

### 测试脚本

`backend/test_context_config.py` 包含以下测试：

1. **AgentLLMConfig 模型测试**：验证新字段定义
2. **配置合并逻辑测试**：验证优先级和兼容性
3. **YAML 加载测试**：验证配置文件解析
4. **上下文预算计算测试**：验证不同场景下的计算结果

### 手动验证

1. **前端验证**：
   - 访问 `/model-adapter`，检查 Provider 配置是否显示新字段
   - 访问 `/agent-config`，检查 Agent 配置是否显示新字段

2. **运行时验证**：
   - 启动 Agent，查看日志中的上下文配置信息
   - 日志应显示：`模型输出限制: 4096 tokens, 上下文窗口: 128000, 上下文预算: 109104 tokens`

## 常见问题

### Q1: 旧配置会失效吗？

**A**: 不会。系统完全向后兼容，旧的 `max_tokens` 会自动映射到 `max_completion_tokens`。

### Q2: 必须配置 max_context_tokens 吗？

**A**: 不是必须的。如果不配置，系统会使用兜底逻辑（输出 token 的 3 倍）。但建议配置以获得更准确的上下文管理。

### Q3: 如何知道模型的上下文窗口大小？

**A**: 查看模型官方文档：
- DeepSeek V3: 128K
- GPT-4 Turbo: 128K
- Claude 3.5 Sonnet: 200K
- GPT-4o: 128K

### Q4: 前端显示"最大Token(旧)"是什么意思？

**A**: 这是为了向后兼容保留的字段，已被禁用。新配置请使用"输出Token限制"。

### Q5: 上下文预算计算公式是什么？

**A**:
```
上下文预算 = (上下文窗口 * 0.9) - 2000 - 输出Token限制
```
- 0.9：预留 10% 安全边界
- 2000：system prompt 估算
- 输出Token限制：预留输出空间

## 相关文档

- **配置指南**：`CLAUDE.md` - 智能体配置章节
- **ModelAdapter 文档**：`backend/model_adapter/README.md`
- **上下文管理**：`backend/agents/context/manager.py`

## 技术支持

如有问题，请查看：
1. 测试脚本输出：`python backend/test_context_config.py`
2. 后端日志：查看 Agent 初始化日志
3. 前端控制台：检查配置加载错误

## 更新日志

- **2026-02-24**：初始版本，完成配置规范化升级
