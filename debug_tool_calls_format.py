"""
检查 DeepSeek tool_calls 的返回格式
"""
import json
import sys
import os

sys.path.append(os.path.join(os.getcwd(), 'backend'))

from llm_adapter import get_default_adapter
from tools.function_definitions import get_tool_definitions

# 获取工具定义
all_tools = get_tool_definitions()
qa_tools = [
    'query_knowledge_graph_with_nl',
    'search_knowledge_graph',
    'get_entity_relations',
]
tools = [
    tool for tool in all_tools
    if tool.get('function', {}).get('name') in qa_tools
]

print(f"已加载 {len(tools)} 个工具\n")

# 获取 adapter
adapter = get_default_adapter()

# 调用 LLM
messages = [
    {"role": "system", "content": "你是知识图谱问答助手"},
    {"role": "user", "content": "2020年南宁发生多少灾害？"}
]

print("调用 LLM...")
response = adapter.chat_completion(
    messages=messages,
    tools=tools,
    temperature=0.7,
    max_tokens=4096
)

print(f"\n{'='*60}")
print("LLM 响应:")
print(f"{'='*60}")
print(f"Content: {response.content}")
print(f"Error: {response.error}")
print(f"\nTool calls 类型: {type(response.tool_calls)}")
print(f"Tool calls 数量: {len(response.tool_calls) if response.tool_calls else 0}")

if response.tool_calls:
    print(f"\n完整的 tool_calls 结构:")
    print(json.dumps(response.tool_calls, indent=2, ensure_ascii=False))

    print(f"\n解析每个 tool_call:")
    for i, tc in enumerate(response.tool_calls):
        print(f"\n[{i}] Tool Call:")
        print(f"  类型: {type(tc)}")
        print(f"  Keys: {tc.keys() if isinstance(tc, dict) else 'N/A'}")
        print(f"  完整内容: {json.dumps(tc, indent=4, ensure_ascii=False)}")

        # 尝试不同的访问方式
        print(f"\n  尝试访问工具名称:")
        print(f"    tc.get('name'): {tc.get('name')}")
        print(f"    tc.get('function', {{}}).get('name'): {tc.get('function', {}).get('name')}")

        print(f"\n  尝试访问参数:")
        print(f"    tc.get('arguments'): {tc.get('arguments')}")
        print(f"    tc.get('function', {{}}).get('arguments'): {tc.get('function', {}).get('arguments')}")
