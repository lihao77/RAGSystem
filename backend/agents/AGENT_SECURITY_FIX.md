# Agent 工具权限安全修复

> **注意**: 本文档记录的是历史修复。文档中提到的 `GenericAgent` 已在后续版本中被移除，系统现在统一使用 `ReActAgent`。

## 修复日期
2026-01-07

## 问题描述

### 严重性：🔴 高危（P0）

发现智能体可以调用未授权的工具，绕过配置文件中的 `enabled_tools` 限制。

### 问题现象

用户配置的 `emergency_plan_agent` 只启用了 `query_emergency_plan` 工具：

```yaml
emergency_plan_agent:
  tools:
    enabled_tools:
      - query_emergency_plan
```

但该智能体实际能调用 `query_knowledge_graph_with_nl` 工具：

```
INFO:agents.agent_loader:emergency_plan_agent 已根据配置过滤工具，启用: ['query_emergency_plan']
...
INFO:Agent.emergency_plan_agent:[ReAct] 执行工具: query_knowledge_graph_with_nl
```

### 根本原因分析

发现了**两个独立的安全漏洞**：

#### 漏洞 1：缺少运行时权限验证（严重）

**文件**: `backend/agents/react_agent.py:304` 和 `backend/agents/generic_agent.py:218`

**问题**:
- `AgentLoader` 在初始化时正确过滤了 `available_tools`
- 但智能体执行工具时，直接调用全局函数 `execute_tool(tool_name, arguments)`
- `execute_tool` 函数**没有权限检查**，可以执行任何工具

**代码流程**:
```python
# agent_loader.py:262-268 - 配置过滤（有效）
if agent_config.tools.enabled_tools:
    filtered_tools = [
        tool for tool in all_tools
        if tool['function']['name'] in enabled_tools
    ]

# react_agent.py:304 - 执行时无权限检查（漏洞）
result = execute_tool(tool_name, arguments)  # ❌ 可以执行任何工具！
```

#### 漏洞 2：系统提示词泄露未授权工具（中等）

**文件**: `backend/agents/react_agent.py:165-180`

**问题**:
- 系统提示词中硬编码了工具使用示例
- 示例中使用了 `query_knowledge_graph_with_nl` 工具
- LLM 从示例中学习到了这个工具，即使不在 `available_tools` 中

**硬编码示例**（旧代码）:
```python
**并行调用示例**：
```json
{
  "thought": "需要查询南宁和桂林两个城市的洪涝灾害数据...",
  "actions": [
    {
      "tool": "query_knowledge_graph_with_nl",  # ❌ 硬编码特定工具
      "arguments": {"question": "南宁市的洪涝灾害历史"}
    }
  ]
}
```

### 影响范围

- **ReActAgent**: 所有使用 ReAct 模式的智能体（qa_agent, emergency_plan_agent 等）
- **GenericAgent**: 所有使用通用模式的智能体
- **严重性**: 配置的工具权限完全失效，智能体可以访问所有工具

---

## 修复方案

### 修复 1：添加运行时权限验证

#### 修复位置 1: `backend/agents/react_agent.py:291-317`

**修改前**:
```python
for idx, action in enumerate(actions, 1):
    tool_name = action.get('tool')
    arguments = action.get('arguments', {})

    if not tool_name:
        continue

    # 直接执行，无权限检查
    result = execute_tool(tool_name, arguments)
```

**修改后**:
```python
for idx, action in enumerate(actions, 1):
    tool_name = action.get('tool')
    arguments = action.get('arguments', {})

    if not tool_name:
        continue

    # 🔒 安全检查：验证工具权限
    allowed_tool_names = [
        tool['function']['name']
        for tool in self.available_tools
    ]
    if tool_name not in allowed_tool_names:
        error_msg = f"权限拒绝：智能体 '{self.name}' 不允许使用工具 '{tool_name}'。允许的工具: {allowed_tool_names}"
        self.logger.warning(f"[ReAct] {error_msg}")

        # 返回权限错误
        result = {
            "success": False,
            "error": error_msg
        }

        # yield 工具错误事件
        yield {
            "type": "tool_error",
            "tool_name": tool_name,
            "error": error_msg,
            "index": idx,
            "total": len(actions)
        }

        # 添加到观察结果
        observations.append(f"**工具 {idx}: {tool_name}**\n错误: {error_msg}")
        continue

    # 权限验证通过，执行工具
    result = execute_tool(tool_name, arguments)
```

#### 修复位置 2: `backend/agents/generic_agent.py:206-233`

**修改前**:
```python
for tool_call in response.tool_calls:
    tool_name = tool_call.get('function', {}).get('name')
    tool_args = tool_call.get('function', {}).get('arguments', {})

    # 直接执行，无权限检查
    result = execute_tool(tool_name, tool_args)
```

**修改后**:
```python
# 🔒 安全检查：预先构建允许的工具列表
allowed_tool_names = [
    tool['function']['name']
    for tool in self.tools
]

for tool_call in response.tool_calls:
    tool_name = tool_call.get('function', {}).get('name')
    tool_args = tool_call.get('function', {}).get('arguments', {})

    # 🔒 安全检查：验证工具权限
    if tool_name not in allowed_tool_names:
        error_msg = f"权限拒绝：智能体 '{self.name}' 不允许使用工具 '{tool_name}'。允许的工具: {allowed_tool_names}"
        self.logger.warning(error_msg)
        result = {
            "success": False,
            "error": error_msg
        }
    else:
        self.logger.info(f"执行工具: {tool_name}, 参数: {tool_args}")
        result = execute_tool(tool_name, tool_args)
```

### 修复 2：动态生成工具示例

#### 修复位置: `backend/agents/react_agent.py:127-150`

**修改前**（硬编码示例）:
```python
**并行调用示例**：
```json
{
  "actions": [
    {
      "tool": "query_knowledge_graph_with_nl",  # ❌ 硬编码
      "arguments": {"question": "南宁市的洪涝灾害历史"}
    }
  ]
}
```

**修改后**（动态生成）:
```python
# 🔒 动态生成示例：使用当前智能体可用的工具
# 避免硬编码工具名称，防止 LLM 学习到未授权的工具
example_tool_name = self.available_tools[0]['function']['name'] if self.available_tools else "tool_name"
example_params = self.available_tools[0]['function'].get('parameters', {}).get('properties', {})

# 构造示例参数（取第一个参数作为示例）
if example_params:
    first_param = list(example_params.keys())[0]
    example_arg = {first_param: "示例值"}
else:
    example_arg = {}

parallel_example = f"""```json
{{
  "thought": "分析任务需求，如果需要执行多个独立操作，可以并行调用工具",
  "actions": [
    {{
      "tool": "{example_tool_name}",  # ✅ 使用当前智能体可用的工具
      "arguments": {example_arg}
    }}
  ],
  "final_answer": null
}}
```"""
```

### 修复 3：增强提示词安全性

在 `react_agent.py:180` 添加明确的权限限制规则：

```python
**重要规则：**
1. **只能使用上面"可用工具"部分列出的工具**，不要使用其他工具  # ✅ 新增
2. **可以一次执行多个独立的工具调用**（actions 是数组）
   ...
```

---

## 测试验证

### 测试场景 1：emergency_plan_agent 尝试调用未授权工具

**配置**:
```yaml
emergency_plan_agent:
  tools:
    enabled_tools:
      - query_emergency_plan
```

**预期行为**（修复后）:
```
INFO:Agent.emergency_plan_agent:[ReAct] 执行工具: query_knowledge_graph_with_nl
WARNING:Agent.emergency_plan_agent:[ReAct] 权限拒绝：智能体 'emergency_plan_agent' 不允许使用工具 'query_knowledge_graph_with_nl'。允许的工具: ['query_emergency_plan']
```

智能体会收到权限错误，并在下一轮推理中调整策略。

### 测试场景 2：qa_agent 使用授权工具

**配置**:
```yaml
qa_agent:
  tools:
    enabled_tools:
      - query_knowledge_graph_with_nl
      - search_knowledge_graph
```

**预期行为**:
```
INFO:Agent.qa_agent:[ReAct] 执行工具: query_knowledge_graph_with_nl
INFO:tools.tool_executor:执行自然语言查询...
✅ 工具执行成功
```

授权工具正常执行。

---

## 安全影响

### 修复前（严重漏洞）

- ❌ 工具权限配置完全失效
- ❌ 任何智能体可以调用任何工具
- ❌ LLM 从硬编码示例中学习未授权工具
- ❌ 配置文件中的 `enabled_tools` 只影响系统提示词，不影响实际执行

### 修复后（安全加固）

- ✅ 运行时强制验证工具权限
- ✅ 未授权工具调用返回明确错误
- ✅ 系统提示词只包含授权工具信息
- ✅ 配置文件的 `enabled_tools` 真正生效

---

## 相关文件

### 修改的文件
- `backend/agents/react_agent.py` - 添加权限验证、动态示例
- `backend/agents/generic_agent.py` - 添加权限验证

### 相关文件（未修改）
- `backend/agents/agent_loader.py` - 工具过滤逻辑（已正确）
- `backend/tools/tool_executor.py` - 工具执行函数（仍无权限检查，由调用者负责）
- `backend/agents/configs/agent_configs.plugin_example.yaml` - 配置示例

---

## 向后兼容性

✅ **完全兼容** - 此修复只加强了安全性，不改变正常工作流程：

1. **已授权的工具调用**: 继续正常工作
2. **配置文件**: 无需修改
3. **API 接口**: 无变化
4. **智能体行为**: 对于正确配置的智能体，行为不变

---

## 后续建议

### 短期（建议）

1. **审计现有智能体配置**
   - 检查所有智能体的 `enabled_tools` 是否符合预期
   - 移除不必要的工具权限（最小权限原则）

2. **监控权限错误**
   - 在日志中搜索 "权限拒绝" 关键词
   - 分析是否有智能体频繁尝试调用未授权工具

### 长期（可选）

1. **工具权限审计日志**
   - 记录所有工具调用和权限检查
   - 便于安全审计和问题排查

2. **配置验证**
   - 在启动时验证配置的 `enabled_tools` 中的工具是否存在
   - 警告配置了不存在的工具

3. **权限分级**
   - 考虑将工具分为"安全级别"（只读 vs 写入）
   - 在配置中增加更细粒度的权限控制

---

## 总结

本次修复解决了一个**严重的安全漏洞**，该漏洞允许智能体绕过配置文件限制，调用任意工具。

**关键改进**:
1. ✅ 运行时权限验证
2. ✅ 动态生成工具示例
3. ✅ 明确的权限限制提示

**影响**:
- 修复了配置工具权限完全失效的问题
- 提高了系统安全性和可控性
- 保持了完全的向后兼容性

**测试状态**: ⏳ 需要测试
- [ ] 测试 emergency_plan_agent 只能调用 query_emergency_plan
- [ ] 测试 qa_agent 可以调用配置的多个工具
- [ ] 测试权限错误后智能体的恢复行为
