# -*- coding: utf-8 -*-
"""
MasterAgent - 主协调智能体

职责：
1. 分析任务复杂度
2. 自动任务分解
3. 智能体编排和协调
4. 结果整合和总结
"""

import logging
import json
import time
from typing import Dict, List, Any, Optional
from .base import BaseAgent, AgentContext, AgentResponse

logger = logging.getLogger(__name__)


class MasterAgent(BaseAgent):
    """
    主协调智能体

    能够：
    - 识别任务是否需要分解
    - 自动将复杂任务分解为子任务
    - 协调多个专业智能体协作
    - 整合各智能体的结果
    - 生成统一的答案

    适用场景：
    - "生成一份完整的灾害分析报告"
    - "分析数据、绘制图表并给出建议"
    - "查询数据、对比分析并可视化"
    """

    # 任务分析提示词
    TASK_ANALYSIS_PROMPT = """你是一个任务规划专家。分析用户的任务，判断是否需要多个智能体协作。

可用智能体：
{agents_info}

请分析以下任务：
"{task}"

你需要判断：
1. 任务复杂度（simple/medium/complex）
2. 是否需要多个智能体（true/false）
3. 如果需要多个智能体，请给出任务分解方案

请以 JSON 格式返回：
{{
  "complexity": "simple|medium|complex",
  "needs_multiple_agents": true|false,
  "reasoning": "你的分析理由",
  "subtasks": [
    {{
      "description": "子任务描述",
      "agent": "智能体名称",
      "order": 1,
      "depends_on": []  // 依赖的子任务序号
    }}
  ]
}}

**判断标准：**
- simple: 单一查询、单一操作，一个智能体即可完成
- medium: 需要多步骤，但可以由一个智能体通过工具调用完成
- complex: 需要不同类型的操作（查询+分析+可视化+报告），必须多个智能体协作

**示例：**
- "查询2023年数据" → simple，qa_agent
- "分析数据并找出趋势" → medium，qa_agent（可以用工具）
- "生成完整报告，包含数据、图表和分析" → complex，需要 qa_agent + chart_agent + analysis_agent

只返回 JSON，不要有其他内容。
"""

    # 结果整合提示词
    RESULT_SYNTHESIS_PROMPT = """你是一个结果整合专家。将多个智能体的执行结果整合为一个连贯的回答。

原始任务：
"{task}"

各智能体执行结果：
{results}

请整合以上结果，生成一个完整、连贯的回答。要求：
1. 保持逻辑清晰
2. 突出重点信息
3. 如果有图表，说明图表展示的内容
4. 给出总结性的结论

请直接返回整合后的回答，不要有额外的说明。
"""

    def __init__(
        self,
        llm_adapter,
        orchestrator,
        agent_config=None,
        system_config=None
    ):
        """
        初始化 MasterAgent

        Args:
            llm_adapter: LLM 适配器
            orchestrator: 智能体编排器（用于调用其他智能体）
            agent_config: 智能体独立配置（AgentConfig 实例）
            system_config: 系统配置对象（降级使用）
        """
        super().__init__(
            name='master_agent',
            description='主协调智能体，负责复杂任务的分解、编排和结果整合',
            capabilities=[
                'task_analysis',
                'task_decomposition',
                'agent_coordination',
                'result_synthesis'
            ],
            llm_adapter=llm_adapter,
            agent_config=agent_config,
            system_config=system_config
        )

        self.orchestrator = orchestrator

        self.logger.info("MasterAgent 初始化完成")

    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        """
        判断是否能处理该任务

        MasterAgent 作为统一入口，处理所有任务
        """
        return True  # 处理所有任务

    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        """
        执行任务

        流程：
        1. 分析任务复杂度
        2. 判断是否需要分解
        3. 如果需要，分解并协调执行
        4. 整合结果
        5. 返回统一答案

        Args:
            task: 用户任务
            context: 上下文

        Returns:
            AgentResponse
        """
        start_time = time.time()

        try:
            # 1. 分析任务
            self.logger.info(f"[MasterAgent] 开始分析任务: {task}")
            analysis = self._analyze_task(task, context)

            if not analysis:
                return AgentResponse(
                    success=False,
                    error="任务分析失败",
                    agent_name=self.name
                )

            # 2. 根据复杂度决定执行方式
            complexity = analysis.get('complexity', 'simple')
            needs_multiple = analysis.get('needs_multiple_agents', False)

            self.logger.info(
                f"[MasterAgent] 任务复杂度: {complexity}, "
                f"需要多智能体: {needs_multiple}"
            )

            # 如果是简单任务，委托给单个智能体
            if complexity == 'simple' or not needs_multiple:
                return self._delegate_to_single_agent(task, context, analysis)

            # 复杂任务，分解并协调执行
            return self._coordinate_multiple_agents(task, context, analysis)

        except Exception as e:
            self.logger.error(f"[MasterAgent] 执行失败: {e}", exc_info=True)
            return AgentResponse(
                success=False,
                error=f"执行失败: {str(e)}",
                agent_name=self.name,
                execution_time=time.time() - start_time
            )

    def _analyze_task(
        self,
        task: str,
        context: AgentContext
    ) -> Optional[Dict[str, Any]]:
        """
        分析任务，判断复杂度和分解方案

        Args:
            task: 用户任务
            context: 上下文

        Returns:
            分析结果字典，包含 complexity, needs_multiple_agents, subtasks 等
        """
        try:
            # 获取可用智能体信息
            agents = self.orchestrator.list_agents()
            agents_info = "\n".join([
                f"- {agent['name']}: {agent['description']}"
                for agent in agents
                if agent['name'] != 'master_agent'  # 排除自己
            ])

            # 构建提示词
            prompt = self.TASK_ANALYSIS_PROMPT.format(
                agents_info=agents_info,
                task=task
            )

            # 调用 LLM 分析
            messages = [
                {"role": "system", "content": "你是一个任务规划专家，擅长分析任务复杂度和制定执行计划。"},
                {"role": "user", "content": prompt}
            ]

            # 获取 LLM 配置（用于任务分析，使用更低的温度）
            llm_config = self.get_llm_config()
            analysis_temperature = self.get_custom_param('analysis_temperature', default=0.0)

            response = self.llm_adapter.chat_completion(
                messages=messages,
                provider=llm_config.get('provider'),
                model=llm_config.get('model_name'),
                temperature=analysis_temperature,
                max_tokens=llm_config.get('max_tokens', 1000),
                timeout=llm_config.get('timeout'),
                max_retries=llm_config.get('retry_attempts')
            )

            if response.error:
                self.logger.error(f"LLM 分析失败: {response.error}")
                return None

            # 解析 JSON 结果
            content = response.content.strip()

            # 提取 JSON（可能被包裹在代码块中）
            if '```json' in content:
                content = content.split('```json')[1].split('```')[0].strip()
            elif '```' in content:
                content = content.split('```')[1].split('```')[0].strip()

            analysis = json.loads(content)

            self.logger.info(f"[MasterAgent] 任务分析完成: {analysis.get('reasoning', '')}")

            return analysis

        except json.JSONDecodeError as e:
            self.logger.error(f"解析 LLM 响应失败: {e}")
            self.logger.error(f"原始响应: {response.content}")
            return None
        except Exception as e:
            self.logger.error(f"任务分析失败: {e}", exc_info=True)
            return None

    def _delegate_to_single_agent(
        self,
        task: str,
        context: AgentContext,
        analysis: Dict[str, Any]
    ) -> AgentResponse:
        """
        委托给单个智能体执行

        Args:
            task: 任务
            context: 上下文
            analysis: 任务分析结果

        Returns:
            AgentResponse
        """
        self.logger.info("[MasterAgent] 任务较简单，委托给单个智能体")

        # 从分析结果获取推荐的智能体
        subtasks = analysis.get('subtasks', [])
        preferred_agent = subtasks[0].get('agent') if subtasks else None

        # 执行任务
        response = self.orchestrator.execute(
            task=task,
            context=context,
            preferred_agent=preferred_agent
        )

        # 添加 MasterAgent 的元数据
        response.metadata['delegated_by'] = 'master_agent'
        response.metadata['complexity'] = analysis.get('complexity', 'simple')

        return response

    def _coordinate_multiple_agents(
        self,
        task: str,
        context: AgentContext,
        analysis: Dict[str, Any]
    ) -> AgentResponse:
        """
        协调多个智能体执行复杂任务

        Args:
            task: 原始任务
            context: 上下文
            analysis: 任务分析结果

        Returns:
            AgentResponse
        """
        start_time = time.time()

        self.logger.info("[MasterAgent] 任务复杂，开始协调多个智能体")

        subtasks = analysis.get('subtasks', [])
        if not subtasks:
            return AgentResponse(
                success=False,
                error="任务分解失败，未生成子任务",
                agent_name=self.name
            )

        # 按顺序执行子任务
        results = []
        subtask_responses = {}

        for subtask in sorted(subtasks, key=lambda x: x.get('order', 0)):
            subtask_desc = subtask.get('description', '')
            agent_name = subtask.get('agent', '')
            depends_on = subtask.get('depends_on', [])

            self.logger.info(f"[MasterAgent] 执行子任务 {subtask.get('order')}: {subtask_desc}")

            # 检查依赖
            if depends_on:
                # 将依赖任务的结果添加到上下文
                dep_results = [
                    subtask_responses.get(dep_order)
                    for dep_order in depends_on
                ]
                context.set_shared_data('previous_results', dep_results)

            # 执行子任务
            try:
                response = self.orchestrator.execute(
                    task=subtask_desc,
                    context=context,
                    preferred_agent=agent_name
                )

                # 保存结果
                subtask_responses[subtask.get('order')] = {
                    'description': subtask_desc,
                    'agent': response.agent_name,
                    'success': response.success,
                    'content': response.content,
                    'data': response.data,
                    'execution_time': response.execution_time
                }

                results.append(subtask_responses[subtask.get('order')])

                # 将结果存储到上下文，供后续任务使用
                context.store_result(f'subtask_{subtask.get("order")}', response.data)

            except Exception as e:
                self.logger.error(f"子任务执行失败: {e}")
                results.append({
                    'description': subtask_desc,
                    'agent': agent_name,
                    'success': False,
                    'error': str(e)
                })

        # 整合结果
        self.logger.info("[MasterAgent] 所有子任务完成，开始整合结果")
        final_answer = self._synthesize_results(task, results)

        execution_time = time.time() - start_time

        return AgentResponse(
            success=True,
            content=final_answer,
            data={
                'subtasks': results,
                'analysis': analysis,
                'total_subtasks': len(subtasks)
            },
            metadata={
                'complexity': analysis.get('complexity'),
                'subtasks_count': len(subtasks),
                'reasoning': analysis.get('reasoning', '')
            },
            agent_name=self.name,
            execution_time=execution_time
        )

    def _synthesize_results(
        self,
        original_task: str,
        results: List[Dict[str, Any]]
    ) -> str:
        """
        整合多个智能体的结果为统一答案

        Args:
            original_task: 原始任务
            results: 各子任务的执行结果

        Returns:
            整合后的答案
        """
        try:
            # 格式化结果
            results_text = ""
            for i, result in enumerate(results, 1):
                results_text += f"\n子任务 {i}: {result.get('description', '')}\n"
                results_text += f"执行智能体: {result.get('agent', '')}\n"
                if result.get('success'):
                    results_text += f"结果: {result.get('content', '')[:500]}...\n"
                else:
                    results_text += f"失败: {result.get('error', '')}\n"
                results_text += "-" * 50 + "\n"

            # 构建提示词
            prompt = self.RESULT_SYNTHESIS_PROMPT.format(
                task=original_task,
                results=results_text
            )

            # 调用 LLM 整合
            messages = [
                {"role": "system", "content": "你是一个结果整合专家，擅长将多个信息源整合为连贯的回答。"},
                {"role": "user", "content": prompt}
            ]

            # 获取 LLM 配置（用于结果整合，使用稍高的温度）
            llm_config = self.get_llm_config()
            synthesis_temperature = self.get_custom_param('synthesis_temperature', default=0.3)

            response = self.llm_adapter.chat_completion(
                messages=messages,
                provider=llm_config.get('provider'),
                model=llm_config.get('model_name'),
                temperature=synthesis_temperature,
                max_tokens=llm_config.get('max_tokens', 2000),
                timeout=llm_config.get('timeout'),
                max_retries=llm_config.get('retry_attempts')
            )

            if response.error:
                self.logger.error(f"结果整合失败: {response.error}")
                # 降级方案：简单拼接
                return self._simple_synthesis(results)

            return response.content

        except Exception as e:
            self.logger.error(f"结果整合异常: {e}", exc_info=True)
            return self._simple_synthesis(results)

    def _simple_synthesis(self, results: List[Dict[str, Any]]) -> str:
        """
        简单的结果拼接（降级方案）

        Args:
            results: 各子任务结果

        Returns:
            拼接的答案
        """
        answer = "以下是各部分的执行结果：\n\n"

        for i, result in enumerate(results, 1):
            answer += f"**{i}. {result.get('description', '')}**\n"
            if result.get('success'):
                answer += f"{result.get('content', '')}\n\n"
            else:
                answer += f"执行失败: {result.get('error', '')}\n\n"

        return answer
