# -*- coding: utf-8 -*-
"""
GraphRAG API 服务层。
"""

from __future__ import annotations

from runtime.dependencies import get_runtime_dependency
import json
from typing import Any, Dict, Optional

from config import get_config
from model_adapter import get_default_adapter
from services.query_service import get_query_service


class GraphRAGApiServiceError(Exception):
    """GraphRAG API 业务异常。"""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


_GRAPH_RAG_SYSTEM_PROMPT = """你是一个知识图谱问答助手，专门回答关于广西水旱灾害的问题。

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


class GraphRAGApiService:
    """封装 GraphRAG schema、工具问答与安全 Cypher 执行。"""

    def __init__(
        self,
        *,
        query_service=None,
        config_getter=None,
        adapter=None,
        tool_definitions_getter=None,
        tool_executor=None,
    ):
        self._query_service = query_service
        self._config_getter = config_getter or get_config
        self._adapter = adapter
        self._tool_definitions_getter = tool_definitions_getter
        self._tool_executor = tool_executor

    def get_schema(self):
        schema = self._get_query_service().get_graph_schema()
        if not schema:
            raise GraphRAGApiServiceError('获取图谱结构失败', status_code=500)
        return schema

    def query_with_tools(self, payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        data = payload or {}
        user_question = (data.get('question') or '').strip()
        conversation_history = data.get('history', [])
        if not user_question:
            raise GraphRAGApiServiceError('问题不能为空', status_code=400)

        config = self._config_getter()
        adapter = self._get_adapter()
        tools = self._get_tool_definitions()

        messages = [{'role': 'system', 'content': _GRAPH_RAG_SYSTEM_PROMPT}]
        for message in conversation_history[-6:]:
            if message.get('role') in ['user', 'assistant']:
                messages.append({'role': message['role'], 'content': message['content']})
        messages.append({'role': 'user', 'content': user_question})

        max_rounds = 10
        conversation_turns = []
        all_tool_calls = []
        final_answer = None

        for round_num in range(max_rounds):
            response = adapter.chat_completion(
                messages=messages,
                provider=config.llm.provider,
                model=config.llm.model_name,
                tools=tools,
                temperature=0.2,
            )
            if getattr(response, 'error', None):
                raise GraphRAGApiServiceError(f'LLM服务调用失败: {response.error}', status_code=500)

            assistant_message = {
                'role': 'assistant',
                'content': getattr(response, 'content', ''),
                'tool_calls': getattr(response, 'tool_calls', []),
            }
            finish_reason = getattr(response, 'finish_reason', None)
            turn = {'round': round_num + 1, 'assistant_message': assistant_message}
            tool_calls = assistant_message.get('tool_calls', [])

            if not tool_calls:
                final_answer = assistant_message.get('content', '')
                turn['final_answer'] = final_answer
                conversation_turns.append(turn)
                break

            tool_results = []
            for tool_call in tool_calls:
                tool_name = tool_call['function']['name']
                tool_args = tool_call['function']['arguments']
                tool_call_id = tool_call['id']
                if isinstance(tool_args, str):
                    tool_args = json.loads(tool_args)
                try:
                    result = self._execute_tool(tool_name, tool_args)
                except Exception as error:
                    result = {'success': False, 'error': str(error)}

                all_tool_calls.append({'name': tool_name, 'arguments': tool_args, 'result': result})
                tool_results.append(
                    {
                        'tool_call_id': tool_call_id,
                        'role': 'tool',
                        'name': tool_name,
                        'content': json.dumps(result, ensure_ascii=False),
                    }
                )

            turn['tool_calls'] = tool_calls
            turn['tool_results'] = tool_results
            conversation_turns.append(turn)
            messages.append(assistant_message)
            messages.extend(tool_results)

            if finish_reason == 'stop':
                final_response = adapter.chat_completion(
                    messages=messages,
                    provider=config.llm.provider,
                    model=config.llm.model_name,
                    temperature=0.2,
                )
                if getattr(final_response, 'error', None):
                    final_answer = '查询已完成，但生成最终答案时出错。'
                else:
                    final_answer = getattr(final_response, 'content', '') or ''
                conversation_turns.append({'round': round_num + 2, 'final_answer': final_answer})
                break

        if final_answer is None:
            final_answer = '抱歉，经过多轮尝试仍未能获取满意的答案。请尝试重新表述您的问题。'

        return {
            'answer': final_answer,
            'tool_calls': all_tool_calls,
            'conversation_turns': conversation_turns,
            'iterations': len(conversation_turns),
        }

    def execute_custom_cypher(self, payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        data = payload or {}
        cypher = (data.get('cypher') or '').strip()
        if not cypher:
            raise GraphRAGApiServiceError('Cypher语句不能为空', status_code=400)

        forbidden_keywords = ['CREATE', 'DELETE', 'REMOVE', 'SET', 'MERGE', 'DROP']
        cypher_upper = cypher.upper()
        for keyword in forbidden_keywords:
            if keyword in cypher_upper:
                raise GraphRAGApiServiceError(f'不允许执行包含 {keyword} 的操作', status_code=403)

        return self._get_query_service().execute_cypher(cypher)

    def _get_query_service(self):
        return self._query_service or get_query_service()

    def _get_adapter(self):
        return self._adapter or get_default_adapter()

    def _get_tool_definitions(self):
        if self._tool_definitions_getter is not None:
            return self._tool_definitions_getter()
        from tools.function_definitions import get_tool_definitions
        return get_tool_definitions()

    def _execute_tool(self, tool_name: str, arguments: Dict[str, Any]):
        if self._tool_executor is not None:
            return self._tool_executor(tool_name, arguments)
        from tools.tool_executor import execute_tool
        return execute_tool(tool_name, arguments)


_graphrag_api_service: Optional[GraphRAGApiService] = None



def get_graphrag_api_service() -> GraphRAGApiService:
    global _graphrag_api_service
    return get_runtime_dependency(
        container_getter='get_graphrag_api_service',
        fallback_name='graphrag_api_service',
        fallback_factory=GraphRAGApiService,
        legacy_getter=lambda: _graphrag_api_service,
        legacy_setter=lambda instance: globals().__setitem__('_graphrag_api_service', instance),
    )
