# MasterAgent 互相调用问题修复

## 🐛 问题描述

### 现象
用户使用 V1 的 `master_agent` 时，LLM 将任务识别给了 `master_agent_v2`，导致出现**两个 master 协调者**的情况。

### 用户反馈
```
"我在使用v1的master，结果他识别到了v2，还想调用它，这是不对的，这样子就存在两个master了"
```

### LLM 的错误推理
```
该任务包含两个核心且不同类型的操作：
1) 从知识图谱中查询特定年份（2020年）和地区（广西各市）的结构化数据（受灾人口）
2) 将查询到的数据进行可视化呈现

这需要分别调用擅长数据查询的智能体和擅长图表生成的智能体。
master_agent_v2 可以协调这两个专业智能体的并行或顺序执行。
```

---

## 🔍 根本原因

### 代码分析

**文件**: `backend/agents/master_agent.py`
**位置**: line 621-627

```python
# 获取可用智能体信息
agents = self.orchestrator.list_agents()
agents_info = "\n".join([
    f"- {agent['name']}: {agent['description']}"
    for agent in agents
    if agent['name'] != 'master_agent'  # ❌ 只排除了自己
])
```

**问题**：
1. V1 的 `MasterAgent` 在任务分析时，会列出所有注册的智能体
2. 过滤条件只排除了 `master_agent`（自己）
3. 但没有排除 `master_agent_v2`
4. 导致 LLM 可以选择 `master_agent_v2` 作为子智能体

### 为什么会有两个 Master？

系统中存在两个 Master 智能体：

1. **MasterAgent (V1)** - `backend/agents/master_agent.py`
   - 传统的主协调智能体
   - 支持 simple/medium/complex 三种模式
   - 使用 `complexity` 字段

2. **MasterAgentV2** - `backend/agents/master_agent_v2/master_agent_v2.py`
   - 增强版主协调智能体
   - 支持 DAG 并行执行
   - 使用 `mode` 字段（simple/sequential/parallel/dag）
   - 包含执行计划可视化、增强上下文管理等功能

**设计意图**：两个 Master 应该是**互斥**的，用户选择使用 V1 或 V2，而不是让一个 Master 调用另一个 Master。

---

## ✅ 修复方案

### 核心思路
Master 智能体在选择子智能体时，应该**排除所有 Master 类型的智能体**（包括自己和其他版本）。

### 实现方式
使用 `startswith('master_agent')` 匹配所有以 `master_agent` 开头的智能体名称。

---

## 📝 具体修改

### 修改 1: MasterAgent (V1)

**文件**: `backend/agents/master_agent.py`
**位置**: line 621-627

**修改前**:
```python
agents_info = "\n".join([
    f"- {agent['name']}: {agent['description']}"
    for agent in agents
    if agent['name'] != 'master_agent'  # ❌ 只排除自己
])
```

**修改后**:
```python
agents_info = "\n".join([
    f"- {agent['name']}: {agent['description']}"
    for agent in agents
    if not agent['name'].startswith('master_agent')  # ✅ 排除所有 master 类型智能体
])
```

**效果**:
- 排除 `master_agent`（自己）
- 排除 `master_agent_v2`
- 排除任何未来可能添加的 `master_agent_xxx`

---

### 修改 2: MasterAgentV2

**文件**: `backend/agents/master_agent_v2/master_agent_v2.py`
**位置**: line 417-422

**修改前**:
```python
agents_info = "\n".join([
    f"- {agent['name']}: {agent['description']}"
    for agent in agents
    if agent['name'] not in ['master_agent', 'master_agent_v2']  # ❌ 硬编码列表
])
```

**修改后**:
```python
agents_info = "\n".join([
    f"- {agent['name']}: {agent['description']}"
    for agent in agents
    if not agent['name'].startswith('master_agent')  # ✅ 排除所有 master 类型智能体
])
```

**改进**:
- V2 之前已经排除了两个 Master，但使用了硬编码列表
- 改为 `startswith` 后更灵活，适应未来扩展

---

## 🧪 测试验证

### 测试用例 1: V1 Master 不应看到 V2

**场景**: 用户使用 V1 的 `master_agent` 执行任务

**预期行为**:
```python
# V1 的任务分析
{
  "complexity": "complex",
  "needs_multiple_agents": true,
  "subtasks": [
    {"agent": "kgqa_agent", ...},      # ✅ 可以选择
    {"agent": "chart_agent", ...}      # ✅ 可以选择
    # ❌ 不应该出现 "master_agent_v2"
  ]
}
```

### 测试用例 2: V2 Master 不应看到 V1

**场景**: 用户使用 V2 的 `master_agent_v2` 执行任务

**预期行为**:
```python
# V2 的任务分析
{
  "mode": "parallel",
  "subtasks": [
    {"agent_name": "kgqa_agent", ...},  # ✅ 可以选择
    {"agent_name": "chart_agent", ...}  # ✅ 可以选择
    # ❌ 不应该出现 "master_agent"
  ]
}
```

### 验证方法

1. **启动后端**:
   ```bash
   cd backend
   python app.py
   ```

2. **测试 V1**:
   ```bash
   curl -X POST http://localhost:5000/api/agent/execute \
     -H "Content-Type: application/json" \
     -d '{"task": "查询2020年广西各市受灾人口并生成柱状图"}'
   ```

3. **检查日志**:
   - 查找 "可用智能体" 相关日志
   - 确认列表中**不包含** `master_agent_v2`

4. **测试 V2**:
   ```bash
   curl -X POST http://localhost:5000/api/agent/execute \
     -H "Content-Type: application/json" \
     -d '{"task": "查询2020年广西各市受灾人口并生成柱状图", "use_v2": true}'
   ```

5. **检查日志**:
   - 确认列表中**不包含** `master_agent`

---

## 📊 影响范围

### 受影响的功能
- ✅ `MasterAgent` (V1) - 任务分析时不再看到 `master_agent_v2`
- ✅ `MasterAgentV2` - 任务分析时不再看到 `master_agent`

### 不受影响的功能
- ❌ 其他普通智能体（`kgqa_agent`, `chart_agent` 等）
- ❌ 工具调用机制
- ❌ 前端交互

---

## 🎯 设计原则

### 为什么 Master 不应该互相调用？

1. **职责冲突**
   - Master 的职责是**协调子智能体**
   - 如果 Master 调用另一个 Master，会导致职责混乱

2. **无限递归风险**
   - `master_agent` → `master_agent_v2` → `master_agent` → ...
   - 可能导致调用栈溢出

3. **用户意图不明确**
   - 用户选择使用 V1 或 V2，不应该由 LLM 自行决定切换版本

4. **资源浪费**
   - 两个 Master 同时运行会消耗更多 token 和计算资源

### 正确的架构

```
用户请求
   ↓
选择使用 V1 或 V2（由用户或路由层决定）
   ↓
MasterAgent (V1) 或 MasterAgentV2
   ↓
协调子智能体（kgqa_agent, chart_agent 等）
   ↓
返回结果
```

**不应该出现**:
```
MasterAgent (V1)
   ↓
调用 MasterAgentV2  ❌ 错误！
   ↓
协调子智能体
```

---

## 📝 总结

### 修改的文件
1. ✅ `backend/agents/master_agent.py` (line 621-627)
2. ✅ `backend/agents/master_agent_v2/master_agent_v2.py` (line 417-422)

### 核心改动
- 从 `agent['name'] != 'master_agent'` 改为 `not agent['name'].startswith('master_agent')`
- V2 从硬编码列表改为 `startswith` 匹配

### 效果
- ✅ V1 和 V2 互相不可见
- ✅ 避免 Master 互相调用
- ✅ 适应未来的 Master 版本扩展

**重启后端后生效**。
