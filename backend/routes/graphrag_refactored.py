# -*- coding: utf-8 -*-
"""
GraphRAG路由 - 基于知识图谱的问答系统（重构版）

原始版本已备份到 graphrag.py.backup
此版本使用服务层架构，大幅简化路由文件
"""

from flask import Blueprint, request
import logging
from services.graphrag_service import get_graphrag_service
from services.query_service import get_query_service
from llm_adapter import get_default_adapter
from utils.response_helpers import success_response, error_response
from config import get_config

logger = logging.getLogger(__name__)

graphrag_bp = Blueprint('graphrag', __name__)


@graphrag_bp.route('/schema', methods=['GET'])
def get_schema():
    """获取图谱结构"""
    try:
        query_service = get_query_service()
        schema = query_service.get_graph_schema()
        
        if schema:
            return success_response(data=schema, message='获取图谱结构成功')
        else:
            return error_response(message='获取图谱结构失败', status_code=500)
    except Exception as e:
        logger.error(f'获取图谱结构API错误: {e}')
        return error_response(message=str(e), status_code=500)


@graphrag_bp.route('/query', methods=['POST'])
def query():
    """
    基于 Function Calling 的 GraphRAG 问答
    LLM 自主选择工具，支持多步推理和工具组合
    """
    try:
        data = request.get_json()
        user_question = data.get('question', '').strip()
        conversation_history = data.get('history', [])
        
        if not user_question:
            return error_response(message='问题不能为空', status_code=400)
        
        logger.info(f'使用 Function Calling 处理问题: {user_question}')
        
        # 导入工具模块
        from tools.function_definitions import get_tool_definitions
        from tools.tool_executor import execute_tool
        
        # 获取配置
        config = get_config()
        adapter = get_default_adapter()

        # 获取所有可用工具
        tools = get_tool_definitions()
        
        # 构建系统提示词（从原文件保留）
        system_prompt = """你是一个知识图谱问答助手，专门回答关于广西水旱灾害的问题。

**核心原则：循序渐进、分步推理**

⚠️ **关键图谱知识：损失数据的存储位置**
- 经济损失、受灾人口等数据**不仅仅存储在事件状态(ES-E-)中**！
- 损失数据可能分散在：
  1. **事件状态节点** (ES-E-*) - 灾害事件的整体统计
  2. **地点状态节点** (LS-L-*) - 各市县的受灾情况
  3. **联合状态节点** (JS-*) - 多个地区的汇总统计
- ⚠️ 查询损失时，必须同时考虑所有State类型，不能只查事件！

你拥有以下工具：

📊 **基础检索工具**
1. query_knowledge_graph_with_nl - 自然语言查询（自动生成Cypher）⭐推荐优先使用
2. search_knowledge_graph - 结构化筛选查询
3. get_entity_relations - 实体关系网络探索
4. execute_cypher_query - 直接执行Cypher
5. get_graph_schema - 获取图谱结构元数据

🔍 **高级分析工具**
6. analyze_temporal_pattern - 时序趋势分析
7. find_causal_chain - 因果链路追踪
8. compare_entities - 多实体对比
9. aggregate_statistics - 聚合统计

**决策流程：**
1. **首选方案**：使用 query_knowledge_graph_with_nl，它会自动生成最优Cypher
2. **次选方案**：如果问题很结构化（如"查找某类型实体"），可用 search_knowledge_graph
3. **高级分析**：涉及时序、因果、对比时，使用对应专用工具
4. **验证结果**：如果结果不符合预期，尝试换另一个工具或组合使用

**重要提示：**
- 🔴 **禁止猜测或编造数据**！如果查询无结果，明确告知用户
- 🔴 工具调用失败时，必须解释原因，不要返回空答案
- ✅ 可以多次调用工具，逐步缩小查询范围
- ✅ 发现数据分散时，考虑组合多个查询
"""
        
        # 构建初始消息
        messages = [{"role": "system", "content": system_prompt}]
        
        # 添加对话历史
        for msg in conversation_history[-6:]:
            if msg.get('role') in ['user', 'assistant']:
                messages.append({
                    "role": msg['role'],
                    "content": msg['content']
                })
        
        messages.append({"role": "user", "content": user_question})
        
        # 多轮对话循环（最多10轮）
        max_rounds = 10
        conversation_turns = []
        all_tool_calls = []  # 记录所有工具调用（用于前端显示）
        final_answer = None
        
        for round_num in range(max_rounds):
            logger.info(f'第 {round_num + 1} 轮对话')
            
            # 调用LLM（支持Function Calling）
            try:
                response = adapter.chat_completion(
                    messages=messages,
                    provider=config.llm.provider,
                    model=config.llm.model_name,
                    tools=tools,
                    temperature=0.2
                )

                if response.error:
                    logger.error(f'LLM调用失败: {response.error}')
                    return error_response(message=f'LLM服务调用失败: {response.error}', status_code=500)

                assistant_message = {
                    'role': 'assistant',
                    'content': response.content,
                    'tool_calls': response.tool_calls
                }
                finish_reason = response.finish_reason
            except Exception as e:
                logger.error(f'LLM调用失败: {e}')
                return error_response(message=f'LLM服务调用失败: {str(e)}', status_code=500)
            
            # 记录对话轮次
            turn = {
                'round': round_num + 1,
                'assistant_message': assistant_message
            }
            
            # 检查是否有工具调用
            tool_calls = assistant_message.get('tool_calls', [])
            
            if not tool_calls:
                # 没有工具调用，LLM直接回答
                final_answer = assistant_message.get('content', '')
                turn['final_answer'] = final_answer
                conversation_turns.append(turn)
                logger.info(f'LLM直接回答（无工具调用）')
                break
            
            # 执行所有工具调用
            tool_results = []
            for tool_call in tool_calls:
                tool_name = tool_call['function']['name']
                tool_args = tool_call['function']['arguments']
                tool_call_id = tool_call['id']
                
                logger.info(f'调用工具: {tool_name}, 参数: {tool_args}')
                
                try:
                    # 执行工具
                    if isinstance(tool_args, str):
                        import json
                        tool_args = json.loads(tool_args)
                    
                    result = execute_tool(tool_name, tool_args)
                    
                    # 记录工具调用（用于前端显示）
                    all_tool_calls.append({
                        'name': tool_name,
                        'arguments': tool_args,
                        'result': result
                    })
                    
                    tool_results.append({
                        'tool_call_id': tool_call_id,
                        'role': 'tool',
                        'name': tool_name,
                        'content': json.dumps(result, ensure_ascii=False)
                    })
                    
                    logger.info(f'工具 {tool_name} 执行成功')
                    
                except Exception as e:
                    logger.error(f'工具 {tool_name} 执行失败: {e}')
                    
                    error_result = {
                        'success': False,
                        'error': str(e)
                    }
                    
                    # 记录失败的工具调用
                    all_tool_calls.append({
                        'name': tool_name,
                        'arguments': tool_args,
                        'result': error_result
                    })
                    
                    tool_results.append({
                        'tool_call_id': tool_call_id,
                        'role': 'tool',
                        'name': tool_name,
                        'content': json.dumps(error_result, ensure_ascii=False)
                    })
            
            turn['tool_calls'] = tool_calls
            turn['tool_results'] = tool_results
            conversation_turns.append(turn)
            
            # 将助手消息和工具结果添加到对话
            messages.append(assistant_message)
            messages.extend(tool_results)
            
            # 如果finish_reason是stop，说明LLM认为任务完成
            if finish_reason == 'stop':
                logger.info('LLM表示任务完成')
                # 再调用一次让LLM总结答案
                try:
                    final_response = adapter.chat_completion(
                        messages=messages,
                        provider=config.llm.provider,
                        model=config.llm.model_name,
                        temperature=0.2
                    )

                    if final_response.error:
                        logger.error(f'生成最终答案失败: {final_response.error}')
                        final_answer = "查询已完成，但生成最终答案时出错。"
                    else:
                        final_answer = final_response.content or ''

                    conversation_turns.append({
                        'round': round_num + 2,
                        'final_answer': final_answer
                    })
                except Exception as e:
                    logger.error(f'生成最终答案失败: {e}')
                    final_answer = "查询已完成，但生成最终答案时出错。"
                break
        
        # 如果循环结束还没有答案
        if final_answer is None:
            final_answer = "抱歉，经过多轮尝试仍未能获取满意的答案。请尝试重新表述您的问题。"
        
        return success_response(
            data={
                'answer': final_answer,
                'tool_calls': all_tool_calls,  # ← 添加工具调用记录（前端显示用）
                'conversation_turns': conversation_turns,
                'iterations': len(conversation_turns)
            },
            message='查询成功'
        )
        
    except Exception as e:
        logger.error(f'GraphRAG查询错误: {e}', exc_info=True)
        return error_response(message=f'查询处理失败: {str(e)}', status_code=500)


@graphrag_bp.route('/execute_cypher', methods=['POST'])
def execute_custom_cypher():
    """执行自定义Cypher查询"""
    try:
        data = request.get_json()
        cypher = data.get('cypher', '').strip()
        
        if not cypher:
            return error_response(message='Cypher语句不能为空', status_code=400)
        
        # 安全检查：只允许查询操作
        forbidden_keywords = ['CREATE', 'DELETE', 'REMOVE', 'SET', 'MERGE', 'DROP']
        cypher_upper = cypher.upper()
        for keyword in forbidden_keywords:
            if keyword in cypher_upper:
                return error_response(
                    message=f'不允许执行包含 {keyword} 的操作',
                    status_code=403
                )
        
        logger.info(f'执行自定义Cypher: {cypher}')
        
        query_service = get_query_service()
        result = query_service.execute_cypher(cypher)
        
        return success_response(
            data=result,
            message='查询执行成功'
        )
        
    except Exception as e:
        logger.error(f'执行Cypher失败: {e}')
        return error_response(message=f'查询执行失败: {str(e)}', status_code=500)
