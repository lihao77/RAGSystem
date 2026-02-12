# 智能上下文管理 (Smart Context Management)

## 概述

智能上下文管理是对传统滑动窗口策略的升级，通过**消息重要性评分**和**选择性保留**，确保关键信息（如工具调用结果）不会因为上下文限制而丢失。

## 核心特性

### 1. 消息重要性评分系统

每条消息根据以下标准计算重要性评分（0-1）：

| 评分维度 | 权重 | 说明 |
|---------|------|------|
| **位置权重** | 0.2-0.5 | 越靠后（越新）的消息评分越高 |
| **内容权重** | 0-0.5 | 包含工具结果、错误信息、思考过程的消息评分更高 |
| **长度权重** | 0-0.2 | 内容较长的消息可能包含更多信息 |

**高重要性标志**（+0.4分）：
- ✅ 📊 📁 - Emoji 标志
- "Agent 执行结果"
- "数据已存储"
- "tool_name"

**错误/警告标志**（+0.3分）：
- ❌ "错误" "Error" "失败"

**思考过程标志**（+0.2分）：
- "思考" "thought" "分析" "决策"

### 2. 选择性保留策略

智能压缩按以下优先级保留消息：

```
优先级 1（必须保留）：
  ├─ 最近 N 轮对话（默认 3 轮 = 6 条消息）
  └─ 包含工具调用结果的消息

优先级 2（可选保留）：
  └─ 重要性评分 ≥ 阈值（默认 0.5）的消息

优先级 3（丢弃）：
  └─ 低重要性的纯文本对话
```

### 3. 二级压缩：工具结果摘要

如果智能压缩后仍超出 token 限制，会对工具结果进行进一步摘要：

- 保留：✅ 成功提示、📊 元数据、📁 文件引用
- 删除：详细的 JSON 数据块
- 添加：`[详细数据已省略，可通过文件路径访问]` 提示

## 配置选项

### ContextConfig 参数

```python
from agents.context_manager import ContextManager, ContextConfig

config = ContextConfig(
    # 基础配置
    max_history_turns=10,           # 最大保留轮数（用于计算 token 限制）
    max_tokens=8000,                # 最大 token 数（估算值）
    keep_system_prompt=True,        # 始终保留 system prompt

    # 压缩策略选择
    compression_strategy="smart",   # "sliding_window" | "smart" | "summarize"

    # 智能压缩配置
    preserve_tool_results=True,     # 是否保留工具调用结果
    preserve_recent_turns=3,        # 始终保留最近 N 轮对话
    importance_threshold=0.5        # 重要性阈值（0-1），高于此值的消息会被保留
)

context_manager = ContextManager(config)
```

### 配置推荐

**场景 1：数据分析任务**（重视工具结果）
```python
config = ContextConfig(
    max_tokens=10000,
    compression_strategy="smart",
    preserve_tool_results=True,      # ✅ 保留所有数据查询结果
    preserve_recent_turns=2,
    importance_threshold=0.6         # 较高阈值，只保留关键对话
)
```

**场景 2：对话式问答**（重视对话连贯性）
```python
config = ContextConfig(
    max_tokens=8000,
    compression_strategy="smart",
    preserve_tool_results=True,
    preserve_recent_turns=5,         # ✅ 保留更多最近对话
    importance_threshold=0.4         # 较低阈值，保留更多对话
)
```

**场景 3：长推理链任务**（Master V2 多轮调用）
```python
config = ContextConfig(
    max_tokens=12000,                # ✅ 更大的 token 预算
    compression_strategy="smart",
    preserve_tool_results=True,      # ✅ 保留所有 Agent 调用结果
    preserve_recent_turns=2,
    importance_threshold=0.5
)
```

## 在 Agent 中启用

### 方法 1：通过 AgentConfig 配置（推荐）

编辑 `backend/agents/configs/agent_configs.yaml`：

```yaml
agents:
  qa_agent:
    agent_name: qa_agent
    display_name: 知识图谱问答智能体
    enabled: true
    llm:
      provider: deepseek
      model_name: deepseek-chat
      temperature: 0.2
      max_tokens: 4096
    tools:
      enabled_tools:
        - query_knowledge_graph_with_nl
    custom_params:
      type: react
      behavior:
        system_prompt: "你是一个知识图谱问答助手..."
        max_rounds: 10

        # 🎯 智能上下文管理配置
        compression_strategy: smart          # 启用智能压缩
        preserve_recent_turns: 3             # 保留最近 3 轮
        importance_threshold: 0.5            # 重要性阈值
        max_context_tokens: 8000             # 上下文 token 预算
```

### 方法 2：代码中直接配置

```python
from agents.context_manager import ContextManager, ContextConfig

# 创建智能上下文管理器
context_config = ContextConfig(
    max_tokens=8000,
    compression_strategy="smart",
    preserve_tool_results=True,
    preserve_recent_turns=3,
    importance_threshold=0.5
)

context_manager = ContextManager(context_config)

# 在 Agent 初始化时使用
class MyAgent(BaseAgent):
    def __init__(self, ...):
        super().__init__(...)
        self.context_manager = context_manager
```

## 实际效果示例

### 压缩前（20 条消息，估算 15000 tokens）

```
1. [user] 查询广西南宁2016-2020年洪涝灾害数据
2. [assistant] {"thought": "需要调用知识图谱查询工具...", ...}
3. [user] Agent 执行结果：✅ 查询成功，返回 500 条记录...（详细 JSON 数据）
4. [assistant] {"thought": "分析数据，发现趋势...", ...}
5. [user] 你觉得这个数据怎么样？（闲聊）
6. [assistant] 这个数据很详细...（闲聊回复）
7. [user] 基于{result_1}生成可视化
8. [assistant] {"thought": "需要调用图表生成工具...", ...}
9. [user] Agent 执行结果：✅ 图表生成成功，ECharts 配置...
... (更多消息)
```

### 智能压缩后（12 条消息，估算 6500 tokens）

```
[智能压缩：已省略 8 条低重要性消息，保留了工具调用结果和关键对话]

1. [user] Agent 执行结果：✅ 查询成功，返回 500 条记录
   📊 数据已存储: data_abc123.json
   💡 [详细数据已省略，可通过文件路径访问]

3. [user] 基于{result_1}生成可视化
4. [assistant] {"thought": "需要调用图表生成工具...", ...}
5. [user] Agent 执行结果：✅ 图表生成成功
   📊 图表类型: 折线图
   📁 ECharts 配置: {...}

... (保留最近 3 轮对话)
```

**压缩效果：**
- 消息数量：20 → 12（保留率 60%）
- Token 估算：15000 → 6500（减少 57%）
- 关键信息：100% 保留（所有工具结果、文件引用、最近对话）

## 性能对比

| 策略 | 消息保留率 | Token 使用 | 关键信息保留 | 对话连贯性 |
|------|-----------|-----------|-------------|-----------|
| **滑动窗口** | 50% | 低 | ⚠️ 可能丢失 | ✅ 好 |
| **智能压缩** | 60-80% | 中 | ✅ 100% 保留 | ✅ 好 |
| **无压缩** | 100% | 高 | ✅ 100% 保留 | ✅ 最好 |

## 日志输出示例

启用智能压缩后，后端日志会显示：

```
[INFO] ContextManager - 上下文过长（估算 15000 tokens，20 条消息），应用 smart 压缩策略
[INFO] ContextManager - 智能压缩完成: 20 -> 12 条消息 (保留率: 60.0%)
[INFO] ContextManager - 上下文管理完成: 20 -> 13 条消息, 估算 6800 tokens
```

## 调试和监控

### 查看消息重要性评分

添加调试代码：

```python
# 在 _calculate_message_importance 方法中添加日志
self.logger.debug(f"消息 {index} 重要性评分: {total_score:.2f} "
                  f"(位置:{position_score:.2f} + 内容:{content_score:.2f} + 长度:{length_score:.2f})")
```

### 查看保留/丢弃的消息

```python
# 在 _apply_smart_compression 方法中添加
for item in scored_messages:
    if item not in kept_items:
        self.logger.debug(f"丢弃消息 {item['index']}: 重要性 {item['importance']:.2f}")
```

## 最佳实践

### ✅ 推荐做法

1. **数据密集型任务**：使用 `smart` 策略 + `preserve_tool_results=True`
2. **长对话场景**：增加 `preserve_recent_turns` 到 5-8 轮
3. **Token 预算充足**：调高 `max_tokens` 到 10000-15000
4. **需要完整历史**：使用 `compression_strategy="sliding_window"` 或增大 `max_history_turns`

### ❌ 避免的陷阱

1. **阈值过高**（如 0.8）：可能导致过度压缩，丢失有用信息
2. **阈值过低**（如 0.2）：失去压缩效果，仍然超出 token 限制
3. **禁用工具结果保留**：Master V2 会忘记之前 Agent 的发现
4. **Token 预算过小**（如 2000）：频繁触发二级摘要，信息损失大

## 未来优化方向

- [ ] 使用 LLM 生成摘要（`summarize` 策略）
- [ ] 向量相似度检测（合并重复/相似消息）
- [ ] 用户反馈学习（动态调整重要性评分）
- [ ] 分层压缩（对不同类型消息使用不同策略）

---

**文档版本**: v1.0
**更新日期**: 2026-02-02
**相关文件**: `backend/agents/context_manager.py`
