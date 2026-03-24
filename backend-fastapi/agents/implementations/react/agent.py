# -*- coding: utf-8 -*-
"""
ReAct Agent - 使用 XML 标签格式 + 流式输出

优势：
1. 不依赖 function calling API
2. 支持任何大模型
3. 推理过程实时流式可见（thinking_delta）
4. 最终答案逐字流式输出
"""

import logging
import json
from typing import Optional, Dict, Any, List
from agents.core import BaseAgent, AgentContext, AgentResponse
from tools.tool_registry import get_tool_registry

logger = logging.getLogger(__name__)
_TOOL_REGISTRY = get_tool_registry()


def _format_tool_contract(tool: Dict[str, Any]) -> List[str]:
    return BaseAgent._format_tool_contract(tool)


class ReActAgent(BaseAgent):
    """
    ReAct (Reasoning + Acting) 智能体

    使用 XML 标签格式 + 流式输出，支持实时展示思考和回答过程
    """

    def __init__(
        self,
        agent_name: str,
        display_name: str = None,
        description: str = None,
        model_adapter = None,
        agent_config = None,
        system_config = None,
        available_tools: Optional[List[Dict[str, Any]]] = None,
        available_skills: Optional[List] = None,  # 新增：Skills 列表
        event_callback = None,  # 新增：事件回调函数（向后兼容）
        event_bus = None  # 新增：会话级事件总线
    ):
        super().__init__(
            name=agent_name,
            description=description or display_name or agent_name,
            capabilities=['reasoning', 'tool_calling'],
            model_adapter=model_adapter,
            agent_config=agent_config,
            system_config=system_config
        )

        self.display_name = display_name or agent_name
        self.event_callback = event_callback  # 保存回调函数（向后兼容）
        from agents.context.budget import WORKER_CONTEXT_PROFILE_NAME
        self._setup_react_runtime(
            available_tools=available_tools,
            available_skills=available_skills,
            event_bus=event_bus,
            budget_profile_name=WORKER_CONTEXT_PROFILE_NAME,
            runtime_label="ReActAgent",
        )

    def _handle_user_input_request(
        self,
        arguments: Dict[str, Any],
        event_bus,
        session_id: Optional[str],
        tool_call_id: str,
        publisher=None,
        parent_call_id: Optional[str] = None,
    ) -> Optional[str]:
        return super()._handle_user_input_request(
            arguments=arguments,
            event_bus=event_bus,
            session_id=session_id,
            tool_call_id=tool_call_id,
            publisher=publisher,
            parent_call_id=parent_call_id,
            log_label="ReAct",
        )

    def _emit_event(
        self,
        event_type: str,
        data: Dict[str, Any],
        *,
        publisher=None,
        agent_call_id: Optional[str] = None,
        session_id: Optional[str] = None,
    ):
        """
        发送事件到回调函数和事件总线

        支持两种方式（向后兼容）：
        1. 旧方式：通过 event_callback 回调函数
        2. 新方式：通过 EventPublisher 发布到事件总线
        """
        # 旧方式：回调函数（向后兼容）
        if self.event_callback:
            try:
                self.event_callback(event_type, data)
            except Exception as e:
                self.logger.warning(f"事件回调失败: {e}")

        # 新方式：事件总线
        if publisher:
            try:
                # 映射事件类型到 EventPublisher 方法
                if event_type == 'tool_start':
                    # 生成唯一的 tool call_id
                    import uuid
                    tool_call_id = data.get('tool_call_id') or f"tool_{uuid.uuid4()}"

                    publisher.tool_call_start(
                        call_id=tool_call_id,
                        tool_name=data.get('tool_name'),
                        arguments=data.get('arguments', {}),
                        parent_call_id=agent_call_id,  # ✨ 关联到 ReActAgent 的调用
                        round=data.get('round'),
                    )
                elif event_type == 'tool_end':
                    from tools.refs.result_references import result_event_payload
                    from tools.tool_registry import get_tool_registry
                    tool_name = data.get('tool_name')
                    result = data.get('result')
                    tool_registry = get_tool_registry()
                    is_skills_tool = tool_name in tool_registry.get_skill_tool_names()
                    observation = self._format_tool_observation(
                        result,
                        tool_name=tool_name,
                        session_id=session_id or getattr(publisher, 'session_id', None),
                        is_skills_tool=is_skills_tool,
                    )
                    preview_text = f"[{tool_name}]\n{observation}" if observation else ""
                    publisher.tool_call_end(
                        call_id=data.get('tool_call_id'),
                        tool_name=tool_name,
                        result=preview_text,
                        result_preview=preview_text,
                        raw_result=result_event_payload(result),
                        raw_result_ref={
                            'session_id': session_id or getattr(publisher, 'session_id', None),
                            'call_id': data.get('tool_call_id'),
                            'tool_name': tool_name,
                        },
                        execution_time=data.get('elapsed_time'),
                        parent_call_id=agent_call_id,  # ✨ 关联到 ReActAgent 的调用
                        success=getattr(result, 'success', True) if result is not None else True,
                        round=data.get('round'),
                    )
                elif event_type == 'tool_error':
                    publisher.tool_error(
                        tool_name=data.get('tool_name'),
                        error=data.get('error')
                    )
            except Exception as e:
                self.logger.warning(f"事件总线发布失败: {e}")

    def _build_system_prompt(self) -> str:
        return BaseAgent._build_shared_system_prompt(self)

    def execute_stream(self, task: str, context: AgentContext) -> AgentResponse:
        """
        执行任务（向后兼容方法）

        注意：不再使用 yield 返回事件，所有事件通过事件总线发布
        前端应使用 SSEAdapter 订阅事件总线
        """
        return self.execute(task, context)

    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        """执行任务（非流式版本，兼容旧接口）"""
        return self._execute_react_task(task, context)

    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        """
        判断是否能处理该任务

        ReAct Agent 始终返回 True，让 OrchestratorAgent 通过 LLM 智能分析来决定路由
        """
        return True

    def _safe_json_dumps(self, obj):
        """
        安全地序列化对象为 JSON 字符串，处理 NaN/Infinity 等特殊值

        Args:
            obj: 要序列化的对象

        Returns:
            JSON 字符串
        """
        import json
        import math

        def clean_value(value):
            """递归清理 NaN 和 Infinity"""
            if isinstance(value, float):
                if math.isnan(value) or math.isinf(value):
                    return None  # 将 NaN/Inf 转换为 null
                return value
            elif isinstance(value, dict):
                return {k: clean_value(v) for k, v in value.items()}
            elif isinstance(value, list):
                return [clean_value(item) for item in value]
            else:
                return value

        cleaned_obj = clean_value(obj)
        return json.dumps(cleaned_obj, ensure_ascii=False)

    def _resolve_tool_references(self, arguments: dict, tool_results: dict, current_idx: int) -> dict:
        """
        解析工具参数中的引用占位符，替换为前面工具的实际结果

        支持的占位符格式：
        - {result_N}  - 引用第N个工具的完整结果
        - {result_N.content.xxx} - 引用第N个工具结果中的特定字段（JSON路径）
        - {result_1} 到 {result_N-1}  - 只能引用当前工具之前的结果

        Args:
            arguments: 工具的原始参数字典
            tool_results: 已执行工具的结果字典 {idx: result}
            current_idx: 当前工具的索引（从1开始）

        Returns:
            替换后的参数字典
        """
        import re
        from tools.refs.result_references import (
            resolve_result_path,
            result_primary_content,
            stringify_result_value,
            is_ref_error,
        )

        def replace_placeholder(match):
            """替换单个占位符"""
            full_match = match.group(0)  # 完整的 {{...}}
            ref_expr = match.group(1)     # {{}} 内的内容

            # 解析引用：result_N 或 result_N.path.to.field
            parts = ref_expr.split('.', 1)
            base_ref = parts[0]  # result_N
            json_path = parts[1] if len(parts) > 1 else None  # path.to.field
            normalized_ref = base_ref.lower()

            # 提取索引 N
            if not normalized_ref.startswith('result'):
                self.logger.warning(f"[链式调用] 无效的占位符格式: {full_match}")
                return full_match  # 保持原样

            try:
                ref_idx = int(normalized_ref.replace('result_', '').replace('result', ''))
            except ValueError:
                self.logger.warning(f"[链式调用] 无法解析索引: {full_match}")
                return full_match

            # 检查是否引用了后面的工具（不允许）
            if ref_idx >= current_idx:
                self.logger.warning(
                    f"[链式调用] 工具 {current_idx} 不能引用后面的工具 {ref_idx}"
                )
                return full_match

            # 检查引用的工具是否已执行
            if ref_idx not in tool_results:
                self.logger.warning(
                    f"[链式调用] 工具 {current_idx} 引用的工具 {ref_idx} 尚未执行"
                )
                return full_match

            # 获取引用的结果
            result = tool_results[ref_idx]

            # 如果有 JSON 路径，提取特定字段
            if json_path:
                try:
                    value = resolve_result_path(
                        result,
                        json_path,
                        prefer_primary_content_root=True,
                        case_insensitive=True,
                    )
                    if is_ref_error(value):
                        available = value.get("available_keys", [])
                        self.logger.warning(f"[链式调用] 路径 {json_path} 不存在, 可用: {available}")
                        return f'[引用错误: 路径 "{json_path}" 不存在, 可用: {available}]'

                    # 如果提取的值是字符串，直接返回；否则序列化为 JSON
                    return stringify_result_value(value)
                except Exception as e:
                    self.logger.warning(
                        f"[链式调用] 提取 JSON 路径失败: {json_path}, 错误: {e}"
                    )
                    return full_match
            else:
                # 没有 JSON 路径，返回完整结果
                primary_content = result_primary_content(result)
                if primary_content is not None:
                    return stringify_result_value(primary_content)

                # 兜底：返回整个 result 的 JSON 序列化
                return self._safe_json_dumps(result)

        # 递归处理参数字典中的所有字符串值
        def process_value(value):
            if isinstance(value, str):
                # 查找所有占位符 {result_N} 或 {result_N.path} 并替换
                # 使用单层花括号，更简洁直观
                pattern = re.compile(
                    r'\{(result_?\d+(?:\.[a-zA-Z0-9_\.]+)?)\}',
                    re.IGNORECASE,
                )
                return pattern.sub(replace_placeholder, value)
            elif isinstance(value, dict):
                return {k: process_value(v) for k, v in value.items()}
            elif isinstance(value, list):
                return [process_value(item) for item in value]
            else:
                return value

        resolved = process_value(arguments)

        # 如果有替换发生，记录日志
        if resolved != arguments:
            self.logger.info(
                f"[链式调用] 工具 {current_idx} 的参数中发现占位符，已替换"
            )

        return resolved


