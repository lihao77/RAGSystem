# -*- coding: utf-8 -*-
"""
Agent-first 工具定义。

当前默认工具面只保留与智能体主链直接相关的通用能力：
- 文档读取与结构化提取
- 数据转换与文件处理
- 图表/地图可视化
- 受限代码执行

MCP 工具与 Skills 系统工具不在此处静态声明：
- MCP 工具由 AgentLoader 在运行时注入
- Skills 系统工具由 AgentLoader 在启用 Skill 时自动补充
"""

from __future__ import annotations

from capabilities.document_retrieval import DocumentRetrievalCapability


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "transform_data",
            "description": "在内存中执行 Python 代码进行数据格式转换，适合小数据量处理。输入数据直接写在代码里，代码执行后必须设置 result 变量作为输出。",
            "parameters": {
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
            "allowed_callers": ["direct"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "process_data_file",
            "description": "对数据文件执行 Python/Pandas 处理。适合大数据量文件转换、过滤、聚合与导出。",
            "parameters": {
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
            "allowed_callers": ["direct"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "generate_chart",
            "description": "生成 ECharts 图表配置。支持 JSON 字符串、对象数组或文件路径作为数据源。",
            "parameters": {
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
            "allowed_callers": ["direct"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "generate_map",
            "description": "生成 Leaflet 地图配置。要求数据中包含几何字段和数值字段。",
            "parameters": {
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
            "allowed_callers": ["direct", "code_execution"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "execute_code",
            "description": "在受限沙箱中执行 Python 代码进行复杂工具编排与数据处理。支持通过 call_tool 调用允许的其他工具，必须设置 result 变量作为输出。",
            "parameters": {
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
            "allowed_callers": ["direct"]
        }
    },
]


TOOLS.extend(DocumentRetrievalCapability().list_tool_definitions())

# Human-in-the-Loop 伪工具定义迁移至 agents/tools/builtin.py；
# 这里保留导入，兼容已有 import。
from agents.tools.builtin import REQUEST_USER_INPUT_TOOL  # noqa: F401


def get_tool_definitions():
    """获取当前默认工具定义。"""
    return TOOLS


def get_tool_by_name(name):
    """按名称查找工具定义。"""
    for tool in TOOLS:
        if tool["function"]["name"] == name:
            return tool
    return None


def get_code_callable_tools():
    """获取允许从 execute_code 中调用的工具名称。"""
    return [
        tool["function"]["name"]
        for tool in TOOLS
        if "code_execution" in tool["function"].get("allowed_callers", ["direct"])
    ]
