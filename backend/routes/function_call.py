# -*- coding: utf-8 -*-
"""
Function Calling API路由
提供给LLM调用的工具接口
"""

from flask import Blueprint, request, jsonify
import logging
import json

from tools.function_definitions import get_tool_definitions, get_tool_by_name
from tools.tool_executor import execute_tool
from config import get_config

logger = logging.getLogger(__name__)

function_call_bp = Blueprint('function_call', __name__)


@function_call_bp.route('/tools', methods=['GET'])
def get_tools():
    """
    获取所有可用的工具定义
    
    返回格式符合OpenAI Function Calling规范
    """
    try:
        tools = get_tool_definitions()
        return jsonify({
            'success': True,
            'data': {
                'tools': tools,
                'count': len(tools)
            }
        })
    except Exception as e:
        logger.error(f'获取工具定义失败: {e}')
        return jsonify({
            'success': False,
            'message': str(e)
        }), 500


@function_call_bp.route('/execute', methods=['POST'])
def execute_tool_call():
    """
    执行工具调用
    
    请求体:
    {
        "tool_name": "search_knowledge_graph",
        "arguments": {
            "keyword": "潘厂水库",
            "time_range": ["2020-01-01", "2020-12-31"]
        }
    }
    """
    try:
        data = request.get_json()
        
        tool_name = data.get('tool_name')
        arguments = data.get('arguments', {})
        
        if not tool_name:
            return jsonify({
                'success': False,
                'message': '缺少tool_name参数'
            }), 400
        
        # 验证工具是否存在
        tool_def = get_tool_by_name(tool_name)
        if not tool_def:
            return jsonify({
                'success': False,
                'message': f'未知的工具: {tool_name}'
            }), 400
        
        # 执行工具
        logger.info(f'执行工具: {tool_name}, 参数: {arguments}')
        result = execute_tool(tool_name, arguments)
        
        return jsonify(result)
        
    except Exception as e:
        logger.error(f'执行工具调用失败: {e}')
        return jsonify({
            'success': False,
            'message': str(e)
        }), 500


@function_call_bp.route('/chat', methods=['POST'])
def chat_with_tools():
    """
    带工具调用的对话接口
    
    这是一个完整的对话流程示例，包含：
    1. 接收用户消息
    2. 调用LLM判断是否需要使用工具
    3. 执行工具调用
    4. 将工具结果返回给LLM
    5. 生成最终回答
    
    请求体:
    {
        "messages": [
            {"role": "user", "content": "查询潘厂水库2020年的情况"}
        ],
        "llm_config": {  // 可选，使用配置文件中的LLM配置
            "api_endpoint": "https://openrouter.ai/api/v1",
            "api_key": "...",
            "model_name": "deepseek/deepseek-chat"
        }
    }
    """
    try:
        import requests
        
        data = request.get_json()
        messages = data.get('messages', [])
        llm_config = data.get('llm_config')
        
        if not messages:
            return jsonify({
                'success': False,
                'message': '缺少messages参数'
            }), 400
        
        # 获取LLM配置
        try:
            config = get_config()
            api_endpoint = config.llm.api_endpoint
            api_key = config.llm.api_key
            model_name = config.llm.model_name
        except Exception as e:
            return jsonify({
                'success': False,
                'message': f'读取配置文件失败: {e}'
            }), 500
        
        # 获取工具定义
        tools = get_tool_definitions()
        
        # 第一次调用LLM，判断是否需要使用工具
        logger.info(f'第一次调用LLM，判断是否需要使用工具')
        response = requests.post(
            f"{api_endpoint}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            },
            json={
                "model": model_name,
                "messages": messages,
                "tools": tools,
                "tool_choice": "auto",
                "temperature": 0.3
            },
            timeout=60
        )
        
        if response.status_code != 200:
            return jsonify({
                'success': False,
                'message': f'LLM API调用失败: {response.text}'
            }), 500
        
        result = response.json()
        assistant_message = result['choices'][0]['message']
        
        # 检查是否需要调用工具
        tool_calls = assistant_message.get('tool_calls', [])
        
        if not tool_calls:
            # 不需要工具，直接返回回答
            return jsonify({
                'success': True,
                'data': {
                    'answer': assistant_message.get('content', ''),
                    'tool_calls': []
                }
            })
        
        # 执行所有工具调用
        logger.info(f'检测到 {len(tool_calls)} 个工具调用')
        tool_results = []
        
        for tool_call in tool_calls:
            tool_name = tool_call['function']['name']
            arguments = json.loads(tool_call['function']['arguments'])
            tool_call_id = tool_call['id']
            
            logger.info(f'执行工具: {tool_name}, 参数: {arguments}')
            
            # 执行工具
            tool_result = execute_tool(tool_name, arguments)
            
            tool_results.append({
                'tool_call_id': tool_call_id,
                'role': 'tool',
                'name': tool_name,
                'content': json.dumps(tool_result, ensure_ascii=False)
            })
        
        # 将工具结果添加到消息历史
        messages.append(assistant_message)
        messages.extend(tool_results)
        
        # 第二次调用LLM，生成最终回答
        logger.info(f'第二次调用LLM，生成最终回答')
        response = requests.post(
            f"{api_endpoint}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            },
            json={
                "model": model_name,
                "messages": messages,
                "temperature": 0.7
            },
            timeout=60
        )
        
        if response.status_code != 200:
            return jsonify({
                'success': False,
                'message': f'LLM API调用失败: {response.text}'
            }), 500
        
        result = response.json()
        final_answer = result['choices'][0]['message']['content']
        
        return jsonify({
            'success': True,
            'data': {
                'answer': final_answer,
                'tool_calls': [
                    {
                        'name': tc['function']['name'],
                        'arguments': json.loads(tc['function']['arguments']),
                        'result': json.loads(tool_results[i]['content'])
                    }
                    for i, tc in enumerate(tool_calls)
                ]
            }
        })
        
    except Exception as e:
        logger.error(f'对话处理失败: {e}')
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'message': str(e)
        }), 500
