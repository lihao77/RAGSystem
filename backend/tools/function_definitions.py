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
            "description": "使用自然语言查询知识图谱。系统会自动将自然语言问题转换为Cypher查询，执行并返回结构化结果。这是最强大的工具，适用于复杂的关联查询、因果分析、时序分析等场景。推荐优先使用此工具。\n\n⚠️重要：损失数据可能存储在事件状态(ES-E-)、地点状态(LS-L-)或联合状态(JS-)中，查询时需要覆盖所有State类型！",
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
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_knowledge_graph",
            "description": "搜索知识图谱中的基础实体或状态节点。根据category参数自动选择查询目标。\n\n**基础实体vs状态节点**：\n- 基础实体（地点/设施/事件）：静态骨架，如'南宁市'、'潘厂水库'、'2023年台风'\n- 状态节点（State）：动态快照，包含时间段内的具体数据（降雨量、受灾人口、经济损失等）\n\n**查询策略**：\n- category='地点'/'设施'/'事件'：返回基础实体节点（:地点:entity, :设施:entity, :事件:entity）\n- category='State'：返回状态节点（:State），包含entity_ids、time、state_type等\n- category=''：默认查询状态节点\n\n⚠️重要：\n1. 查询损失数据时，必须用category='State'！损失信息存储在状态节点的属性中\n2. 查询基础实体信息（名称、位置）时，用category='地点'/'设施'/'事件'\n3. 时间范围(time_range)只对State节点有效",
            "parameters": {
                "type": "object",
                "properties": {
                    "keyword": {
                        "type": "string",
                        "description": "搜索关键词，用于模糊匹配。\n- 查基础实体：匹配name、id、geo_description字段\n- 查状态节点：先查关联的基础实体，再通过entity_ids匹配状态\n示例：'潘厂水库'、'南宁市'、'洪涝'、'450100'（行政区划码）"
                    },
                    "category": {
                        "type": "string",
                        "description": "节点类别（决定查询哪类节点）：\n- '地点'：查询地点基础实体（行政区、河流等）\n- '设施'：查询设施基础实体（水库、大坝、水文站等）\n- '事件'：查询事件基础实体（台风、洪水等）\n- 'State'：查询状态节点（包含时序数据和属性）\n- ''（空）：默认查询State节点",
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
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_entity_relations",
            "description": "获取指定基础实体的关系网络。支持查询空间关系、状态链、因果关系等。\n\n**返回的关系类型**：\n1. **空间结构关系**（基础实体之间）：\n   - `locatedIn`：地点层级关系（市→省）、设施归属（水库→县）\n   - `occurredAt`：事件发生地（台风→影响区域）\n\n2. **状态链关系**（基础实体→状态）：\n   - `hasState`：实体的首个状态节点\n   - `nextState`：状态的时间序列链（自动展开）\n\n3. **因果关系**（状态之间）：\n   - `hasRelation {type:'导致'}`：直接因果\n   - `hasRelation {type:'间接导致'}`：调制作用\n   - `hasRelation {type:'触发'}`：阈值触发\n\n**使用场景**：\n- 查看某个地点的上下级行政区\n- 查看某个设施所在位置\n- 查看某个实体的历史状态链\n- 探索因果关系网络",
            "parameters": {
                "type": "object",
                "properties": {
                    "entity_id": {
                        "type": "string",
                        "description": "基础实体ID（必须是:entity节点的ID）：\n- 地点：'L-450100'（南宁市）、'L-450103>新竹街道'、'L-RIVER-长江'\n- 设施：'F-450381-潘厂水库'、'F-420500-三峡大坝'\n- 事件：'E-450000-20231001-TYPHOON'\n\n⚠️注意：不支持State节点ID（ES-*/LS-*/FS-*/JS-*）"
                    }
                },
                "required": ["entity_id"]
            }
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
            }
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
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "analyze_temporal_pattern",
            "description": "分析时序模式和趋势。统计指定时间范围内的事件频率、强度变化等。适用于趋势分析、周期性分析等场景。",
            "parameters": {
                "type": "object",
                "properties": {
                    "entity_name": {
                        "type": "string",
                        "description": "实体名称，例如：'潘厂水库'、'南宁市'"
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
                        "description": "分析指标，例如：'降雨量'、'受灾人口'、'经济损失'",
                    }
                },
                "required": ["entity_name", "start_date", "end_date"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "find_causal_chain",
            "description": "查找因果链路。追踪事件的前因后果，分析影响传播路径。适用于影响分析、溯源分析等场景。",
            "parameters": {
                "type": "object",
                "properties": {
                    "start_event": {
                        "type": "string",
                        "description": "起始事件或实体名称"
                    },
                    "end_event": {
                        "type": "string",
                        "description": "目标事件或实体名称（可选）"
                    },
                    "max_depth": {
                        "type": "integer",
                        "description": "最大追踪深度，默认为3",
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
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "compare_entities",
            "description": "比较多个实体的状态和属性。适用于对比分析、异同点识别等场景。",
            "parameters": {
                "type": "object",
                "properties": {
                    "entity_names": {
                        "type": "array",
                        "description": "要比较的实体名称列表",
                        "items": {
                            "type": "string"
                        },
                        "minItems": 2
                    },
                    "time_range": {
                        "type": "array",
                        "description": "时间范围 [开始日期, 结束日期]",
                        "items": {
                            "type": "string"
                        },
                        "minItems": 2,
                        "maxItems": 2
                    },
                    "compare_attributes": {
                        "type": "array",
                        "description": "要比较的属性列表，例如：['降雨量', '受灾人口']",
                        "items": {
                            "type": "string"
                        }
                    }
                },
                "required": ["entity_names"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "aggregate_statistics",
            "description": "聚合统计分析。计算总和、平均值、最大值、最小值等统计指标。适用于数据汇总、统计分析等场景。",
            "parameters": {
                "type": "object",
                "properties": {
                    "entity_type": {
                        "type": "string",
                        "description": "实体类型：'地点'、'设施'、'事件'",
                        "enum": ["地点", "设施", "事件"]
                    },
                    "attribute": {
                        "type": "string",
                        "description": "要统计的属性，例如：'降雨量'、'受灾人口'"
                    },
                    "aggregation": {
                        "type": "string",
                        "description": "聚合方式：sum（总和）、avg（平均）、max（最大）、min（最小）、count（计数）",
                        "enum": ["sum", "avg", "max", "min", "count"]
                    },
                    "time_range": {
                        "type": "array",
                        "description": "时间范围 [开始日期, 结束日期]",
                        "items": {
                            "type": "string"
                        }
                    },
                    "group_by": {
                        "type": "string",
                        "description": "分组字段，例如：'source'（按来源分组）、'time'（按时间分组）"
                    }
                },
                "required": ["attribute", "aggregation"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_spatial_neighbors",
            "description": "获取空间邻近实体。查找指定实体周边的地理位置、设施等。适用于空间关系分析、影响范围评估等场景。",
            "parameters": {
                "type": "object",
                "properties": {
                    "entity_name": {
                        "type": "string",
                        "description": "中心实体名称"
                    },
                    "radius": {
                        "type": "integer",
                        "description": "邻近层级，1表示直接相邻，2表示二级邻居，以此类推",
                        "default": 1
                    },
                    "neighbor_type": {
                        "type": "string",
                        "description": "邻居类型过滤：'地点'、'设施'、'事件'，不指定则返回所有类型"
                    }
                },
                "required": ["entity_name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "query_emergency_plan",
            "description": "查询应急预案文档。使用语义搜索从应急预案知识库中检索相关内容。适用于：\n\n**应急响应规范查询**：\n- 响应等级启动条件（Ⅰ级/Ⅱ级/Ⅲ级/Ⅳ级）\n- 应急响应流程和步骤\n- 各部门职责分工\n- 应急预案触发标准\n\n**操作指南查询**：\n- 防汛减灾措施\n- 应急处置方案\n- 预警发布流程\n- 灾后恢复程序\n\n**规范标准查询**：\n- 灾害等级划分标准\n- 安全阈值规定\n- 技术规范要求\n\n⚠️使用场景：\n1. 当问题涉及'应急响应'、'预案'、'措施'、'标准'、'流程'等关键词时优先使用\n2. 补充图谱查询：图谱提供历史事实数据，预案提供规范操作指南\n3. 决策支持：结合历史数据（图谱）和标准流程（预案）给出综合建议\n\n返回结果包含：文档片段、相似度评分、元数据（文档来源、章节等）",
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
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "generate_chart",
            "description": "生成数据可视化图表配置。根据指定的数据和字段映射生成 ECharts 配置。\n\n**使用说明**：\n1. 支持直接传入数据列表，也支持传入文件路径（由 process_data_file 生成的）。\n2. **必须**明确指定 x_field（X轴/类目轴）和 y_field（Y轴/数值轴）。\n3. **必须**明确指定 chart_type（图表类型）。\n\n**适用场景**：\n- 当用户要求画图时。\n- 数据包含明确的类别/时间和数值。\n\n**不适用场景**：\n- 数据极其稀疏或非结构化。\n- 纯文本内容。",
            "parameters": {
                "type": "object",
                "properties": {
                    "data": {
                        "type": "string",
                        "description": "数据源。可以是数据列表(List[Dict])，也可以是包含数据的 JSON/CSV 文件路径（推荐）。"
                    },
                    "chart_type": {
                        "type": "string",
                        "description": "图表类型（必填）：\n- line: 折线图（适合时序趋势）\n- bar: 柱状图（适合类别对比）\n- pie: 饼图（适合占比分布）\n- scatter: 散点图（适合相关性分析）",
                        "enum": ["line", "bar", "pie", "scatter"]
                    },
                    "title": {
                        "type": "string",
                        "description": "图表标题（可选，不指定则自动生成）"
                    },
                    "x_field": {
                        "type": "string",
                        "description": "X轴字段名（必填）。用于映射到类目轴或时间轴的字段。例如：'time', 'city'。"
                    },
                    "y_field": {
                        "type": "string",
                        "description": "Y轴字段名（必填）。用于映射到数值轴的字段。例如：'value', 'count'。"
                    },
                    "series_field": {
                        "type": "string",
                        "description": "系列分组字段名（可选）。如果数据需要按某字段分组展示（如“按城市分组显示不同颜色的折线”），请指定此字段。"
                    }
                },
                "required": ["data", "chart_type", "x_field", "y_field"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "process_data_file",
            "description": "通用数据处理工具。当需要将上一个工具输出的文件转换为下一个工具需要的格式时使用。支持执行 Python/Pandas 代码对数据进行清洗、过滤、转换、重塑。\n\n**使用场景**：\n1. 格式转换：JSON -> CSV，List[Dict] -> List[Value]\n2. 数据提取：从复杂对象中提取特定字段\n3. 数据过滤：筛选满足条件的记录\n4. 数据重组：合并、透视、聚合数据\n\n**重要规则**：\n1. 代码环境已预置 pandas (pd) 和 json 库\n2. 输入文件路径通过 source_path 参数传入，代码中直接读取\n3. 处理结果必须保存到 result_path 指定的文件中\n4. 代码必须是合法的 Python 脚本片段",
            "parameters": {
                "type": "object",
                "properties": {
                    "source_path": {
                        "type": "string",
                        "description": "源文件路径（通常是上一个工具返回的临时文件路径）"
                    },
                    "python_code": {
                        "type": "string",
                        "description": "用于处理数据的 Python 代码。代码中应包含：\n1. 读取 source_path\n2. 处理数据 (DataFrame 操作)\n3. 将结果保存到 result_path (系统会自动生成此路径并注入到环境变量或全局变量)\n\n示例：\n```python\nimport pandas as pd\nimport json\n\n# 读取源文件\nwith open(source_path, 'r', encoding='utf-8') as f:\n    data = json.load(f)\n\n# 转换为 DataFrame\ndf = pd.DataFrame(data)\n\n# 提取需要的字段\nresult_df = df[['time', 'value']]\n\n# 保存结果 (result_path 变量由系统注入)\nresult_df.to_json(result_path, orient='records', force_ascii=False)\n```"
                    },
                    "description": {
                        "type": "string",
                        "description": "对本次数据转换操作的简短描述，例如：'提取时间和受灾人口字段'"
                    }
                },
                "required": ["source_path", "python_code"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "generate_map",
            "description": "生成地图可视化配置（Leaflet 地图）。从知识图谱数据中提取 WKT geometry 并转换为地图格式。支持热力图、标记点、圆圈标记等多种地图类型。\n\n**使用说明**：\n1. 数据中必须包含 geometry 字段（WKT格式：POINT (lng lat)）。\n2. 必须指定 value_field（数值字段）。\n3. 可选指定 name_field（地名字段，用于标记点显示）。\n\n**适用场景**：\n- 展示受灾地区的空间分布（热力图）\n- 标记具体灾害事件位置（标记点）\n- 对比不同地区的受灾程度（圆圈标记）\n\n**地图类型选择**：\n- heatmap：热力图 - 展示数值的空间密度分布，适合宏观了解影响范围\n- marker：标记点 - 精确标记位置，点击可查看详情\n- circle：圆圈标记 - 圆的大小代表数值大小，适合直观对比\n\n**重要提示**：\n- 数据必须从知识图谱查询获得（包含geometry字段）\n- geometry格式示例：'POINT (108.55015524500028 25.17981577140806)'\n- 如果数据是文件路径，需确保文件包含geometry列",
            "parameters": {
                "type": "object",
                "properties": {
                    "data": {
                        "type": "string",
                        "description": "数据源。可以是包含 geometry 字段的数据列表(List[Dict])，也可以是 JSON/CSV 文件路径。"
                    },
                    "map_type": {
                        "type": "string",
                        "description": "地图类型（默认 heatmap）：\n- heatmap: 热力图 - 展示数值的空间密度分布\n- marker: 标记点 - 精确标记位置，显示名称和数值\n- circle: 圆圈标记 - 圆的大小代表数值大小",
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
            }
        }
    },
    # 14. 获取实体几何信息
    {
        "type": "function",
        "function": {
            "name": "get_entity_geometry",
            "description": "根据实体 ID 列表获取实体的几何信息（WKT 格式坐标，可能存在线数据以及面数据）。\n\n**适用场景**：\n- 为地图可视化准备带坐标的实体数据\n- 获取特定实体的地理位置信息\n- 补充查询结果中缺失的 geometry 字段\n\n**使用说明**：\n1. 传入实体 ID 列表（如从其他工具的查询结果中提取）\n2. 返回 id 和 geometry 的映射列表\n3. 只返回有 geometry 属性的实体（:entity 标签）\n\n**典型用法**：\n```\n# 先查询实体，获取 ID\nresult1 = query_knowledge_graph_with_nl(\"2023年广西各市的洪涝灾害事件\")\nentity_ids = [item['event_id'] for item in result1]\n\n# 获取这些实体的几何信息\ngeometry_data = get_entity_geometry(entity_ids)\n\n# 合并数据后传给 generate_map\n```\n\n**重要提示**：\n- 只查询基础实体节点（:entity 标签），不包括状态节点（:State）\n- geometry 字段格式为 WKT，如 \"POINT (108.55 25.18)\"\n- 如果某个 ID 没有 geometry 属性，不会出现在结果中",
            "parameters": {
                "type": "object",
                "properties": {
                    "entity_ids": {
                        "type": "array",
                        "items": {
                            "type": "string"
                        },
                        "description": "实体 ID 列表。例如: [\"L-450100\", \"L-450200\", \"E-450000-20211012-FLOOD\"]"
                    }
                },
                "required": ["entity_ids"]
            }
        }
    },
    # 15. 内存数据转换
    {
        "type": "function",
        "function": {
            "name": "transform_data",
            "description": "执行 Python 代码进行数据转换（纯内存操作）。适用于你已经从前一个工具获得数据，需要快速转换的场景。\n\n**适用场景**：\n- 为地图可视化添加 geometry 字段\n- 合并多个数据源\n- 数据格式转换和字段重命名\n- 简单的数据计算和映射\n\n**与 process_data_file 的区别**：\n- transform_data：内存操作，直接在代码中硬编码数据\n- process_data_file：文件操作，适合大数据（> 1000 条）\n\n**使用规则**：\n1. **直接在 python_code 中硬编码数据**（从前一个工具的结果中复制）\n2. **必须设置 `result` 变量**作为输出\n3. 可以使用 `pd`（pandas）和 `json` 模块\n\n**典型用法**：\n\n```python\n# 示例 1: 为地图数据添加 geometry 字段\n# 假设你从 query_knowledge_graph_with_nl 获得了业务数据\n# 又从 get_entity_geometry 获得了坐标数据\n\npython_code = '''\n# 业务数据（从前一个工具复制）\nbusiness_data = [\n    {\"location_id\": \"L-450100\", \"name\": \"南宁市\", \"value\": 1500},\n    {\"location_id\": \"L-450200\", \"name\": \"柳州市\", \"value\": 800}\n]\n\n# 几何数据（从 get_entity_geometry 获得）\ngeometry_data = [\n    {\"id\": \"L-450100\", \"geometry\": \"POINT (108.37 22.82)\"},\n    {\"id\": \"L-450200\", \"geometry\": \"POINT (109.42 24.33)\"}\n]\n\n# 合并数据\nresult = []\nfor item in business_data:\n    geo = next((g for g in geometry_data if g['id'] == item['location_id']), None)\n    if geo:\n        result.append({\n            'name': item['name'],\n            'value': item['value'],\n            'geometry': geo['geometry']\n        })\n'''\n\n# 示例 2: 简单的字段转换\npython_code = '''\nraw_data = [\n    {\"city\": \"南宁\", \"lng\": 108.37, \"lat\": 22.82, \"loss\": 1500},\n    {\"city\": \"柳州\", \"lng\": 109.42, \"lat\": 24.33, \"loss\": 800}\n]\n\nresult = []\nfor item in raw_data:\n    result.append({\n        'name': item['city'],\n        'value': item['loss'],\n        'geometry': f\"POINT ({item['lng']} {item['lat']})\"\n    })\n'''\n\n# 示例 3: 使用 pandas\npython_code = '''\nimport pandas as pd\n\nraw_data = [{\"name\": \"南宁\", \"lng\": 108.37, \"lat\": 22.82, \"value\": 1500}]\ndf = pd.DataFrame(raw_data)\ndf['geometry'] = df.apply(lambda row: f\"POINT ({row['lng']} {row['lat']})\", axis=1)\nresult = df.to_dict('records')\n'''\n```\n\n**重要提示**：\n- 数据量应该较小（< 1000 条），否则请使用 process_data_file\n- 代码末尾**必须设置** `result = ...`\n- 数据直接硬编码在 python_code 中，不要传递文件路径",
            "parameters": {
                "type": "object",
                "properties": {
                    "python_code": {
                        "type": "string",
                        "description": "Python 转换代码。在代码中直接定义数据（硬编码），最后必须设置 result 变量。可以使用 pd（pandas）和 json 模块。"
                    },
                    "description": {
                        "type": "string",
                        "description": "操作描述（可选）。例如: '添加 geometry 字段', '合并业务数据和几何数据'"
                    }
                },
                "required": ["python_code"]
            }
        }
    }
]


def get_tool_definitions():
    """获取所有工具定义"""
    return TOOLS


def get_tool_by_name(name):
    """根据名称获取工具定义"""
    for tool in TOOLS:
        if tool["function"]["name"] == name:
            return tool
    return None
