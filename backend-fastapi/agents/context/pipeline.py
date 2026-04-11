# -*- coding: utf-8 -*-
"""
ContextPipeline - 统一上下文压缩管道

单一入口，每轮调用一次，LLM 摘要优先。
完全替代两套旧机制：
  - compress_context_if_needed()（循环外，base.py）
  - manage_messages()（旧的循环内上下文管理逻辑）
"""

import logging
from dataclasses import dataclass
from typing import List, Dict, Any, Optional, Callable

from .compression_view import resolve_compression_view
from .config import ContextConfig

logger = logging.getLogger(__name__)


class ContextCompressionError(RuntimeError):
    """历史摘要失败时抛出的上下文准备异常。"""


@dataclass
class PreparedMessagesResult:
    messages: List[Dict[str, Any]]
    total_tokens: int
    system_tokens: int
    budget_tokens: int
    cache_hit: bool
    rebuild_reason: str


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
        return self.prepare_execution_messages(
            system_prompt=system_prompt,
            context=context,
            current_session=current_session,
            publisher=publisher,
            llm_config=llm_config,
        ).messages

    def prepare_execution_messages(
        self,
        *,
        system_prompt: str,
        context,
        current_session: List[Dict[str, Any]],
        publisher=None,
        llm_config: Optional[Dict[str, Any]] = None,
        cache_state: Optional[Dict[str, Any]] = None,
    ) -> PreparedMessagesResult:
        cache_state = cache_state if cache_state is not None else {}
        cached_messages = cache_state.get('messages')
        cached_session_len = cache_state.get('session_len', 0)
        rebuild_reason = 'initial_build'
        cache_hit = False

        if cached_messages is not None:
            if len(current_session) < cached_session_len:
                rebuild_reason = 'session_rewind'
            else:
                updated_messages = list(cached_messages)
                if len(current_session) > cached_session_len:
                    appended_messages = current_session[cached_session_len:]
                    updated_messages.extend(appended_messages)
                total_tokens = self.count_messages_tokens(updated_messages)
                if self.should_rebuild_after_append(total_tokens):
                    rebuild_reason = 'threshold_rebuild'
                else:
                    cache_state['messages'] = updated_messages
                    cache_state['session_len'] = len(current_session)
                    cache_hit = True
                    return self._build_prepared_result(
                        messages=updated_messages,
                        rebuild_reason='cache_hit',
                        cache_hit=True,
                    )

        prepared = self._prepare_messages_full(
            system_prompt=system_prompt,
            context=context,
            current_session=current_session,
            publisher=publisher,
            llm_config=llm_config,
        )
        cache_state['messages'] = prepared
        cache_state['session_len'] = len(current_session)
        return self._build_prepared_result(
            messages=prepared,
            rebuild_reason=rebuild_reason,
            cache_hit=cache_hit,
        )

    def inspect_messages(
        self,
        system_prompt: str,
        context,
        current_session: Optional[List[Dict[str, Any]]] = None,
    ) -> List[Dict[str, Any]]:
        return self.inspect_messages_with_stats(
            system_prompt=system_prompt,
            context=context,
            current_session=current_session,
        ).messages

    def inspect_messages_with_stats(
        self,
        *,
        system_prompt: str,
        context,
        current_session: Optional[List[Dict[str, Any]]] = None,
    ) -> PreparedMessagesResult:
        self._ensure_memory_prefix_snapshot(context, reason='inspect_messages')
        history_raw = self._get_history_raw(context)
        history_resolved = resolve_compression_view(history_raw)
        system_msg = {"role": "system", "content": system_prompt}
        prepared = [system_msg]
        for reminder_block in self._build_reminder_blocks(context):
            prepared.append({
                "role": "system",
                "content": reminder_block,
            })
        prepared.extend(history_resolved)
        prepared.extend(current_session or [])
        return self._build_prepared_result(
            messages=prepared,
            rebuild_reason='inspect',
            cache_hit=False,
        )

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

    def count_messages_tokens(self, messages: List[Dict[str, Any]]) -> int:
        return self._token_counter.count_messages(messages)

    def force_compress(self, context, publisher=None, system_prompt: str = "") -> Dict[str, Any]:
        """强制压缩上下文，跳过阈值检查。返回压缩统计和持久化信息。"""
        history_raw = self._get_history_raw(context)
        history_resolved = resolve_compression_view(history_raw)
        before_count = len(history_raw)
        before_tokens = self._token_counter.count_messages(history_resolved)

        if not history_resolved:
            return {'status': 'skipped', 'reason': 'no_history', 'before': 0, 'after': 0, 'tokens_saved': 0}

        compressed = self._compress(
            history_raw, history_resolved, context, publisher,
            system_prompt=system_prompt,
        )
        self._ensure_memory_prefix_snapshot(context, reason='apply_compression')

        after_tokens = self._token_counter.count_messages(compressed)

        # 提取摘要信息和 replaces_up_to_seq 用于持久化
        new_history = context.conversation_history
        summary_content = None
        replaces_up_to_seq = None
        if new_history and (new_history[0].metadata or {}).get('compression'):
            summary_content = new_history[0].content
            # 新历史中保留的消息 seq 集合
            kept_seqs = {msg.seq for msg in new_history[1:] if msg.seq is not None}
            # 原始历史中被替换的最大 seq
            replaced_seqs = [
                m.get('seq') for m in history_raw
                if m.get('seq') is not None and m.get('seq') not in kept_seqs
            ]
            replaces_up_to_seq = max(replaced_seqs) if replaced_seqs else None

        return {
            'status': 'success',
            'before': before_count,
            'after': len(new_history),
            'tokens_saved': max(0, before_tokens - after_tokens),
            'summary_content': summary_content,
            'replaces_up_to_seq': replaces_up_to_seq,
        }

    def should_rebuild_after_append(self, total_tokens: int) -> bool:
        trigger_threshold = self.config.max_tokens * self.config.compression_trigger_ratio
        return total_tokens >= trigger_threshold

    def build_usage_stats(self, messages: List[Dict[str, Any]]) -> Dict[str, int]:
        current_tokens = self.count_messages_tokens(messages)
        system_tokens = self.count_messages_tokens([messages[0]]) if messages else 0
        return {
            'used_tokens': current_tokens,
            'system_prompt_tokens': system_tokens,
            'total_tokens': current_tokens,
            'budget_tokens': self.config.max_tokens + system_tokens,
        }

    def _build_prepared_result(
        self,
        *,
        messages: List[Dict[str, Any]],
        rebuild_reason: str,
        cache_hit: bool,
    ) -> PreparedMessagesResult:
        usage = self.build_usage_stats(messages)
        return PreparedMessagesResult(
            messages=messages,
            total_tokens=usage['total_tokens'],
            system_tokens=usage['system_prompt_tokens'],
            budget_tokens=usage['budget_tokens'],
            cache_hit=cache_hit,
            rebuild_reason=rebuild_reason,
        )

    def _prepare_messages_full(
        self,
        *,
        system_prompt: str,
        context,
        current_session: List[Dict[str, Any]],
        publisher=None,
        llm_config: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        self._ensure_memory_prefix_snapshot(context, reason='prepare_messages')
        history_raw = self._get_history_raw(context)
        history_resolved = resolve_compression_view(history_raw)
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
        for reminder_block in self._build_reminder_blocks(context):
            prepared.append({
                "role": "system",
                "content": reminder_block,
            })
        prepared.extend(history_resolved)
        prepared.extend(current_session)
        return self._apply_prompt_cache_policy(prepared, llm_config or {})

    @staticmethod
    def _render_system_reminder(context_map: Dict[str, str]) -> str:
        if not context_map:
            return ""
        lines = [
            "<system-reminder>",
            "As you answer the user's questions, you can use the following context:",
        ]
        for key, value in context_map.items():
            if not value:
                continue
            lines.append(f"# {key}")
            lines.append(str(value).strip())
        lines.extend([
            "",
            "IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.",
            "</system-reminder>",
        ])
        return "\n".join(lines)

    @staticmethod
    def _build_reminder_blocks(context) -> List[str]:
        reminders: List[str] = []

        memory_block = ContextPipeline._build_memory_block(context)
        if memory_block:
            reminder = ContextPipeline._render_system_reminder({'memory': memory_block})
            if reminder:
                reminders.append(reminder)

        return reminders

    @staticmethod
    def _build_memory_block(context) -> str:
        metadata = getattr(context, 'metadata', {}) or {}
        snapshot = metadata.get('memory_prefix_snapshot') or {}
        rendered_block = snapshot.get('rendered_block')
        if rendered_block:
            return str(rendered_block).strip()
        return ''

    @staticmethod
    def _ensure_memory_prefix_snapshot(context, *, reason: str) -> None:
        metadata = getattr(context, 'metadata', {}) or {}
        handle = getattr(context, 'memory_prefix_handle', None)
        snapshot = metadata.get('memory_prefix_snapshot')
        force_refresh = reason in {'apply_compression', 'fallback_truncate'}
        expected_fingerprint = (snapshot or {}).get('fingerprint', {}).get('fingerprint')
        current_fingerprint_payload = handle.get_current_fingerprint() if handle is not None else None
        current_fingerprint = (current_fingerprint_payload or {}).get('fingerprint')
        if not force_refresh and snapshot and expected_fingerprint and expected_fingerprint == current_fingerprint:
            return
        if handle is None:
            return
        refreshed = handle.refresh_snapshot(reason=reason, force_rebuild=force_refresh)
        if refreshed:
            metadata['memory_prefix_snapshot'] = refreshed
            return
        metadata.pop('memory_prefix_snapshot', None)

    # ── 内部方法 ──────────────────────────────────────────────────────────────

    def _get_system_llm_config(self) -> Optional[Dict[str, Any]]:
        """获取系统配置的保底 LLM 配置。"""
        try:
            from config import get_config
            system_config = get_config()
            llm = getattr(system_config, 'llm', None)
            if not llm:
                return None
            cfg = {
                'provider': getattr(llm, 'provider', None),
                'provider_type': getattr(llm, 'provider_type', None),
                'model_name': getattr(llm, 'model_name', None),
                'temperature': getattr(llm, 'temperature', 0.7),
            }
            for key, value in (getattr(llm, 'extra_params', None) or {}).items():
                if key not in cfg:
                    cfg[key] = value
            return cfg if cfg.get('provider') else None
        except Exception:
            return None

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
        self._ensure_memory_prefix_snapshot(context, reason='fallback_truncate')

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
        """尝试用 LLM 生成摘要。按 fast → default → 系统配置 逐级 fallback。"""

        # 构建候选配置列表（按优先级去重）
        candidates = []
        seen = set()
        for tier in ('fast', 'default'):
            cfg = self.get_llm_config_fn(task_type=tier)
            key = (cfg.get('provider'), cfg.get('provider_type'))
            if cfg.get("provider") and key not in seen:
                seen.add(key)
                candidates.append(cfg)

        # 最终 fallback：系统配置的保底 LLM
        system_llm = self._get_system_llm_config()
        if system_llm:
            key = (system_llm.get('provider'), system_llm.get('provider_type'))
            if system_llm.get('provider') and key not in seen:
                candidates.append(system_llm)

        if not candidates:
            raise ContextCompressionError("上下文压缩失败：无可用摘要模型（fast/default/系统配置均未配置）")

        # 准备摘要 prompt
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

        last_error = None
        for i, llm_config in enumerate(candidates):
            provider = llm_config['provider']
            provider_type = llm_config.get("provider_type")
            model_name = llm_config.get('model_name', 'unknown')
            tier_label = ['fast', 'default', '系统配置'][i] if i < 3 else f'fallback-{i}'
            try:
                self.logger.info(f"尝试 {tier_label} 层级模型进行压缩: provider={provider}, model={model_name}")
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
                    raise ContextCompressionError(f"模型返回错误: {resp.error}")

                content = (resp.content or "").strip()
                if not content:
                    raise ContextCompressionError("摘要模型返回空内容")
                if not content.startswith("[历史摘要]"):
                    content = "[历史摘要]\n" + content

                self.logger.info(f"LLM 摘要生成成功（{tier_label}）: {len(content)} 字符")
                return content

            except ContextCompressionError as e:
                last_error = e
                self.logger.warning(f"{tier_label} 层级摘要失败: {e}，尝试下一层级")
                continue
            except Exception as e:
                last_error = ContextCompressionError(str(e))
                self.logger.warning(f"{tier_label} 层级摘要异常: {e}，尝试下一层级")
                continue

        raise last_error or ContextCompressionError("上下文压缩失败：所有层级模型均不可用")

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
        self._ensure_memory_prefix_snapshot(context, reason='apply_compression')

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
