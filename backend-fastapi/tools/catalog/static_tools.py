# -*- coding: utf-8 -*-
"""Static common tool definitions."""

from __future__ import annotations

from tools.tool_definition_builder import ToolContract, build_function_tools


STATIC_TOOL_CONTRACTS = [
    ToolContract(
        name="transform_data",
        description="在内存中执行 Python 代码进行数据格式转换，适合小数据量处理。输入数据直接写在代码里，代码执行后必须设置 result 变量作为输出。",
        parameters={
            "type": "object",
            "properties": {
                "python_code": {
                    "type": "string",
                    "description": "Python 转换代码。必须设置 result 变量，类型为 list 或 dict。可用模块：pd（pandas）、json。"
                },
                "description": {
                    "type": "string",
                    "description": "操作描述（可选），例如：'提取字段并重命名'"
                }
            },
            "required": ["python_code"]
        },
        source="static",
    ),
    ToolContract(
        name="process_data_file",
        description="对数据文件执行 Python/Pandas 处理。适合大数据量文件转换、过滤、聚合与导出。",
        parameters={
            "type": "object",
            "properties": {
                "source_path": {
                    "type": "string",
                    "description": "源文件路径，通常来自前一个工具的输出"
                },
                "python_code": {
                    "type": "string",
                    "description": "处理代码。需要读取 source_path，处理后写入 result_path。result_path 由系统自动注入。"
                },
                "description": {
                    "type": "string",
                    "description": "本次处理的简短描述（可选）"
                }
            },
            "required": ["source_path", "python_code"]
        },
        source="static",
    ),
    ToolContract(
        name="generate_chart",
        description="生成 ECharts 图表草稿候选，不直接推送前端。生成后可检查配置文件、按需修改，最后通过 present_chart 决定是否发送前端。",
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
            "description": "成功时返回图表草稿候选信息",
            "shape": {
                "candidate_id": "string",
                "chart_type": "string",
                "config_path": "string",
                "preview": {
                    "title": "string",
                    "chart_type": "string",
                    "series_count": "number",
                    "series_names": "string[]",
                    "dataset_rows": "number",
                },
            },
        },
        usage_contract=[
            "generate_chart 只生成草稿，不会自动发送前端",
            "返回的 candidate_id 可传给 update_chart_config 或 present_chart",
            "config_path 指向完整图表配置文件，可用 read_file 检查",
            "若需要展示，必须再调用 present_chart(candidate_id)",
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
                    "candidate_id": "chart_xxx",
                    "config_path": "./static/temp_data/data_xxx.json",
                },
            }
        ],
        source="static",
    ),
    ToolContract(
        name="update_chart_config",
        description="更新 generate_chart 产生的图表候选配置。默认把 config_patch 深度合并到原配置，replace=true 时整份替换。",
        parameters={
            "type": "object",
            "properties": {
                "candidate_id": {
                    "type": "string",
                    "description": "generate_chart 返回的候选 ID"
                },
                "config_patch": {
                    "type": "object",
                    "description": "要合并或替换到图表配置中的 JSON 对象"
                },
                "replace": {
                    "type": "boolean",
                    "description": "是否用 config_patch 完整替换原配置，默认 false",
                    "default": False
                }
            },
            "required": ["candidate_id", "config_patch"]
        },
        returns={
            "type": "object",
            "description": "成功时返回更新后的图表候选信息",
            "shape": {
                "candidate_id": "string",
                "chart_type": "string",
                "config_path": "string",
                "preview": "object",
                "version": "number",
            },
        },
        usage_contract=[
            "默认对原配置做深度合并",
            "replace=true 时用 config_patch 整份替换原配置",
            "更新后仍不会自动发送前端，如需展示需再调用 present_chart",
        ],
        examples=[
            {
                "input": {
                    "candidate_id": "chart_xxx",
                    "config_patch": {"title": {"text": "更新后的标题"}},
                }
            }
        ],
        source="static",
    ),
    ToolContract(
        name="present_chart",
        description="显式选择某个图表候选用于前端展示。该工具只登记待发布图表，真正的前端事件会在最终答案形成后统一发送。",
        parameters={
            "type": "object",
            "properties": {
                "candidate_id": {
                    "type": "string",
                    "description": "要发布的图表候选 ID"
                }
            },
            "required": ["candidate_id"]
        },
        returns={
            "type": "object",
            "description": "成功时返回已选中的图表和待发布信息",
            "shape": {
                "candidate_id": "string",
                "echarts_config": "object",
                "chart_type": "string",
                "config_path": "string",
                "preview": "object",
            },
        },
        usage_contract=[
            "present_chart 只把图表加入待发布队列",
            "真正的前端事件会在 Agent 形成最终答案后统一发送",
            "若最终答案要展示该图表，需在 <answer> 中插入 [CHART:N]",
        ],
        examples=[
            {
                "input": {
                    "candidate_id": "chart_xxx",
                }
            }
        ],
        source="static",
    ),
    ToolContract(
        name="generate_map",
        description="生成 Leaflet 地图配置。要求数据中包含几何字段和数值字段。",
        parameters={
            "type": "object",
            "properties": {
                "data": {
                    "type": "string",
                    "description": "数据源。可以是 JSON 字符串，也可以是 JSON/CSV 文件路径。"
                },
                "map_type": {
                    "type": "string",
                    "description": "地图类型：heatmap、marker、circle。",
                    "enum": ["heatmap", "marker", "circle"],
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
                }
            },
            "required": ["data", "value_field"]
        },
        allowed_callers=["direct", "code_execution"],
        returns={
            "type": "object",
            "description": "成功时返回地图可视化数据，可直接作为待展示地图使用",
            "shape": {
                "map_type": "string",
                "heat_data": "array",
                "markers": "array",
                "bounds": "number[][]",
                "center": "number[]",
                "title": "string",
                "value_field": "string",
                "total_points": "number",
            },
        },
        usage_contract=[
            "generate_map 成功后会直接形成可展示地图数据",
            "若最终答案要展示该地图，需要插入 [CHART:N] 占位符",
            "地理点数据必须包含 geometry 字段，格式通常是 POINT (lng lat)",
        ],
        examples=[
            {
                "input": {
                    "data": '[{"name":"南宁","value":12,"geometry":"POINT (108.32 22.82)"}]',
                    "map_type": "marker",
                    "title": "示例地图",
                    "name_field": "name",
                    "value_field": "value",
                }
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
]


STATIC_TOOLS = build_function_tools(STATIC_TOOL_CONTRACTS)
