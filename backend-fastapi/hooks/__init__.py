"""Hook system for RAGSystem.

Provides event-driven hooks for tool runtime, agent lifecycle, and subsystems.
"""

from hooks.models import (
    HookContext,
    HookResult,
    HookDefinition,
    HookMatcher,
    HookBackendDefinition,
)
from hooks.executor import run_hooks
from hooks.registry import HookRegistry

__all__ = [
    "HookContext",
    "HookResult",
    "HookDefinition",
    "HookMatcher",
    "HookBackendDefinition",
    "run_hooks",
    "HookRegistry",
]
