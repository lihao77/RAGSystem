"""
StreamExecutor - ReActAgent 和 MasterAgentV2 共用的流式 LLM 执行逻辑。

将 LLM 流式输出 → XML 解析 → 事件发布串联起来，
返回结构化的 StreamResult 供 Agent 使用。
"""

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from agents.streaming.xml_parser import StreamingXMLParser, TagType
from agents.streaming.tool_xml_parser import parse_tools_xml

logger = logging.getLogger(__name__)


@dataclass
class StreamResult:
    """流式执行结果。"""
    thought: str = ""
    actions: Optional[List[Dict[str, Any]]] = None
    answer: Optional[str] = None
    full_response: str = ""
    error: Optional[str] = None


class StreamExecutor:
    """
    流式 LLM 执行器。

    调用 model_adapter.chat_completion_stream()，
    将输出通过 StreamingXMLParser 增量解析，
    实时发布 thinking_delta / chunk 等事件。
    """

    def __init__(self, model_adapter, publisher, agent_logger=None):
        self.model_adapter = model_adapter
        self.publisher = publisher
        self.parser = StreamingXMLParser()
        self.logger = agent_logger or logger

    def execute_llm_stream(
        self,
        messages: List[Dict[str, str]],
        llm_config: Dict[str, Any],
        round_num: int,
        cancel_event=None,
        extra_kwargs: Optional[Dict[str, Any]] = None,
    ) -> StreamResult:
        """
        执行一轮流式 LLM 调用。

        Args:
            messages: 完整的消息列表
            llm_config: LLM 配置字典
            round_num: 当前轮次编号
            cancel_event: 取消信号
            extra_kwargs: 额外的 LLM 调用参数

        Returns:
            StreamResult: 解析后的结构化结果
        """
        self.parser.reset()
        thought = ""
        answer = ""

        kwargs = dict(extra_kwargs or {})
        kwargs['cancel_event'] = cancel_event
        # XML 模式下让 LLM 遇到 </tools> 时停止（避免生成无用内容）
        kwargs['stop'] = ["</tools>"]
        # 不要传 response_format（XML 模式不需要 json_object）
        kwargs.pop('response_format', None)

        try:
            stream = self.model_adapter.chat_completion_stream(
                messages=messages,
                provider=llm_config.get('provider'),
                model=llm_config.get('model_name'),
                provider_type=llm_config.get('provider_type'),
                temperature=llm_config.get('temperature', 0.3),
                max_tokens=llm_config.get('max_tokens'),
                **kwargs,
            )

            for chunk_data in stream:
                # 错误处理
                if chunk_data.get('error'):
                    return StreamResult(error=chunk_data['error'])

                # 中断处理
                if chunk_data.get('finish_reason') == 'interrupted':
                    return StreamResult(
                        thought=thought,
                        answer=answer or None,
                        full_response=self.parser.get_full_response(),
                        error='interrupted',
                    )

                content = chunk_data.get('content', '')
                if not content:
                    continue

                events = self.parser.feed(content)

                for evt in events:
                    if evt.tag == TagType.THINKING:
                        if evt.type == 'content':
                            thought += evt.content
                            if self.publisher:
                                self.publisher.thinking_delta(evt.content, round=round_num)
                        elif evt.type == 'tag_close':
                            if self.publisher:
                                self.publisher.thinking_complete(thought, round=round_num)

                    elif evt.tag == TagType.TOOLS:
                        # tools 内容由 parser 积累，tag_close 时解析
                        pass

                    elif evt.tag == TagType.ANSWER:
                        if evt.type == 'content':
                            answer += evt.content
                            if self.publisher:
                                self.publisher.chunk(evt.content)

        except Exception as e:
            self.logger.error(f"流式 LLM 调用异常: {e}", exc_info=True)
            return StreamResult(
                thought=thought,
                full_response=self.parser.get_full_response(),
                error=str(e),
            )

        # 解析工具调用
        actions = None
        tools_content = self.parser.get_tag_content(TagType.TOOLS)
        if tools_content:
            actions, parse_err = parse_tools_xml(tools_content)
            if parse_err:
                self.logger.warning(f"工具 XML 解析警告: {parse_err}")

        full_response = self.parser.get_full_response()

        # LLM 输出了裸文本（没有任何 XML 标签），解析器会丢弃标签外文本
        # 此时 thought/actions/answer 全为空，但 full_response 有内容
        # 将 full_response 视为最终答案，避免触发兜底重试逻辑
        if not thought and not actions and not answer and full_response.strip():
            self.logger.warning("LLM 输出了裸文本（无 XML 标签），将其作为最终答案处理")
            answer = full_response.strip()

        return StreamResult(
            thought=thought,
            actions=actions if actions else None,
            answer=answer or None,
            full_response=full_response,
        )
