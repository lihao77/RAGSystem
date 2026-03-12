# -*- coding: utf-8 -*-
"""
ContextPipeline - 统一上下文压缩管道

单一入口，每轮调用一次，LLM 摘要优先，滑动窗口降级。
完全替代两套旧机制：
  - compress_context_if_needed()（循环外，base.py）
  - manage_messages()（旧的循环内上下文管理逻辑）
"""

import logging
from typing import List, Dict, Any, Optional, Callable

from .compression_view import resolve_compression_view
from .config import ContextConfig

logger = logging.getLogger(__name__)


class ContextPipeline:
    """
    统一上下文压缩管道

    流程（每轮调用 prepare_messages 一次）：
    1. history_raw  = context.conversation_history → dict 列表
    2. history_resolved = resolve_compression_view(history_raw)
    3. history_tokens = count_tokens(history_resolved)
    4. if history_tokens >= max_tokens * trigger_ratio:
         a. segment = history_resolved 中除最近 preserve_recent_turns 轮之外的所有消息
         b. summary = _try_llm_summary(segment, existing_summary)
         c. 成功：_apply_compression(summary, ...) → 更新 history_resolved
         d. 失败：_apply_sliding_window(...)  → 更新 history_resolved
    5. safety net：if total_tokens > max_tokens → 对 current_session 做内存截断
    6. 返回：[system] + history_resolved + current_session
    """

    def __init__(
        self,
        config: ContextConfig,
        model_adapter,
        get_llm_config_fn: Callable[[Optional[str]], Dict[str, Any]],  # 支持 task_type 参数
        logger: Optional[logging.Logger] = None,
        observation_window=None,
    ):
        self.config = config
        self.model_adapter = model_adapter
        self.get_llm_config_fn = get_llm_config_fn
        self.logger = logger or logging.getLogger(__name__)
        self.observation_window = observation_window
        from .token_counter import TokenCounter
        self._token_counter = TokenCounter(model_name=config.model_name)

    def prepare_messages(
        self,
        system_prompt: str,
        context,
        current_session: List[Dict[str, Any]],
        publisher=None,
    ) -> List[Dict[str, Any]]:
        """
        每轮调用一次，返回完整消息列表给 LLM。

        Args:
            system_prompt: 构建好的 system prompt 字符串
            context: AgentContext 实例（含 conversation_history）
            current_session: 当次执行中累积的消息（从 task 开始）
            publisher: EventPublisher，用于发布压缩事件（可选）

        Returns:
            [system_msg] + history_resolved + current_session（经过必要截断）
        """
        # 1. 转换历史
        history_raw = self._get_history_raw(context)

        # 2. 解析压缩视图
        history_resolved = resolve_compression_view(history_raw)

        # 3. 检查是否触发压缩
        history_tokens = self._token_counter.count_messages(history_resolved)
        trigger_threshold = self.config.max_tokens * self.config.compression_trigger_ratio

        if history_tokens >= trigger_threshold:
            self.logger.info(
                f"触发上下文压缩: tokens={history_tokens}/{self.config.max_tokens} "
                f"({history_tokens / self.config.max_tokens * 100:.1f}%)"
            )
            history_resolved = self._compress(
                history_raw, history_resolved, context, publisher
            )

        # 4. Safety net：超出预算时截断 current_session（不持久化）
        system_msg = {"role": "system", "content": system_prompt}
        base_messages = [system_msg] + history_resolved
        base_tokens = self._token_counter.count_messages(base_messages)
        remaining_budget = self.config.max_tokens - base_tokens

        if remaining_budget <= 0:
            self.logger.warning(
                f"历史消息已超出预算（{base_tokens}/{self.config.max_tokens}），"
                "将截断 current_session"
            )
            self._record_trim(len(current_session))
            current_session = []
        else:
            session_tokens = self._token_counter.count_messages(current_session)
            if session_tokens > remaining_budget:
                self.logger.warning(
                    f"总 tokens {base_tokens + session_tokens} 超出预算 "
                    f"{self.config.max_tokens}，对 current_session 做内存截断（不持久化）"
                )
                original_len = len(current_session)
                current_session = self._trim_current_session(
                    current_session, remaining_budget
                )
                self._record_trim(original_len - len(current_session))

        return base_messages + current_session

    def format_summary(self, messages: List[Dict[str, Any]]) -> str:
        """返回消息列表的简要统计字符串（用于日志）"""
        tokens = self._token_counter.count_messages(messages)
        roles = {}
        for m in messages:
            r = m.get("role", "unknown")
            roles[r] = roles.get(r, 0) + 1
        parts = [f"{r}:{n}" for r, n in roles.items()]
        return (
            f"消息总数: {len(messages)} "
            f"({', '.join(parts)}), 估算 tokens: {tokens}"
        )

    # ── 内部方法 ──────────────────────────────────────────────────────────────

    def _get_history_raw(self, context) -> List[Dict[str, Any]]:
        """将 context.conversation_history 转换为 dict 列表"""
        result = []
        for msg in context.conversation_history:
            result.append(
                {
                    "role": msg.role,
                    "content": msg.content,
                    "metadata": msg.metadata or {},
                    "seq": msg.seq,
                }
            )
        return result

    def _compress(
        self,
        history_raw: List[Dict[str, Any]],
        history_resolved: List[Dict[str, Any]],
        context,
        publisher=None,
    ) -> List[Dict[str, Any]]:
        # 确定被摘要段：压缩「除最近 preserve_recent_turns 轮之外」的所有历史
        # 这样无论消息长短，每次都能尽量多地压缩，token 效率最优。
        start_idx = 0
        if history_resolved and (history_resolved[0].get("metadata") or {}).get(
            "compression"
        ):
            start_idx = 1

        preserve_count = self.config.preserve_recent_turns * 2
        candidates = history_resolved[start_idx:]

        if len(candidates) <= preserve_count:
            # 可压缩消息不足，不触发
            self._record_compression(status="skipped", replaced_messages=0)
            return history_resolved

        segment = candidates[:-preserve_count]

        # 提取已有摘要
        existing_summary = ""
        if start_idx == 1:
            existing_summary = history_resolved[0].get("content", "")

        # 尝试 LLM 摘要
        summary = self._try_llm_summary(segment, existing_summary)

        if summary:
            self._record_compression(status="success", replaced_messages=len(segment))
            return self._apply_compression(
                summary, segment, history_raw, context, publisher
            )
        else:
            self.logger.warning("LLM 摘要失败，降级到滑动窗口")
            self._record_compression(
                status="fallback",
                replaced_messages=max(0, len(history_raw) - (self.config.preserve_recent_turns * 2)),
            )
            return self._apply_sliding_window(history_raw, context, publisher)

    def _try_llm_summary(
        self,
        segment: List[Dict[str, Any]],
        existing_summary: str = "",
    ) -> str:
        """尝试用 LLM 生成摘要，返回摘要内容；失败返回空字符串。"""
        try:
            # 优先使用 fast 层级模型进行压缩（成本优化）
            llm_config = self.get_llm_config_fn(task_type='fast')
            provider = llm_config.get("provider")
            provider_type = llm_config.get("provider_type")

            if not provider:
                self.logger.warning("未配置 LLM provider，跳过 LLM 摘要")
                return ""

            # 记录使用的模型
            model_name = llm_config.get('model_name', 'unknown')
            self.logger.debug(f"使用 fast 层级模型进行压缩: {model_name}")

            lines = []
            for m in segment:
                role = m.get("role", "user")
                content = (m.get("content") or "").strip()
                if content:
                    lines.append(
                        f"{role}: {content[:500]}"
                        + ("..." if len(content) > 500 else "")
                    )

            text = "\n".join(lines) or "（无内容）"

            if existing_summary:
                prompt = (
                    f"以下是之前的对话摘要：\n{existing_summary}\n\n"
                    f"以下是新的对话内容：\n{text}\n\n"
                    "请将上述历史摘要和新对话合并为一段简短摘要，保留关键事实和结论。"
                    "只输出摘要正文，不要其他说明。"
                )
            else:
                prompt = (
                    "请将以下对话压缩为一段简短摘要，保留关键事实和结论。"
                    "只输出摘要正文，不要其他说明。\n\n" + text
                )

            req = [
                {"role": "system", "content": "你是一个对话摘要助手。"},
                {"role": "user", "content": prompt},
            ]

            resp = self.model_adapter.chat_completion(
                messages=req,
                provider=provider,
                provider_type=provider_type,
                temperature=0.2,
                max_tokens=self.config.summarize_max_tokens,
            )

            if getattr(resp, "error", None):
                self.logger.warning(f"LLM 摘要失败: {resp.error}")
                return ""

            content = (resp.content or "").strip()
            if content and not content.startswith("[历史摘要]"):
                content = "[历史摘要]\n" + content

            self.logger.info(f"LLM 摘要生成成功: {len(content)} 字符")
            return content

        except Exception as e:
            self.logger.warning(f"LLM 摘要异常: {e}")
            return ""

    def _apply_compression(
        self,
        summary_content: str,
        segment: List[Dict[str, Any]],
        history_raw: List[Dict[str, Any]],
        context,
        publisher=None,
    ) -> List[Dict[str, Any]]:
        """应用 LLM 摘要压缩，写回 context，发布事件，返回新的 history_resolved。"""
        summary_message = {
            "role": "system",
            "content": summary_content,
            "metadata": {"compression": True, "fallback": False},
        }

        # 找到 segment 最后一条消息在 history_raw 中的索引
        last_msg = segment[-1] if segment else None
        remaining = []
        replaces_up_to_seq: int | None = None

        if last_msg:
            found_idx = -1
            for idx, m in enumerate(history_raw):
                if (
                    m.get("role") == last_msg.get("role")
                    and m.get("content") == last_msg.get("content")
                ):
                    found_idx = idx
                    break
            if found_idx >= 0:
                replaces_up_to_seq = history_raw[found_idx].get("seq")
                remaining = history_raw[found_idx + 1:]
            else:
                remaining = history_raw
        else:
            remaining = history_raw

        updated_raw = [summary_message] + remaining
        self._write_back_context(context, updated_raw)

        if publisher:
            publisher.compression_summary(summary_content, replaces_up_to_seq=replaces_up_to_seq)

        resolved = resolve_compression_view(updated_raw)
        self.logger.info(
            f"LLM 压缩完成: {len(history_raw)} -> {len(updated_raw)} 条原始消息, "
            f"{len(resolved)} 条解析后消息"
        )
        return resolved

    def _apply_sliding_window(
        self,
        history_raw: List[Dict[str, Any]],
        context,
        publisher=None,
    ) -> List[Dict[str, Any]]:
        """滑动窗口降级：保留最近 preserve_recent_turns 轮对话。"""
        max_messages = self.config.preserve_recent_turns * 2

        non_system = [m for m in history_raw if m.get("role") != "system"]
        windowed = (
            non_system[-max_messages:]
            if len(non_system) > max_messages
            else non_system
        )

        omitted = len(non_system) - len(windowed)
        rule_summary = (
            f"[历史摘要]\n（共 {omitted} 条消息通过滑动窗口压缩，"
            f"保留最近 {self.config.preserve_recent_turns} 轮对话）"
        )

        summary_message = {
            "role": "system",
            "content": rule_summary,
            "metadata": {"compression": True, "fallback": True},
        }

        updated_raw = [summary_message] + windowed
        self._write_back_context(context, updated_raw)

        if publisher:
            publisher.compression_summary(rule_summary)

        resolved = resolve_compression_view(updated_raw)
        self.logger.info(
            f"滑动窗口降级完成: {len(history_raw)} -> {len(updated_raw)} 条原始消息, "
            f"{len(resolved)} 条解析后消息"
        )
        return resolved

    def _write_back_context(self, context, updated_raw: List[Dict[str, Any]]):
        """将更新后的消息列表写回 context.conversation_history。"""
        from agents.core.models import Message

        context.conversation_history = [
            Message(
                role=m.get("role", "user"),
                content=m.get("content", ""),
                metadata=m.get("metadata") or {},
                seq=m.get("seq"),
            )
            for m in updated_raw
            if m.get("role") in ("user", "assistant", "system")
        ]

    def _trim_current_session(
        self,
        current_session: List[Dict[str, Any]],
        budget: int,
    ) -> List[Dict[str, Any]]:
        """从后往前保留能放入预算内的 current_session 消息（内存截断，不持久化）。"""
        trimmed = []
        remaining = budget
        for msg in reversed(current_session):
            msg_tokens = self._token_counter.count_messages([msg])
            if remaining >= msg_tokens:
                trimmed.insert(0, msg)
                remaining -= msg_tokens
            else:
                break
        return trimmed

    def _record_compression(self, *, status: str, replaced_messages: int) -> None:
        if self.observation_window is None:
            return
        self.observation_window.record_compression(
            status=status,
            replaced_messages=replaced_messages,
        )

    def _record_trim(self, trimmed_messages: int) -> None:
        if self.observation_window is None:
            return
        self.observation_window.record_trim(trimmed_messages=trimmed_messages)
