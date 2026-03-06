"""
parse_tools_xml - 解析 <tools> 标签内容为 actions 列表。

输入格式:
    <tool name="search_knowledge_graph">{"keyword":"南宁"}</tool>
    <tool name="get_entity_relations">{"entity":"南宁市"}</tool>

输出格式（与现有 JSON actions 完全一致）:
    [
        {"tool": "search_knowledge_graph", "arguments": {"keyword": "南宁"}},
        {"tool": "get_entity_relations", "arguments": {"entity": "南宁市"}}
    ]
"""

import json
import logging
import re
from typing import Any, Dict, List, Optional, Tuple


logger = logging.getLogger(__name__)

# 匹配 <tool name="xxx">...</tool> 模式
TOOL_PATTERN = re.compile(
    r'<tool\s+name\s*=\s*"([^"]+)"\s*>(.*?)</tool>',
    re.DOTALL
)

# 兜底：匹配未闭合的 <tool name="xxx">... （stop token 截断导致 </tool> 丢失）
TOOL_PATTERN_UNCLOSED = re.compile(
    r'<tool\s+name\s*=\s*"([^"]+)"\s*>(.*?)(?=<tool[\s>]|</tools>|$)',
    re.DOTALL
)

# 匹配 XML 子标签 <tagname>value</tagname>
XML_FIELD_PATTERN = re.compile(
    r'<([^/>\s][^>\s]*)>(.*?)</\1>',
    re.DOTALL
)


def _extract_json_object(s: str) -> Optional[str]:
    """
    从字符串中提取第一个完整的 JSON 对象（{...}）。
    用于处理 args_str 中混入了额外标签或文本的情况。
    """
    start = s.find('{')
    if start == -1:
        return None
    depth = 0
    in_str = False
    escape = False
    for i, ch in enumerate(s[start:], start):
        if escape:
            escape = False
            continue
        if ch == '\\' and in_str:
            escape = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return s[start:i + 1]
    return None


def _try_parse_xml_arguments(args_str: str) -> Optional[Dict[str, Any]]:
    """
    尝试将 XML 格式的参数体解析为字典。
    处理形如：
        <skill_name>kg-advanced-query</skill_name>
        <script_name>query.py</script_name>
        <arguments>
        --cypher
        MATCH ...
        --params
        {"name": "x"}
        </arguments>
    其中嵌套的 <arguments> 标签内容解析为字符串列表（按行分割，过滤空行）。
    """
    fields = XML_FIELD_PATTERN.findall(args_str)
    if not fields:
        return None

    result = {}
    for tag, value in fields:
        value = value.strip()
        tag = tag.strip()

        # 嵌套 <arguments> 标签：把多行内容拆成列表
        if tag == "arguments":
            items = [line.strip() for line in value.splitlines() if line.strip()]
            result[tag] = items
        else:
            result[tag] = value

    return result if result else None


def _fix_backslash_paths(s: str) -> str:
    """
    修复 JSON 字符串中 Windows 路径反斜杠导致的非法转义。
    例如 {"file_path": ".\\static\\temp"} 中的 \\s、\\t 等非法转义序列
    会被替换为正斜杠，使 JSON 可以正常解析。
    合法转义（\\\\、\\"、\\/、\\n、\\r、\\t、\\b、\\f、\\uXXXX）保持不变。
    """
    LEGAL_ESCAPES = set('"\\\/bfnrtu')
    result = []
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == '\\' and i + 1 < len(s):
            next_ch = s[i + 1]
            if next_ch not in LEGAL_ESCAPES:
                result.append('/')
                i += 1
                continue
        result.append(ch)
        i += 1
    return ''.join(result)


def parse_tools_xml(content: str) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """
    解析 <tools> 标签内的工具调用 XML。

    Args:
        content: <tools>...</tools> 标签之间的内容

    Returns:
        (actions_list, error_message)
        - actions_list: 解析成功的 action 列表，每个 action 包含 tool 和 arguments
        - error_message: 解析出错时的错误信息，成功则为 None
    """
    if not content or not content.strip():
        return [], "空的 tools 内容"

    matches = TOOL_PATTERN.findall(content)
    if not matches:
        # 兜底：尝试匹配未闭合的 <tool> 标签（stop token 截断了 </tool>）
        matches = TOOL_PATTERN_UNCLOSED.findall(content)
    if not matches:
        return [], f"未找到有效的 <tool> 标签，内容: {content[:200]}"

    actions = []
    errors = []

    for tool_name, args_str in matches:
        tool_name = tool_name.strip()
        args_str = args_str.strip()

        if not args_str:
            # 无参数工具调用
            actions.append({"tool": tool_name, "arguments": {}})
            continue

        # 先尝试直接 JSON 解析
        try:
            arguments = json.loads(args_str)
            if not isinstance(arguments, dict):
                arguments = {"value": arguments}
            actions.append({"tool": tool_name, "arguments": arguments})
            continue
        except json.JSONDecodeError:
            pass

        # JSON 解析失败：尝试修复反斜杠路径后再解析
        fixed_str = _fix_backslash_paths(args_str)
        if fixed_str != args_str:
            try:
                arguments = json.loads(fixed_str)
                if not isinstance(arguments, dict):
                    arguments = {"value": arguments}
                logger.debug(f"工具 '{tool_name}' 参数经反斜杠修复后解析成功")
                actions.append({"tool": tool_name, "arguments": arguments})
                continue
            except json.JSONDecodeError:
                pass

        # JSON 解析失败：args_str 可能混入了多余内容（残留标签等）
        # 尝试从中提取第一个完整 JSON 对象
        json_str = _extract_json_object(args_str)
        if json_str:
            try:
                arguments = json.loads(json_str)
                if not isinstance(arguments, dict):
                    arguments = {"value": arguments}
                logger.debug(f"工具 '{tool_name}' 参数通过 JSON 提取解析成功")
                actions.append({"tool": tool_name, "arguments": arguments})
                continue
            except json.JSONDecodeError:
                pass

        # 尝试 XML 格式解析
        xml_arguments = _try_parse_xml_arguments(args_str)
        if xml_arguments:
            logger.debug(f"工具 '{tool_name}' 参数使用 XML 格式解析成功")
            actions.append({"tool": tool_name, "arguments": xml_arguments})
            continue

        # 所有解析方式都失败，记录错误并跳过该工具调用
        errors.append(f"工具 '{tool_name}' 参数解析失败，原始内容: {args_str[:100]}")
        logger.warning(f"工具 '{tool_name}' 参数解析失败，跳过该调用")

    error_msg = "; ".join(errors) if errors else None
    return actions, error_msg
