# -*- coding: utf-8 -*-
"""
pipeline.py 压缩逻辑单元测试。

覆盖范围：
- force_compress：候选不足时正确返回 skipped（Bug 1 fix）
- force_compress：已有旧摘要 + 候选不足时不重复插入（Bug 1b fix）
- _apply_compression：seq 优先匹配（Bug 2 fix）
- force_compress：正常压缩路径返回 success + summary_content
- CompressionResult：_compress 返回语义正确
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch

import pytest

from agents.context.config import ContextConfig
from agents.context.pipeline import ContextPipeline, CompressionResult, ContextCompressionError


# ─── Fixtures / helpers ──────────────────────────────────────────────────────

@dataclass
class FakeMessage:
    role: str
    content: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    seq: Optional[int] = None


@dataclass
class FakeContext:
    conversation_history: List[FakeMessage] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    memory_prefix_handle: Any = None


def _make_pipeline(preserve_recent_turns: int = 2) -> ContextPipeline:
    """构造一个不依赖真实 LLM 的 ContextPipeline（_try_llm_summary 被 mock）。"""
    config = ContextConfig(
        max_tokens=4000,
        compression_trigger_ratio=0.85,
        summarize_max_tokens=200,
        preserve_recent_turns=preserve_recent_turns,
    )
    model_adapter = MagicMock()
    pipeline = ContextPipeline(
        config=config,
        model_adapter=model_adapter,
        get_llm_config_fn=lambda task_type=None: {'provider': 'test', 'provider_type': 'test'},
    )
    return pipeline


def _make_context_with_messages(msgs: List[Dict]) -> FakeContext:
    ctx = FakeContext()
    ctx.conversation_history = [
        FakeMessage(
            role=m['role'],
            content=m['content'],
            metadata=m.get('metadata', {}),
            seq=m.get('seq'),
        )
        for m in msgs
    ]
    return ctx


# ─── Tests ───────────────────────────────────────────────────────────────────

class TestForceCompressSkipBehavior:
    """Bug 1 fix：候选不足时必须返回 status='skipped'，不误报 success。"""

    def test_skipped_when_no_history(self):
        pipeline = _make_pipeline()
        ctx = FakeContext()
        result = pipeline.force_compress(ctx, system_prompt='')
        assert result['status'] == 'skipped'
        assert result['reason'] == 'no_history'
        assert result['tokens_saved'] == 0

    def test_skipped_when_insufficient_candidates(self):
        """preserve_recent_turns=2 → preserve_count=4；消息 ≤4 条时不压缩。"""
        pipeline = _make_pipeline(preserve_recent_turns=2)
        # 4 条普通消息，恰好等于 preserve_count
        msgs = [
            {'seq': i, 'role': 'user' if i % 2 == 1 else 'assistant', 'content': f'msg{i}', 'metadata': {}}
            for i in range(1, 5)
        ]
        ctx = _make_context_with_messages(msgs)
        original_history = list(ctx.conversation_history)

        result = pipeline.force_compress(ctx, system_prompt='')

        assert result['status'] == 'skipped'
        assert result['reason'] == 'insufficient_candidates'
        assert result['tokens_saved'] == 0
        assert result['summary_content'] is None
        # context 不应被修改
        assert ctx.conversation_history == original_history

    def test_skipped_does_not_expose_old_summary_content(self):
        """Bug 1b fix：已有旧摘要 + 候选不足时，summary_content 必须为 None，
        防止 compact_session 将旧摘要重复写入 DB。"""
        pipeline = _make_pipeline(preserve_recent_turns=2)
        # 旧摘要 + 2 轮（4 条）消息 = candidates ≤ preserve_count
        msgs = [
            {'seq': 3, 'role': 'assistant', 'content': '[历史摘要]\n旧摘要内容',
             'metadata': {'compression': True, 'replaces_up_to_seq': 2}},
            {'seq': 4, 'role': 'user', 'content': 'q1', 'metadata': {}},
            {'seq': 5, 'role': 'assistant', 'content': 'a1', 'metadata': {}},
            {'seq': 6, 'role': 'user', 'content': 'q2', 'metadata': {}},
            {'seq': 7, 'role': 'assistant', 'content': 'a2', 'metadata': {}},
        ]
        ctx = _make_context_with_messages(msgs)

        result = pipeline.force_compress(ctx, system_prompt='')

        assert result['status'] == 'skipped'
        assert result['summary_content'] is None   # 核心断言：不能返回旧摘要


class TestForceCompressSuccess:
    """正常压缩路径：LLM 返回摘要，status='success'，summary_content 非 None。"""

    def test_success_path(self):
        pipeline = _make_pipeline(preserve_recent_turns=2)
        # 7 条消息：preserve_count=4，candidates=7，segment=3，足够触发
        msgs = [
            {'seq': i, 'role': 'user' if i % 2 == 1 else 'assistant', 'content': f'msg{i}', 'metadata': {}}
            for i in range(1, 8)
        ]
        ctx = _make_context_with_messages(msgs)

        with patch.object(pipeline, '_try_llm_summary', return_value='[历史摘要]\n生成的摘要'):
            result = pipeline.force_compress(ctx, system_prompt='')

        assert result['status'] == 'success'
        assert result['summary_content'] == '[历史摘要]\n生成的摘要'
        assert result['before'] == 7
        assert result['after'] < 7
        assert result['tokens_saved'] >= 0

    def test_success_populates_replaces_up_to_seq(self):
        """压缩成功后 replaces_up_to_seq 必须是被压缩的最后一条消息的 seq。"""
        pipeline = _make_pipeline(preserve_recent_turns=2)
        msgs = [
            {'seq': i, 'role': 'user' if i % 2 == 1 else 'assistant', 'content': f'msg{i}', 'metadata': {}}
            for i in range(1, 8)
        ]
        ctx = _make_context_with_messages(msgs)

        with patch.object(pipeline, '_try_llm_summary', return_value='[历史摘要]\n摘要'):
            result = pipeline.force_compress(ctx, system_prompt='')

        # segment = msgs[0..2]（seq 1,2,3），preserve 后 4 条（seq 4-7）
        assert result['replaces_up_to_seq'] == 3


class TestApplyCompressionSeqMatching:
    """Bug 2 fix：_apply_compression 使用 seq 优先匹配，不依赖 role+content。"""

    def test_seq_match_takes_priority_over_content(self):
        """有重复内容时，seq 匹配确保命中正确的消息，不误切。"""
        pipeline = _make_pipeline(preserve_recent_turns=1)

        # history_raw 中有两条内容相同的 assistant 消息（seq 不同）
        history_raw = [
            {'seq': 1, 'role': 'user', 'content': 'q', 'metadata': {}},
            {'seq': 2, 'role': 'assistant', 'content': '同样的回答', 'metadata': {}},
            {'seq': 3, 'role': 'user', 'content': 'q2', 'metadata': {}},
            {'seq': 4, 'role': 'assistant', 'content': '同样的回答', 'metadata': {}},  # 内容重复
        ]
        ctx = _make_context_with_messages(history_raw)

        # segment 最后一条是 seq=2 的 assistant 消息
        segment = [history_raw[0], history_raw[1]]  # seq 1, 2

        resolved, summary_content, replaces_up_to_seq = pipeline._apply_compression(
            summary_content='[历史摘要]\n测试摘要',
            segment=segment,
            history_raw=history_raw,
            context=ctx,
        )

        # seq 匹配：应命中 seq=2，replaces_up_to_seq=2，remaining = [seq3, seq4]
        assert replaces_up_to_seq == 2
        # 压缩后保留：摘要 + seq3 + seq4 → resolved 有 3 条
        assert len(resolved) == 3

    def test_fallback_to_content_match_when_no_seq(self):
        """segment 消息没有 seq 时，降级到 role+content 匹配，不崩溃。"""
        pipeline = _make_pipeline(preserve_recent_turns=1)

        history_raw = [
            {'seq': None, 'role': 'user', 'content': 'hello', 'metadata': {}},
            {'seq': None, 'role': 'assistant', 'content': 'world', 'metadata': {}},
            {'seq': None, 'role': 'user', 'content': 'bye', 'metadata': {}},
        ]
        ctx = _make_context_with_messages(history_raw)
        segment = [history_raw[0], history_raw[1]]

        resolved, _, _ = pipeline._apply_compression(
            summary_content='[历史摘要]\n摘要',
            segment=segment,
            history_raw=history_raw,
            context=ctx,
        )
        # 摘要 + bye = 2 条
        assert len(resolved) == 2


class TestCompressResult:
    """CompressionResult 返回语义一致性。"""

    def test_insufficient_candidates_returns_compression_result(self):
        pipeline = _make_pipeline(preserve_recent_turns=2)
        msgs = [
            {'seq': i, 'role': 'user' if i % 2 == 1 else 'assistant', 'content': f'x{i}', 'metadata': {}}
            for i in range(1, 5)
        ]
        history_raw = msgs
        history_resolved = msgs  # 简化：不含压缩消息
        ctx = _make_context_with_messages(msgs)

        result = pipeline._compress(history_raw, history_resolved, ctx, None)

        assert isinstance(result, CompressionResult)
        assert result.did_compress is False
        assert result.reason == 'insufficient_candidates'
        assert result.messages == history_resolved

    def test_successful_compress_returns_compression_result(self):
        pipeline = _make_pipeline(preserve_recent_turns=2)
        msgs = [
            {'seq': i, 'role': 'user' if i % 2 == 1 else 'assistant', 'content': f'x{i}', 'metadata': {}}
            for i in range(1, 8)
        ]
        ctx = _make_context_with_messages(msgs)

        with patch.object(pipeline, '_try_llm_summary', return_value='[历史摘要]\n结果'):
            result = pipeline._compress(msgs, msgs, ctx, None)

        assert isinstance(result, CompressionResult)
        assert result.did_compress is True
        assert result.reason == 'success'
        assert result.summary_content == '[历史摘要]\n结果'


class TestForceCompressError:
    """LLM 失败时 force_compress 返回 error，不截断消息。"""

    def test_llm_failure_returns_error_status(self):
        pipeline = _make_pipeline(preserve_recent_turns=2)
        msgs = [
            {'seq': i, 'role': 'user' if i % 2 == 1 else 'assistant', 'content': f'msg{i}', 'metadata': {}}
            for i in range(1, 8)
        ]
        ctx = _make_context_with_messages(msgs)
        original_history = list(ctx.conversation_history)

        with patch.object(pipeline, '_try_llm_summary',
                          side_effect=ContextCompressionError('摘要模型返回空内容')):
            result = pipeline.force_compress(ctx, system_prompt='')

        assert result['status'] == 'error'
        assert '摘要模型返回空内容' in result['reason']
        # 重要：context 不应被修改
        assert ctx.conversation_history == original_history

    def test_llm_failure_in_loop_raises(self):
        """循环内压缩失败时，ContextCompressionError 上抛给 agent 错误处理。"""
        pipeline = _make_pipeline(preserve_recent_turns=2)
        msgs = [
            {'seq': i, 'role': 'user' if i % 2 == 1 else 'assistant', 'content': f'msg{i}', 'metadata': {}}
            for i in range(1, 8)
        ]
        ctx = _make_context_with_messages(msgs)

        with patch.object(pipeline, '_try_llm_summary',
                          side_effect=ContextCompressionError('所有层级均不可用')):
            with pytest.raises(ContextCompressionError):
                pipeline._compress(msgs, msgs, ctx, None)


class TestMicrocompact:
    """microcompact_messages：旧工具结果清除逻辑。"""

    def _make_obs_msg(self, content: str, round_num: int) -> Dict[str, Any]:
        return {
            'role': 'user',
            'content': content,
            'metadata': {'react_intermediate': True, 'msg_type': 'observation', 'round': round_num},
            'seq': round_num * 2,
        }

    def _make_assistant_msg(self, content: str, round_num: int) -> Dict[str, Any]:
        return {
            'role': 'assistant',
            'content': content,
            'metadata': {'react_intermediate': True, 'msg_type': 'intent', 'round': round_num},
            'seq': round_num * 2 - 1,
        }

    def test_clears_old_observations_keeps_recent(self):
        """超出 keep 数量的旧 observation 应被清除，最近 N 条保留。"""
        pipeline = _make_pipeline()
        # 6 条 observation，keep=5，最旧的那条应被清除
        msgs = []
        for i in range(1, 7):
            msgs.append(self._make_assistant_msg(f'thought{i}', i))
            msgs.append(self._make_obs_msg(f'file_content_{i}_very_long', i))

        result = pipeline.microcompact_messages(msgs)

        # 找出所有 observation
        obs = [m for m in result if (m.get('metadata') or {}).get('msg_type') == 'observation']
        assert len(obs) == 6

        # 最旧的 1 条（round=1）应被清除
        old_obs = [m for m in obs if (m.get('metadata') or {}).get('round') == 1]
        assert len(old_obs) == 1
        assert '[工具结果已清理' in old_obs[0]['content']

        # 最近 5 条（round 2-6）应保留
        for i in range(2, 7):
            recent_obs = [m for m in obs if (m.get('metadata') or {}).get('round') == i]
            assert len(recent_obs) == 1
            assert recent_obs[0]['content'] == f'file_content_{i}_very_long'

    def test_no_clear_when_under_limit(self):
        """observation 数量 <= keep 时，不清除任何内容。"""
        pipeline = _make_pipeline()
        msgs = [self._make_obs_msg(f'content{i}', i) for i in range(1, 6)]  # 5 条 = keep

        result = pipeline.microcompact_messages(msgs)

        for m in result:
            assert '[工具结果已清理' not in m['content']

    def test_non_observation_messages_unchanged(self):
        """非 observation 消息不受影响。"""
        pipeline = _make_pipeline()
        msgs = [
            {'role': 'user', 'content': 'user question', 'metadata': {}, 'seq': 1},
            {'role': 'assistant', 'content': 'assistant answer', 'metadata': {}, 'seq': 2},
        ] + [self._make_obs_msg(f'obs{i}', i) for i in range(1, 8)]

        result = pipeline.microcompact_messages(msgs)

        # user/assistant 消息不受影响
        non_obs = [m for m in result if (m.get('metadata') or {}).get('msg_type') != 'observation']
        for m in non_obs:
            assert '[工具结果已清理' not in m['content']

    def test_already_cleared_not_double_cleared(self):
        """已清除的消息不重复处理（幂等性）。"""
        from agents.context.pipeline import _MICROCOMPACT_CLEARED_LABEL
        pipeline = _make_pipeline()
        msgs = [self._make_obs_msg(_MICROCOMPACT_CLEARED_LABEL, i) for i in range(1, 8)]

        result = pipeline.microcompact_messages(msgs)
        for m in result:
            # 内容不应该变成 "[工具结果已清理，轮次 X]" (因为已经是 _MICROCOMPACT_CLEARED_LABEL)
            # 但也不应该被双重修改
            assert m['content'].startswith('[')


class TestFormatCompactResponse:
    """_format_compact_response：解析 <analysis>/<summary> 结构。"""

    def test_strips_analysis_extracts_summary(self):
        pipeline = _make_pipeline()
        raw = """<analysis>
分析草稿内容，应该被丢弃。
</analysis>

<summary>
1. 主要请求：测试任务
2. 关键技术：Python
</summary>"""
        result = pipeline._format_compact_response(raw)
        assert 'analysis' not in result.lower() or '<analysis>' not in result
        assert '分析草稿' not in result
        assert '主要请求' in result
        assert '关键技术' in result

    def test_fallback_no_xml_tags(self):
        """无 XML 标签时，返回原始内容加前缀（向后兼容）。"""
        pipeline = _make_pipeline()
        raw = '这是一段简单摘要，没有 XML 标签。'
        result = pipeline._format_compact_response(raw)
        assert '这是一段简单摘要' in result
        # 应有延续前缀
        assert '本次会话' in result or 'Summary' in result

    def test_summary_prefix_added(self):
        """输出应包含 Claude Code 风格的会话延续前缀。"""
        pipeline = _make_pipeline()
        raw = '<summary>测试摘要内容</summary>'
        result = pipeline._format_compact_response(raw)
        assert result.startswith('本次会话从之前的对话继续')
