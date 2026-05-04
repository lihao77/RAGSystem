# -*- coding: utf-8 -*-
"""
ContextBudget - 统一上下文预算管理

具名常量替代魔法数字，提供统一的上下文预算计算函数。
"""

from dataclasses import dataclass
from typing import Optional

# ── 具名常量（硬编码 fallback，运行时从 AppConfig.context 读取） ───────────────
_FALLBACK_SYSTEM_PROMPT_RESERVE = 2000
_FALLBACK_MIN_CONTEXT_BUDGET = 4000
CONTEXT_WINDOW_SAFETY_FACTOR = 0.9   # 安全系数（预留 10% 防估算误差）
DEFAULT_CONTEXT_FALLBACK_MULTIPLIER = 3  # 未知上下文窗口时的统一兜底倍数


def _get_context_config():
    """从系统配置读取上下文预算参数。"""
    try:
        from config import get_config
        return get_config().context
    except Exception:
        return None


def _system_prompt_reserve() -> int:
    cfg = _get_context_config()
    return cfg.system_prompt_reserve if cfg else _FALLBACK_SYSTEM_PROMPT_RESERVE


def _min_context_budget() -> int:
    cfg = _get_context_config()
    return cfg.min_context_budget if cfg else _FALLBACK_MIN_CONTEXT_BUDGET


def _default_compression_trigger_ratio() -> float:
    cfg = _get_context_config()
    return cfg.compression_trigger_ratio if cfg else 0.85


def _default_summarize_max_tokens() -> int:
    cfg = _get_context_config()
    return cfg.summarize_max_tokens if cfg else 300


def _default_preserve_recent_turns() -> int:
    cfg = _get_context_config()
    return cfg.preserve_recent_turns if cfg else 3


# 向后兼容：外部模块可能直接引用这两个名字
SYSTEM_PROMPT_RESERVE = _FALLBACK_SYSTEM_PROMPT_RESERVE
MIN_CONTEXT_BUDGET = _FALLBACK_MIN_CONTEXT_BUDGET
DEFAULT_MAX_COMPLETION_TOKENS = 4096 # 默认输出 token 上限
WORKER_CONTEXT_PROFILE_NAME = "worker"
ORCHESTRATOR_CONTEXT_PROFILE_NAME = "orchestrator"


@dataclass(frozen=True)
class ContextBudgetProfile:
    """Agent 上下文预算默认档位。"""

    name: str
    fallback_multiplier: float
    compression_trigger_ratio: float = 0.85
    summarize_max_tokens: int = 300
    preserve_recent_turns: int = 3


def _build_profile(name: str) -> ContextBudgetProfile:
    """动态构建预算档位，从 AppConfig.context 读取默认值。"""
    return ContextBudgetProfile(
        name=name,
        fallback_multiplier=DEFAULT_CONTEXT_FALLBACK_MULTIPLIER,
        compression_trigger_ratio=_default_compression_trigger_ratio(),
        summarize_max_tokens=_default_summarize_max_tokens(),
        preserve_recent_turns=_default_preserve_recent_turns(),
    )


def get_context_budget_profile(profile_name: Optional[str] = None) -> ContextBudgetProfile:
    """返回显式预算档位，不存在时回退到 worker。"""
    name = profile_name or WORKER_CONTEXT_PROFILE_NAME
    if name not in (WORKER_CONTEXT_PROFILE_NAME, ORCHESTRATOR_CONTEXT_PROFILE_NAME):
        name = WORKER_CONTEXT_PROFILE_NAME
    return _build_profile(name)


def compute_context_budget(
    model_context_window: Optional[int],
    max_completion_tokens: int,
    explicit_budget: Optional[int] = None,
    fallback_multiplier: float = DEFAULT_CONTEXT_FALLBACK_MULTIPLIER,
) -> int:
    """
    计算上下文预算（对话历史可用的 token 数）。

    优先级：
    1. explicit_budget（用户在 behavior_config 中显式指定）
    2. 基于 context_window 的精确计算
    3. 兜底估算（max_completion_tokens × fallback_multiplier）

    精确计算：int(context_window × 0.9) - 2000 - max_completion_tokens
    兜底估算：int(max_completion_tokens × fallback_multiplier)
    结果下限：MIN_CONTEXT_BUDGET (4000)

    Args:
        model_context_window: 模型支持的最大上下文窗口（输入+输出总 token 数），None 表示未配置
        max_completion_tokens: 单次生成的最大 token 数
        explicit_budget: 用户显式指定的预算，优先级最高
        fallback_multiplier: 无窗口配置时的兜底倍数

    Returns:
        上下文预算 token 数（>= MIN_CONTEXT_BUDGET）
    """
    min_budget = _min_context_budget()
    sys_reserve = _system_prompt_reserve()

    # 优先级 1：用户显式指定
    if explicit_budget is not None:
        return max(explicit_budget, min_budget)

    # 优先级 2：基于上下文窗口精确计算
    if model_context_window:
        budget = int(model_context_window * CONTEXT_WINDOW_SAFETY_FACTOR) - sys_reserve - max_completion_tokens
        return max(budget, min_budget)

    # 优先级 3：兜底估算
    budget = int(max_completion_tokens * fallback_multiplier)
    return max(budget, min_budget)
