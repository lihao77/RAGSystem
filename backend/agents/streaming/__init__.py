"""
流式输出子包 - XML 标签格式的增量解析与流式执行。

核心组件:
- StreamingXMLParser: 增量 XML 标签解析器
- parse_tools_xml: 工具调用 XML 解析
- StreamExecutor: Agent 共用的流式 LLM 执行逻辑
"""

from .xml_parser import StreamingXMLParser, TagType, ParseEvent
from .tool_xml_parser import parse_tools_xml
from .stream_executor import StreamExecutor, StreamResult

__all__ = [
    'StreamingXMLParser', 'TagType', 'ParseEvent',
    'parse_tools_xml',
    'StreamExecutor', 'StreamResult',
]
