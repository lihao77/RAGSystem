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
            }
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
            }
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
            }
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
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "save_json_file",
            "description": "保存 JSON 数据到文件。支持格式化输出、编码设置。返回保存的文件路径。",
            "parameters": {
                "type": "object",
                "properties": {
                    "data": {
                        "type": "object",
                        "description": "要保存的数据（dict 或 list）"
                    },
                    "file_path": {
                        "type": "string",
                        "description": "保存路径（可选）。不指定则自动生成临时文件路径。"
                    },
                    "indent": {
                        "type": "integer",
                        "description": "JSON 缩进空格数，默认 2（美化输出）",
                        "default": 2
                    },
                    "ensure_ascii": {
                        "type": "boolean",
                        "description": "是否转义非 ASCII 字符，默认 False（保留中文）",
                        "default": False
                    }
                },
                "required": ["data"]
            }
        }
    }
]
