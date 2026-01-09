# MasterAgent V1 改进说明

## 问题描述

原 MasterAgent V1 在处理有依赖关系的多智能体协作任务时，存在上下文传递不足的问题：

- **问题**：步骤 2 的智能体需要步骤 1 的结果，但原实现只是将结果对象存储在上下文中，后续智能体无法有效利用
- **影响**：导致后续任务无法基于前置任务的结果继续执行，失去了任务链的连贯性

## 解决方案

### 核心改进

在 `_coordinate_multiple_agents` 和 `_stream_coordinate_multiple_agents` 两个方法中增强了依赖结果的传递逻辑：

#### 1. 上下文增强

将前置任务的结果格式化后，直接附加到子任务描述中，确保后续智能体能够清晰理解前置任务的输出：

```python
# 检查依赖并传递前置任务结果
enhanced_subtask_desc = subtask_desc
if depends_on:
    dep_results = [
        subtask_responses.get(dep_order)
        for dep_order in depends_on
        if dep_order in subtask_responses
    ]
    context.set_shared_data('previous_results', dep_results)

    # 在子任务描述中增强上下文，明确包含前置任务的结果
    if dep_results:
        dep_context = "\n\n【前置任务结果】\n"
        for dep in dep_results:
            dep_context += f"- 任务: {dep.get('description', '未知')}\n"
            if dep.get('success'):
                # 截取合理长度的结果内容
                dep_content = dep.get('content', '')
                if len(dep_content) > 1000:
                    dep_content = dep_content[:1000] + "...(内容过长，已截断)"
                dep_context += f"  结果: {dep_content}\n"
                # 如果有结构化数据，也传递
                if dep.get('data'):
                    dep_context += f"  数据: {json.dumps(dep.get('data'), ensure_ascii=False, indent=2)}\n"
            else:
                dep_context += f"  失败: {dep.get('error', '未知错误')}\n"
            dep_context += "\n"

        enhanced_subtask_desc = f"{subtask_desc}\n{dep_context}"
        self.logger.info(f"[MasterAgent] 子任务 {subtask_order} 已增强上下文，包含 {len(dep_results)} 个前置任务的结果")
```

#### 2. 使用增强描述执行任务

所有子任务执行时，都使用 `enhanced_subtask_desc` 而非原始的 `subtask_desc`：

```python
# 流式执行
for event in agent.execute_stream(enhanced_subtask_desc, context):
    ...

# 非流式执行
response = self.orchestrator.execute(
    task=enhanced_subtask_desc,
    context=context,
    preferred_agent=agent_name
)
```

### 修改文件

- `backend/agents/master_agent.py`
  - `_coordinate_multiple_agents` 方法（line 849-907）
  - `_stream_coordinate_multiple_agents` 方法（line 512-631）

## 优势

### 1. 清晰的上下文传递
- 前置任务的结果以结构化、可读的格式直接呈现给后续任务
- 智能体能够直接看到前置任务的完整输出

### 2. 支持复杂依赖
- 支持多个前置任务的依赖（`depends_on: [1, 2]`）
- 自动过滤不存在的依赖

### 3. 内容截断保护
- 对于超过 1000 字符的长文本自动截断
- 避免上下文过载

### 4. 结构化数据传递
- 同时传递文本结果（`content`）和结构化数据（`data`）
- 方便后续任务进行数据处理

## 使用示例

### 场景：多步骤数据分析任务

```json
{
  "complexity": "complex",
  "needs_multiple_agents": true,
  "reasoning": "需要先查询数据，再进行分析",
  "subtasks": [
    {
      "description": "查询南宁2023年洪涝灾害数据",
      "agent": "qa_agent",
      "order": 1,
      "depends_on": []
    },
    {
      "description": "基于查询结果，分析灾害趋势并生成报告",
      "agent": "react_agent",
      "order": 2,
      "depends_on": [1]  // 依赖第 1 个子任务
    }
  ]
}
```

**执行流程：**

1. **步骤 1**：`qa_agent` 查询数据，返回结果
   ```
   查询到南宁2023年共发生3次洪涝灾害...
   ```

2. **步骤 2**：`react_agent` 收到增强后的任务描述：
   ```
   基于查询结果，分析灾害趋势并生成报告

   【前置任务结果】
   - 任务: 查询南宁2023年洪涝灾害数据
     结果: 查询到南宁2023年共发生3次洪涝灾害...
     数据: {
       "disasters": [
         {"date": "2023-06-15", "affected": 5000},
         ...
       ]
     }
   ```

3. `react_agent` 基于前置结果进行分析，生成报告

## 测试建议

### 测试用例 1：简单依赖链
```
用户输入: "查询南宁2023年洪涝灾害数据，然后分析受灾人数趋势"
预期: 第2个任务能看到第1个任务的查询结果
```

### 测试用例 2：多重依赖
```
用户输入: "查询灾害数据，查询救援数据，综合两者生成分析报告"
预期: 第3个任务能看到前2个任务的结果
```

### 测试用例 3：依赖失败处理
```
用户输入: "查询不存在的数据，然后基于结果分析"
预期: 第2个任务能看到第1个任务失败的错误信息
```

## 日志输出

启用改进后，日志中会显示：

```
[MasterAgent] 执行子任务 2: 基于查询结果，分析灾害趋势并生成报告
[MasterAgent] 子任务 2 已增强上下文，包含 1 个前置任务的结果
```

## 后续优化建议

1. **智能截断**：根据任务类型动态调整截断长度
2. **摘要生成**：对长文本使用 LLM 生成摘要而非简单截断
3. **依赖图验证**：在任务分析阶段验证依赖图的合法性（避免循环依赖）
4. **并行执行**：支持无依赖的子任务并行执行

## 版本信息

- **修改日期**：2025-01-07
- **修改文件**：`backend/agents/master_agent.py`
- **影响范围**：多智能体协作场景
- **向后兼容**：完全兼容，不影响单智能体或无依赖场景
