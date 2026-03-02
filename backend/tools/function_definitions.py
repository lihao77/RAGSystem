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
            "description": "使用自然语言查询知识图谱。自动将问题转换为Cypher查询并返回结果。适用于复杂查询、因果分析、时序分析。优先使用此工具。",
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
            "description": "搜索知识图谱中的实体或状态节点。基础实体(地点/设施/事件)是静态骨架，State节点包含时间段内的具体数据。category参数决定查询目标：'地点'/'设施'/'事件'查基础实体，'State'查状态节点。损失数据查询必须用category='State'。",
            "parameters": {
                "type": "object",
                "properties": {
                    "keyword": {
                        "type": "string",
                        "description": "搜索关键词，用于模糊匹配。查基础实体时匹配name/id字段，查State节点时在状态ID上过滤。"
                    },
                    "category": {
                        "type": "string",
                        "description": "节点类别：'地点'(行政区/河流)、'设施'(水库/大坝)、'事件'(台风/洪水)、'State'(时序数据)、''(默认State)。",
                        "enum": ["地点", "设施", "事件", "State", ""]
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
            "description": "获取实体的关系网络。自动识别基础实体和State节点，返回对应关系。基础实体返回空间关系和状态链，State节点返回属性关系和因果关系。",
            "parameters": {
                "type": "object",
                "properties": {
                    "entity_id": {
                        "type": "string",
                        "description": "实体ID，支持基础实体(L-/F-/E-)和State节点(LS-/FS-/ES-/JS-)，支持部分匹配。"
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
            "description": "分析时序模式和趋势。查询指定时间范围内的状态数据，支持指标趋势分析。自动计算min/max/avg和趋势方向。",
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
            "description": "查找因果链路。追踪事件的前因后果，分析影响传播路径。支持forward(影响)/backward(原因)/both三个方向。",
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
            "description": "比较多个实体的状态和属性。一次性获取所有实体数据，支持按属性列表过滤。",
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
            "description": "聚合统计分析。计算sum/avg/max/min等统计指标。支持按实体类型(地点/设施/事件)过滤，支持时间范围和分组。",
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
                        "description": "实体类型（可选）。指定后只统计该类型实体的状态：\n- '地点'：地点状态（LS-L-*）\n- '设施'：设施状态（FS-F-*）\n- '事件'：事件状态（ES-E-*）\n不指定则统计所有状态",
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
                        "description": "分组字段（可选）。常用字段：\n- 'source'：按数据来源分组\n- 'time'：按时间分组\n- 'state_type'：按状态类型分组"
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
            "description": "获取空间邻近实体。查找指定实体周边的地理位置、设施等，使用locatedIn/occurredAt关系。",
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
            "description": "查询应急预案文档。使用语义搜索从应急预案知识库检索。适用于查询响应等级、应急流程、部门职责、操作指南、标准规范等。",
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
                        "description": "数据源。可以是JSON格式的字符串(如'[{\"a\":1},{\"b\":2}]')，也可以是JSON/CSV文件路径。"
                    },
                    "chart_type": {
                        "type": "string",
                        "description": "图表类型：line(折线图)/bar(柱状图)/pie(饼图)/scatter(散点图)。",
                        "enum": ["line", "bar", "pie", "scatter"]
                    },
                    "title": {
                        "type": "string",
                        "description": "图表标题（可选，不指定则自动生成）"
                    },
                    "x_field": {
                        "type": "string",
                        "description": "X轴字段名，用于映射到类目轴或时间轴。"
                    },
                    "y_field": {
                        "type": "string",
                        "description": "Y轴字段名，用于映射到数值轴。"
                    },
                    "series_field": {
                        "type": "string",
                        "description": "系列分组字段名(可选)，用于按字段分组显示不同系列。"
                    }
                },
                "required": ["data", "chart_type", "x_field", "y_field"]
            },
            "allowed_callers": ["direct", "code_execution"]
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
                        "description": "几何字段名（默认 'geometry'）。包含 WKT POINT 格式坐标的字段名。",
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
            "description": "根据实体ID列表获取几何信息(WKT坐标)。支持基础实体和State节点混合，返回id、geometry和type的映射列表。",
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
            "description": "执行Python代码进行内存数据转换。适用于小数据量(<1000条)的快速转换，如添加geometry字段、合并数据、格式转换等。代码中直接硬编码数据，最后必须设置result变量为list或dict（不要使用json.dumps序列化）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "python_code": {
                        "type": "string",
                        "description": "Python转换代码。在代码中硬编码数据，最后必须设置result变量为list或dict（例如result = filtered_data，不要用json.dumps）。可使用pd和json模块。"
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
- 中间结果不占用对话上下文（只有最终结果返回）

**使用场景**：
1. 批量调用同一工具（如查询 10 个城市）
2. 根据中间结果动态决定下一步操作
3. 复杂数据处理（循环、条件、聚合）
4. 组合多个工具的结果

**代码环境**：
- 可用模块：math, json, re, datetime, collections, itertools, functools, statistics
- 可用函数：call_tool(tool_name, arguments) - 调用其他工具
- 必须设置 result 变量作为最终输出
- 只有 allowed_callers 包含 "code_execution" 的工具可以在 call_tool 中调用

**安全限制**：
- 禁止 os, sys, subprocess 等系统模块
- 禁止文件操作（open, file）
- 执行超时：30秒
- 高风险工具（如 execute_cypher_query）禁止从代码调用

**示例**：
```python
# 批量查询
cities = ["南宁市", "柳州市", "桂林市"]
results = []
for city in cities:
    data = call_tool("search_knowledge_graph", {
        "keyword": city,
        "category": "地点"
    })
    results.append({"city": city, "count": len(data)})
result = results
```""",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "Python 代码。必须设置 result 变量作为输出。可使用 call_tool(tool_name, arguments) 调用工具。"
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
