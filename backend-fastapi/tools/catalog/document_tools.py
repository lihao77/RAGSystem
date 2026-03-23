# -*- coding: utf-8 -*-
"""Document and file tool definitions."""

from __future__ import annotations

from tools.tool_definition_builder import ToolContract, build_function_tools


DOCUMENT_TOOL_CONTRACTS = [
    ToolContract(
        name="write_file",
        description=(
            "将文本内容写入文件。JSON 数据请先用 json.dumps 序列化为字符串再传入。"
            "不指定路径时系统自动分配受管绝对路径，返回实际保存的文件路径（在 content.file_path 字段中）。"
            "修改已有文件的部分内容，请优先使用 edit_file 工具。"
            "相对路径默认按 workspace 解析，也可用 XML 写法 <file_path space=\"workspace|transient|exports\">..."
            " 显式指定解析根。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "要写入的文本内容。若要保存 JSON，请先 json.dumps 转为字符串。"
                },
                "file_path": {
                    "type": "string",
                    "description": "保存路径（可选）。支持相对路径（系统自动解析为绝对路径）。不指定则系统自动分配受管路径。"
                },
                "encoding": {
                    "type": "string",
                    "description": "文件编码，默认 utf-8",
                    "default": "utf-8"
                }
            },
            "required": ["content"]
        },
        allowed_callers=["direct"],
        returns={
            "type": "object",
            "description": "成功时返回保存后的文件信息",
            "shape": {
                "file_path": "string",
                "file_size": "number",
                "display_path": "string",
            },
        },
        usage_contract=[
            "content 是最终要写入的文本；JSON 请先序列化成字符串",
            "后续工具需要路径时，优先复用返回的 file_path（绝对路径）",
            "若在同一轮链式调用，可引用 {result_N.content.file_path}",
            "修改已有文件的部分内容时，请优先使用 edit_file 工具进行精准替换",
            "content.display_path 是可读展示路径，仅用于向用户展示",
            "支持 workspace/transient/exports 三个受管目录；统一规则见下方“受管目录 space 说明”",
            "不传 file_path 时，仍由 default_output_space 决定自动分配到 workspace/transient/exports",
        ],
        examples=[
            {
                "input": {
                    "content": "{\"city\": \"Nanning\"}",
                },
                "result_hint": {
                    "file_path": "/abs/path/to/output.json",
                    "display_path": "./data/sessions/<session_id>/transient/output_xxx.json",
                },
            },
            {
                "input": {
                    "content": "temporary text",
                    "file_path": "tmp.txt",
                },
                "xml_attrs": {
                    "file_path": {"space": "transient"},
                },
                "result_hint": {
                    "display_path": "./data/sessions/<session_id>/transient/tmp.txt",
                },
            },
            {
                "input": {
                    "content": "# report",
                    "file_path": "report.md",
                },
                "xml_attrs": {
                    "file_path": {"space": "exports"},
                },
                "result_hint": {
                    "display_path": "./data/sessions/<session_id>/exports/<run_id>/report.md",
                },
            }
        ],
        source="document",
    ),
    ToolContract(
        name="read_file",
        description=(
            "按行读取文件内容，返回原始文本内容。"
            "默认从第 1 行开始，最多读取 2000 行。"
            "file_path 必须是真实的文件路径字符串，不能是占位符变量名。"
            "支持相对路径（系统会自动解析为绝对路径；默认按 workspace，支持 XML file_path@space 显式指定）。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "文件路径。支持绝对路径或相对路径（系统自动解析）。优先复用上一步工具返回的 file_path。"
                },
                "encoding": {
                    "type": "string",
                    "description": "文件编码，默认 utf-8",
                    "default": "utf-8"
                },
                "offset": {
                    "type": "integer",
                    "description": "起始行号（1-based），默认 1",
                    "default": 1,
                    "minimum": 1
                },
                "limit": {
                    "type": "integer",
                    "description": "最多读取的行数，默认 2000",
                    "default": 2000,
                    "minimum": 1
                }
            },
            "required": ["file_path"]
        },
        allowed_callers=["direct"],
        returns={
            "type": "object",
            "description": "成功时返回文件内容和分页元数据",
            "shape": {
                "content": "string",
                "metadata": {
                    "file_path": "string",
                    "file_size": "number",
                    "total_lines": "number",
                    "start_line": "number",
                    "end_line": "number",
                    "has_more": "boolean",
                    "next_offset": "number|null",
                },
            },
        },
        usage_contract=[
            "read_file 默认只返回前 2000 行；大文件请用 metadata.next_offset 继续分页",
            "可用 offset/limit 指定行号区间",
            "返回内容为文件原始文本内容，不附带行号",
            "file_path 必须是真实路径字符串，不是变量名文本",
            "支持 workspace/transient/exports 三个受管目录；统一规则见下方“受管目录 space 说明”",
            "数据文件（JSON/GeoJSON/CSV）已有路径时，优先用 preview_data_structure 确认结构；需要确认数据完整性时可用 read_file（带 limit）检查，但确认后只传递文件路径，不要把内容输出到 final_answer",
        ],
        examples=[
            {
                "input": {
                    "file_path": "./data/output.json",
                },
                "result_hint": {
                    "content": "{\"city\": \"Nanning\"}",
                },
            },
            {
                "input": {
                    "file_path": "tmp.txt",
                },
                "xml_attrs": {
                    "file_path": {"space": "transient"},
                },
                "result_hint": {
                    "content": "temporary text",
                },
            },
            {
                "input": {
                    "file_path": "./data/large.txt",
                    "offset": 100,
                    "limit": 50,
                },
                "result_hint": {
                    "content": "第100行内容...",
                    "metadata": {
                        "start_line": 100,
                        "end_line": 149,
                        "has_more": True,
                        "next_offset": 150,
                    },
                },
            }
        ],
        source="document",
    ),
    ToolContract(
        name="preview_data_structure",
        description=(
            "预览文件的数据结构，帮助 Agent 判断 JSON/YAML 的层级、CSV/TSV 的列结构，"
            "或文本文件的基本形态，而不必先读取全部内容。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "要预览结构的文件路径。支持相对路径（系统自动解析为绝对路径）。"
                },
                "encoding": {
                    "type": "string",
                    "description": "文件编码，默认 utf-8",
                    "default": "utf-8"
                },
                "max_preview_rows": {
                    "type": "integer",
                    "description": "最多采样的行数或数组项数，默认 5",
                    "default": 5,
                    "minimum": 1
                },
                "max_depth": {
                    "type": "integer",
                    "description": "结构递归预览的最大深度，默认 3",
                    "default": 3,
                    "minimum": 1
                },
                "max_fields": {
                    "type": "integer",
                    "description": "对象或表结构中最多返回的字段数，默认 20",
                    "default": 20,
                    "minimum": 1
                }
            },
            "required": ["file_path"]
        },
        allowed_callers=["direct", "code_execution"],
        returns={
            "type": "object",
            "description": "成功时返回文件类型、基础元信息和结构预览结果",
            "shape": {
                "content": {
                    "file_path": "string",
                    "file_name": "string",
                    "file_type": "string",
                    "file_size": "number",
                    "structure": "object",
                },
                "metadata": {
                    "file_type": "string",
                    "file_size": "number",
                    "max_preview_rows": "number",
                    "max_depth": "number",
                    "max_fields": "number",
                },
            },
        },
        usage_contract=[
            "适合先探索数据结构，再决定是否调用 read_file 或直接进入后续处理步骤",
            "JSON/YAML 返回层级结构预览；CSV/TSV 返回列与样例行；文本返回行统计与预览",
            "想看更深层结构时可提高 max_depth；想看更多列或样例可提高 max_fields/max_preview_rows",
        ],
        examples=[
            {
                "input": {
                    "file_path": "./data/sample.json",
                    "max_depth": 2,
                },
                "result_hint": {
                    "file_type": "json",
                    "structure": {
                        "type": "object",
                        "fields": {
                            "items": {
                                "type": "array",
                            }
                        },
                    },
                },
            }
        ],
        source="document",
    ),
    ToolContract(
        name="edit_file",
        description=(
            "精准字符串替换编辑文件。old_string 必须在文件中唯一匹配（除非 replace_all=true）。"
            "new_string 为空字符串时表示删除匹配内容。返回 diff 预览和替换次数。"
            "相对路径默认按 workspace 解析，也支持 XML file_path@space 显式指定目录桶。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "要编辑的文件路径。支持相对路径（系统自动解析为绝对路径）。优先复用上一步工具返回的 file_path。"
                },
                "old_string": {
                    "type": "string",
                    "description": "要被替换的原始字符串，必须精确匹配文件中的内容"
                },
                "new_string": {
                    "type": "string",
                    "description": "替换后的字符串。传空字符串表示删除 old_string"
                },
                "encoding": {
                    "type": "string",
                    "description": "文件编码，默认 utf-8",
                    "default": "utf-8"
                },
                "replace_all": {
                    "type": "boolean",
                    "description": "是否替换所有匹配。默认 false，仅在唯一匹配时替换",
                    "default": False
                }
            },
            "required": ["file_path", "old_string", "new_string"]
        },
        allowed_callers=["direct"],
        returns={
            "type": "object",
            "description": "成功时返回替换信息和 diff 预览",
            "shape": {
                "file_path": "string",
                "replacements": "number",
                "file_size": "number",
                "diff_preview": "string",
            },
        },
        usage_contract=[
            "old_string 必须精确匹配文件中的内容，包括空格和换行",
            "默认要求唯一匹配；多处匹配时设 replace_all=true",
            "new_string 为空字符串表示删除",
            "建议先用 read_file 确认要编辑的内容再调用",
            "支持 workspace/transient/exports 三个受管目录；统一规则见下方“受管目录 space 说明”",
        ],
        examples=[
            {
                "input": {
                    "file_path": "note.txt",
                    "old_string": "before",
                    "new_string": "updated",
                },
                "xml_attrs": {
                    "file_path": {"space": "workspace"},
                },
                "result_hint": {
                    "replacements": 1,
                },
            }
        ],
        source="document",
    ),
]


DOCUMENT_TOOLS = build_function_tools(DOCUMENT_TOOL_CONTRACTS)


