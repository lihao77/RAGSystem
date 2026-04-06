# -*- coding: utf-8 -*-
"""
ContextPipeline - 统一上下文压缩管道

单一入口，每轮调用一次，LLM 摘要优先。
完全替代两套旧机制：
  - compress_context_if_needed()（循环外，base.py）
  - manage_messages()（旧的循环内上下文管理逻辑）
"""

import logging
from typing import List, Dict, Any, Optional, Callable

from .compression_view import resolve_compression_view
from .config import ContextConfig

logger = logging.getLogger(__name__)


class ContextCompressionError(RuntimeError):
    """历史摘要失败时抛出的上下文准备异常。"""


class ContextPipeline:
    """
    统一上下文压缩管道。

    流程（每轮调用 prepare_messages 一次）：
    1. history_raw  = context.conversation_history → dict 列表
    2. history_resolved = resolve_compression_view(history_raw)
    3. history_tokens = count_tokens(history_resolved)
    4. if history_tokens >= max_tokens * trigger_ratio:
         a. segment = history_resolved 中除最近 preserve_recent_turns 轮之外的所有消息
         b. summary = _try_llm_summary(segment, existing_summary)
         c. 成功：_apply_compression(summary, ...) → 更新 history_resolved
         d. 失败：抛出 ContextCompressionError，终止当前轮执行
    5. 返回：[system] + history_resolved + current_session
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
        llm_config: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """
        每轮调用一次，返回完整消息列表给 LLM。

        Args:
            system_prompt: 构建好的 system prompt 字符串
            context: AgentContext 实例（含 conversation_history）
            current_session: 当次执行中累积的消息（从 task 开始）
            publisher: EventPublisher，用于发布压缩事件（可选）

        Returns:
            [system_msg] + history_resolved + current_session
        """
        # 1. 转换历史
        history_raw = self._get_history_raw(context)

        # 2. 解析压缩视图
        history_resolved = resolve_compression_view(history_raw)

        # 3. 检查是否触发压缩
        history_tokens = self._token_counter.count_messages(history_resolved)
        trigger_threshold = self.config.max_tokens * self.config.compression_trigger_ratio
        self.logger.info(
            f"压缩检查: history_msgs={len(history_resolved)}, "
            f"history_tokens={history_tokens}, "
            f"threshold={trigger_threshold:.0f} "
            f"(max={self.config.max_tokens}, ratio={self.config.compression_trigger_ratio})"
        )

        if history_tokens >= trigger_threshold:
            self.logger.info(
                f"触发上下文压缩: tokens={history_tokens}/{self.config.max_tokens} "
                f"({history_tokens / self.config.max_tokens * 100:.1f}%)"
            )
            history_resolved = self._compress(
                history_raw, history_resolved, context, publisher,
                system_prompt=system_prompt,
            )

        system_msg = {"role": "system", "content": system_prompt}
        prepared = [system_msg]
        memory_block = self._build_memory_block(context)
        if memory_block:
            prepared.append({"role": "system", "content": memory_block})
        prepared.extend(history_resolved)
        prepared.extend(current_session)
        return self._apply_prompt_cache_policy(prepared, llm_config or {})

    def inspect_messages(
        self,
        system_prompt: str,
        context,
        current_session: Optional[List[Dict[str, Any]]] = None,
    ) -> List[Dict[str, Any]]:
        """
        只读快照：返回 LLM 实际会看到的消息列表，不触发压缩，不修改 context。

        Args:
            system_prompt: 构建好的 system prompt 字符串
            context: AgentContext 实例
            current_session: 当次执行中累积的消息（可选，调试时通常为空）

        Returns:
            [system_msg] + history_resolved + current_session
        """
        history_raw = self._get_history_raw(context)
        history_resolved = resolve_compression_view(history_raw)
        system_msg = {"role": "system", "content": system_prompt}
        prepared = [system_msg]
        memory_block = self._build_memory_block(context)
        if memory_block:
            prepared.append({"role": "system", "content": memory_block})
        prepared.extend(history_resolved)
        prepared.extend(current_session or [])
        return prepared

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

    @staticmethod
    def _build_memory_block(context) -> str:
        metadata = getattr(context, 'metadata', {}) or {}
        indices = metadata.get('memory_indices') or {}
        retrieved = metadata.get('retrieved_memories') or []
        scope_capabilities = metadata.get('memory_scope_capabilities') or {}
        sections: list[str] = []

        allowed_scopes = scope_capabilities.get('allowed_scopes') or []
        write_scopes = scope_capabilities.get('write_scopes') or []
        archive_scopes = scope_capabilities.get('archive_scopes') or []
        if allowed_scopes or write_scopes or archive_scopes:
            sections.append(
                "[Memory Scope Capabilities]\n"
                f"- 可读取 scope: {', '.join(allowed_scopes) if allowed_scopes else '无'}\n"
                f"- 可写入 scope: {', '.join(write_scopes) if write_scopes else '无'}\n"
                f"- 可归档 scope: {', '.join(archive_scopes) if archive_scopes else '无'}\n"
                "- 执行 memory 工具前，必须先确认目标 scope 在对应权限列表内，避免误操作"
            )

        scope_titles = {
            'team': 'Team',
            'session': 'Session',
            'agent': 'Agent',
            'workspace': 'Workspace',
        }
        for scope_name, content in indices.items():
            if content:
                title = scope_titles.get(scope_name, str(scope_name).replace('_', ' ').title())
                sections.append(f"[{title} Memory Index]\n" + str(content).strip())
        if retrieved:
            lines = ["[Relevant Memory Files]", "如需更多细节，请直接调用 read_file 读取下面文件："]
            for item in retrieved[:5]:
                lines.append(
                    f"- [{item.get('scope')}/{item.get('memory_type')}] {item.get('name')} -> {item.get('file_path')}"
                )
            sections.append("\n".join(lines))
        if not sections:
            return ""
        return "\n\n".join(sections)

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

    def _apply_prompt_cache_policy(
        self,
        messages: List[Dict[str, Any]],
        llm_config: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        provider = self._resolve_provider(llm_config)
        if not provider:
            return messages

        prompt_cache_enabled = llm_config.get('prompt_cache_enabled')
        if prompt_cache_enabled is False:
            return messages
        if not getattr(provider, 'supports_prompt_caching', False):
            return messages

        cache_style = getattr(provider, 'prompt_cache_style', None)
        if cache_style == 'anthropic':
            return self._annotate_anthropic_cache_prefix(messages, provider)
        return messages

    def _resolve_provider(self, llm_config: Dict[str, Any]):
        provider_name = llm_config.get('provider')
        provider_type = llm_config.get('provider_type')
        if not provider_name or not self.model_adapter:
            return None
        try:
            return self.model_adapter.get_provider(provider_name, provider_type)
        except Exception:
            return None

    def _annotate_anthropic_cache_prefix(self, messages: List[Dict[str, Any]], provider) -> List[Dict[str, Any]]:
        candidates: List[int] = []
        min_tokens = getattr(provider, 'prompt_cache_min_tokens', None) or 0

        for idx, message in enumerate(messages):
            role = message.get('role')
            if role == 'system':
                candidates.append(idx)
                continue

            metadata = message.get('metadata') or {}
            if metadata.get('compression'):
                candidates.append(idx)
                continue

            if role == 'user' and message.get('seq') is not None and self._is_stable_historical_user_message(messages, idx):
                if self._token_counter.count_messages(message) >= min_tokens:
                    candidates.append(idx)

        if not candidates:
            return messages

        annotated = [dict(message) for message in messages]
        for idx in candidates[:4]:
            metadata = dict(annotated[idx].get('metadata') or {})
            metadata['prompt_cache'] = {
                'enabled': True,
                'style': 'anthropic',
                'segment': 'stable_prefix',
            }
            annotated[idx]['metadata'] = metadata
        return annotated

    @staticmethod
    def _is_stable_historical_user_message(messages: List[Dict[str, Any]], idx: int) -> bool:
        if idx >= len(messages) - 1:
            return False
        next_message = messages[idx + 1]
        if next_message.get('role') != 'assistant':
            return False
        current_metadata = messages[idx].get('metadata') or {}
        if current_metadata.get('compression'):
            return False
        next_metadata = next_message.get('metadata') or {}
        return next_message.get('seq') is not None or next_metadata.get('compression')

    def _compress(
        self,
        history_raw: List[Dict[str, Any]],
        history_resolved: List[Dict[str, Any]],
        context,
        publisher=None,
        system_prompt: str = "",
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

        try:
            self.logger.info(f"开始 LLM 摘要: 待压缩 {len(segment)} 条消息, 已有摘要={bool(existing_summary)}")
            if publisher:
                publisher.compression_start(
                    message_count=len(segment),
                    has_existing_summary=bool(existing_summary),
                )
                self._publish_pre_compression_usage(publisher, history_resolved, system_prompt)
            summary = self._try_llm_summary(segment, existing_summary, publisher=publisher)
        except ContextCompressionError as e:
            self.logger.warning(f"LLM 摘要失败，降级为截断: {e}")
            return self._fallback_truncate(
                history_raw, history_resolved, context, preserve_count, publisher
            )
        self._record_compression(status="success", replaced_messages=len(segment))
        return self._apply_compression(
            summary, segment, history_raw, context, publisher
        )

    def _fallback_truncate(
        self,
        history_raw: List[Dict[str, Any]],
        history_resolved: List[Dict[str, Any]],
        context,
        preserve_count: int,
        publisher=None,
    ) -> List[Dict[str, Any]]:
        """LLM 摘要不可用时的降级策略：丢弃早期消息，保留最近 preserve_count 条。"""
        discarded = len(history_resolved) - preserve_count
        if discarded <= 0:
            self._record_compression(status="fallback_skipped", replaced_messages=0)
            return history_resolved

        kept = history_resolved[-preserve_count:]
        fallback_summary = (
            f"[历史摘要]\n（LLM 摘要不可用，已丢弃 {discarded} 条早期消息）"
        )
        summary_message = {
            "role": "assistant",
            "content": fallback_summary,
            "metadata": {"compression": True},
        }
        updated_raw = [summary_message] + kept
        self._write_back_context(context, updated_raw)

        if publisher:
            publisher.compression_summary(fallback_summary, replaces_up_to_seq=None)

        self._record_compression(status="fallback", replaced_messages=discarded)
        self.logger.info(
            f"降级截断完成: 丢弃 {discarded} 条消息, 保留 {preserve_count} 条"
        )
        return resolve_compression_view(updated_raw)

    def _try_llm_summary(
        self,
        segment: List[Dict[str, Any]],
        existing_summary: str = "",
        publisher=None,
    ) -> str:
        """尝试用 LLM 生成摘要，失败时抛出明确异常。"""
        try:
            llm_config = self.get_llm_config_fn(task_type='fast')
            provider = llm_config.get("provider")
            provider_type = llm_config.get("provider_type")

            if not provider:
                raise ContextCompressionError("上下文压缩失败：未配置摘要模型 provider")

            model_name = llm_config.get('model_name', 'unknown')
            self.logger.info(f"使用 fast 层级模型进行压缩: provider={provider}, model={model_name}")

            lines = []
            for m in segment:
                role = m.get("role", "user")
                content = (m.get("content") or "").strip()
                if content:
                    lines.append(f"{role}: {content}")

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
                retry_attempts=llm_config.get('retry_attempts'),
                retry_backoff_factor=llm_config.get('retry_backoff_factor'),
                publisher=publisher,
                thinking_budget_tokens=llm_config.get('thinking_budget_tokens'),
                reasoning_effort=llm_config.get('reasoning_effort'),
            )

            if getattr(resp, "error", None):
                raise ContextCompressionError(f"上下文压缩失败：{resp.error}")

            content = (resp.content or "").strip()
            if not content:
                raise ContextCompressionError("上下文压缩失败：摘要模型返回空内容")
            if not content.startswith("[历史摘要]"):
                content = "[历史摘要]\n" + content

            self.logger.info(f"LLM 摘要生成成功: {len(content)} 字符")
            return content

        except ContextCompressionError:
            raise
        except Exception as e:
            raise ContextCompressionError(f"上下文压缩失败：{e}") from e

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
            "role": "assistant",
            "content": summary_content,
            "metadata": {"compression": True},
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

    def _publish_pre_compression_usage(self, publisher, history_resolved, system_prompt):
        """发布压缩前的 context-usage，避免前端在压缩期间无数据。"""
        from agents.events.bus import EventType
        system_msg = [{"role": "system", "content": system_prompt}]
        system_tokens = self._token_counter.count_messages(system_msg)
        history_tokens = self._token_counter.count_messages(history_resolved)
        current_tokens = system_tokens + history_tokens
        budget_tokens = self.config.max_tokens + system_tokens
        publisher._publish(EventType.CONTEXT_USAGE, {
            'used_tokens': current_tokens,
            'system_prompt_tokens': system_tokens,
            'total_tokens': current_tokens,
            'budget_tokens': budget_tokens,
            'round': 0,
            'compressing': True,
        })

    def _record_compression(self, *, status: str, replaced_messages: int) -> None:
        if self.observation_window is None:
            return
        self.observation_window.record_compression(
            status=status,
            replaced_messages=replaced_messages,
        )
