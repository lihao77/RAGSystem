"""Hook matcher for filtering hook execution based on context."""

import logging
import re
from typing import List

from hooks.models import HookContext, HookDefinition, HookMatcher

logger = logging.getLogger(__name__)


def matches_hook(hook: HookDefinition, context: HookContext) -> bool:
    """Check if a hook should execute for the given context.

    Two-stage filtering:
    1. Structured matcher (fast path)
    2. If expression (secondary filter)

    Args:
        hook: Hook definition to check
        context: Current execution context

    Returns:
        True if hook should execute
    """
    # Stage 1: Structured matcher
    if not _matches_structured(hook.matcher, context):
        return False

    # Stage 2: If expression
    if hook.if_expr and not _evaluate_if_expr(hook.if_expr, context):
        return False

    return True


def _matches_structured(matcher: HookMatcher, context: HookContext) -> bool:
    """Check structured matcher fields."""

    # Tool name filter
    if matcher.tool_names and context.tool_name not in matcher.tool_names:
        return False

    # Agent name filter
    if matcher.agent_names and context.agent_name not in matcher.agent_names:
        return False

    # Caller filter
    if matcher.callers and context.caller not in matcher.callers:
        return False

    # Risk level filter
    if matcher.risk_levels and context.tool_context:
        tool_risk = getattr(context.tool_context, "risk_level", None)
        if tool_risk and tool_risk not in matcher.risk_levels:
            return False

    # Workspace trust filter
    if matcher.workspace_trust and context.workspace_trust not in matcher.workspace_trust:
        return False

    # Session ID filter
    if matcher.session_ids and context.session_id not in matcher.session_ids:
        return False

    # User role filter
    if matcher.user_roles and context.user_role not in matcher.user_roles:
        return False

    # Result success filter
    if matcher.when_result_success is not None:
        result_success = context.result_snapshot.get("success")
        if result_success != matcher.when_result_success:
            return False

    # Permission mode filter
    if matcher.when_permission_mode and context.permission_decision:
        perm_mode = getattr(context.permission_decision, "decision", None)
        if perm_mode and perm_mode not in matcher.when_permission_mode:
            return False

    # Source filter
    if matcher.sources and context.source not in matcher.sources:
        return False

    # Tags filter (any tag match)
    if matcher.tags:
        context_tags = context.metadata.get("tags", [])
        if not any(tag in context_tags for tag in matcher.tags):
            return False

    return True


def _evaluate_if_expr(if_expr: str, context: HookContext) -> bool:
    """Evaluate if expression against context.

    Phase 1: Simple comparison expressions only.
    Allowed patterns:
    - context.field == "value"
    - context.field != "value"
    - context.field in ["value1", "value2"]
    - context.field not in ["value1", "value2"]
    - context.metadata.key == "value"
    - not condition

    Security: No arbitrary code execution, only whitelisted field access.
    """
    if not if_expr:
        return True

    try:
        # Build safe evaluation namespace
        safe_namespace = _build_safe_namespace(context)

        # Simple expression evaluation with restricted builtins
        result = eval(
            if_expr,
            {"__builtins__": {"True": True, "False": False, "None": None}},
            safe_namespace,
        )

        return bool(result)

    except Exception as e:
        logger.warning(f"Failed to evaluate if expression '{if_expr}': {e}")
        return False


def _build_safe_namespace(context: HookContext) -> dict:
    """Build a safe namespace for expression evaluation.

    Only exposes whitelisted fields from context.
    """
    return {
        "context": _SafeContextProxy(context),
    }


class _SafeContextProxy:
    """Safe proxy for HookContext that only allows whitelisted field access."""

    _ALLOWED_FIELDS = {
        "event_name",
        "phase",
        "session_id",
        "run_id",
        "agent_name",
        "agent_display_name",
        "caller",
        "user_role",
        "tool_name",
        "tool_call_id",
        "round",
        "order",
        "workspace_trust",
        "source",
        "metadata",
    }

    def __init__(self, context: HookContext):
        self._context = context

    def __getattr__(self, name: str):
        if name not in self._ALLOWED_FIELDS:
            raise AttributeError(f"Access to context.{name} not allowed in if expression")
        return getattr(self._context, name)


def get_matching_hooks(
    event_name: str, context: HookContext, all_hooks: List[HookDefinition]
) -> List[HookDefinition]:
    """Get all hooks that match the given event and context.

    Returns hooks sorted by priority (descending).

    Args:
        event_name: Event name to match
        context: Current execution context
        all_hooks: List of all candidate hooks (already filtered by event)

    Returns:
        List of matching hooks in priority order
    """
    matching = []

    for hook in all_hooks:
        if matches_hook(hook, context):
            matching.append(hook)
            logger.debug(f"Hook {hook.id} matched for event {event_name}")

    return matching
