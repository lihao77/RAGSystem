# -*- coding: utf-8 -*-
"""
反思机制 - ReAct 循环内的条件性自我纠错。

当检测到工具连续失败、重复调用、推理停滞等异常模式时，
在下一轮 LLM 调用前注入反思提示，引导模型审视推理链并调整策略。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

@dataclass
class ReflectionConfig:
    """反思触发阈值配置。通过 agent_config.custom_params.behavior.reflection 注入。"""

    enabled: bool = True
    # 工具连续失败 N 次触发
    consecutive_tool_failures: int = 2
    # 同一工具连续调用 N 次触发（循环检测）
    repeated_tool_calls: int = 3
    # 总轮次超过阈值且无 final_answer 时触发
    rounds_without_answer: int = 6
    # 工具返回空结果累积 N 次触发
    empty_result_count: int = 2
    # 单次 run 最大反思次数（防无限反思）
    max_reflections_per_run: int = 3

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]]) -> ReflectionConfig:
        if not data or not isinstance(data, dict):
            return cls()
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


# ---------------------------------------------------------------------------
# 状态追踪
# ---------------------------------------------------------------------------

@dataclass
class ReflectionState:
    """单次 run 内的反思状态。"""

    consecutive_failures: int = 0
    empty_results: int = 0
    tool_call_counter: Dict[str, int] = field(default_factory=dict)
    last_tool_name: Optional[str] = None
    reflection_count: int = 0
    pending_reflection: Optional[str] = None
    reflection_history: List[Dict[str, Any]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# 评估器
# ---------------------------------------------------------------------------

class ReflectionEvaluator:
    """在每轮工具执行后评估是否需要触发反思。"""

    def __init__(self, config: ReflectionConfig):
        self.config = config

    def evaluate(self, ref: ReflectionState, rounds: int) -> Optional[str]:
        """
        返回反思类型字符串，或 None（不触发）。

        反思类型: 'tool_failure' | 'loop_detected' | 'stalled' | 'empty_results'
        """
        if not self.config.enabled:
            return None
        if ref.reflection_count >= self.config.max_reflections_per_run:
            return None

        # 1. 连续工具失败
        if ref.consecutive_failures >= self.config.consecutive_tool_failures:
            return 'tool_failure'

        # 2. 重复工具调用（循环检测）
        if ref.last_tool_name:
            count = ref.tool_call_counter.get(ref.last_tool_name, 0)
            if count >= self.config.repeated_tool_calls:
                return 'loop_detected'

        # 3. 推理轮次过长
        if rounds >= self.config.rounds_without_answer:
            return 'stalled'

        # 4. 空结果累积
        if ref.empty_results >= self.config.empty_result_count:
            return 'empty_results'

        return None


# ---------------------------------------------------------------------------
# 反思提示模板
# ---------------------------------------------------------------------------

REFLECTION_PROMPTS: Dict[str, str] = {
    'tool_failure': (
        "[reflection] 你连续 {failure_count} 次工具调用失败。在继续之前，请分析：\n"
        "1. 失败的根本原因是什么？（参数错误？工具选择错误？前置条件未满足？）\n"
        "2. 是否需要换一个工具或策略？\n"
        "3. 是否缺少必要的信息需要先获取？\n\n"
        "基于分析，决定下一步行动。不要重复相同的失败操作。"
    ),
    'loop_detected': (
        "[reflection] 你已经连续 {repeat_count} 次调用 {tool_name}。这可能意味着你陷入了循环。请分析：\n"
        "1. 之前的调用为什么没有达到预期效果？\n"
        "2. 是否需要完全不同的方法来解决这个问题？\n"
        "3. 当前已有的信息是否足够直接回答用户？\n\n"
        "如果已有足够信息，请直接给出回答。"
    ),
    'stalled': (
        "[reflection] 已经过了 {rounds} 轮推理但尚未产出最终答案。请评估：\n"
        "1. 原始任务是什么？你当前的进展如何？\n"
        "2. 是否偏离了主题？\n"
        "3. 已收集的信息是否足以回答？如果是，请立即给出答案。\n"
        "4. 如果确实需要更多步骤，最关键的下一步是什么？\n\n"
        "避免完美主义，用已有信息给出最佳答案。"
    ),
    'empty_results': (
        "[reflection] 最近 {empty_count} 次工具调用返回了空结果或无关信息。请分析：\n"
        "1. 搜索关键词或查询参数是否正确？\n"
        "2. 数据源是否包含所需信息？\n"
        "3. 是否需要尝试不同的数据路径？\n\n"
        "调整策略后继续。"
    ),
}


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------

def make_reflection_state() -> ReflectionState:
    """创建初始反思状态。"""
    return ReflectionState()


def update_reflection_state(
    ref: ReflectionState,
    round_history: List[Dict[str, Any]],
) -> None:
    """根据当前轮次的 tool_calls_history 条目更新反思状态。"""
    if not round_history:
        return

    round_failures = 0
    round_empties = 0
    last_tool = None

    for entry in round_history:
        tool_name = entry.get('tool_name', '')
        result = entry.get('result')
        last_tool = tool_name

        success = True
        empty = False

        if result is not None:
            if hasattr(result, 'success'):
                success = result.success
            if hasattr(result, 'data'):
                data = result.data
                empty = (data is None or data == '' or data == [] or data == {})
            elif hasattr(result, 'content'):
                empty = not result.content

        if not success:
            round_failures += 1
        if empty and success:
            round_empties += 1

    # 更新连续失败计数
    if round_failures > 0:
        ref.consecutive_failures += round_failures
    else:
        ref.consecutive_failures = 0

    # 更新空结果计数
    if round_empties > 0:
        ref.empty_results += round_empties
    else:
        ref.empty_results = 0

    # 更新工具连续调用计数
    if last_tool:
        if last_tool == ref.last_tool_name:
            ref.tool_call_counter[last_tool] = ref.tool_call_counter.get(last_tool, 0) + len(round_history)
        else:
            # 工具切换，重置计数
            ref.tool_call_counter = {last_tool: len([e for e in round_history if e.get('tool_name') == last_tool])}
        ref.last_tool_name = last_tool


def format_reflection_prompt(
    reflection_type: str,
    ref: ReflectionState,
    rounds: int,
) -> str:
    """格式化反思提示。"""
    template = REFLECTION_PROMPTS.get(reflection_type, '')
    return template.format(
        failure_count=ref.consecutive_failures,
        repeat_count=ref.tool_call_counter.get(ref.last_tool_name or '', 0),
        tool_name=ref.last_tool_name or '?',
        rounds=rounds,
        empty_count=ref.empty_results,
    )


def load_reflection_config(agent_config, system_config=None) -> ReflectionConfig:
    """加载反思配置：系统级默认 + agent 级覆盖。

    优先级：agent_config.custom_params.behavior.reflection > system_config.reflection
    """
    # 1. 系统级默认
    base = {}
    if system_config:
        sys_reflection = getattr(system_config, 'reflection', None)
        if sys_reflection:
            base = {
                k: getattr(sys_reflection, k)
                for k in ReflectionConfig.__dataclass_fields__
                if hasattr(sys_reflection, k)
            }

    # 2. agent 级覆盖
    agent_override = {}
    if agent_config:
        custom_params = getattr(agent_config, 'custom_params', None) or {}
        behavior = custom_params.get('behavior', {}) or {}
        agent_override = behavior.get('reflection') or {}

    # 3. 合并：agent 覆盖 > 系统默认 > dataclass 默认
    if not base and not agent_override:
        # 无任何配置时，使用 dataclass 默认（enabled=True）
        return ReflectionConfig() if system_config else ReflectionConfig(enabled=False)

    merged = {**base, **{k: v for k, v in agent_override.items() if k in ReflectionConfig.__dataclass_fields__}}
    return ReflectionConfig.from_dict(merged)
