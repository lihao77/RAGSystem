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

        try:
            arguments = json.loads(args_str)
            if not isinstance(arguments, dict):
                arguments = {"value": arguments}
            actions.append({"tool": tool_name, "arguments": arguments})
        except json.JSONDecodeError as e:
            errors.append(f"工具 '{tool_name}' 参数 JSON 解析失败: {e}, 原始: {args_str[:100]}")
            # 仍然添加，但参数为原始字符串
            actions.append({"tool": tool_name, "arguments": {"_raw": args_str}})

    error_msg = "; ".join(errors) if errors else None
    return actions, error_msg
