from agents.streaming.tool_xml_parser import parse_tools_xml, _coerce_xml_value
from agents.streaming.xml_parser import StreamingXMLParser, TagType


# ============================================================
# XML 子标签参数格式测试
# ============================================================

def test_xml_subtag_basic_parsing():
    """XML 子标签基本解析"""
    content = """
<tool name="read_file">
  <file_path>report.txt</file_path>
  <encoding>utf-8</encoding>
</tool>
"""
    actions, error = parse_tools_xml(content)
    assert error is None
    assert len(actions) == 1
    assert actions[0] == {
        "tool": "read_file",
        "arguments": {"file_path": "report.txt", "encoding": "utf-8"},
    }


def test_xml_cdata_multiline_code():
    """CDATA 包裹的多行代码参数"""
    content = """
<tool name="execute_code">
  <code><![CDATA[import os
for f in os.listdir("."):
    if f.endswith("<.py>"):
        print(f"found: {f}")]]></code>
  <description>列出文件</description>
</tool>
"""
    actions, error = parse_tools_xml(content)
    assert error is None
    assert len(actions) == 1
    args = actions[0]["arguments"]
    assert args["description"] == "列出文件"
    # CDATA 内容原样保留，包含 < > { } 等特殊字符
    assert '<.py>' in args["code"]
    assert 'import os' in args["code"]
    assert 'print(f"found: {f}")' in args["code"]


def test_xml_placeholder_in_value():
    """XML 中的占位符 {result_1} 作为纯文本保留"""
    content = """
<tool name="call_agent">
  <task>生成折线图，数据：{result_1}，X轴=年份</task>
</tool>
"""
    actions, error = parse_tools_xml(content)
    assert error is None
    assert actions[0]["arguments"]["task"] == "生成折线图，数据：{result_1}，X轴=年份"


def test_xml_value_type_coercion():
    """值类型推断（int/bool/string/JSON数组）"""
    content = """
<tool name="create_chart">
  <width>800</width>
  <height>600</height>
  <show_legend>true</show_legend>
  <title>测试图表</title>
  <data>[1, 2, 3]</data>
  <nullable>null</nullable>
</tool>
"""
    actions, error = parse_tools_xml(content)
    assert error is None
    args = actions[0]["arguments"]
    assert args["width"] == 800
    assert args["height"] == 600
    assert args["show_legend"] is True
    assert args["title"] == "测试图表"
    assert args["data"] == [1, 2, 3]
    assert args["nullable"] is None


def test_json_fallback_still_works():
    """JSON fallback 仍正常工作"""
    content = """
<tool name="read_file">{"file_path": "report.txt", "encoding": "utf-8"}</tool>
"""
    actions, error = parse_tools_xml(content)
    assert error is None
    assert actions[0] == {
        "tool": "read_file",
        "arguments": {"file_path": "report.txt", "encoding": "utf-8"},
    }


def test_xml_file_path_space_attribute_is_flattened():
    """file_path 的 space 属性会被扁平化为 file_path_space。"""
    content = """
<tool name="write_file">
  <file_path space="transient">test.txt</file_path>
  <content>hello</content>
</tool>
"""
    actions, error = parse_tools_xml(content)
    assert error is None
    assert actions[0]["arguments"] == {
        "file_path": "test.txt",
        "file_path_space": "transient",
        "content": "hello",
    }




def test_xml_working_dir_space_attribute_is_flattened():
    """working_dir 的 space 属性会被扁平化为 working_dir_space。"""
    content = """
<tool name="execute_bash">
  <working_dir space="workspace">.</working_dir>
  <command>pwd</command>
</tool>
"""
    actions, error = parse_tools_xml(content)
    assert error is None
    assert actions[0]["arguments"] == {
        "working_dir": ".",
        "working_dir_space": "workspace",
        "command": "pwd",
    }


def test_xml_working_dir_without_space_keeps_legacy_shape():
    """无属性的 working_dir 保持旧参数结构。"""
    content = """
<tool name="execute_bash">
  <working_dir>tmp</working_dir>
  <command>pwd</command>
</tool>
"""
    actions, error = parse_tools_xml(content)
    assert error is None
    assert actions[0]["arguments"] == {"working_dir": "tmp", "command": "pwd"}


def test_xml_multiline_without_cdata():
    """多行代码不用 CDATA 时的处理（普通 XML 子标签，值会被 strip）"""
    content = """
<tool name="execute_code">
  <code>
import json
data = json.loads('{"a": 1}')
print(data)
  </code>
  <description>解析JSON</description>
</tool>
"""
    actions, error = parse_tools_xml(content)
    assert error is None
    args = actions[0]["arguments"]
    assert "import json" in args["code"]
    assert "print(data)" in args["code"]
    assert args["description"] == "解析JSON"


def test_coerce_xml_value():
    """_coerce_xml_value 类型推断单元测试"""
    assert _coerce_xml_value("true") is True
    assert _coerce_xml_value("false") is False
    assert _coerce_xml_value("True") is True
    assert _coerce_xml_value("null") is None
    assert _coerce_xml_value("none") is None
    assert _coerce_xml_value("42") == 42
    assert _coerce_xml_value("3.14") == 3.14
    assert _coerce_xml_value("[1,2,3]") == [1, 2, 3]
    assert _coerce_xml_value('{"a": 1}') == {"a": 1}
    assert _coerce_xml_value("hello world") == "hello world"
    # 不是合法 JSON 的花括号字符串保持原样
    assert _coerce_xml_value("{result_1}") == "{result_1}"


def test_xml_arguments_with_nested_item_tags():
    """arguments 标签内嵌套 <item> 子标签时，正确提取为列表，不产生多余的 item 参数"""
    content = """
<tool name="execute_skill_script">
  <skill_name>kg-advanced-query</skill_name>
  <script_name>query.py</script_name>
  <arguments>
    <item>--cypher</item>
    <item><![CDATA[
MATCH (city:地点:entity)-[:locatedIn]->(prov:地点:entity)
WHERE prov.name = '广西壮族自治区'
RETURN city.name AS 城市
]]></item>
    <item>--params</item>
    <item><![CDATA[{"start_date":"2022-01-01"}]]></item>
    <item>--limit</item>
    <item>500</item>
  </arguments>
</tool>
"""
    actions, error = parse_tools_xml(content)
    assert error is None
    assert len(actions) == 1
    args = actions[0]["arguments"]
    assert args["skill_name"] == "kg-advanced-query"
    assert args["script_name"] == "query.py"
    assert isinstance(args["arguments"], list)
    assert "--cypher" in args["arguments"]
    assert "--limit" in args["arguments"]
    assert 500 in args["arguments"] or "500" in args["arguments"]
    # 不应有多余的 item 参数
    assert "item" not in args


def test_xml_arguments_without_item_tags_fallback_to_lines():
    """arguments 标签无 <item> 子标签时，按行分割"""
    content = """
<tool name="execute_skill_script">
  <skill_name>kg-advanced-query</skill_name>
  <script_name>query.py</script_name>
  <arguments>
--cypher
MATCH (n) RETURN n
--limit
100
  </arguments>
</tool>
"""
    actions, error = parse_tools_xml(content)
    assert error is None
    args = actions[0]["arguments"]
    assert args["arguments"] == ["--cypher", "MATCH (n) RETURN n", "--limit", "100"]


# ============================================================
# 原有测试
# ============================================================


def test_parse_tools_xml_supports_cdata_wrapped_json_arguments():
    content = """
<tool name="execute_code"><![CDATA[{
  "code": "result = {'ok': True}",
  "description": "demo"
}]]></tool>
"""

    actions, error = parse_tools_xml(content)

    assert error is None
    assert actions == [
        {
            "tool": "execute_code",
            "arguments": {
                "code": "result = {'ok': True}",
                "description": "demo",
            },
        }
    ]


def test_streaming_xml_parser_supports_final_answer_tag():
    parser = StreamingXMLParser()

    events = parser.feed("<final_answer>done</final_answer>")

    assert [(evt.type, evt.tag, evt.content) for evt in events] == [
        ("tag_open", TagType.FINAL_ANSWER, ""),
        ("content", TagType.FINAL_ANSWER, "done"),
        ("tag_close", TagType.FINAL_ANSWER, ""),
    ]
    assert parser.get_tag_content(TagType.FINAL_ANSWER) == "done"


def test_streaming_xml_parser_keeps_legacy_answer_tag_compatible():
    parser = StreamingXMLParser()

    events = parser.feed("<answer>legacy</answer>")

    assert [(evt.type, evt.tag, evt.content) for evt in events] == [
        ("tag_open", TagType.FINAL_ANSWER, ""),
        ("content", TagType.FINAL_ANSWER, "legacy"),
        ("tag_close", TagType.FINAL_ANSWER, ""),
    ]
    assert parser.get_tag_content(TagType.FINAL_ANSWER) == "legacy"
