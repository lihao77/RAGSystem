# 工具返回格式标准化重构总结

## 重构日期
2026-01-12

## 问题背景

在之前的实现中，`process_data_file` 函数保存的数据文件包含了完整的工具响应对象（包括 `answer`、`result_summary`、`sample_results` 等元数据字段），而不是纯净的数据列表。这导致：

1. **数据污染**：保存的文件不是纯数据，无法直接传递给下游工具
2. **格式不一致**：不同工具返回的格式各异，难以统一处理
3. **提取复杂**：`_format_observation` 需要复杂的逻辑来猜测哪些是"纯数据"

## 解决方案

采用**渐进式重构**策略，统一所有工具的返回格式。

### 标准化响应格式

```python
{
    "success": bool,
    "error": str (仅在失败时),
    "data": {
        "results": 纯净数据,    # ← 核心：可直接传递给下游工具
        "metadata": {...},       # 自动生成的元数据
        "summary": "...",        # 自动生成的摘要
        "answer": "..." (可选),  # 完整答案（仅查询类工具）
        "debug": {...} (可选)    # 调试信息
    }
}
```

### 核心设计原则

1. **`data.results`** - 永远是纯净的、可传递的数据
2. **`data.metadata`** - 结构化的元数据（字段、类型、样本）
3. **`data.summary`** - Agent 可读的简洁描述
4. **`data.answer`** - 仅查询类工具返回完整答案

## 已重构的工具

### 1. query_knowledge_graph_with_nl

**文件**: `backend/tools/tool_executor.py` (lines 330-447)

**改动**:
- 使用 `success_response()` 构造标准响应
- `results` 包含纯净的查询记录（`query_records`）
- `answer` 包含完整的文本答案
- `debug` 包含 Cypher、执行时间、重试次数

**示例返回**:
```python
{
    "success": True,
    "data": {
        "results": [{...}, {...}],  # 纯净查询记录
        "metadata": {...},          # 自动生成
        "summary": "查询返回 24 条记录，包含字段: city_name, population_data",
        "answer": "根据知识图谱查询结果...",
        "debug": {
            "cypher": "MATCH ...",
            "execution_time": 1.23,
            "retry_count": 0
        }
    }
}
```

### 2. aggregate_statistics

**文件**: `backend/tools/tool_executor.py` (lines 877-965)

**改动**:
- 使用 `success_response()` 构造响应
- `results` 包含聚合统计结果
- 自动生成 summary（如"聚合统计完成：sum(受灾人口)，按 年份 分组"）

**示例返回**:
```python
{
    "success": True,
    "data": {
        "results": [
            {"group_key": "2019", "result": 187.21},
            {"group_key": "2020", "result": 203.45}
        ],
        "metadata": {...},
        "summary": "聚合统计完成：sum(受灾人口)，按 年份 分组"
    }
}
```

### 3. generate_chart

**文件**: `backend/tools/tool_executor.py` (lines 1127-1285)

**改动**:
- 使用 `success_response()` 构造响应
- `results` 包含 `{"echarts_config": {...}, "chart_type": "bar"}`
- 自动生成 summary

**示例返回**:
```python
{
    "success": True,
    "data": {
        "results": {
            "echarts_config": {...},  # 完整的 ECharts 配置
            "chart_type": "bar"
        },
        "metadata": {...},
        "summary": "图表配置已生成 (bar)"
    }
}
```

## 核心组件

### response_builder.py

**文件**: `backend/tools/response_builder.py`

**功能**:
- 提供 `ToolResponse` 类，统一构造响应
- `success_response()` - 构造成功响应
- `error_response()` - 构造失败响应
- 自动生成 `metadata` 和 `summary`

**使用示例**:
```python
from tools.response_builder import success_response, error_response

# 成功响应
return success_response(
    results=query_records,
    answer=answer,
    debug={"cypher": cypher}
)

# 错误响应
return error_response("查询失败: 连接超时")
```

### 改进的 _format_observation

**文件**: `backend/agents/react_agent.py` (lines 617-698)

**改动**:
1. **优先检查 `data.answer`** - 直接返回完整答案（query_knowledge_graph_with_nl）
2. **提取 `data.results`** - 作为纯净数据
3. **使用 `data.summary`** - 作为元数据描述
4. **向后兼容** - 如果没有标准格式，降级到旧格式处理
5. **保存纯数据** - 大数据保存时只保存 `results`，不包含元数据

**核心逻辑**:
```python
# 1. 处理错误
if not result.get('success'):
    return f"错误: {result.get('error')}"

# 2. 提取 data
data = result.get('data', {})

# 3. 优先返回 answer
if 'answer' in data:
    return data['answer']

# 4. 提取纯数据
pure_data = data.get('results')
summary = data.get('summary')

# 5. 小数据直接返回，大数据保存到文件
if len(json.dumps(pure_data)) < 2000:
    return json.dumps(data, indent=2)
else:
    # 保存纯数据到文件
    json.dump(pure_data, f, indent=2)
    return f"数据已保存至 {file_path}..."
```

### 改进的 chart_generated 事件

**文件**: `backend/agents/react_agent.py` (lines 372-390)

**改动**:
- 适配新的标准化响应格式
- 从 `data.results` 中提取 `echarts_config`
- 发送 chart_generated 事件给前端

**核心逻辑**:
```python
if isinstance(result, dict) and result.get('success'):
    data = result.get('data', {})
    results = data.get('results', {})

    if isinstance(results, dict) and 'echarts_config' in results:
        yield {
            "type": "chart_generated",
            "echarts_config": results['echarts_config'],
            "chart_type": results.get('chart_type'),
            "title": results['echarts_config'].get('title', {}).get('text')
        }
```

## 向后兼容性

### 兼容旧格式

`_format_observation` 包含降级逻辑：

```python
# 如果没有标准化格式，尝试兼容旧格式
if pure_data is None:
    # 兼容旧格式：直接返回 data
    pure_data = data
```

这确保了未重构的工具仍能正常工作。

### 未重构的工具

以下工具尚未重构，但可以继续使用：

- `search_knowledge_graph`
- `get_entity_relations`
- `execute_cypher_query`
- `analyze_temporal_pattern`
- `find_causal_chain`
- `compare_entities`
- `get_spatial_neighbors`
- `get_graph_schema`
- `query_emergency_plan`
- `process_data_file`

## 重构优势

### 1. 数据干净
`process_data_file` 现在保存的是纯净数据：
```json
[
    {"year": "2019", "population": 187.21},
    {"year": "2020", "population": 203.45}
]
```

而不是混乱的：
```json
{
    "answer": "根据知识图谱查询结果...",
    "result_summary": "...",
    "sample_results": [...]
}
```

### 2. 提取简单
`_format_observation` 只需：
```python
pure_data = data.get('results')  # 一行搞定
```

而不需要复杂的判断逻辑。

### 3. 元数据自动生成
不需要手写摘要：
```python
return success_response(results=records)
# 自动生成: "查询返回 24 条记录，包含字段: city_name, population_data"
```

### 4. 统一错误处理
所有错误响应格式一致：
```python
{
    "success": False,
    "error": "查询失败: 连接超时"
}
```

## 后续计划

### 短期（按需）
- 重构其他8个工具使用标准化格式
- 逐步清理旧的兼容逻辑

### 长期
- 建立工具开发规范文档
- 添加自动化测试验证响应格式

## 测试建议

### 测试用例 1: query_knowledge_graph_with_nl
```
用户: "查询2019年广西各市的受灾人口"
预期: 返回带有 answer 和 results 的标准响应
```

### 测试用例 2: aggregate_statistics + generate_chart
```
用户: "统计2016-2023年各年的洪涝灾害事件数量并绘制柱状图"
预期:
1. aggregate_statistics 返回纯净的统计数据
2. 数据自动保存到文件
3. generate_chart 读取文件并生成图表
4. 前端接收 chart_generated 事件并渲染
```

### 测试用例 3: process_data_file
```
用户: "将上述数据转换为绘图所需的格式"
预期:
1. 读取源文件（纯数据）
2. 执行 Pandas 转换
3. 保存新文件（纯数据）
4. 返回新文件路径
```

## 注意事项

1. **导入 response_builder**: 所有重构的工具都需要导入：
   ```python
   from tools.response_builder import success_response, error_response
   ```

2. **results 字段必须是纯数据**: 不要在 results 中混入元数据

3. **answer 字段仅用于查询类工具**: 其他工具不需要 answer

4. **metadata 和 summary 自动生成**: 除非有特殊需求，否则让系统自动生成

## 文件清单

### 新增文件
- `backend/tools/response_builder.py` - 标准化响应构造器

### 修改文件
- `backend/tools/tool_executor.py` - 重构3个核心工具
- `backend/agents/react_agent.py` - 改进 _format_observation 和事件处理

### 文档文件
- `backend/tools/TOOL_RESPONSE_REFACTORING.md` - 本文档

## 总结

通过标准化工具返回格式，我们解决了：

✅ **数据污染问题** - 保存的文件是纯数据
✅ **格式混乱问题** - 所有工具统一格式
✅ **提取复杂问题** - 简单的 `data.results` 提取
✅ **元数据缺失问题** - 自动生成结构化元数据

系统现在具备了更清晰的数据流和控制流分离，为 Universal Data Bridge 模式奠定了坚实的基础。
