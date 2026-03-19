"""
parse_tools_xml - 解析 <tools> 标签内容为 actions 列表。

主格式（XML 子标签）:
    <tool name="read_document">
      <file_path>report.pdf</file_path>
    </tool>
    <tool name="execute_code">
      <code><![CDATA[import os
print("<hello>")]]></code>
      <description>运行示例</description>
    </tool>

兼容格式（JSON，自动 fallback）:
    <tool name="read_document">{"file_path":"report.pdf"}</tool>

输出格式（与现有 JSON actions 完全一致）:
    [
        {"tool": "read_document", "arguments": {"file_path": "report.pdf"}},
        {"tool": "execute_code", "arguments": {"code": "import os\nprint(\"<hello>\")", "description": "运行示例"}}
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

# 匹配 <variable key="xxx">value</variable> 格式（部分 LLM 输出此格式）
VARIABLE_KEY_PATTERN = re.compile(
    r'<variable\s+key\s*=\s*"([^"]+)"\s*>(.*?)</variable>',
    re.DOTALL
)

CDATA_PATTERN = re.compile(r'^\s*<!\[CDATA\[(.*)\]\]>\s*$', re.DOTALL)

# 匹配 XML 子标签中 CDATA 包裹的字段：<code><![CDATA[...]]></code>
XML_CDATA_FIELD_PATTERN = re.compile(
    r'<([^/>\s][^>\s]*)>\s*<!\[CDATA\[(.*?)\]\]>\s*</\1>',
    re.DOTALL
)

# 匹配 JSON 值位置的裸占位符：{result_1} 或 {result_1.content.layers}
# 仅匹配不在引号内、作为 JSON 值出现的占位符
_BARE_PLACEHOLDER = re.compile(
    r'(?<=[:,\[])(\s*)\{(result_?\d+(?:\.[a-zA-Z0-9_\.]+)?)\}',
    re.IGNORECASE,
)


def _unwrap_cdata(s: str) -> str:
    """移除包裹整个参数体的 CDATA 标记。"""
    match = CDATA_PATTERN.match(s)
    if not match:
        return s
    return match.group(1).strip()


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


def _coerce_xml_value(value: str) -> Any:
    """
    对 XML 子标签提取的字符串值做类型推断。
    - "true"/"false" → bool
    - "null"/"none" → None
    - 纯数字 → int/float
    - "[...]" 或 "{...}" → 尝试 json.loads
    - 其余 → 保持字符串
    """
    lower = value.lower()
    if lower == "true":
        return True
    if lower == "false":
        return False
    if lower in ("null", "none"):
        return None

    # 尝试 int
    try:
        return int(value)
    except ValueError:
        pass

    # 尝试 float
    try:
        return float(value)
    except ValueError:
        pass

    # 尝试 JSON 数组/对象
    if value.startswith(('[', '{')):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, ValueError):
            pass

    return value


def _extract_toplevel_xml_fields(args_str: str) -> List[Tuple[str, str, bool]]:
    """
    提取顶层 XML 子标签，返回 [(tag, value, is_cdata), ...]。
    单次顺序扫描：按开标签出现顺序提取，外层标签消费整个区间后，
    内部嵌套标签自然被跳过。
    """
    results: List[Tuple[str, str, bool]] = []
    # 匹配开标签（不含自闭合），捕获标签名
    open_tag_pattern = re.compile(r'<([^/>\s!][^>\s]*)>')
    pos = 0

    while pos < len(args_str):
        m = open_tag_pattern.search(args_str, pos)
        if not m:
            break

        tag = m.group(1).strip()
        content_start = m.end()

        # 尝试找到匹配的闭标签（处理同名嵌套）
        close_tag = f'</{tag}>'
        open_tag_re = re.compile(rf'<{re.escape(tag)}[\s>]')
        search_pos = content_start
        depth = 1
        found = False

        while depth > 0 and search_pos < len(args_str):
            next_close = args_str.find(close_tag, search_pos)
            if next_close == -1:
                break

            # 计算 search_pos 到 next_close 之间的同名开标签数
            check_pos = search_pos
            while check_pos < next_close:
                nested = open_tag_re.search(args_str, check_pos)
                if nested and nested.start() < next_close:
                    depth += 1
                    check_pos = nested.end()
                else:
                    break

            depth -= 1
            if depth == 0:
                value = args_str[content_start:next_close]
                tag_end = next_close + len(close_tag)
                # 检查值是否是 CDATA 包裹
                cdata_m = CDATA_PATTERN.match(value)
                if cdata_m:
                    results.append((tag, cdata_m.group(1), True))
                else:
                    results.append((tag, value, False))
                pos = tag_end  # 跳过整个标签区间，内部标签不再扫描
                found = True
                break
            else:
                search_pos = next_close + len(close_tag)

        if not found:
            pos = content_start  # 未找到闭标签，跳过这个开标签继续

    return results


def _try_parse_xml_arguments(args_str: str) -> Optional[Dict[str, Any]]:
    """
    尝试将 XML 格式的参数体解析为字典。

    解析优先级：
    1. <variable key="xxx">value</variable> 格式（部分 LLM 输出）
    2. 顶层 XML 子标签提取（CDATA 保持原样，普通值做类型推断）

    其中 <arguments> 标签内容：
    - 如果包含 <item> 子标签，提取为列表
    - 否则按行分割为列表
    """
    # 优先尝试 <variable key="xxx"> 格式
    var_fields = VARIABLE_KEY_PATTERN.findall(args_str)
    if var_fields:
        result = {}
        for key, value in var_fields:
            key = key.strip()
            value = value.strip()
            if key == "arguments":
                items = [line.strip() for line in value.splitlines() if line.strip()]
                result[key] = items
            else:
                result[key] = _coerce_xml_value(value)
        if result:
            logger.debug("参数使用 <variable key> 格式解析成功")
            return result

    # 提取顶层字段
    fields = _extract_toplevel_xml_fields(args_str)
    if not fields:
        return None

    result = {}
    for tag, value, is_cdata in fields:
        if is_cdata:
            # arguments 标签的 CDATA 内容尝试按列表解析，其余原样保留
            if tag == "arguments":
                result[tag] = _parse_list_value(value)
            else:
                result[tag] = value
        elif tag == "arguments":
            result[tag] = _parse_list_value(value)
        else:
            result[tag] = _coerce_xml_value(value.strip())

    return result if result else None


def _parse_list_value(value: str) -> list:
    """
    解析列表类型的标签值。
    - 如果包含 <item> 子标签，提取每个 <item> 的内容，并对每个值做 JSON 解析或去引号处理
    - 如果是 JSON 数组字符串，直接解析
    - 否则按行分割
    """
    # 检查是否有 <item> 子标签
    item_pattern = re.compile(
        r'<item>\s*<!\[CDATA\[(.*?)\]\]>\s*</item>|<item>(.*?)</item>',
        re.DOTALL
    )
    item_matches = item_pattern.findall(value)
    if item_matches:
        items = []
        for cdata_val, plain_val in item_matches:
            v = cdata_val if cdata_val else plain_val.strip()
            if v:
                # 命令行参数始终是字符串，不做类型推断
                # 只去掉首尾引号（如 '"广西"' → '广西'，'"--region"' → '--region'）
                stripped = v.strip()
                if len(stripped) >= 2 and stripped[0] == '"' and stripped[-1] == '"':
                    stripped = stripped[1:-1]
                items.append(stripped)
        return items

    # 尝试 JSON 数组解析
    stripped = value.strip()
    if stripped.startswith('['):
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, list):
                return [str(item) for item in parsed]
        except (json.JSONDecodeError, ValueError):
            pass

    # 无 <item> 子标签，按行分割
    return [line.strip() for line in value.splitlines() if line.strip()]


def _fix_bare_placeholders(s: str) -> str:
    """
    修复 JSON 中未加引号的裸占位符。
    例如 {"layers": {result_1.content.layers}} 中的 {result_1.content.layers}
    会被替换为 "{result_1.content.layers}"，使 JSON 可以正常解析。
    """
    return _BARE_PLACEHOLDER.sub(r'\1"{{\2}}"', s)


def _fix_backslash_paths(s: str) -> str:
    """
    修复 JSON 字符串中 Windows 路径反斜杠导致的非法转义。
    例如 {"file_path": ".\\static\\temp"} 中的 \\s、\\t 等非法转义序列
    会被替换为正斜杠，使 JSON 可以正常解析。
    合法转义（\\\\、\\"、\\/、\\n、\\r、\\t、\\b、\\f、\\uXXXX）保持不变。
    """
    LEGAL_ESCAPES = {'"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u'}
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
        args_str = _unwrap_cdata(args_str)

        if not args_str:
            # 无参数工具调用
            actions.append({"tool": tool_name, "arguments": {}})
            continue

        # ① XML 子标签优先（纯 JSON 不含 XML 标签，会返回 None，自然 fallback）
        xml_arguments = _try_parse_xml_arguments(args_str)
        if xml_arguments:
            logger.debug(f"工具 '{tool_name}' 参数使用 XML 格式解析成功")
            actions.append({"tool": tool_name, "arguments": xml_arguments})
            continue

        # ② JSON 直接解析
        try:
            arguments = json.loads(args_str)
            if not isinstance(arguments, dict):
                arguments = {"value": arguments}
            actions.append({"tool": tool_name, "arguments": arguments})
            continue
        except json.JSONDecodeError:
            pass

        # ③ JSON 修复：裸占位符
        placeholder_fixed = _fix_bare_placeholders(args_str)
        if placeholder_fixed != args_str:
            try:
                arguments = json.loads(placeholder_fixed)
                if not isinstance(arguments, dict):
                    arguments = {"value": arguments}
                logger.debug(f"工具 '{tool_name}' 参数经裸占位符修复后解析成功")
                actions.append({"tool": tool_name, "arguments": arguments})
                continue
            except json.JSONDecodeError:
                pass

        # ④ JSON 修复：反斜杠路径
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

        # ⑤ JSON 提取：从混杂内容中提取第一个完整 JSON 对象
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

        # 所有解析方式都失败，记录错误并跳过该工具调用
        errors.append(f"工具 '{tool_name}' 参数解析失败，原始内容: {args_str[:100]}")
        logger.warning(f"工具 '{tool_name}' 参数解析失败，跳过该调用")

    error_msg = "; ".join(errors) if errors else None
    return actions, error_msg
