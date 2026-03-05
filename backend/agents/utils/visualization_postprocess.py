# -*- coding: utf-8 -*-
"""当 LLM 未按要求插入 [CHART:N] 时，自动追加缺失占位符到末尾。"""
import re
from typing import Set

CHART_PLACEHOLDER_RE = re.compile(r'\[CHART:(\d+)\]')


def ensure_chart_placeholders(content: str, chart_count: int) -> str:
    """确保 content 中包含 [CHART:1] ~ [CHART:chart_count] 的全部占位符。

    如果 LLM 已正确插入，原样返回；否则将缺失的占位符追加到末尾。
    """
    if chart_count <= 0 or not content:
        return content

    existing: Set[int] = {int(m.group(1)) for m in CHART_PLACEHOLDER_RE.finditer(content)}
    missing = [i for i in range(1, chart_count + 1) if i not in existing]

    if not missing:
        return content

    suffix = "\n" + "\n".join(f"\n[CHART:{idx}]\n" for idx in missing)
    return content.rstrip() + suffix
