# -*- coding: utf-8 -*-
"""Static common tool definitions."""

from __future__ import annotations

from tools.tool_definition_builder import ToolContract, build_function_tools


STATIC_TOOL_CONTRACTS = [
    ToolContract(
        name="create_chart",
        description="一步生成 ECharts 图表：构建配置 -> 校验 -> 持久化 -> 返回 artifact_id。在 <final_answer> 中用 [viz:artifact_id] 展示。",
        parameters={
            "type": "object",
            "properties": {
                "data": {
                    "type": "string",
                    "description": "数据源。可以是 JSON 字符串，也可以是 JSON/CSV 文件路径。"
                },
                "chart_type": {
                    "type": "string",
                    "description": "图表类型：line、bar、pie、scatter。",
                    "enum": ["line", "bar", "pie", "scatter"]
                },
                "title": {
                    "type": "string",
                    "description": "图表标题（可选）"
                },
                "x_field": {
                    "type": "string",
                    "description": "X 轴字段名"
                },
                "y_field": {
                    "type": "string",
                    "description": "Y 轴字段名"
                },
                "series_field": {
                    "type": "string",
                    "description": "系列分组字段名（可选）"
                }
            },
            "required": ["data", "chart_type", "x_field", "y_field"]
        },
        returns={
            "type": "object",
            "description": "成功时返回 artifact_id 和预览信息",
            "shape": {
                "artifact_id": "string",
                "viz_type": "string",
                "title": "string",
                "preview": {
                    "title": "string",
                    "chart_type": "string",
                    "series_count": "number",
                    "data_rows": "number",
                },
            },
        },
        usage_contract=[
            "create_chart 一步完成生成+持久化，不需要额外调用",
            "返回的 artifact_id 用于在 <final_answer> 中插入 [viz:artifact_id]",
            "不满意时可用 revise_visualization 修改配置",
            "不要编造 artifact_id，必须使用工具返回的真实 ID",
        ],
        examples=[
            {
                "input": {
                    "data": '[{"年份": 2016, "受灾人口": 325.48}, {"年份": 2017, "受灾人口": 429.67}]',
                    "chart_type": "line",
                    "title": "受灾人口趋势",
                    "x_field": "年份",
                    "y_field": "受灾人口",
                },
                "result_hint": {
                    "artifact_id": "viz_abc123",
                    "viz_type": "chart",
                },
            }
        ],
        source="static",
    ),

    ToolContract(
        name="create_map",
        description="一步生成 Leaflet 地图：构建数据 -> 持久化 -> 返回 artifact_id。在 <final_answer> 中用 [viz:artifact_id] 展示。",
        parameters={
            "type": "object",
            "properties": {
                "data": {
                    "type": "string",
                    "description": "数据源。可以是 JSON 字符串，也可以是 JSON/CSV 文件路径。"
                },
                "map_type": {
                    "type": "string",
                    "description": "地图类型：heatmap（热力图）、marker（标记点）、circle（圆圈）、choropleth（区域填色）、geojson（GeoJSON通用）。",
                    "enum": ["heatmap", "marker", "circle", "choropleth", "geojson"],
                    "default": "heatmap"
                },
                "title": {
                    "type": "string",
                    "description": "地图标题（可选）"
                },
                "name_field": {
                    "type": "string",
                    "description": "名称字段（可选）"
                },
                "value_field": {
                    "type": "string",
                    "description": "数值字段名"
                },
                "geometry_field": {
                    "type": "string",
                    "description": "几何字段名，默认 geometry。",
                    "default": "geometry"
                },
                "marker_style": {
                    "type": "object",
                    "description": "点图层样式（marker/choropleth/geojson 的点要素可用）。支持 icon=pin/dot/ring/square/diamond/triangle/star/flag/badge/hospital/shelter/station/warning/rescue/supply/school/bridge/dam/reservoir/pump/cross/hexagon/arrow/shield/drop，另可指定 color、border_color、glyph、glyph_color、size(sm/md/lg/xl 或数字)。此为全局默认样式；若数据行包含 icon 字段，则该行使用行级图标覆盖全局设置。",
                    "properties": {
                        "icon": {
                            "type": "string",
                            "enum": ["pin", "dot", "ring", "square", "diamond", "triangle", "star", "flag", "badge", "hospital", "shelter", "station", "warning", "rescue", "supply", "school", "bridge", "dam", "reservoir", "pump", "cross", "hexagon", "arrow", "shield", "drop"]
                        },
                        "color": {"type": "string"},
                        "border_color": {"type": "string"},
                        "glyph": {"type": "string"},
                        "glyph_color": {"type": "string"},
                        "size": {
                            "oneOf": [
                                {"type": "string", "enum": ["sm", "md", "lg", "xl"]},
                                {"type": "number"}
                            ]
                        }
                    }
                }
            },
            "required": ["data", "value_field"]
        },
        returns={
            "type": "object",
            "description": "成功时返回 artifact_id 和预览信息",
            "shape": {
                "artifact_id": "string",
                "viz_type": "string",
                "title": "string",
                "preview": {
                    "map_type": "string",
                    "total_points": "number",
                    "center": "number[]",
                },
            },
        },
        usage_contract=[
            "create_map 一步完成生成+持久化",
            "返回的 artifact_id 用于在 <final_answer> 中插入 [viz:artifact_id]",
            "地理点数据必须包含 geometry 字段，格式可以是 WKT POINT (如 'POINT (lng lat)') 或 GeoJSON (如 '{\"type\":\"Polygon\",\"coordinates\":[...]}')",
            "choropleth 类型用于区域填色，需要面数据（Polygon/MultiPolygon）",
            "geojson 类型支持任意几何类型混合渲染",
        ],
        examples=[
            {
                "input": {
                    "data": '[{"name":"南宁","value":12,"geometry":"POINT (108.32 22.82)"}]',
                    "map_type": "marker",
                    "title": "示例地图",
                    "name_field": "name",
                    "value_field": "value",
                    "marker_style": {"icon": "star", "color": "#ef4444", "glyph": "A"},
                }
            },
            {
                "input": {
                    "data": '[{"name":"区域A","value":85,"geometry":"{\\\"type\\\":\\\"Polygon\\\",\\\"coordinates\\\":[[[108.2,22.7],[108.5,22.7],[108.5,23.0],[108.2,23.0],[108.2,22.7]]]}"}]',
                    "map_type": "choropleth",
                    "title": "区域风险填色图",
                    "name_field": "name",
                    "value_field": "value",
                }
            }
        ],
        allowed_callers=["direct", "code_execution"],
        source="static",
    ),

    ToolContract(
        name="create_bindmap",
        description="多图层叠加地图：将多个数据源/类型叠加在一张地图上，支持图层切换控件。在 <final_answer> 中用 [viz:artifact_id] 展示。",
        parameters={
            "type": "object",
            "properties": {
                "layers": {
                    "type": "array",
                    "description": "图层列表，每个图层包含独立的数据源和渲染配置",
                    "items": {
                        "type": "object",
                        "properties": {
                            "data": {
                                "type": "string",
                                "description": "数据源。JSON 字符串或文件路径。"
                            },
                            "map_type": {
                                "type": "string",
                                "description": "图层类型",
                                "enum": ["heatmap", "marker", "circle", "choropleth", "geojson"]
                            },
                            "label": {
                                "type": "string",
                                "description": "图层显示名称"
                            },
                            "name_field": {
                                "type": "string",
                                "description": "名称字段（可选）"
                            },
                            "value_field": {
                                "type": "string",
                                "description": "数值字段名"
                            },
                            "geometry_field": {
                                "type": "string",
                                "description": "几何字段名，默认 geometry",
                                "default": "geometry"
                            },
                            "marker_style": {
                                "type": "object",
                                "description": "点图层样式。支持 icon、color、border_color、glyph、glyph_color、size。若数据行包含 icon 字段，则该行使用行级图标覆盖全局设置。",
                                "properties": {
                                    "icon": {
                                        "type": "string",
                                        "enum": ["pin", "dot", "ring", "square", "diamond", "triangle", "star", "flag", "badge", "hospital", "shelter", "station", "warning", "rescue", "supply", "school", "bridge", "dam", "reservoir", "pump", "cross", "hexagon", "arrow", "shield", "drop"]
                                    },
                                    "color": {"type": "string"},
                                    "border_color": {"type": "string"},
                                    "glyph": {"type": "string"},
                                    "glyph_color": {"type": "string"},
                                    "size": {
                                        "oneOf": [
                                            {"type": "string", "enum": ["sm", "md", "lg", "xl"]},
                                            {"type": "number"}
                                        ]
                                    }
                                }
                            }
                        },
                        "required": ["data", "map_type", "value_field"]
                    }
                },
                "title": {
                    "type": "string",
                    "description": "地图标题（可选）"
                }
            },
            "required": ["layers"]
        },
        returns={
            "type": "object",
            "description": "成功时返回 artifact_id 和预览信息",
            "shape": {
                "artifact_id": "string",
                "viz_type": "string",
                "title": "string",
                "preview": {
                    "map_type": "string",
                    "total_layers": "number",
                    "total_points": "number",
                },
            },
        },
        usage_contract=[
            "create_bindmap 用于将多种地图数据叠加展示",
            "每个图层可以是不同的数据源和类型（如热力图+标记点）",
            "返回的 artifact_id 用于在 <final_answer> 中插入 [viz:artifact_id]",
            "前端自动生成图层切换控件",
        ],
        examples=[
            {
                "input": {
                    "layers": [
                        {
                            "data": '[{"name":"南宁","value":120,"geometry":"POINT (108.32 22.82)"}]',
                            "map_type": "heatmap",
                            "label": "降雨量热力图",
                            "value_field": "value",
                        },
                        {
                            "data": '[{"name":"南宁","value":78.5,"geometry":"POINT (108.32 22.82)"}]',
                            "map_type": "marker",
                            "label": "水位监测站",
                            "name_field": "name",
                            "value_field": "value",
                            "marker_style": {"icon": "flag", "color": "#10b981", "glyph": "S"},
                        }
                    ],
                    "title": "防汛态势图",
                }
            }
        ],
        allowed_callers=["direct", "code_execution"],
        source="static",
    ),
    ToolContract(
        name="revise_visualization",
        description="修改已生成的可视化 artifact 配置。同一个 artifact_id，前端拉取时自动拿最新版，无需更改占位符。",
        parameters={
            "type": "object",
            "properties": {
                "artifact_id": {
                    "type": "string",
                    "description": "create_chart 或 create_map 返回的 artifact_id"
                },
                "config_patch": {
                    "type": "object",
                    "description": "要合并或替换的配置补丁"
                },
                "replace": {
                    "type": "boolean",
                    "description": "是否用 config_patch 完整替换原配置，默认 false",
                    "default": False
                }
            },
            "required": ["artifact_id", "config_patch"]
        },
        returns={
            "type": "object",
            "description": "成功时返回更新后的 artifact 信息",
            "shape": {
                "artifact_id": "string",
                "viz_type": "string",
                "title": "string",
                "version": "number",
            },
        },
        usage_contract=[
            "默认对原配置做深度合并",
            "replace=true 时用 config_patch 整份替换原配置",
            "artifact_id 不变，<final_answer> 中占位符无需修改",
        ],
        examples=[
            {
                "input": {
                    "artifact_id": "viz_abc123",
                    "config_patch": {"title": {"text": "更新后的标题"}},
                }
            }
        ],
        source="static",
    ),
    ToolContract(
        name="query_emergency_plan",
        description="检索应急预案知识库，通过向量语义搜索返回最相关的预案内容片段。支持按预案类型过滤。",
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "查询内容，例如：'三级防汛应急响应启动条件'"
                },
                "plan_type": {
                    "type": "string",
                    "description": "预案类型过滤（可选），例如：'防汛'、'抗旱'、'台风'",
                    "enum": ["防汛", "抗旱", "台风", "地质灾害", "综合"]
                },
                "top_k": {
                    "type": "integer",
                    "description": "返回结果数量，默认5，最大20",
                    "default": 5
                }
            },
            "required": ["query"]
        },
        returns={
            "type": "object",
            "description": "检索到的预案内容片段列表",
            "shape": {
                "query": "string",
                "plan_type": "string|null",
                "results": [{"text": "string", "similarity": "number", "metadata": "object"}],
                "total": "number",
            },
        },
        usage_contract=[
            "向量库为空时返回友好提示而非报错",
            "返回结果按相似度从高到低排序",
            "plan_type 为可选过滤条件，不传则检索全部预案",
        ],
        examples=[
            {
                "input": {
                    "query": "广西三级防汛应急响应启动条件",
                    "top_k": 3,
                },
                "result_hint": {
                    "total": 3,
                    "results": [{"text": "...", "similarity": 0.85}],
                },
            }
        ],
        source="static",
    ),
    ToolContract(
        name="assess_flood_risk",
        description="根据气象/水文数据评估洪涝风险等级（I-IV级）。内置广西防汛四级响应标准阈值，结合降雨量、水位等数据计算风险。",
        parameters={
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "评估地点，例如：'南宁市'、'桂林市'"
                },
                "rainfall_24h": {
                    "type": "number",
                    "description": "24小时累计降雨量（mm）"
                },
                "water_level": {
                    "type": "number",
                    "description": "当前水位（m）"
                },
                "warning_level": {
                    "type": "number",
                    "description": "警戒水位（m），与 water_level 配合计算超警幅度"
                },
                "forecast_rainfall": {
                    "type": "number",
                    "description": "未来24小时预报降雨量（mm）"
                }
            },
            "required": ["location"]
        },
        returns={
            "type": "object",
            "description": "风险评估结果",
            "shape": {
                "location": "string",
                "risk_level": "string|null",
                "risk_label": "string",
                "risk_factors": ["string"],
                "assessment": "string",
            },
        },
        usage_contract=[
            "至少需要 rainfall_24h、water_level、forecast_rainfall 中的一项",
            "风险等级从高到低匹配：I > II > III > IV",
            "未达到任何阈值时 risk_level 为 null",
        ],
        examples=[
            {
                "input": {
                    "location": "南宁市",
                    "rainfall_24h": 150,
                    "water_level": 78.5,
                    "warning_level": 77.0,
                },
                "result_hint": {
                    "risk_level": "III",
                    "risk_label": "较大",
                },
            }
        ],
        source="static",
    ),
    ToolContract(
        name="match_emergency_response",
        description="根据风险等级和灾害类型匹配应急响应措施。检索相关预案条款并结合内置模板，输出职责分工、关键行动和时间要求。",
        parameters={
            "type": "object",
            "properties": {
                "risk_level": {
                    "type": "string",
                    "description": "风险等级：I/II/III/IV",
                    "enum": ["I", "II", "III", "IV"]
                },
                "disaster_type": {
                    "type": "string",
                    "description": "灾害类型，例如：'洪涝'、'台风'、'内涝'、'山洪'"
                },
                "affected_area": {
                    "type": "string",
                    "description": "受影响区域（可选），例如：'南宁市西乡塘区'"
                }
            },
            "required": ["risk_level", "disaster_type"]
        },
        returns={
            "type": "object",
            "description": "匹配到的应急响应措施",
            "shape": {
                "risk_level": "string",
                "disaster_type": "string",
                "response": {
                    "name": "string",
                    "command_authority": "string",
                    "key_actions": ["string"],
                    "time_requirements": ["string"],
                    "resource_mobilization": ["string"],
                },
                "plan_references": [{"text": "string", "similarity": "number"}],
            },
        },
        usage_contract=[
            "会先检索预案库获取相关条款，检索失败时降级使用内置模板",
            "返回结构化的响应措施：职责分工、关键行动、时间要求、资源调度",
            "affected_area 为可选参数，提供后会增加检索精度",
        ],
        examples=[
            {
                "input": {
                    "risk_level": "III",
                    "disaster_type": "洪涝",
                    "affected_area": "南宁市",
                },
                "result_hint": {
                    "response": {
                        "name": "III级应急响应",
                        "command_authority": "自治区防汛抗旱指挥部秘书长",
                    },
                },
            }
        ],
        source="static",
    ),
    ToolContract(
        name="execute_code",
        description="在受限沙箱中执行 Python 代码进行复杂工具编排与数据处理。支持通过 call_tool 调用允许的其他工具，必须设置 result 变量作为输出。",
        parameters={
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": "Python 代码。必须设置 result 变量作为最终输出。"
                },
                "description": {
                    "type": "string",
                    "description": "代码用途说明（可选）"
                }
            },
            "required": ["code"]
        },
        returns={
            "type": "object",
            "description": "成功时返回代码中 result 变量的值",
            "shape": {
                "content": "任意 JSON 值或字符串",
                "metadata": {
                    "stdout": "string",
                    "tool_calls_count": "number",
                    "execution_time": "number",
                },
            },
        },
        usage_contract=[
            "代码必须设置 result 变量作为最终输出",
            "需要调用工具时使用 call_tool(tool_name, arguments)",
            "call_tool 返回的是工具主内容，不是完整响应壳",
            "不要对 call_tool(...) 再取 ['content']；read_file 返回字符串时应直接使用该字符串",
            "复杂数据转换优先在 execute_code 内完成，再交给其他工具",
        ],
        examples=[
            {
                "input": {
                    "code": "rows = call_tool('read_file', {'file_path': './data/sample.json'})\nresult = rows",
                    "description": "读取文件并返回内容",
                }
            }
        ],
        source="static",
    ),
    ToolContract(
        name="create_risk_map",
        description="批量风险评估+自动生成风险地图：对多个地点批量调用 assess_flood_risk，并自动生成带风险等级颜色标记的地图。在 <final_answer> 中用 [viz:artifact_id] 展示。",
        parameters={
            "type": "object",
            "properties": {
                "locations_data": {
                    "type": "string",
                    "description": "包含多个地点的数据源（JSON 字符串或文件路径）。每条记录必须包含 location、geometry 字段，以及至少一项气象/水文字段（rainfall_24h/water_level/warning_level/forecast_rainfall）。"
                },
                "title": {
                    "type": "string",
                    "description": "地图标题（可选）"
                },
                "disaster_type": {
                    "type": "string",
                    "description": "灾害类型，默认'洪涝'",
                    "default": "洪涝"
                }
            },
            "required": ["locations_data"]
        },
        returns={
            "type": "object",
            "description": "成功时返回 artifact_id、评估摘要和详细结果",
            "shape": {
                "artifact_id": "string",
                "viz_type": "string",
                "assessment_summary": {"I": "number", "II": "number", "III": "number", "IV": "number"},
                "detailed_results": [{"location": "string", "risk_level": "string", "assessment": "string"}],
            },
        },
        usage_contract=[
            "create_risk_map 内部自动调用 assess_flood_risk，无需手动逐个评估",
            "返回的 artifact_id 用于在 <final_answer> 中插入 [viz:artifact_id]",
            "适合批量监测点数据的快速风险评估和可视化",
            "风险等级颜色：I=红色, II=橙色, III=黄色, IV=蓝色",
        ],
        examples=[
            {
                "input": {
                    "locations_data": '[{"location":"南宁市","geometry":"POINT (108.32 22.82)","rainfall_24h":150,"water_level":78.5,"warning_level":77.0},{"location":"桂林市","geometry":"POINT (110.29 25.27)","rainfall_24h":80}]',
                    "title": "广西防汛风险评估",
                    "disaster_type": "洪涝",
                }
            }
        ],
        source="static",
    ),
    ToolContract(
        name="generate_report",
        description="生成标准格式应急报告（汛情快报/灾情报告/综合态势报告）。将分析结果汇总为结构化 Markdown 文档，直接在 <final_answer> 中展示。",
        parameters={
            "type": "object",
            "properties": {
                "report_type": {
                    "type": "string",
                    "description": "报告类型",
                    "enum": ["flood_bulletin", "disaster_report", "situation_report"]
                },
                "title": {
                    "type": "string",
                    "description": "报告标题（可选，不传则使用默认标题）"
                },
                "location": {
                    "type": "string",
                    "description": "区域，例如：'南宁市'、'广西全区'"
                },
                "situation_data": {
                    "type": "string",
                    "description": "态势/灾情数据（JSON 字符串），如 {\"summary\": \"...\", \"affected\": {...}}"
                },
                "risk_data": {
                    "type": "string",
                    "description": "风险评估数据（JSON 字符串），如 assess_flood_risk 返回结果"
                },
                "warning_data": {
                    "type": "string",
                    "description": "预警数据（JSON 字符串），如 fetch_warning.py 返回结果"
                },
                "plan_data": {
                    "type": "string",
                    "description": "预案/建议数据（JSON 字符串），如 match_emergency_response 返回结果"
                },
                "action_data": {
                    "type": "string",
                    "description": "行动/响应数据（JSON 字符串）"
                },
                "weather_data": {
                    "type": "string",
                    "description": "气象数据（JSON 字符串），如 fetch_weather.py 返回结果"
                },
                "extra_sections": {
                    "type": "string",
                    "description": "额外章节（JSON 字符串），格式 {\"章节名\": \"内容\"}"
                },
                "report_time": {
                    "type": "string",
                    "description": "报告时间（可选），格式 YYYY-MM-DD HH:MM"
                }
            },
            "required": ["report_type"]
        },
        returns={
            "type": "object",
            "description": "生成的报告对象，含结构化数据和 Markdown 正文",
            "shape": {
                "report_type": "string",
                "title": "string",
                "location": "string",
                "report_time": "string",
                "sections": "object",
                "markdown": "string",
            },
        },
        usage_contract=[
            "generate_report 将已有分析结果汇总为标准格式报告",
            "未提供的数据章节会标注'暂无数据'，不会报错",
            "返回 output_type=markdown，llm_hint 中包含完整 Markdown 内容",
            "在 <final_answer> 中直接展示 llm_hint 中的 Markdown 即可",
            "flood_bulletin: 汛情快报（基本情况→雨情水情→预警→风险→措施→建议）",
            "disaster_report: 灾情报告（概述→受灾→响应→救援→需求）",
            "situation_report: 综合态势报告（概览→预警→重点区域→风险→预案→行动）",
        ],
        examples=[
            {
                "input": {
                    "report_type": "flood_bulletin",
                    "title": "南宁市汛情快报",
                    "location": "南宁市",
                    "risk_data": '{"risk_level": "III", "risk_label": "较大"}',
                    "warning_data": '{"warnings": [{"title": "暴雨橙色预警", "warning_level": "橙色"}]}',
                },
                "result_hint": {
                    "report_type": "flood_bulletin",
                    "title": "南宁市汛情快报",
                    "markdown": "# 南宁市汛情快报\n...",
                },
            }
        ],
        source="static",
    ),
]


STATIC_TOOLS = build_function_tools(STATIC_TOOL_CONTRACTS)

