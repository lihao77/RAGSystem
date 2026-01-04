# -*- coding: utf-8 -*-
"""
QAAgent - 知识图谱问答智能体

基于 Function Calling 的问答系统，支持：
- 自然语言查询知识图谱
- 多轮对话和工具调用
- 自主推理和工具组合
"""

import logging
import json
import time
from typing import Dict, List, Any, Optional
from .base import BaseAgent, AgentContext, AgentResponse
from tools.function_definitions import get_tool_definitions
from tools.tool_executor import execute_tool

logger = logging.getLogger(__name__)


class QAAgent(BaseAgent):
    """
    知识图谱问答智能体

    职责：
    1. 理解用户问题
    2. 调用知识图谱工具（通过 Function Calling）
    3. 多轮对话和推理
    4. 生成自然语言答案

    工具：
    - query_knowledge_graph_with_nl - 自然语言查询
    - search_knowledge_graph - 结构化查询
    - get_entity_relations - 关系探索
    - execute_cypher_query - 执行 Cypher
    - analyze_temporal_pattern - 时序分析
    - find_causal_chain - 因果追踪
    - compare_entities - 实体对比
    - aggregate_statistics - 聚合统计
    """

    # 系统提示词
    SYSTEM_PROMPT = """你是一个知识图谱问答助手，专门回答关于广西水旱灾害的问题。

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

    def __init__(self, llm_adapter, agent_config=None, system_config=None, max_rounds: int = None):
        """
        初始化 QAAgent

        Args:
            llm_adapter: LLM 适配器
            agent_config: 智能体独立配置（AgentConfig 实例）
            system_config: 系统配置对象（降级使用）
            max_rounds: 最大对话轮数（可选，不指定则从 agent_config 读取）
        """
        super().__init__(
            name='qa_agent',
            description='知识图谱问答智能体，基于 Function Calling 实现多轮对话和工具调用',
            capabilities=[
                'knowledge_graph_query',
                'multi_turn_conversation',
                'tool_calling',
                'reasoning'
            ],
            llm_adapter=llm_adapter,
            agent_config=agent_config,
            system_config=system_config
        )

        # 从配置中获取 max_rounds，优先使用传入参数
        if max_rounds is not None:
            self.max_rounds = max_rounds
        else:
            self.max_rounds = self.get_custom_param('max_rounds', default=10)

        # 加载工具定义
        self.tools = get_tool_definitions()

        # 根据配置过滤工具
        if agent_config and agent_config.tools and agent_config.tools.enabled_tools:
            enabled_tools = agent_config.tools.enabled_tools
            self.tools = [
                tool for tool in self.tools
                if tool.get('function', {}).get('name') in enabled_tools
            ]
            self.logger.info(f"QAAgent 已根据配置过滤工具，启用: {enabled_tools}")

        self.logger.info(f"QAAgent 初始化完成，可用工具数量: {len(self.tools)}")

    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        """
        判断是否能处理该任务

        QAAgent 处理所有问答类任务
        """
        # 问答类关键词
        qa_keywords = [
            '查询', '什么', '为什么', '如何', '多少', '哪些',
            '情况', '数据', '信息', '详情', '介绍', '说明',
            '有关', '关于', '发生', '影响', '导致'
        ]

        task_lower = task.lower()
        return any(keyword in task_lower for keyword in qa_keywords)

    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        """
        执行问答任务

        流程：
        1. 构建消息历史
        2. 多轮对话循环
        3. 调用 LLM + Function Calling
        4. 执行工具
        5. 生成最终答案

        Args:
            task: 用户问题
            context: 上下文

        Returns:
            AgentResponse
        """
        start_time = time.time()

        try:
            # 1. 构建消息
            messages = self._build_messages(task, context)

            # 2. 多轮对话
            conversation_turns = []
            all_tool_calls = []
            final_answer = None

            for round_num in range(self.max_rounds):
                self.logger.info(f"[QAAgent] 第 {round_num + 1} 轮对话")

                # 调用 LLM
                try:
                    # 获取 LLM 配置（优先使用 agent_config，否则使用系统配置）
                    llm_config = self.get_llm_config()

                    llm_response = self.llm_adapter.chat_completion(
                        messages=messages,
                        provider=llm_config.get('provider'),
                        model=llm_config.get('model_name'),
                        tools=self.tools,
                        temperature=llm_config.get('temperature', 0.2),
                        max_tokens=llm_config.get('max_tokens'),
                        timeout=llm_config.get('timeout'),
                        max_retries=llm_config.get('retry_attempts')
                    )

                    if llm_response.error:
                        self.logger.error(f"LLM 调用失败: {llm_response.error}")
                        return AgentResponse(
                            success=False,
                            error=f"LLM 服务调用失败: {llm_response.error}",
                            agent_name=self.name
                        )

                    assistant_message = {
                        'role': 'assistant',
                        'content': llm_response.content,
                        'tool_calls': llm_response.tool_calls
                    }
                    finish_reason = llm_response.finish_reason

                except Exception as e:
                    self.logger.error(f"LLM 调用异常: {e}", exc_info=True)
                    return AgentResponse(
                        success=False,
                        error=f"LLM 服务调用异常: {str(e)}",
                        agent_name=self.name
                    )

                # 记录对话轮次
                turn = {
                    'round': round_num + 1,
                    'assistant_message': assistant_message
                }

                # 检查是否有工具调用
                tool_calls = assistant_message.get('tool_calls', [])

                if not tool_calls:
                    # 没有工具调用，LLM 直接回答
                    final_answer = assistant_message.get('content', '')
                    turn['final_answer'] = final_answer
                    conversation_turns.append(turn)
                    self.logger.info(f"[QAAgent] LLM 直接回答（无工具调用）")
                    break

                # 执行工具调用
                tool_results = self._execute_tools(tool_calls, all_tool_calls)
                turn['tool_calls'] = tool_calls
                turn['tool_results'] = tool_results
                conversation_turns.append(turn)

                # 将助手消息和工具结果添加到对话
                messages.append(assistant_message)
                messages.extend(tool_results)

                # 检查是否完成
                if finish_reason == 'stop':
                    self.logger.info("[QAAgent] LLM 表示任务完成")
                    # 再调用一次让 LLM 总结答案
                    final_answer = self._generate_final_answer(messages)
                    conversation_turns.append({
                        'round': round_num + 2,
                        'final_answer': final_answer
                    })
                    break

            # 如果循环结束还没有答案
            if final_answer is None:
                final_answer = "抱歉，经过多轮尝试仍未能获取满意的答案。请尝试重新表述您的问题。"

            # 构建响应
            execution_time = time.time() - start_time

            return AgentResponse(
                success=True,
                content=final_answer,
                data={
                    'conversation_turns': conversation_turns,
                    'iterations': len(conversation_turns)
                },
                metadata={
                    'rounds': len(conversation_turns),
                    'tool_calls_count': len(all_tool_calls)
                },
                agent_name=self.name,
                execution_time=execution_time,
                tool_calls=all_tool_calls
            )

        except Exception as e:
            self.logger.error(f"[QAAgent] 执行失败: {e}", exc_info=True)
            return AgentResponse(
                success=False,
                error=f"执行失败: {str(e)}",
                agent_name=self.name,
                execution_time=time.time() - start_time
            )

    def _build_messages(self, task: str, context: AgentContext) -> List[Dict[str, str]]:
        """
        构建消息列表

        Args:
            task: 用户问题
            context: 上下文

        Returns:
            消息列表
        """
        messages = [{"role": "system", "content": self.SYSTEM_PROMPT}]

        # 添加对话历史（最近 6 条）
        history = context.get_history(limit=6)
        for msg in history:
            if msg.get('role') in ['user', 'assistant']:
                messages.append({
                    "role": msg['role'],
                    "content": msg['content']
                })

        # 添加当前问题
        messages.append({"role": "user", "content": task})

        return messages

    def _execute_tools(
        self,
        tool_calls: List[Dict],
        all_tool_calls: List[Dict]
    ) -> List[Dict]:
        """
        执行工具调用

        Args:
            tool_calls: 工具调用列表
            all_tool_calls: 累积的所有工具调用（用于记录）

        Returns:
            工具结果列表
        """
        tool_results = []

        for tool_call in tool_calls:
            tool_name = tool_call['function']['name']
            tool_args = tool_call['function']['arguments']
            tool_call_id = tool_call['id']

            self.logger.info(f"[QAAgent] 调用工具: {tool_name}, 参数: {tool_args}")

            try:
                # 解析参数
                if isinstance(tool_args, str):
                    tool_args = json.loads(tool_args)

                # 执行工具
                result = execute_tool(tool_name, tool_args)

                # 记录工具调用
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

                self.logger.info(f"[QAAgent] 工具 {tool_name} 执行成功")

            except Exception as e:
                self.logger.error(f"[QAAgent] 工具 {tool_name} 执行失败: {e}")

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

        return tool_results

    def _generate_final_answer(self, messages: List[Dict]) -> str:
        """
        生成最终答案

        Args:
            messages: 消息历史

        Returns:
            最终答案文本
        """
        try:
            # 获取 LLM 配置
            llm_config = self.get_llm_config()

            final_response = self.llm_adapter.chat_completion(
                messages=messages,
                provider=llm_config.get('provider'),
                model=llm_config.get('model_name'),
                temperature=llm_config.get('temperature', 0.2),
                max_tokens=llm_config.get('max_tokens'),
                timeout=llm_config.get('timeout'),
                max_retries=llm_config.get('retry_attempts')
            )

            if final_response.error:
                self.logger.error(f"生成最终答案失败: {final_response.error}")
                return "查询已完成，但生成最终答案时出错。"

            return final_response.content or "查询已完成。"

        except Exception as e:
            self.logger.error(f"生成最终答案异常: {e}")
            return "查询已完成，但生成最终答案时出错。"
