# -*- coding: utf-8 -*-
"""
Function Calling 工具定义
用于LLM直接调用知识图谱检索功能
"""

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "query_knowledge_graph_with_nl",
            "description": """使用自然语言查询知识图谱。自动将问题转换为Cypher查询并返回结果。适用于复杂查询、因果分析、时序分析。优先使用此工具。

**返回值结构（execute_code中使用）**：
```python
ret = call_tool("query_knowledge_graph_with_nl", {"question": "..."})
# ret["success"] == True 时：
records = ret["data"]["results"]   # list[dict]，查询记录列表
answer  = ret["data"]["answer"]    # str，LLM生成的文字答案
summary = ret["data"]["summary"]   # str，如"查询返回10条记录，包含字段: state_id, time, ..."
# 每条记录的字段取决于查询内容，通常包含：state_id/id、time、value等
```""",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "自然语言问题，例如：'潘厂水库在2020年6月7日的情况'、'南宁市2023年的洪涝灾害导致了什么影响'"
                    },
                    "history": {
                        "type": "array",
                        "description": "对话历史，用于上下文理解。每个元素包含role和content",
                        "items": {
                            "type": "object",
                            "properties": {
                                "role": {
                                    "type": "string",
                                    "enum": ["user", "assistant"]
                                },
                                "content": {
                                    "type": "string"
                                }
                            }
                        }
                    }
                },
                "required": ["question"]
            },
            "allowed_callers": ["direct", "code_execution"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_knowledge_graph",
            "description": """搜索知识图谱中的实体或状态节点。基础实体(地点/设施/事件)是静态骨架，State节点包含时间段内的具体灾情数据。category参数决定查询目标：'地点'/'设施'/'事件'查基础实体，'State'查状态节点（含降雨量、受灾人口、经济损失等具体数值）。查询损失/水位/降雨等具体数值必须用category='State'，查询实体是否存在用对应类别。

**返回值结构（execute_code中使用）**：
```python
ret = call_tool("search_knowledge_graph", {"keyword": "南宁市", "category": "State"})
items = ret["data"]["results"]  # list[dict]
# 查基础实体时每条记录：{"id": "L-450100", "name": "南宁市", "category": "地点", "labels": [...], "source": "...", "properties": {...}}
# 查State节点时每条记录：{"id": "LS-L-450100-...", "name": "State", "category": "State", "time": "...", "source": "...", "entity_ids": [...], "properties": {...}}
# entity_ids 是该State关联的实体ID列表，properties 包含具体的属性值
```""",
            "parameters": {
                "type": "object",
                "properties": {
                    "keyword": {
                        "type": "string",
                        "description": "搜索关键词，模糊匹配。查基础实体(地点/设施/事件)时匹配实体名称；查State节点时匹配状态ID（状态ID中包含实体名称，直接填写实体名称片段即可，如'潘厂水库'、'南宁市'、'450100'）。"
                    },
                    "category": {
                        "type": "string",
                        "description": "节点类别：'地点'（行政区/河流）、'设施'（水库/大坝）、'事件'（台风/洪水）、'State'（包含具体灾情数值的时序数据节点）。不填默认查询State节点。",
                        "enum": ["地点", "设施", "事件", "State"]
                    },
                    "document_source": {
                        "type": "string",
                        "description": "文档来源，例如：'2023年广西水旱灾害公报'、'2020年广西水旱灾害公报'"
                    },
                    "time_range": {
                        "type": "array",
                        "description": "时间范围，格式为 [开始时间, 结束时间]，例如：['2023-01-01', '2023-12-31']",
                        "items": {
                            "type": "string",
                            "format": "date"
                        },
                        "minItems": 2,
                        "maxItems": 2
                    },
                    "location": {
                        "type": "array",
                        "description": "地理位置层级，例如：['guangxi', 'nanning', 'qingxiu'] 表示广西>南宁>青秀区",
                        "items": {
                            "type": "string"
                        }
                    },
                    "advanced_query": {
                        "type": "string",
                        "description": "高级查询条件，使用Cypher WHERE子句语法，例如：'n.type = \"洪涝\"'"
                    }
                },
                "required": []
            },
            "allowed_callers": ["direct", "code_execution"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_entity_relations",
            "description": """获取实体的关系网络。自动识别基础实体和State节点，返回对应关系。基础实体返回空间关系和状态链，State节点返回属性关系和因果关系。

**返回值结构（execute_code中使用）**：
```python
ret = call_tool("get_entity_relations", {"entity_id": "L-450100"})
graph = ret["data"]["results"]     # dict，包含 nodes 和 relationships
nodes = graph["nodes"]             # list[dict]，节点列表，每个节点：{"id": int, "labels": [...], "properties": {...}}
rels  = graph["relationships"]     # list[dict]，关系列表：{"id": int, "type": "locatedIn", "source": str, "target": str, "properties": {...}}
# 常见关系类型：locatedIn(空间层级)、occurredAt(事件发生地)、hasState(状态链)、hasAttribute(属性)、hasRelation(因果)
```""",
            "parameters": {
                "type": "object",
                "properties": {
                    "entity_id": {
                        "type": "string",
                        "description": "实体ID，支持部分匹配。通常直接使用search_knowledge_graph等工具返回结果中的id字段值，无需手动构造。基础实体ID以L-(地点)/F-(设施)/E-(事件)开头，State节点ID以LS-/FS-/ES-/JS-开头（分别对应地点/设施/事件/联合状态）。"
                    }
                },
                "required": ["entity_id"]
            },
            "allowed_callers": ["direct", "code_execution"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "execute_cypher_query",
            "description": "直接执行Cypher查询语句。仅限只读查询（MATCH、RETURN等），不允许修改操作。适用于需要精确控制查询逻辑的高级场景。",
            "parameters": {
                "type": "object",
                "properties": {
                    "cypher": {
                        "type": "string",
                        "description": "Cypher查询语句，例如：'MATCH (n:State) WHERE n.id CONTAINS \"潘厂水库\" RETURN n LIMIT 10'"
                    }
                },
                "required": ["cypher"]
            },
            "allowed_callers": ["direct"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_graph_schema",
            "description": "获取知识图谱的结构信息，包括节点类型、关系类型、属性等元数据。用于了解图谱的整体结构。",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            },
            "allowed_callers": ["direct", "code_execution"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "analyze_temporal_pattern",
            "description": """分析时序模式和趋势。查询指定时间范围内的状态数据，支持指标趋势分析。自动计算min/max/avg和趋势方向。

**返回值结构（execute_code中使用）**：
```python
ret = call_tool("analyze_temporal_pattern", {"entity_name": "南宁市", "start_date": "2020-01-01", "end_date": "2023-12-31", "metric": "受灾人口"})
records = ret["data"]["results"]   # list[dict]，时序记录
# 指定metric时每条记录：{"state_id": "LS-L-450100-...", "time": "...", "start": date, "end": date, "state_type": "...", "attr_name": "受灾人口", "value": "18.8万人"}
# 未指定metric时：{"state_id": ..., "time": ..., "start": date, "end": date, "state_type": ...}
analysis = ret["data"]["metadata"]["analysis"]  # dict，趋势分析
# analysis 包含：{"count": 5, "min": 10.2, "max": 46.87, "avg": 28.5, "trend": "increasing", "valid_values": 5}
```""",
            "parameters": {
                "type": "object",
                "properties": {
                    "entity_name": {
                        "type": "string",
                        "description": "实体名称或名称片段（会在状态ID中模糊匹配）。例如：'潘厂水库'、'南宁市'、'450100'"
                    },
                    "start_date": {
                        "type": "string",
                        "description": "开始日期，格式：YYYY-MM-DD"
                    },
                    "end_date": {
                        "type": "string",
                        "description": "结束日期，格式：YYYY-MM-DD"
                    },
                    "metric": {
                        "type": "string",
                        "description": "分析指标（可选）。指定后返回该属性的时序值和趋势分析。例如：'降雨量'、'受灾人口'、'经济损失'、'水位'"
                    }
                },
                "required": ["entity_name", "start_date", "end_date"]
            },
            "allowed_callers": ["direct", "code_execution"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "find_causal_chain",
            "description": """查找因果链路。追踪事件的前因后果，分析影响传播路径。支持forward(影响)/backward(原因)/both三个方向。

**返回值结构（execute_code中使用）**：
```python
ret = call_tool("find_causal_chain", {"start_event": "南宁市洪涝", "direction": "forward"})
chains = ret["data"]["results"]    # list[dict]，每条链路
# 每个链路：{"nodes": [{"id": "ES-...", "state_type": "...", "time": "...", "entity_ids": [...], "attributes": [{"type": "受灾人口", "value": "..."}]}], "relationships": [...]}
# chains[0]["nodes"] 是路径上的状态节点列表，relationships 是连接它们的因果关系
count = ret["data"]["metadata"]["chain_count"]  # int，找到的链路数量
```""",
            "parameters": {
                "type": "object",
                "properties": {
                    "start_event": {
                        "type": "string",
                        "description": "起始事件或实体名称片段（会在状态ID中模糊匹配）"
                    },
                    "end_event": {
                        "type": "string",
                        "description": "目标事件或实体名称片段（可选）。指定后只返回从start_event到end_event的路径"
                    },
                    "max_depth": {
                        "type": "integer",
                        "description": "最大追踪深度（因果链的最大长度），默认为3",
                        "default": 3
                    },
                    "direction": {
                        "type": "string",
                        "description": "追踪方向：'forward'（向前追踪影响）、'backward'（向后追溯原因）、'both'（双向）",
                        "enum": ["forward", "backward", "both"],
                        "default": "forward"
                    }
                },
                "required": ["start_event"]
            },
            "allowed_callers": ["direct", "code_execution"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "compare_entities",
            "description": """比较多个实体的状态和属性。一次性获取所有实体数据，支持按属性列表过滤。

**返回值结构（execute_code中使用）**：
```python
ret = call_tool("compare_entities", {"entity_names": ["南宁市", "柳州市"], "compare_attributes": ["受灾人口", "经济损失"]})
comparisons = ret["data"]["results"]  # dict，以实体名为key
# comparisons["南宁市"] 是该实体的记录列表
# 指定compare_attributes时每条记录：{"state_id": "...", "time": "...", "entity_ids": [...], "attributes": [{"attr": "受灾人口", "value": "18.8万人"}]}
# 未指定时：{"state_id": ..., "time": ..., "state_type": ..., "entity_ids": [...], "properties": {...}}
```""",
            "parameters": {
                "type": "object",
                "properties": {
                    "entity_names": {
                        "type": "array",
                        "description": "要比较的实体名称列表（会在状态ID中模糊匹配）",
                        "items": {
                            "type": "string"
                        },
                        "minItems": 2
                    },
                    "time_range": {
                        "type": "array",
                        "description": "时间范围 [开始日期, 结束日期]，格式：YYYY-MM-DD",
                        "items": {
                            "type": "string"
                        },
                        "minItems": 2,
                        "maxItems": 2
                    },
                    "compare_attributes": {
                        "type": "array",
                        "description": "要比较的属性列表（可选）。指定后只返回这些属性的值。例如：['降雨量', '受灾人口', '经济损失']",
                        "items": {
                            "type": "string"
                        }
                    }
                },
                "required": ["entity_names"]
            },
            "allowed_callers": ["direct", "code_execution"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "aggregate_statistics",
            "description": """聚合统计分析。计算sum/avg/max/min等统计指标。支持按实体类型(地点/设施/事件)过滤，支持时间范围和分组。

**返回值结构（execute_code中使用）**：
```python
ret = call_tool("aggregate_statistics", {"attribute": "受灾人口", "aggregation": "sum", "group_by": "source"})
records = ret["data"]["results"]   # list[dict]
# 有group_by时每条记录：{"group_key": "2023年广西水旱灾害公报", "result": 1234567.0}
# 无group_by时：[{"result": 5678901.0}]（单条，直接取 records[0]["result"]）
```""",
            "parameters": {
                "type": "object",
                "properties": {
                    "attribute": {
                        "type": "string",
                        "description": "要统计的属性名称（在hasAttribute关系的type字段中）。例如：'降雨量'、'受灾人口'、'经济损失'"
                    },
                    "aggregation": {
                        "type": "string",
                        "description": "聚合方式：sum（总和）、avg（平均）、max（最大）、min（最小）、count（计数）",
                        "enum": ["sum", "avg", "max", "min", "count"]
                    },
                    "entity_type": {
                        "type": "string",
                        "description": "实体类型过滤（可选）：'地点'（行政区/河流相关灾情数据）、'设施'（水库/大坝相关运行数据）、'事件'（台风/洪水等灾害事件数据）。不指定则统计所有类型的状态数据。",
                        "enum": ["地点", "设施", "事件"]
                    },
                    "time_range": {
                        "type": "array",
                        "description": "时间范围 [开始日期, 结束日期]，格式：YYYY-MM-DD",
                        "items": {
                            "type": "string"
                        },
                        "minItems": 2,
                        "maxItems": 2
                    },
                    "group_by": {
                        "type": "string",
                        "description": "分组字段（可选）。支持的值：'source'（按数据来源年份分组，如按年份公报）、'time'（按时间分组）、'state_type'（按状态类型分组）。仅使用这三个支持的值，其他字段名可能无效。"
                    }
                },
                "required": ["attribute", "aggregation"]
            },
            "allowed_callers": ["direct", "code_execution"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_spatial_neighbors",
            "description": """获取空间邻近实体。查找指定实体周边的地理位置、设施等，使用locatedIn/occurredAt关系。

**返回值结构（execute_code中使用）**：
```python
ret = call_tool("get_spatial_neighbors", {"entity_name": "南宁市", "radius": 1})
neighbors = ret["data"]["results"]  # list[dict]，邻近实体列表
# 每条记录：{"id": "L-450103", "name": "青秀区", "labels": ["地点", "entity"], "distance": 1}
# distance 是层级数（1=直接相邻，2=隔一层）
```""",
            "parameters": {
                "type": "object",
                "properties": {
                    "entity_name": {
                        "type": "string",
                        "description": "中心实体名称或名称片段"
                    },
                    "radius": {
                        "type": "integer",
                        "description": "邻近层级(1-5)，1为直接相邻，数字越大范围越广。",
                        "default": 1,
                        "minimum": 1,
                        "maximum": 5
                    },
                    "neighbor_type": {
                        "type": "string",
                        "description": "邻居类型过滤：'地点'/'设施'/'事件'，不指定则返回所有类型。",
                        "enum": ["地点", "设施", "事件"]
                    }
                },
                "required": ["entity_name"]
            },
            "allowed_callers": ["direct", "code_execution"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "query_emergency_plan",
            "description": """查询应急预案文档。使用语义搜索从应急预案知识库检索。适用于查询响应等级、应急流程、部门职责、操作指南、标准规范等。

**返回值结构（execute_code中使用）**：
```python
ret = call_tool("query_emergency_plan", {"query": "Ⅰ级应急响应启动条件"})
docs = ret["data"]["results"]      # list[dict]，检索到的文档片段
# 每条记录：{"content": "文档原文...", "source": "广西应急预案", "similarity": 0.85, "chunk_id": "..."}
# 按相似度降序排列，直接读取 content 字段即可
```""",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "查询问题或关键词。支持自然语言提问，例如：\n- 'Ⅰ级应急响应的启动条件是什么'\n- '降雨量达到多少需要启动应急响应'\n- '防汛应急处置流程'\n- '洪涝灾害等级划分标准'"
                    },
                    "top_k": {
                        "type": "integer",
                        "description": "返回结果数量，默认为5。建议：\n- 精确查询：3-5条\n- 探索性查询：5-10条\n- 全面了解：10-15条",
                        "default": 5,
                        "minimum": 1,
                        "maximum": 20
                    },
                    "min_similarity": {
                        "type": "number",
                        "description": "最小相似度阈值（0-1），低于此值的结果将被过滤。默认0.3\n- 0.7+：高度相关\n- 0.5-0.7：中度相关\n- 0.3-0.5：弱相关",
                        "default": 0.3,
                        "minimum": 0.0,
                        "maximum": 1.0
                    },
                    "document_filter": {
                        "type": "string",
                        "description": "文档来源过滤（可选）。例如：'广西应急预案'、'防汛预案'。不指定则搜索所有文档"
                    }
                },
                "required": ["query"]
            },
            "allowed_callers": ["direct", "code_execution"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "generate_chart",
            "description": "生成ECharts图表配置。支持数据列表或文件路径，必须指定chart_type、x_field、y_field。支持line/bar/pie/scatter四种图表。",
            "parameters": {
                "type": "object",
                "properties": {
                    "data": {
                        "type": "string",
                        "description": "数据源，两种格式：\n1. JSON字符串（对象数组）：如'[{\"年份\":2020,\"受灾人口\":18.8},{\"年份\":2021,\"受灾人口\":22.3}]'\n2. 文件路径：上一个工具返回的JSON/CSV文件路径（当工具返回'数据已保存至文件'时使用）\n注意：x_field和y_field的值必须与data中实际存在的字段名完全一致。"
                    },
                    "chart_type": {
                        "type": "string",
                        "description": "图表类型：line(折线图，适合时序/趋势)/bar(柱状图，适合分类对比)/pie(饼图，适合占比)/scatter(散点图，适合相关性)。",
                        "enum": ["line", "bar", "pie", "scatter"]
                    },
                    "title": {
                        "type": "string",
                        "description": "图表标题（可选，不指定则自动生成）"
                    },
                    "x_field": {
                        "type": "string",
                        "description": "X轴字段名，必须与data中的字段名完全一致（区分大小写）。通常是时间、地区等分类字段，用于类目轴。"
                    },
                    "y_field": {
                        "type": "string",
                        "description": "Y轴字段名，必须与data中的字段名完全一致（区分大小写）。必须是数字类型字段，用于数值轴。"
                    },
                    "series_field": {
                        "type": "string",
                        "description": "系列分组字段名(可选)，用于按字段分组显示不同系列。"
                    }
                },
                "required": ["data", "chart_type", "x_field", "y_field"]
            },
            "allowed_callers": ["direct"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "process_data_file",
            "description": "通用数据处理工具。执行Python/Pandas代码处理数据文件，支持格式转换、字段提取、过滤、聚合等操作。代码环境已预置pandas和json库。",
            "parameters": {
                "type": "object",
                "properties": {
                    "source_path": {
                        "type": "string",
                        "description": "源文件路径（通常是上一个工具返回的临时文件路径）"
                    },
                    "python_code": {
                        "type": "string",
                        "description": "Python代码，需包含读取source_path、处理数据、保存到result_path三步。result_path由系统自动注入。推荐保存为JSON格式（json.dump），也支持CSV格式（会自动转换）。"
                    },
                    "description": {
                        "type": "string",
                        "description": "对本次数据转换操作的简短描述，例如：'提取时间和受灾人口字段'"
                    }
                },
                "required": ["source_path", "python_code"]
            },
            "allowed_callers": ["direct"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "generate_map",
            "description": "生成Leaflet地图可视化配置。从知识图谱数据提取WKT geometry并转换为地图格式。支持heatmap/marker/circle三种类型，必须包含geometry字段。",
            "parameters": {
                "type": "object",
                "properties": {
                    "data": {
                        "type": "string",
                        "description": "数据源。可以是JSON格式的字符串(必须包含geometry字段)，也可以是JSON/CSV文件路径。"
                    },
                    "map_type": {
                        "type": "string",
                        "description": "地图类型：heatmap(热力图)/marker(标记点)/circle(圆圈标记)。",
                        "enum": ["heatmap", "marker", "circle"],
                        "default": "heatmap"
                    },
                    "title": {
                        "type": "string",
                        "description": "地图标题（可选，不指定则自动生成）"
                    },
                    "name_field": {
                        "type": "string",
                        "description": "地名字段（可选）。用于在标记点上显示名称。例如：'city', 'name', '行政区划'"
                    },
                    "value_field": {
                        "type": "string",
                        "description": "数值字段（必填）。用于映射热力图强度或圆圈大小的字段。例如：'受灾人口', '经济损失', 'value'"
                    },
                    "geometry_field": {
                        "type": "string",
                        "description": "几何字段名（默认'geometry'）。该字段的值必须是WKT格式的POINT坐标，例如：'POINT(108.366543 22.817002)'（经度 纬度，WGS84）。通常来自get_entity_geometry工具的返回结果，直接使用即可。暂不支持POLYGON等其他几何类型。",
                        "default": "geometry"
                    }
                },
                "required": ["data", "value_field"]
            },
            "allowed_callers": ["direct", "code_execution"]
        }
    },
    # 14. 获取实体几何信息
    {
        "type": "function",
        "function": {
            "name": "get_entity_geometry",
            "description": """根据实体ID列表获取几何信息(WKT坐标)。支持基础实体和State节点混合，返回id、geometry和type的映射列表。

**返回值结构（execute_code中使用）**：
```python
ret = call_tool("get_entity_geometry", {"entity_ids": ["L-450100", "L-450200"]})
geom_list = ret["data"]["results"]  # list[dict]
# 每条记录：{"id": "L-450100", "geometry": "POINT(108.366543 22.817002)", "type": "地点"}
# geometry 格式为 WKT POINT（经度 纬度），可直接传给 generate_map 的 data 参数
```""",
            "parameters": {
                "type": "object",
                "properties": {
                    "entity_ids": {
                        "type": "array",
                        "items": {
                            "type": "string"
                        },
                        "description": "实体ID列表，支持基础实体和State节点混合。"
                    }
                },
                "required": ["entity_ids"]
            },
            "allowed_callers": ["direct", "code_execution"]
        }
    },
    # 15. 内存数据转换
    {
        "type": "function",
        "function": {
            "name": "transform_data",
            "description": "在内存中执行Python代码进行数据格式转换，适合小数据量(<1000条)。与execute_code的区别：本工具不能调用其他工具（call_tool不可用），仅适合对已有数据做格式变换（如添加字段、过滤、合并）；execute_code可调用其他工具进行批量查询。代码中将数据字面量赋值给变量，处理后设置result变量（list或dict）作为输出。",
            "parameters": {
                "type": "object",
                "properties": {
                    "python_code": {
                        "type": "string",
                        "description": "Python转换代码。将数据字面量赋值给变量（例如：data = [{\"id\": \"L-001\", ...}, ...]），进行处理后设置result变量为list或dict（不要用json.dumps序列化result）。可用模块：pd（pandas）、json。"
                    },
                    "description": {
                        "type": "string",
                        "description": "操作描述（可选）。例如: '添加 geometry 字段', '合并业务数据和几何数据'"
                    }
                },
                "required": ["python_code"]
            },
            "allowed_callers": ["direct"]
        }
    },
    # 16. PTC 代码执行
    {
        "type": "function",
        "function": {
            "name": "execute_code",
            "description": """执行 Python 代码进行复杂数据处理和工具编排。

**核心优势**：
- 可在代码中调用其他工具（使用 call_tool 函数）
- 支持复杂逻辑、循环、条件判断
- 中间结果不进入对话上下文（只有最终 result 返回）
- 支持受限文件读写（限沙箱目录，写操作需用户审批）

**与其他工具的区别**：
- vs `transform_data`：本工具可调用其他工具（call_tool），适合批量查询；transform_data仅做内存数据转换
- vs `process_data_file`：本工具支持沙箱内文件读写；process_data_file用于处理文件路径的大数据

**使用场景**：
1. 批量调用同一工具（如查询多个城市）
2. 根据中间结果动态决定下一步
3. 组合多个工具的结果
4. 读取沙箱内文件进行处理
5. 将处理结果写入沙箱文件（需审批）

**代码环境**：
- 可用模块：math, json, re, csv, datetime, collections, itertools, functools, statistics
- 可用函数：call_tool(tool_name, arguments_dict) → 返回工具结果字典
- 必须设置 result 变量作为最终输出（list 或 dict）
- 只有 allowed_callers 包含 "code_execution" 的工具可在 call_tool 中调用

**文件读写**（限沙箱目录 SANDBOX_DIR）：
- 读文件：直接使用 open(path, 'r')，path 为相对或绝对路径（必须在沙箱内）
- 写文件：需先调用 request_write_approval(path, reason)，获批后再 open(path, 'w')
- SANDBOX_DIR 变量：沙箱根目录的绝对路径字符串
```python
# 读文件示例
with open('result.json', 'r') as f:
    data = json.load(f)

# 写文件示例（需审批）
request_write_approval('output.csv', reason='保存查询结果')
with open('output.csv', 'w') as f:
    f.write('city,count\\n')
```

**call_tool 返回值结构**：
```python
# 成功时返回：{"success": True, "data": {"results": [...]}}
# 失败时返回：{"success": False, "error": "错误信息"}
# 提取数据的标准写法：
ret = call_tool("search_knowledge_graph", {"keyword": "南宁市", "category": "State"})
data = ret.get("data", {}).get("results", [])  # 提取实际数据列表
```

**安全限制**：
- 禁止 os, sys, subprocess 等系统模块
- 文件读写限制在沙箱目录内，写操作需用户审批
- 执行超时：30秒
- 高风险工具（如 execute_cypher_query）禁止从代码调用

**示例**：
```python
# 批量查询多个城市
cities = ["南宁市", "柳州市", "桂林市"]
results = []
for city in cities:
    ret = call_tool("search_knowledge_graph", {
        "keyword": city,
        "category": "State"
    })
    data = ret.get("data", {}).get("results", [])
    results.append({"city": city, "count": len(data)})
result = results
```""",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "Python 代码。必须设置 result 变量（list 或 dict）作为输出。使用 call_tool(tool_name, arguments_dict) 调用工具，通过 ret.get('data', {}).get('results', []) 提取结果数据。"
                    },
                    "description": {
                        "type": "string",
                        "description": "代码功能描述（可选），例如：'批量查询10个城市的灾害数据'"
                    }
                },
                "required": ["code"]
            },
            "allowed_callers": ["direct"]
        }
    }
    # 注意：load_skill_resource 和 execute_skill_script 工具已由 agent_loader.py 自动注入
    # 当智能体启用了 Skills 时，这两个工具会自动添加到该智能体的工具列表中
]

# 导入文档处理工具
from tools.document_tools import DOCUMENT_TOOLS

# 合并工具列表
TOOLS.extend(DOCUMENT_TOOLS)


def get_tool_definitions():
    """获取所有工具定义"""
    return TOOLS


def get_tool_by_name(name):
    """根据名称获取工具定义"""
    for tool in TOOLS:
        if tool["function"]["name"] == name:
            return tool
    return None


def get_code_callable_tools():
    """
    获取允许从代码执行环境调用的工具列表

    Returns:
        list: 工具名称列表（allowed_callers 包含 "code_execution" 的工具）
    """
    return [
        tool["function"]["name"]
        for tool in TOOLS
        if "code_execution" in tool["function"].get("allowed_callers", ["direct"])
    ]
