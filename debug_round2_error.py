"""
调试 GenericAgent 第二轮调用失败的问题
模拟完整的两轮对话流程
"""
import logging
import json
import requests
import sys
import os

# Add backend directory to path
sys.path.append(os.path.join(os.getcwd(), 'backend'))

from tools.function_definitions import get_tool_definitions

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def debug_second_round_call():
    # Configuration
    API_KEY = "REDACTED_API_KEY"
    API_ENDPOINT = "https://api.deepseek.com/v1"
    MODEL = "deepseek-chat"

    # Get tools
    all_tools = get_tool_definitions()
    qa_tools = [
        'query_knowledge_graph_with_nl',
        'search_knowledge_graph',
        'get_entity_relations',
        'execute_cypher_query',
        'analyze_temporal_pattern',
        'find_causal_chain',
        'compare_entities',
        'aggregate_statistics'
    ]

    tools = [
        tool for tool in all_tools
        if tool.get('function', {}).get('name') in qa_tools
    ]

    print(f"Loaded {len(tools)} tools\n")

    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json"
    }

    # ===== 第一轮调用 =====
    print("=" * 60)
    print("第一轮调用（初始请求）")
    print("=" * 60)

    messages_round1 = [
        {"role": "system", "content": "你是 qa_agent，知识图谱问答智能体"},
        {"role": "user", "content": "2020年南宁发生了多少灾害？"}
    ]

    payload_round1 = {
        "model": MODEL,
        "messages": messages_round1,
        "temperature": 0.7,
        "max_tokens": 4096,
        "tools": tools
    }

    try:
        response1 = requests.post(
            f"{API_ENDPOINT}/chat/completions",
            headers=headers,
            json=payload_round1,
            timeout=30
        )

        print(f"Status: {response1.status_code}")

        if response1.status_code != 200:
            print(f"第一轮失败: {response1.text}")
            return

        response1_data = response1.json()
        print(f"✅ 第一轮成功")

        # 提取关键信息
        assistant_message = response1_data['choices'][0]['message']
        tool_calls = assistant_message.get('tool_calls', [])

        if tool_calls:
            print(f"Tool calls: {len(tool_calls)} 个")
            for tc in tool_calls:
                print(f"  - {tc.get('function', {}).get('name')} (id: {tc.get('id')})")

    except Exception as e:
        print(f"第一轮请求失败: {e}")
        return

    # ===== 模拟工具执行 =====
    print("\n" + "=" * 60)
    print("模拟工具执行")
    print("=" * 60)

    mock_tool_result = "根据知识图谱查询，2020年南宁共发生了15次灾害事件。"
    print(f"工具返回结果: {mock_tool_result}")

    # ===== 第二轮调用 =====
    print("\n" + "=" * 60)
    print("第二轮调用（包含工具结果）")
    print("=" * 60)

    messages_round2 = messages_round1.copy()

    # 添加 assistant 的 tool_calls 消息
    messages_round2.append({
        "role": "assistant",
        "content": assistant_message.get('content'),
        "tool_calls": tool_calls
    })

    # 添加 tool 结果消息
    for tool_call in tool_calls:
        tool_message = {
            "role": "tool",
            "content": mock_tool_result,
            "tool_call_id": tool_call.get('id'),
            "name": tool_call.get('function', {}).get('name')
        }
        messages_round2.append(tool_message)

        print(f"添加 tool 消息:")
        print(f"  - role: tool")
        print(f"  - tool_call_id: {tool_call.get('id')}")
        print(f"  - name: {tool_call.get('function', {}).get('name')}")
        print(f"  - content: {mock_tool_result[:50]}...")

    # 构建第二轮 payload
    payload_round2 = {
        "model": MODEL,
        "messages": messages_round2,
        "temperature": 0.7,
        "max_tokens": 4096,
        "tools": tools
    }

    print(f"\n消息历史长度: {len(messages_round2)}")
    print("消息结构:")
    for i, msg in enumerate(messages_round2):
        role = msg.get('role')
        has_tool_calls = 'tool_calls' in msg
        has_tool_call_id = 'tool_call_id' in msg
        print(f"  [{i}] role={role}, tool_calls={has_tool_calls}, tool_call_id={has_tool_call_id}")

    try:
        response2 = requests.post(
            f"{API_ENDPOINT}/chat/completions",
            headers=headers,
            json=payload_round2,
            timeout=30
        )

        print(f"\nStatus: {response2.status_code}")

        if response2.status_code != 200:
            print(f"\n❌ 第二轮失败!")
            print(f"Error: {response2.text}")

            # 打印完整的 payload 用于调试
            print("\n完整 Payload (不含 tools):")
            debug_payload = {**payload_round2, "tools": f"<{len(tools)} tools>"}
            print(json.dumps(debug_payload, indent=2, ensure_ascii=False))

        else:
            print(f"\n✅ 第二轮成功!")
            response2_data = response2.json()
            final_answer = response2_data['choices'][0]['message'].get('content', '')
            print(f"最终答案: {final_answer}")

    except Exception as e:
        print(f"第二轮请求失败: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    debug_second_round_call()
