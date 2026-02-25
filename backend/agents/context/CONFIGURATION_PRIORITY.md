# 上下文管理配置优先级说明

## 配置来源和优先级

### 1. **上下文窗口** (`max_context_tokens`)
模型支持的最大上下文窗口（输入+输出总 token 数）。

**优先级**（从高到低）：
1. **Agent 配置** - `agent_configs.yaml` 中的 `llm.max_context_tokens`
2. **Provider 配置** - ModelAdapter 的 Provider 配置中的 `max_context_tokens`
3. **系统默认** - `config.yaml` 中的 `llm.max_context_tokens`

**代码位置**：`backend/agents/config/models.py` 第 111-123 行

```python
# 上下文窗口：优先级 Agent配置 > ModelAdapter Provider配置 > 系统默认
context_tokens = self.max_context_tokens
if not context_tokens and model_adapter and result['provider'] and result['provider_type']:
    provider_key = f"{result['provider']}_{result['provider_type']}"
    provider = model_adapter.providers.get(provider_key)
    if provider and hasattr(provider, 'max_context_tokens'):
        context_tokens = provider.max_context_tokens

result['max_context_tokens'] = context_tokens or getattr(default_config.llm, 'max_context_tokens', None)
```

---

### 2. **输出限制** (`max_completion_tokens`)
单次生成的最大 token 数。

**优先级**（从高到低）：
1. **Agent 配置（新字段）** - `agent_configs.yaml` 中的 `llm.max_completion_tokens`
2. **Agent 配置（旧字段）** - `llm.max_tokens`（向后兼容）
3. **Provider 配置** - ModelAdapter 的 Provider 配置中的 `max_completion_tokens`
4. **系统默认** - `config.yaml` 中的 `llm.max_tokens`，默认 4096

**代码位置**：`backend/agents/config/models.py` 第 95-109 行

```python
# 输出 token 限制：优先级 Agent配置 > ModelAdapter Provider配置 > 系统默认
completion_tokens = self.max_completion_tokens or self.max_tokens
if not completion_tokens and model_adapter and result['provider'] and result['provider_type']:
    provider_key = f"{result['provider']}_{result['provider_type']}"
    provider = model_adapter.providers.get(provider_key)
    if provider and hasattr(provider, 'max_completion_tokens'):
        completion_tokens = provider.max_completion_tokens

result['max_tokens'] = completion_tokens or getattr(default_config.llm, 'max_tokens', 4096)
```

---

### 3. **显式预算** (`explicit_budget`)
用户在 Agent 的 `behavior_config` 中**显式指定**的上下文预算。

**配置位置**：`agent_configs.yaml` 中的 `custom_params.behavior.max_context_tokens`

```yaml
agents:
  qa_agent:
    llm:
      max_completion_tokens: 4096      # 输出限制
      max_context_tokens: 128000       # 上下文窗口
    custom_params:
      behavior:
        max_context_tokens: 50000      # ← 显式预算（可选）
```

**优先级最高**：如果配置了显式预算，会直接使用，忽略自动计算。

**代码位置**：`backend/agents/context/budget.py` 第 46-48 行

```python
# 优先级 1：用户显式指定
if explicit_budget is not None:
    return max(explicit_budget, MIN_CONTEXT_BUDGET)
```

---

## 完整优先级链

### 上下文预算计算优先级

```
compute_context_budget() 的优先级：
1. behavior.max_context_tokens（显式预算）
2. 基于 max_context_tokens 和 max_completion_tokens 自动计算
   公式：int(max_context_tokens × 0.9) - 2000 - max_completion_tokens
3. 兜底估算（max_completion_tokens × 倍数）
   - ReAct Agent: max_completion_tokens × 3
   - Master Agent: max_completion_tokens × 0.6
```

### max_context_tokens 的优先级

```
1. Agent 配置（agent_configs.yaml 中的 llm.max_context_tokens）
2. Provider 配置（ModelAdapter Provider 的 max_context_tokens）
3. 系统默认（config.yaml 中的 llm.max_context_tokens）
```

### max_completion_tokens 的优先级

```
1. Agent 配置（新字段）（agent_configs.yaml 中的 llm.max_completion_tokens）
2. Agent 配置（旧字段）（agent_configs.yaml 中的 llm.max_tokens）
3. Provider 配置（ModelAdapter Provider 的 max_completion_tokens）
4. 系统默认（config.yaml 中的 llm.max_tokens，默认 4096）
```

---

## 配置示例

### 示例 1：完全依赖 Provider 配置

```yaml
# agent_configs.yaml
agents:
  qa_agent:
    llm:
      provider: test
      provider_type: deepseek
      # 不配置 max_completion_tokens 和 max_context_tokens
```

```yaml
# model_adapter/configs/providers.yaml
providers:
  - name: test
    provider_type: deepseek
    max_completion_tokens: 8192        # ← Agent 会使用这个
    max_context_tokens: 128000         # ← Agent 会使用这个
```

**结果**：
- 输出限制: 8192（来自 Provider）
- 上下文窗口: 128000（来自 Provider）
- 上下文预算: `int(128000 × 0.9) - 2000 - 8192 = 105008` tokens

---

### 示例 2：Agent 配置覆盖 Provider

```yaml
# agent_configs.yaml
agents:
  qa_agent:
    llm:
      provider: test
      provider_type: deepseek
      max_completion_tokens: 4096      # ← 覆盖 Provider 的 8192
      max_context_tokens: 64000        # ← 覆盖 Provider 的 128000
```

**结果**：
- 输出限制: 4096（来自 Agent 配置）
- 上下文窗口: 64000（来自 Agent 配置）
- 上下文预算: `int(64000 × 0.9) - 2000 - 4096 = 51504` tokens

---

### 示例 3：使用显式预算

```yaml
# agent_configs.yaml
agents:
  qa_agent:
    llm:
      provider: test
      provider_type: deepseek
      max_completion_tokens: 4096
      max_context_tokens: 128000
    custom_params:
      behavior:
        max_context_tokens: 50000      # ← 显式预算
```

**结果**：
- 输出限制: 4096
- 上下文窗口: 128000
- 上下文预算: **50000**（直接使用显式预算，忽略自动计算）

---

### 示例 4：向后兼容旧字段名

```yaml
# agent_configs.yaml
agents:
  qa_agent:
    llm:
      provider: test
      provider_type: deepseek
      max_tokens: 4096               # ← 旧字段名（向后兼容）
      max_context_tokens: 128000
```

**结果**：
- 输出限制: 4096（从 max_tokens 读取）
- 上下文窗口: 128000
- 上下文预算: `int(128000 × 0.9) - 2000 - 4096 = 109104` tokens

---

## 推荐配置方式

### 方式 1：在 Provider 中配置（推荐）

适用于同一 Provider 的所有 Agent 使用相同配置。

```yaml
# model_adapter/configs/providers.yaml
providers:
  - name: production
    provider_type: deepseek
    max_completion_tokens: 8192
    max_context_tokens: 128000
```

```yaml
# agent_configs.yaml
agents:
  qa_agent:
    llm:
      provider: production
      provider_type: deepseek
      # 不配置 token 限制，自动从 Provider 继承
```

### 方式 2：在 Agent 中配置

适用于特定 Agent 需要不同的配置。

```yaml
# agent_configs.yaml
agents:
  qa_agent:
    llm:
      provider: production
      provider_type: deepseek
      max_completion_tokens: 4096      # 覆盖 Provider 配置
      max_context_tokens: 64000        # 覆盖 Provider 配置
```

### 方式 3：使用显式预算（高级）

适用于需要精确控制上下文预算的场景。

```yaml
# agent_configs.yaml
agents:
  qa_agent:
    llm:
      provider: production
      provider_type: deepseek
    custom_params:
      behavior:
        max_context_tokens: 50000      # 显式预算
```

---

## 常见问题

### Q1: 为什么有两个字段名 `max_tokens` 和 `max_completion_tokens`？

**A**: 为了向后兼容。旧配置使用 `max_tokens`，新配置使用更明确的 `max_completion_tokens`。系统会优先使用 `max_completion_tokens`，如果没有则回退到 `max_tokens`。

### Q2: 什么时候应该配置显式预算？

**A**: 大多数情况下不需要。只有在以下场景才需要：
- 需要精确控制上下文预算（如限制成本）
- 自动计算的预算不符合需求
- 需要为不同 Agent 设置不同的预算策略

### Q3: Provider 配置和 Agent 配置哪个优先级更高？

**A**: Agent 配置优先级更高。如果 Agent 配置了 `max_completion_tokens` 或 `max_context_tokens`，会覆盖 Provider 的配置。

### Q4: 如果都不配置会怎样？

**A**: 系统会使用默认值：
- `max_completion_tokens`: 4096
- `max_context_tokens`: None（触发兜底估算）
- 上下文预算: `4096 × 3 = 12288` tokens（ReAct Agent）
