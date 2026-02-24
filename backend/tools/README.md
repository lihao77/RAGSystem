# GraphRAG 工具系统

## 概述

本目录包含GraphRAG问答系统的Function Calling工具定义和执行器。这些工具允许LLM直接调用知识图谱查询和向量检索功能。

## 文件结构

```
tools/
├── function_definitions.py  # 工具定义（OpenAI Function Calling格式）
├── tool_executor.py          # 工具执行器
└── README.md                 # 本文档
```

## 可用工具

### 1. 知识图谱工具

#### query_knowledge_graph_with_nl
**最强大的工具** - 自然语言转Cypher查询
- 适用场景：复杂关联查询、因果分析、时序分析
- 自动转换自然语言为Cypher
- 推荐优先使用

#### search_knowledge_graph
搜索基础实体或状态节点
- 支持关键词搜索
- 按类别过滤（地点/设施/事件/State）
- 时间范围和地理位置过滤

#### get_entity_relations
获取实体关系网络
- 空间结构关系
- 状态链关系
- 因果关系

#### execute_cypher_query
直接执行Cypher查询
- 仅限只读查询
- 适用于高级场景

#### get_graph_schema
获取图谱结构信息

### 2. 分析工具

#### analyze_temporal_pattern
时序模式分析
- 事件频率统计
- 趋势分析
- 周期性分析

#### find_causal_chain
因果链路追踪
- 前向追踪（影响分析）
- 后向追溯（溯源分析）
- 双向追踪

#### compare_entities
实体对比分析
- 多实体比较
- 属性对比
- 时间范围过滤

#### aggregate_statistics
聚合统计分析
- sum、avg、max、min、count
- 按时间/来源分组

#### get_spatial_neighbors
空间邻近查询
- 查找周边实体
- 多层级邻居
- 类型过滤

### 3. 向量检索工具（新增 v2.0）

#### query_emergency_plan ⭐ 新增
**应急预案语义检索**
- 使用向量相似度搜索预案文档
- 支持自然语言查询
- 返回相关文档片段和相似度

**参数**：
- `query`: 查询问题（必填）
- `top_k`: 返回结果数，默认5
- `min_similarity`: 最小相似度阈值，默认0.3
- `document_filter`: 文档来源过滤（可选）

**适用场景**：
- 响应等级启动条件查询
- 应急响应流程查询
- 操作规范查询
- 标准阈值查询

**示例查询**：
```json
{
  "query": "Ⅰ级应急响应的启动条件是什么",
  "top_k": 5,
  "min_similarity": 0.5
}
```

## 工具调用流程

```
用户问题
    ↓
LLM 分析问题
    ↓
选择合适的工具
    ↓
┌─────────────────────┐
│  工具执行器         │
│  (tool_executor.py) │
└─────────────────────┘
    ↓
┌─────────────────────┐
│ 知识图谱查询 │ 向量检索 │
│  (Neo4j)    │(ChromaDB)│
└─────────────────────┘
    ↓
返回结构化结果
    ↓
LLM 生成自然语言答案
```

## 混合检索策略（v2.0）

系统现在支持**图谱 + 向量**混合检索：

### 1. 纯图谱查询
**适用场景**：历史事实、数据统计
- "南宁市2023年受灾人口"
- "潘厂水库2020年6月的降雨量"

### 2. 纯向量查询
**适用场景**：规范标准、流程指南
- "Ⅰ级响应启动条件"
- "防汛应急处置流程"

### 3. 混合查询
**适用场景**：决策支持、综合分析
- "南宁市降雨300mm应启动什么响应？"
  - 图谱：查询历史降雨数据
  - 向量：查询响应启动标准
  - 结合：给出综合建议

## 开发指南

### 添加新工具

1. **在 function_definitions.py 中定义**：
```python
{
    "type": "function",
    "function": {
        "name": "your_tool_name",
        "description": "工具描述...",
        "parameters": {
            "type": "object",
            "properties": {
                "param1": {
                    "type": "string",
                    "description": "参数描述"
                }
            },
            "required": ["param1"]
        }
    }
}
```

2. **在 tool_executor.py 中实现**：
```python
def execute_tool(tool_name, arguments):
    ...
    elif tool_name == "your_tool_name":
        return your_tool_function(**arguments)
    ...

def your_tool_function(param1):
    """工具实现"""
    try:
        # 实现逻辑
        return {
            "success": True,
            "data": {...}
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }
```

### 测试工具

```python
from tools.tool_executor import execute_tool

result = execute_tool("query_emergency_plan", {
    "query": "Ⅰ级响应启动条件",
    "top_k": 3
})

print(result)
```

## 初始化向量检索

在使用 `query_emergency_plan` 工具前，需要先索引文档：

```bash
# 方式1：运行初始化脚本
cd backend
python scripts/init_emergency_plans.py

# 方式2：使用模块方式
python -m scripts.init_emergency_plans
```

初始化过程（当前版本基于 SQLite-vec 向量库）：
1. 读取 `广西应急预案.md`
2. 文本分块（chunk_size=500, overlap=50）
3. 通过向量化器生成向量嵌入（维度由向量化器自动决定）
4. 写入 SQLite + sqlite-vec 向量库（详见 `docs/migration/VECTOR_STORE_MIGRATION.md`）
5. 自动验证检索功能

## 性能指标

- **图谱查询**：< 1秒（简单查询），< 5秒（复杂查询）
- **向量检索**：< 1秒（Top 10）
- **混合查询**：< 10秒（总响应时间）

## 更新日志

### v2.0 (2025-01-18, 旧版说明)
- ✅ 新增 `query_emergency_plan` 向量检索工具
- ✅ （历史）集成 ChromaDB 向量数据库 —— 现已迁移到 SQLite + sqlite-vec
- ✅ 支持图谱+向量混合检索
- ✅ 添加应急预案初始化脚本

### v1.0
- 基础知识图谱工具集（10个工具）
- Function Calling集成
- 自然语言转Cypher

## 参考资料

- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [Neo4j Cypher文档](https://neo4j.com/docs/cypher-manual/)
- [SQLite + sqlite-vec 项目页面](https://github.com/asg017/sqlite-vec)
- [sentence-transformers文档](https://www.sbert.net/)
