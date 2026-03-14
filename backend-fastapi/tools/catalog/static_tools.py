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

