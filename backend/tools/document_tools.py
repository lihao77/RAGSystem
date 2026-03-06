# -*- coding: utf-8 -*-
"""
文档处理工具
用于长文档读取、分块、结构化提取
"""

DOCUMENT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_document",
            "description": "读取文档文件内容。支持 PDF、Word(docx)、TXT、Markdown 格式。自动提取文本内容并返回。",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "文档文件路径，支持绝对路径或相对路径"
                    },
                    "encoding": {
                        "type": "string",
                        "description": "文本文件编码（仅 TXT/MD 需要），默认 utf-8",
                        "default": "utf-8"
                    }
                },
                "required": ["file_path"]
            },
            "allowed_callers": ["direct", "code_execution"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "chunk_document",
            "description": "将长文档分块。支持按字符数、段落、语义分块。返回分块列表，每块包含内容和元数据（块索引、字符位置）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "文档内容（通常来自 read_document 的结果）"
                    },
                    "chunk_size": {
                        "type": "integer",
                        "description": "每块最大字符数，默认 2000",
                        "default": 2000
                    },
                    "chunk_overlap": {
                        "type": "integer",
                        "description": "块之间重叠字符数，默认 200",
                        "default": 200
                    },
                    "strategy": {
                        "type": "string",
                        "description": "分块策略：'fixed'(固定大小)、'paragraph'(按段落)、'semantic'(语义分块)",
                        "enum": ["fixed", "paragraph", "semantic"],
                        "default": "fixed"
                    }
                },
                "required": ["content"]
            },
            "allowed_callers": ["direct", "code_execution"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "extract_structured_data",
            "description": "从文本中提取结构化数据。使用 LLM 按照指定 JSON Schema 提取信息。适用于从长文档中提取实体、事件、关系等结构化信息。",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "要提取的文本内容（可以是文档片段或完整文档）"
                    },
                    "schema": {
                        "type": "object",
                        "description": "JSON Schema 定义，描述要提取的数据结构。必须包含 type、properties 等标准 JSON Schema 字段。"
                    },
                    "instruction": {
                        "type": "string",
                        "description": "提取指令（可选）。补充说明提取规则、注意事项等。例如：'提取所有洪涝灾害事件，包括时间、地点、损失数据'"
                    },
                    "examples": {
                        "type": "array",
                        "description": "示例数据（可选）。提供 1-3 个提取示例，帮助 LLM 理解格式。",
                        "items": {
                            "type": "object"
                        }
                    }
                },
                "required": ["text", "schema"]
            },
            "allowed_callers": ["direct", "code_execution"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "merge_extracted_data",
            "description": "合并多个提取结果。将分块提取的数据合并为完整数据集，自动去重、排序、验证。",
            "parameters": {
                "type": "object",
                "properties": {
                    "data_list": {
                        "type": "array",
                        "description": "提取结果列表，每个元素是一个提取结果（通常来自 extract_structured_data）",
                        "items": {
                            "type": "object"
                        }
                    },
                    "merge_strategy": {
                        "type": "string",
                        "description": "合并策略：'append'(追加)、'deduplicate'(去重)、'merge_by_key'(按键合并)",
                        "enum": ["append", "deduplicate", "merge_by_key"],
                        "default": "deduplicate"
                    },
                    "unique_key": {
                        "type": "string",
                        "description": "唯一键字段名（merge_strategy='deduplicate' 或 'merge_by_key' 时必填）。例如：'id'、'name'、'event_id'"
                    }
                },
                "required": ["data_list"]
            },
            "allowed_callers": ["direct", "code_execution"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "将文本内容写入文件。JSON 数据请先用 json.dumps 序列化为字符串再传入。不指定路径时自动生成临时文件，返回实际保存的文件路径（在 results.file_path 字段中）。若要在同一 <tools> 块内让下一个工具使用此路径，可用链式引用 {result_N.data.results.file_path}；若是下一轮调用，请直接从观察结果文本中复制文件路径字符串填入参数。",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "要写入的文本内容。若要保存 JSON，请先 json.dumps 转为字符串。"
                    },
                    "file_path": {
                        "type": "string",
                        "description": "保存路径（可选）。不指定则自动生成临时文件路径。"
                    },
                    "encoding": {
                        "type": "string",
                        "description": "文件编码，默认 utf-8",
                        "default": "utf-8"
                    }
                },
                "required": ["content"]
            },
            "allowed_callers": ["direct", "code_execution"]
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "读取文件内容，以字符串返回。若文件是 JSON，可对返回的 content 执行 json.loads 解析。file_path 必须是真实的文件路径字符串，不能是占位符变量名。",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "文件路径（绝对路径或相对路径）"
                    },
                    "encoding": {
                        "type": "string",
                        "description": "文件编码，默认 utf-8",
                        "default": "utf-8"
                    }
                },
                "required": ["file_path"]
            },
            "allowed_callers": ["direct", "code_execution"]
        }
    }
]
