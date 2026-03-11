# -*- coding: utf-8 -*-
"""Unified tool execution result schema."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class ArtifactRef:
    artifact_type: str
    path: str
    mime_type: Optional[str] = None
    size: Optional[int] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolExecutionResult:
    success: bool
    tool_name: str
    summary: str = ""
    answer: Optional[str] = None
    output_type: str = "text"
    content: Any = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    artifacts: List[ArtifactRef] = field(default_factory=list)
    llm_hint: Optional[str] = None
