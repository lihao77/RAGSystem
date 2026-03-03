"""
StreamingXMLParser - 增量 XML 标签解析器。

支持的标签: <thinking>, <tools>, <answer>
- thinking: 每个 chunk 产生 content 事件（实时流式）
- tools: 只积累不产生 content 事件，tag_close 时一次性可用
- answer: 每个 chunk 产生 content 事件（实时流式）
"""

import logging
import re
from enum import Enum
from typing import List, Optional


logger = logging.getLogger(__name__)


class TagType(Enum):
    THINKING = "thinking"
    TOOLS = "tools"
    ANSWER = "answer"


TAG_NAMES = {t.value for t in TagType}


class ParseEvent:
    """解析器产生的事件。"""
    __slots__ = ('type', 'tag', 'content')

    def __init__(self, type: str, tag: TagType, content: str = ""):
        self.type = type      # "tag_open" | "content" | "tag_close"
        self.tag = tag
        self.content = content

    def __repr__(self):
        return f"ParseEvent({self.type}, {self.tag.value}, {self.content[:30]!r})"


class StreamingXMLParser:
    """
    增量 XML 标签解析器，用于流式 LLM 输出的实时解析。

    状态机: IDLE → IN_TAG → IDLE
    """

    def __init__(self):
        self.reset()

    def reset(self):
        """重置解析器状态（每轮循环调用）。"""
        self._state: Optional[TagType] = None       # 当前在哪个标签内，None=IDLE
        self._buffer: str = ""                       # 未消费的文本缓冲
        self._tag_contents: dict = {t: "" for t in TagType}  # 各标签累积内容
        self._full_response: str = ""                # 完整原始文本
        self._pending_open: Optional[TagType] = None # 延迟发送的 tag_open

    def feed(self, chunk: str) -> List[ParseEvent]:
        """
        喂入一个 chunk，返回产生的事件列表。

        Args:
            chunk: LLM 流式输出的一个片段

        Returns:
            ParseEvent 列表
        """
        if not chunk:
            return []

        self._full_response += chunk
        self._buffer += chunk
        events: List[ParseEvent] = []

        while self._buffer:
            if self._state is None:
                # IDLE 状态：寻找开始标签
                consumed = self._scan_for_open_tag(events)
                if not consumed:
                    break
            else:
                # IN_TAG 状态：寻找结束标签
                consumed = self._scan_for_close_tag(events)
                if not consumed:
                    break

        return events

    def _scan_for_open_tag(self, events: List[ParseEvent]) -> bool:
        """在 IDLE 状态扫描开始标签。返回是否消费了缓冲区内容。"""
        # 查找 '<' 字符
        lt_pos = self._buffer.find('<')
        if lt_pos == -1:
            # 没有 '<'，丢弃所有内容（标签外文本）
            if self._buffer.strip():
                logger.debug(f"忽略标签外文本: {self._buffer[:50]!r}")
            self._buffer = ""
            return False

        # 丢弃 '<' 之前的文本
        if lt_pos > 0:
            skipped = self._buffer[:lt_pos]
            if skipped.strip():
                logger.debug(f"忽略标签外文本: {skipped[:50]!r}")
            self._buffer = self._buffer[lt_pos:]

        # 检查是否有完整的开始标签
        gt_pos = self._buffer.find('>')
        if gt_pos == -1:
            # 标签不完整（如 "<thin" 等待更多数据）
            return False

        tag_str = self._buffer[1:gt_pos].strip().lower()

        # 检查是否是已知标签
        matched_tag = None
        for t in TagType:
            if tag_str == t.value:
                matched_tag = t
                break

        if matched_tag is None:
            # 不认识的标签，跳过这个 '<'
            logger.debug(f"忽略未知标签: <{tag_str}>")
            self._buffer = self._buffer[gt_pos + 1:]
            return True

        # 找到有效开始标签
        self._state = matched_tag
        self._buffer = self._buffer[gt_pos + 1:]
        events.append(ParseEvent("tag_open", matched_tag))
        return True

    def _scan_for_close_tag(self, events: List[ParseEvent]) -> bool:
        """在 IN_TAG 状态扫描结束标签。返回是否消费了缓冲区内容。"""
        close_tag = f"</{self._state.value}>"

        close_pos = self._buffer.lower().find(close_tag.lower())
        if close_pos != -1:
            # 找到结束标签
            content_before = self._buffer[:close_pos]
            if content_before:
                self._tag_contents[self._state] += content_before
                # thinking 和 answer 产生 content 事件，tools 不产生
                if self._state in (TagType.THINKING, TagType.ANSWER):
                    events.append(ParseEvent("content", self._state, content_before))

            events.append(ParseEvent("tag_close", self._state))
            self._buffer = self._buffer[close_pos + len(close_tag):]
            self._state = None
            return True

        # 没找到结束标签
        # 检查缓冲区末尾是否可能是不完整的结束标签开头
        # 例如缓冲区以 "</thi" 结尾，需要等待更多数据
        safe_len = self._find_safe_content_length()

        if safe_len > 0:
            content = self._buffer[:safe_len]
            self._tag_contents[self._state] += content
            # thinking 和 answer 产生 content 事件
            if self._state in (TagType.THINKING, TagType.ANSWER):
                events.append(ParseEvent("content", self._state, content))
            self._buffer = self._buffer[safe_len:]
            return True

        # 缓冲区太短或可能是不完整标签，等待更多数据
        return False

    def _find_safe_content_length(self) -> int:
        """
        计算可以安全消费的内容长度。

        在缓冲区末尾可能存在不完整的结束标签（如 "</thi"），
        这部分不能消费，需要等待更多数据。
        """
        buf = self._buffer
        if not buf:
            return 0

        # 从末尾开始检查可能的不完整结束标签
        # 结束标签格式: </thinking> </tools> </answer>
        # 最长的结束标签是 "</thinking>" (11 字符)
        max_close_len = 12  # 稍微多留一点

        # 检查缓冲区末尾是否以 '<' 或 '</' 开头的不完整标签
        check_start = max(0, len(buf) - max_close_len)
        tail = buf[check_start:]

        # 找到最后一个 '<' 的位置
        last_lt = tail.rfind('<')
        if last_lt == -1:
            # 尾部没有 '<'，全部安全
            return len(buf)

        # '<' 之后的内容
        partial = tail[last_lt:]

        # 检查这个 partial 是否可能是某个结束标签的前缀
        for t in TagType:
            close_str = f"</{t.value}>"
            if close_str.lower().startswith(partial.lower()):
                # 是结束标签的前缀，保留这部分
                safe = check_start + last_lt
                return safe

        # 不是任何结束标签的前缀，全部安全
        return len(buf)

    def get_full_response(self) -> str:
        """获取完整的原始响应文本（用于持久化）。"""
        return self._full_response

    def get_tag_content(self, tag: TagType) -> str:
        """获取指定标签的完整累积内容。"""
        return self._tag_contents.get(tag, "")

    @property
    def current_state(self) -> Optional[TagType]:
        """当前解析状态。"""
        return self._state
