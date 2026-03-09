# Master Agent 智能上下文管理配置指南

## 概述

Master Agent V2 已经默认启用了**智能上下文管理**，无需额外配置即可使用！

## 已启用的智能压缩配置

### Master Agent V2（默认启用）

**位置：** `backend/agents/config/loader.py` → `_load_system_master_agent_v2()`

**默认配置：**
```python
'compression_strategy': 'smart',         # 智能压缩策略
'preserve_tool_results': True,           # 保留所有 Agent 调用结果
'preserve_recent_turns': 3,              # 保留最近 3 轮对话
'importance_threshold': 0.5,             # 重要性阈值 0.5
'max_context_tokens': 10000,             # 上下文预算 10000 tokens
```

**特点：**
- ✅ **自动保留 Agent 调用结果**：Master V2 不会忘记之前调用的 Agent 返回的数据
- ✅ **智能选择消息**：丢弃低重要性的闲聊，保留关键对话
- ✅ **更大的上下文预算**：从原来的 2400 tokens 提升到 10000 tokens
- ✅ **适合长推理链**：Master V2 的多轮编排不会因为上下文限制而丢失信息

### Master Agent V1（不需要）

Master V1 主要负责任务分解和编排，**不使用 ContextManager**，因此不需要智能压缩。

---

## 如何调整配置

如果您想调整 Master V2 的智能压缩参数，需要修改源代码：

### 步骤 1：编辑配置文件

打开 `backend/agents/config/loader.py`，找到 `_load_system_master_agent_v2()` 方法：

```python
custom_params={
    'type': 'master_v2',
    'behavior': {
        # ... 其他配置 ...

        # 🎯 在这里调整智能压缩参数
        'compression_strategy': 'smart',         # 可选: 'smart', 'sliding_window', 'summarize'
        'preserve_tool_results': True,           # 建议保持 True
        'preserve_recent_turns': 3,              # 可调整: 1-8 轮
        'importance_threshold': 0.5,             # 可调整: 0.3-0.8
        'max_context_tokens': 10000,             # 可调整: 5000-20000

        # ...
    }
}
```

### 步骤 2：重启后端

```bash
cd D:\python\RAGSystem\backend
python app.py
```

### 步骤 3：验证配置

查看后端日志，确认智能压缩已启用：

```
[INFO] MasterAgentV2 初始化完成，模型 max_tokens: 4096, 上下文预算: 10000 tokens
[INFO] ContextManager - 应用 smart 压缩策略
[INFO] ContextManager - 智能压缩完成: 20 -> 12 条消息 (保留率: 60.0%)
```

---

## 配置参数说明

### compression_strategy（压缩策略）

| 值 | 说明 | 适用场景 |
|----|------|---------|
| `'smart'` | 智能压缩（推荐） | Master V2 多轮编排 |
| `'sliding_window'` | 滑动窗口 | 简单任务，对话较短 |
| `'summarize'` | LLM 摘要（未实现） | 未来功能 |

### preserve_recent_turns（保留最近 N 轮）

- **推荐值：** 2-3 轮
- **最小值：** 1 轮（只保留最后一轮对话，可能导致上下文不连贯）
- **最大值：** 8 轮（保留过多，可能无法有效压缩）

**Master V2 特点：** 推理链较短（通常 2-5 轮），保留 2-3 轮足够

### preserve_tool_results（保留工具结果）

- **推荐值：** `True`（强烈推荐）
- **说明：** 启用后，所有 Agent 调用结果（包含数据查询、图表生成等）都会被保留

**警告：** 如果设置为 `False`，Master V2 可能会忘记之前 Agent 返回的数据！

### importance_threshold（重要性阈值）

- **推荐值：** 0.5（中等）
- **较高值（0.6-0.8）：** 更激进的压缩，只保留最重要的消息
- **较低值（0.3-0.4）：** 更保守的压缩，保留更多消息

**说明：** 消息重要性评分范围是 0-1，只有评分 ≥ 阈值的消息才会被保留（最近对话和工具结果除外）

### max_context_tokens（上下文预算）

- **推荐值：** 10000 tokens（Master V2）
- **说明：** 这是为上下文管理预留的 token 数量
  - 系统提示词、输出、开销会占用额外的 tokens
  - 实际可用于模型的 tokens = LLM max_tokens * 0.6

**计算公式：**
```
max_context_tokens = llm_max_tokens * 0.6
```

**示例：**
- `llm_max_tokens = 4096` → `max_context_tokens ≈ 2400`
- `llm_max_tokens = 8192` → `max_context_tokens ≈ 5000`

---

## 实际效果

### 测试场景：Master V2 执行 3 个 Agent 调用

**输入任务：**
```
1. 查询广西南宁2016-2020年洪涝灾害数据
2. 基于{result_1}生成可视化图表
3. 分析趋势并生成报告
```

**压缩效果：**

| 项目 | 滑动窗口 | 智能压缩 |
|------|---------|---------|
| 原始消息数 | 25 条 | 25 条 |
| 压缩后消息数 | 10 条 | 16 条 |
| Token 使用 | 5000 | 7500 |
| **保留 Agent 结果** | ⚠️ 第1步结果可能丢失 | ✅ 全部保留 |
| **对话连贯性** | ⚠️ 中断较多 | ✅ 保持良好 |

**关键差异：**
- **滑动窗口：** 第3步执行时，第1步的数据查询结果已被丢弃，Master V2 无法访问
- **智能压缩：** 第1步的数据查询结果被保留，第3步可以正常引用

---

## 故障排查

### 问题 1：Master V2 忘记了之前 Agent 的结果

**症状：**
```
第1步：查询数据成功，返回 500 条记录
第2步：尝试引用{result_1}，但 LLM 说"没有可用数据"
```

**原因：** 上下文被压缩时丢失了第1步的结果

**解决方案：**
1. 确认 `preserve_tool_results = True`
2. 增大 `max_context_tokens`（如 15000）
3. 降低 `importance_threshold`（如 0.4）

### 问题 2：仍然超出上下文限制

**症状：**
```
[WARNING] ContextManager - 智能压缩后仍超标（12000 tokens），对工具结果进行摘要
```

**原因：** 数据量太大（如查询返回 1000+ 条记录）

**解决方案：**
1. **最佳方案：** ObservationFormatter 会自动将大数据保存为文件，后续 Agent 通过文件路径访问
2. 增大 `max_context_tokens` 到 15000-20000
3. 减少 `preserve_recent_turns` 到 2 轮

### 问题 3：对话不连贯

**症状：**
```
用户：之前你说要查询数据
Master V2：我不记得之前说了什么
```

**原因：** `preserve_recent_turns` 设置过小

**解决方案：**
1. 增加 `preserve_recent_turns` 到 4-5 轮
2. 降低 `importance_threshold` 到 0.4

---

## 监控和调试

### 启用调试日志

在 `backend/agents/context_manager.py` 中添加：

```python
# 在 _calculate_message_importance 方法中
self.logger.debug(f"消息 {index} 重要性评分: {total_score:.2f}")
```

### 查看实时压缩效果

后端日志会显示：

```
[INFO] ContextManager - 上下文过长（估算 15000 tokens，20 条消息），应用 smart 压缩策略
[INFO] ContextManager - 智能压缩完成: 20 -> 12 条消息 (保留率: 60.0%)
[INFO] ContextManager - 上下文管理完成: 20 -> 13 条消息, 估算 6800 tokens
```

---

## 总结

✅ **Master Agent V2 已默认启用智能压缩**，无需额外配置

✅ **关键特性：**
- 自动保留所有 Agent 调用结果
- 智能选择重要消息
- 更大的上下文预算（10000 tokens）

✅ **推荐配置（已内置）：**
```python
compression_strategy='smart'
preserve_tool_results=True
preserve_recent_turns=3
importance_threshold=0.5
max_context_tokens=10000
```

✅ **适用场景：** Master V2 多轮编排、数据分析任务、长推理链

---

**相关文档：**
- 完整文档：[SMART_CONTEXT_MANAGEMENT.md](SMART_CONTEXT_MANAGEMENT.md)（本目录）
- 测试脚本：`backend/test_smart_context.py`
- 实现代码：`backend/agents/context_manager.py`
