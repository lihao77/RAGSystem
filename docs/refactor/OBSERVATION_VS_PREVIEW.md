# Observation vs Preview：两个不同的视角

## 问题

为什么前端看到的 `preview` 不是发还给 agent 的 `observation`？

## 答案

**它们服务于不同的目标受众**：
- `observation`：给 **Agent（LLM）** 看的，用于 ReAct 推理
- `preview`：给 **用户（前端）** 看的，用于 UI 展示

---

## 详细对比

### 1. Observation（给 Agent 看）

**生成位置**：`agents/core/base.py::_format_tool_observation()`

**生成流程**：
```python
observation = self._format_tool_observation(
    result,
    tool_name=tool_name,
    session_id=current_session_id,
    is_skills_tool=is_skills_tool,
)
```

**处理链路**：
```
ToolExecutionResult
  → ObservationPolicy.decide() → ObservationDecision(mode="inline" | "artifact_ref")
  → ObservationFormatter (inline / large_payload / error / ...)
  → 格式化后的文本（Markdown 格式）
```

**特点**：
- 📝 **Markdown 格式**，适合 LLM 理解
- 🎯 **上下文优化**：根据预算决定 inline 还是 artifact_ref
- 📊 **结构化信息**：包含数据结构预览、样本、提示
- 💡 **指导性**：告诉 Agent 如何使用结果（如"后续工具可直接使用此文件路径"）

**示例**（大结果落盘）：
```markdown
✅ 数据查询成功

📁 数据已存储: /path/to/data_abc123.json
📊 List: 1000 条记录 | 字段: id, name, value 等 10 个字段
💡 后续工具可直接使用此文件路径作为 data 参数；需要处理数据时用 execute_code 读取此文件
📝 样本: [{"id": 1, "name": "test", ...}]
🔍 数据结构:
```json
{
  "type": "array",
  "length": 1000,
  "sample": [...]
}
```
```

---

### 2. Preview（给用户看）

**生成位置**：`tools/refs/result_references.py::result_display_text()`

**生成流程**：
```python
preview_text = result_display_text(result)
```

**处理链路**：
```
ToolExecutionResult
  → result_display_text()
    → result_primary_text() 或 result_summary()
  → 简短文本
```

**特点**：
- 📱 **简洁**：适合前端 UI 展示
- ✅ **状态优先**：成功/失败一目了然
- 📄 **摘要性**：只显示关键信息
- 🎨 **无格式**：纯文本，前端自行渲染

**示例**（同样的大结果）：
```
数据查询成功，返回 1000 条记录
```

---

### 3. 事件结构对比

**发送给前端的事件**（`publisher.tool_call_end()`）：
```python
{
    "tool_name": "read_file",
    "success": true,
    "result": "[read_file]\n✅ 文件读取成功\n📄 原始文件: demo.txt\n...",  // observation（给 Agent）
    "result_preview": "文件读取成功，共 500 行",                          // preview（给用户）
    "raw_result": {...},                                                  // 原始结果（调试用）
    "raw_result_ref": {...},                                              // 结果引用
    "execution_time": 0.5,
    "approval_message": ""
}
```

**发送给 Agent 的 prompt**：
```
<observation>
[read_file]
✅ 文件读取成功

📄 原始文件: demo.txt
📍 当前片段: 行 1-100
💡 如需后续内容，请继续调用 read_file(file_path='demo.txt', offset=100)
📝 预览: 第一行内容...
</observation>
```

---

## 为什么要分开？

### 1. **受众不同**

| 维度 | Agent（LLM） | 用户（前端） |
|------|-------------|-------------|
| 目标 | 推理和决策 | 了解进度 |
| 需求 | 详细上下文 | 简洁摘要 |
| 格式 | Markdown | 纯文本 |
| 长度 | 可长（有预算控制） | 必须短 |

### 2. **上下文预算管理**

Agent 需要根据上下文预算决定：
- **inline**：直接注入完整内容（小结果）
- **artifact_ref**：落盘后只注入引用+预览（大结果）

用户不需要这种复杂性，只需要知道"成功了，返回了什么"。

### 3. **指导性 vs 信息性**

**Observation（指导性）**：
```markdown
💡 后续工具可直接使用此文件路径作为 data 参数
💡 如需后续内容，请继续调用 read_file(file_path='demo.txt', offset=100)
```

**Preview（信息性）**：
```
文件读取成功，共 500 行
```

---

## 代码位置

### Observation 生成

```python
# agents/core/base.py::_handle_actions()
observation = self._format_tool_observation(
    result,
    tool_name=tool_name,
    session_id=current_session_id,
    is_skills_tool=is_skills_tool,
)

# agents/core/base.py::_format_tool_observation()
decision = self.observation_policy.decide(result, is_skills_tool=is_skills_tool)
return self.prompt_materializer.materialize_tool_observation(
    result=result,
    tool_name=tool_name,
    decision=decision,
    session_id=session_id,
)
```

### Preview 生成

```python
# agents/core/base.py::_handle_actions()
preview_text = result_display_text(result)

# tools/refs/result_references.py::result_display_text()
def result_display_text(result: Any) -> str:
    if not result_success(result):
        return result_error_message(result)
    primary_text = result_primary_text(result)
    if primary_text:
        return primary_text
    return result_summary(result)
```

### 事件发布

```python
# agents/core/base.py::_handle_actions()
publisher.tool_call_end(
    call_id=tool_call_id,
    tool_name=tool_name,
    result=f"[{tool_name}]\n{observation}",      # 给 Agent 的
    result_preview=preview_text,                  # 给用户的
    raw_result=result_event_payload(result),      # 原始数据
    ...
)
```

---

## 前端如何使用

**前端代码**（`frontend-client/src/utils/executionProjector.js`）：

```javascript
// 执行树节点
{
  tool_name: step.tool_name,
  result_preview: step.result_preview,  // 显示在 UI 上
  success: step.success,
  execution_time: step.execution_time,
  ...
}
```

**前端不需要 observation**，因为：
1. observation 是给 Agent 推理用的，不是给用户看的
2. observation 可能很长（包含数据结构、样本、指导信息）
3. 用户只需要知道"成功了，返回了什么"

---

## 总结

| 字段 | 目标受众 | 用途 | 格式 | 长度 | 生成位置 |
|------|---------|------|------|------|---------|
| `observation` | Agent（LLM） | ReAct 推理 | Markdown | 可长 | `_format_tool_observation()` |
| `result_preview` | 用户（前端） | UI 展示 | 纯文本 | 简短 | `result_display_text()` |
| `raw_result` | 调试/回读 | 原始数据 | JSON | 完整 | `result_event_payload()` |

**核心设计理念**：
- **Observation**：为 Agent 优化，包含上下文管理、指导信息、结构化预览
- **Preview**：为用户优化，简洁、清晰、一目了然
- **分离关注点**：不同受众有不同需求，不应混为一谈

---

**最后更新**：2026-04-01
