# -*- coding: utf-8 -*-
"""Context configuration models."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class ContextConfig:
    """上下文管理配置"""

    max_tokens: int = 8000
    budget_profile: str = "worker"
    model_name: Optional[str] = None
    compression_trigger_ratio: float = 0.85
    summarize_max_tokens: int = 2000
    preserve_recent_turns: int = 3
    # microcompact：保留最近 N 条 observation 消息的完整内容，更旧的内容清除
    microcompact_keep_recent_tools: int = 5
    # 本地缓存 TTL：距上次准备超过此秒数才允许清理旧工具结果（保护 KV 缓存）
    local_cache_ttl_seconds: float = 600.0
    # waiting loop 轮询间隔
    waiting_poll_interval_seconds: float = 3.0
    # waiting loop 空闲超时
    waiting_idle_timeout_seconds: float = 300.0
    # hidden keepalive 间隔
    keepalive_interval_seconds: float = 240.0
    # hidden keepalive 提前发送余量
    keepalive_grace_seconds: float = 30.0
    # hidden keepalive 最大轮数
    max_hidden_keepalive_rounds: int = 20
