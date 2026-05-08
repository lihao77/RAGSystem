# -*- coding: utf-8 -*-
"""
ContextPipeline - 统一上下文压缩管道

单一入口，每轮调用一次，LLM 摘要优先。
完全替代两套旧机制：
  - compress_context_if_needed()（循环外，base.py）
  - manage_messages()（旧的循环内上下文管理逻辑）
"""

import hashlib
import logging
import re
import time
from dataclasses import dataclass
from typing import List, Dict, Any, Optional, Callable

from .compression_view import resolve_compression_view
from .config import ContextConfig
from .session_cache import get_cache, flush_session

logger = logging.getLogger(__name__)

# ─── Compact prompt constants (参考 Claude Code services/compact/prompt.ts) ──

_NO_TOOLS_PREAMBLE = (
    "重要提示：仅输出文本，不要调用任何工具。"
    "你已有生成摘要所需的全部上下文。工具调用将被拒绝并导致任务失败。\n\n"
)

_NO_TOOLS_TRAILER = (
    "\n\n提醒：不要调用任何工具。"
    "仅输出 <analysis> 块（内部草稿）和 <summary> 块（最终摘要）。"
)

_COMPACT_PROMPT_BODY = """\
你的任务是对以下对话生成详细摘要，重点关注用户的明确请求和之前的操作记录。
摘要须全面捕捉技术细节、代码模式和架构决策，以便后续在不丢失上下文的情况下继续工作。

在提供最终摘要之前，请将分析过程写在 <analysis> 标签内（此部分最终会被丢弃，是供你整理思路的草稿区）：
1. 按时间顺序分析每条消息，识别：
   - 用户的明确请求和意图
   - 处理请求的方式与关键决策
   - 技术概念、代码模式、文件名、函数签名、具体修改
   - 遇到的错误及修复方法，以及用户的特定反馈
2. 检查技术准确性与完整性

摘要须包含以下章节：

1. 主要请求和意图：详细描述所有明确请求和意图
2. 关键技术概念：列出重要技术概念、技术栈和框架
3. 文件和代码片段：列举查看/修改/创建的文件，附重要代码片段，说明为何重要
4. 错误与修复：列出所有错误及修复方法，包含用户反馈
5. 问题解决：记录已解决问题和正在进行的排查
6. 所有用户消息：列出所有非工具结果的用户消息（完整保留）
7. 待办任务：列出所有待处理任务
8. 当前工作：详细描述摘要请求前正在进行的工作（附文件名和代码）
9. 可选的下一步：列出与最近工作直接相关的下一步，引用对话原文

输出格式：

<analysis>
[分析过程，确保覆盖所有要点]
</analysis>

<summary>
1. 主要请求和意图：
   [详细描述]

2. 关键技术概念：
   - [概念1]

3. 文件和代码片段：
   - [文件名]
     - [重要性说明]
     - [代码片段]

4. 错误与修复：
   - [错误]：[修复方法]

5. 问题解决：
   [描述]

6. 所有用户消息：
   - [消息]

7. 待办任务：
   - [任务]

8. 当前工作：
   [描述]

9. 可选的下一步：
   [下一步]
</summary>
"""

_COMPACT_SUMMARY_PREFIX = (
    "本次会话从之前的对话继续，以下是该对话早期内容的摘要。\n\n"
)

# microcompact：旧工具结果内容替换占位符
_MICROCOMPACT_CLEARED_LABEL = "[工具结果已清理]"


class ContextCompressionError(RuntimeError):
    """历史摘要失败时抛出的上下文准备异常。"""


@dataclass
class CompressionResult:
    """_compress() 的返回值，统一描述一次压缩操作的结果。"""
    did_compress: bool
    messages: List[Dict[str, Any]]         # 压缩后的 history_resolved
    summary_content: Optional[str] = None
    replaces_up_to_seq: Optional[int] = None
    reason: str = ""   # 'success' / 'insufficient_candidates'


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
         d. 失败：写入降级截断标记并保留最近消息，避免当前轮执行中断
    5. 返回：[system] + history_resolved + current_session
    """

    def __init__(
        self,
        config: ContextConfig,
        model_adapter,
        get_llm_config_fn: Callable[[Optional[str]], Dict[str, Any]],  # 支持 task_type 参数
        logger: Optional[logging.Logger] = None,
        observation_window=None,
        agent_name: str = "",
    ):
        self.config = config
        self.model_adapter = model_adapter
        self.get_llm_config_fn = get_llm_config_fn
        self.logger = logger or logging.getLogger(__name__)
        self.observation_window = observation_window
        self.agent_name = agent_name
        from .token_counter import TokenCounter
        self._token_counter = TokenCounter(model_name=config.model_name)

    def _session_cache(self, context) -> Dict[str, Any]:
        """获取当前 session+thread 的持久化缓存 dict。"""
        session_id = getattr(context, 'session_id', '') or ''
        thread_key = (getattr(context, 'metadata', None) or {}).get('thread_key', 'root') or 'root'
        return get_cache(session_id, thread_key)

    @staticmethod
    def flush_session_cache(context) -> None:
        """将当前 session 的缓存写回 DB（run 结束时由上层调用）。"""
        session_id = getattr(context, 'session_id', '') or ''
        if session_id:
            flush_session(session_id)

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
    ) -> PreparedMessagesResult:
        cache = self._session_cache(context)

        cached_messages = cache.get('prepared_messages')
        cached_session_len = cache.get('prepared_session_len', 0)
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
                    cache['prepared_messages'] = updated_messages
                    cache['prepared_session_len'] = len(current_session)
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
        cache['prepared_messages'] = prepared
        cache['prepared_session_len'] = len(current_session)
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
        stable_content = self._build_stable_prefix_content(system_prompt, context)
        prepared = [{"role": "system", "content": stable_content}]
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

    def microcompact_messages(
        self,
        messages: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """微压缩：清除旧工具结果内容，无需调用 LLM。

        仿照 Claude Code 的 microcompactMessages 逻辑：
        - 识别 metadata.msg_type == 'observation' 的消息（工具结果）
        - 保留最近 microcompact_keep_recent_tools 条的完整内容
        - 将更旧的内容替换为占位符，节省 tokens 同时保留结构
        """
        keep = self.config.microcompact_keep_recent_tools
        obs_indices = [
            i for i, m in enumerate(messages)
            if (m.get('metadata') or {}).get('msg_type') == 'observation'
        ]
        if not obs_indices or len(obs_indices) <= keep:
            return messages

        to_clear = set(obs_indices[:-keep])
        result = []
        cleared = 0
        for i, m in enumerate(messages):
            if i in to_clear and m.get('content') != _MICROCOMPACT_CLEARED_LABEL:
                round_num = (m.get('metadata') or {}).get('round', '')
                label = (
                    f"[工具结果已清理，轮次 {round_num}]"
                    if round_num else _MICROCOMPACT_CLEARED_LABEL
                )
                result.append({**m, 'content': label})
                cleared += 1
            else:
                result.append(m)

        if cleared:
            tokens_before = self._token_counter.count_messages(messages)
            tokens_after = self._token_counter.count_messages(result)
            self.logger.debug(
                f"微压缩: 清除 {cleared} 条旧工具结果"
                f"（保留最近 {keep} 条），"
                f"节省约 {tokens_before - tokens_after} tokens"
            )
        return result

    # ── 稳定前缀（KV 缓存保护）────────────────────────────────────────────

    @staticmethod
    def _build_stable_prefix_content(system_prompt: str, context) -> str:
        """合并 system_prompt + memory 为单个稳定前缀内容。"""
        metadata = getattr(context, 'metadata', {}) or {}
        snapshot = metadata.get('memory_prefix_snapshot') or {}
        memory_block = snapshot.get('rendered_block')
        if memory_block:
            return f"{system_prompt}\n\n{str(memory_block).strip()}"
        return system_prompt

    @staticmethod
    def _compute_stable_prefix_fingerprint(content: str) -> str:
        """计算稳定前缀的 fingerprint（SHA256 前 16 位）。"""
        return hashlib.sha256(content.encode('utf-8')).hexdigest()[:16]

    def _should_microcompact(self, fingerprint_changed: bool, cache: Dict[str, Any]) -> bool:
        """判断是否应执行 microcompact。

        双重门控：fingerprint 变化（缓存已废）或超过时间阈值（服务端缓存已过期）才执行。
        连续对话中两者都不满足 → 跳过，保护 KV 缓存。
        """
        if fingerprint_changed:
            return True
        last_time = cache.get('t')
        if last_time is None:
            return True
        threshold = self.config.local_cache_ttl_seconds
        if time.time() - last_time >= threshold:
            return True
        return False

    def force_compress(self, context, publisher=None, system_prompt: str = "", cancel_event=None) -> Dict[str, Any]:
        """强制压缩上下文，跳过阈值检查。返回压缩统计和持久化信息。"""
        history_raw = self._get_history_raw(context)
        history_resolved = resolve_compression_view(history_raw)

        if not history_resolved:
            return {'status': 'skipped', 'reason': 'no_history', 'before': 0, 'after': 0, 'tokens_saved': 0}

        before_count = len(history_raw)
        before_tokens = self._token_counter.count_messages(history_resolved)

        try:
            result = self._compress(
                history_raw, history_resolved, context, publisher,
                system_prompt=system_prompt, cancel_event=cancel_event,
            )
        except ContextCompressionError as e:
            return {'status': 'error', 'reason': str(e), 'before': before_count, 'after': before_count, 'tokens_saved': 0}

        if not result.did_compress:
            return {
                'status': 'skipped',
                'reason': result.reason,
                'before': before_count,
                'after': before_count,
                'tokens_saved': 0,
                'summary_content': None,
                'replaces_up_to_seq': None,
            }

        after_tokens = self._token_counter.count_messages(result.messages)
        # 压缩后历史大幅变化，清除缓存强制下次 rebuild
        cache = self._session_cache(context)
        cache.pop('fp', None)
        cache.pop('_content', None)
        return {
            'status': 'success',
            'before': before_count,
            'after': len(context.conversation_history),
            'tokens_saved': max(0, before_tokens - after_tokens),
            'summary_content': result.summary_content,
            'replaces_up_to_seq': result.replaces_up_to_seq,
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

    @staticmethod
    def _get_memory_snapshot_fp(metadata: Dict[str, Any]) -> Optional[str]:
        """提取 memory_prefix_snapshot 中的 fingerprint。"""
        snapshot = metadata.get('memory_prefix_snapshot') or {}
        fp_data = snapshot.get('fingerprint') or {}
        return fp_data.get('fingerprint')

    def _prepare_messages_full(
        self,
        *,
        system_prompt: str,
        context,
        current_session: List[Dict[str, Any]],
        publisher=None,
        llm_config: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        cache = self._session_cache(context)
        metadata = getattr(context, 'metadata', {}) or {}

        # 记录 memory 变化前的 fingerprint
        prev_mem_fp = self._get_memory_snapshot_fp(metadata)
        self._ensure_memory_prefix_snapshot(context, reason='prepare_messages')
        curr_mem_fp = self._get_memory_snapshot_fp(metadata)
        memory_changed = (curr_mem_fp != prev_mem_fp)

        # 尝试复用缓存中的稳定前缀
        prev_fp = cache.get('fp')
        cached_content = cache.get('_content')  # 不持久化，仅内存缓存

        if prev_fp and cached_content and not memory_changed:
            # memory 未变，system_prompt 在 ReAct 循环中不变 → 缓存有效
            stable_content = cached_content
            fp_changed = False
        else:
            # 需要重建（首次、memory 变化、或 force_compress 后）
            stable_content = self._build_stable_prefix_content(system_prompt, context)
            fingerprint = self._compute_stable_prefix_fingerprint(stable_content)
            fp_changed = (fingerprint != prev_fp)
            cache['fp'] = fingerprint
            cache['_content'] = stable_content

        history_raw = self._get_history_raw(context)
        history_resolved = resolve_compression_view(history_raw)

        # microcompact：仅在 fingerprint 变化或超时时执行，保护 KV 缓存
        if self._should_microcompact(fp_changed, cache):
            history_resolved = self.microcompact_messages(history_resolved)

        history_tokens = self._token_counter.count_messages(history_resolved)
        trigger_threshold = self.config.max_tokens * self.config.compression_trigger_ratio
        self.logger.debug(
            f"压缩检查: history_msgs={len(history_resolved)}, "
            f"history_tokens={history_tokens}, "
            f"threshold={trigger_threshold:.0f} "
            f"(max={self.config.max_tokens}, ratio={self.config.compression_trigger_ratio})"
        )

        if history_tokens >= trigger_threshold:
            self.logger.debug(
                f"触发上下文压缩: tokens={history_tokens}/{self.config.max_tokens} "
                f"({history_tokens / self.config.max_tokens * 100:.1f}%)"
            )
            compress_result = self._compress(
                history_raw, history_resolved, context, publisher,
                system_prompt=system_prompt,
                fallback_on_error=True,
            )
            history_resolved = compress_result.messages

        # 单个 system message（已合并 memory），减少缓存断裂点
        prepared = [{"role": "system", "content": stable_content}]
        prepared.extend(history_resolved)
        prepared.extend(current_session)

        # 更新时间戳
        cache['t'] = time.time()

        return self._apply_prompt_cache_policy(prepared, llm_config or {})

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
        cancel_event=None,
        fallback_on_error: bool = False,
    ) -> CompressionResult:
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
            return CompressionResult(
                did_compress=False,
                messages=history_resolved,
                reason='insufficient_candidates',
            )

        segment = candidates[:-preserve_count]

        # 提取已有摘要
        existing_summary = ""
        if start_idx == 1:
            existing_summary = history_resolved[0].get("content", "")

        try:
            self.logger.debug(f"开始 LLM 摘要: 待压缩 {len(segment)} 条消息, 已有摘要={bool(existing_summary)}")
            if publisher:
                publisher.compression_start(
                    message_count=len(segment),
                    has_existing_summary=bool(existing_summary),
                )
                self._publish_pre_compression_usage(publisher, history_resolved, system_prompt)
            summary = self._try_llm_summary(segment, existing_summary, publisher=publisher, cancel_event=cancel_event)
        except ContextCompressionError as error:
            if not fallback_on_error:
                raise
            if str(error) == "压缩已被用户中断":
                raise
            self.logger.warning("LLM 摘要失败，降级截断历史上下文: %s", error)
            self._record_compression(status="failed", replaced_messages=0)
            return self._fallback_truncate(
                segment=segment,
                history_raw=history_raw,
                context=context,
                publisher=publisher,
                error=error,
            )
        self._record_compression(status="success", replaced_messages=len(segment))
        resolved, summary_content, replaces_up_to_seq = self._apply_compression(
            summary, segment, history_raw, context, publisher
        )
        return CompressionResult(
            did_compress=True,
            messages=resolved,
            summary_content=summary_content,
            replaces_up_to_seq=replaces_up_to_seq,
            reason='success',
        )

    def _fallback_truncate(
        self,
        *,
        segment: List[Dict[str, Any]],
        history_raw: List[Dict[str, Any]],
        context,
        publisher=None,
        error: ContextCompressionError,
    ) -> CompressionResult:
        """When LLM summarization is unavailable, replace old history with an explicit marker."""
        trimmed_messages = len(segment)
        summary = (
            f"{_COMPACT_SUMMARY_PREFIX}"
            f"LLM 摘要不可用，已降级截断 {trimmed_messages} 条较早历史消息以保持上下文预算。\n\n"
            f"降级原因: {error}"
        )
        resolved, summary_content, replaces_up_to_seq = self._apply_compression(
            summary,
            segment,
            history_raw,
            context,
            publisher,
        )
        self._record_trim(trimmed_messages=trimmed_messages)
        return CompressionResult(
            did_compress=True,
            messages=resolved,
            summary_content=summary_content,
            replaces_up_to_seq=replaces_up_to_seq,
            reason='fallback_truncate',
        )

    def _try_llm_summary(
        self,
        segment: List[Dict[str, Any]],
        existing_summary: str = "",
        publisher=None,
        cancel_event=None,
    ) -> str:
        """尝试用 LLM 生成摘要。按 fast → default → 系统配置 逐级 fallback。"""

        # 构建候选配置列表（按优先级去重），同时记录 label
        candidates = []  # List of (label, cfg)
        seen = set()
        for tier in ('default', 'fast'):
            cfg = self.get_llm_config_fn(task_type=tier)
            key = (cfg.get('provider'), cfg.get('provider_type'))
            if cfg.get("provider") and key not in seen:
                seen.add(key)
                candidates.append((tier, cfg))

        # 最终 fallback：系统配置的保底 LLM
        system_llm = self._get_system_llm_config()
        if system_llm:
            key = (system_llm.get('provider'), system_llm.get('provider_type'))
            if system_llm.get('provider') and key not in seen:
                candidates.append(('系统配置', system_llm))

        if not candidates:
            raise ContextCompressionError("上下文压缩失败：无可用摘要模型（fast/default/系统配置均未配置）")

        # 构建摘要 prompt（参考 Claude Code prompt.ts 结构）
        req = [
            {
                "role": "system",
                "content": (
                    "你是一名专业的对话摘要助手。"
                    "你的任务是将对话压缩为结构化摘要，以便后续会话继续进行。"
                    "不要调用任何工具，只输出文本。"
                ),
            },
            {"role": "user", "content": self._build_compact_prompt(segment, existing_summary)},
        ]
        last_error = None
        for tier_label, llm_config in candidates:
            # 每次 fallback 重试前检查中断信号
            if cancel_event and cancel_event.is_set():
                raise ContextCompressionError("压缩已被用户中断")
            provider = llm_config['provider']
            provider_type = llm_config.get("provider_type")
            model_name = llm_config.get('model_name', 'unknown')
            try:
                self.logger.debug(f"尝试 {tier_label} 层级模型进行压缩: provider={provider}, model={model_name}")
                raw = self._call_summary_model(
                    messages=req,
                    provider=provider,
                    provider_type=provider_type,
                    cancel_event=cancel_event,
                )
                if not raw:
                    raise ContextCompressionError("摘要模型返回空内容")
                content = self._format_compact_response(raw)
                self.logger.debug(f"LLM 摘要生成成功（{tier_label}）: {len(content)} 字符")
                return content

            except ContextCompressionError as e:
                last_error = e
                self.logger.warning(f"{tier_label} 层级摘要失败: {e}，尝试下一层级")
                continue
            except Exception as e:
                last_error = ContextCompressionError(str(e))
                self.logger.warning(
                    f"{tier_label} 层级摘要异常: {type(e).__name__}: {e}，"
                    f"provider={provider}/{provider_type} model={model_name}，尝试下一层级",
                    exc_info=True,
                )
                continue

        raise last_error or ContextCompressionError("上下文压缩失败：所有层级模型均不可用")

    def _call_summary_model(
        self,
        *,
        messages: List[Dict[str, Any]],
        provider: str,
        provider_type: Optional[str],
        cancel_event=None,
    ) -> str:
        """Collect summary text from streaming first, then non-streaming when needed."""
        stream_error = None
        stream_method = getattr(self.model_adapter, 'chat_completion_stream', None)
        if callable(stream_method):
            raw_parts = []
            try:
                for chunk in stream_method(
                    messages=messages,
                    provider=provider,
                    provider_type=provider_type,
                    temperature=0.2,
                    max_tokens=self.config.summarize_max_tokens,
                    reasoning_effort="none",
                    cancel_event=cancel_event,
                ):
                    if chunk.get('error'):
                        stream_error = chunk['error']
                        break
                    raw_parts.append(chunk.get('content') or '')
            except Exception as error:
                stream_error = str(error)

            raw = ''.join(raw_parts).strip()
            if raw:
                return raw

        completion_method = getattr(self.model_adapter, 'chat_completion', None)
        if callable(completion_method):
            response = completion_method(
                messages=messages,
                provider=provider,
                provider_type=provider_type,
                temperature=0.2,
                max_tokens=self.config.summarize_max_tokens,
                reasoning_effort="none",
                cancel_event=cancel_event,
            )
            if isinstance(response, dict):
                error = response.get('error')
                content = response.get('content')
            else:
                error = getattr(response, 'error', None)
                content = getattr(response, 'content', None)
            if error:
                raise ContextCompressionError(f"非流式摘要失败: {error}")
            if content:
                return str(content).strip()

        if stream_error:
            raise ContextCompressionError(f"流式摘要失败: {stream_error}")
        raise ContextCompressionError("摘要适配器不支持 chat_completion_stream 或 chat_completion")

    @staticmethod
    def _build_compact_prompt(segment: "List[Dict[str, Any]]", existing_summary: str = "") -> str:
        """构建结构化 compact prompt（参考 Claude Code prompt.ts）。

        - <analysis> 草稿区：供 LLM 整理思路（最终被丢弃）
        - <summary> 9章节结构化摘要
        - 前后 NO_TOOLS 提示防止工具调用
        """
        msg_lines = []
        for m in segment:
            role = m.get("role", "user")
            c = (m.get("content") or "").strip()
            # 跳过微压缩清除标记（无信息量）
            if c and c != _MICROCOMPACT_CLEARED_LABEL and not c.startswith("[工具结果已清理"):
                msg_lines.append(f"{role}: {c}")
        conversation_text = "\n".join(msg_lines) or "（无内容）"

        existing_section = ""
        if existing_summary:
            existing_section = (
                f"\n\n---已有历史摘要（将与新内容合并）---\n{existing_summary}\n---end---"
            )

        prompt = (
            _NO_TOOLS_PREAMBLE
            + _COMPACT_PROMPT_BODY
            + existing_section
            + "\n\n---待压缩对话内容---\n"
            + conversation_text
            + "\n---end---"
            + _NO_TOOLS_TRAILER
        )
        return prompt

    @staticmethod
    def _format_compact_response(raw: str) -> str:
        """解析 LLM 响应：去除 <analysis> 草稿区，提取 <summary> 内容。

        参考 Claude Code 的 formatCompactSummary()：
        - 剥离 <analysis>...</analysis>（LLM 思维草稿，不进入上下文）
        - 提取 <summary>...</summary> 内容作为最终摘要
        - 如无 XML 标签，原样返回（兼容简单响应）
        """
        # 去除 <analysis> 草稿区
        cleaned = re.sub(r'<analysis>[\s\S]*?</analysis>', '', raw, flags=re.IGNORECASE)

        # 提取 <summary> 内容
        match = re.search(r'<summary>([\s\S]*?)</summary>', cleaned, re.IGNORECASE)
        if match:
            summary_body = match.group(1).strip()
        else:
            # 无 <summary> 标签，使用清理后的全文（兼容旧 prompt）
            summary_body = cleaned.strip()

        if not summary_body:
            summary_body = raw.strip()

        # 清理多余空行
        summary_body = re.sub(r'\n{3,}', '\n\n', summary_body).strip()

        # 加上 Claude Code 风格的会话延续前缀
        return _COMPACT_SUMMARY_PREFIX + "Summary:\n" + summary_body

    def _apply_compression(
        self,
        summary_content: str,
        segment: List[Dict[str, Any]],
        history_raw: List[Dict[str, Any]],
        context,
        publisher=None,
    ) -> tuple:
        """应用 LLM 摘要压缩，写回 context，发布事件。
        返回 (resolved, summary_content, replaces_up_to_seq)。
        """
        summary_message = {
            "role": "assistant",
            "content": summary_content,
            "metadata": {"compression": True},
        }

        # 找到 segment 最后一条消息在 history_raw 中的索引
        # 优先使用 seq 精确匹配，避免重复内容误命中（Bug 2 fix）
        last_msg = segment[-1] if segment else None
        remaining = []
        replaces_up_to_seq: int | None = None

        if last_msg:
            found_idx = -1
            last_seq = last_msg.get('seq')
            for idx, m in enumerate(history_raw):
                if last_seq is not None:
                    match = m.get('seq') == last_seq
                else:
                    match = (
                        m.get("role") == last_msg.get("role")
                        and m.get("content") == last_msg.get("content")
                    )
                if match:
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
        self.logger.debug(
            f"LLM 压缩完成: {len(history_raw)} -> {len(updated_raw)} 条原始消息, "
            f"{len(resolved)} 条解析后消息"
        )
        return resolved, summary_content, replaces_up_to_seq

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

    def _record_trim(self, *, trimmed_messages: int) -> None:
        if self.observation_window is None:
            return
        self.observation_window.record_trim(trimmed_messages=trimmed_messages)
