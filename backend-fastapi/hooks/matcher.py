"""Hook matcher for filtering hook execution based on context."""

import ast
import logging
from typing import Any, List, Optional

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
    if matcher.risk_levels:
        risk_level = _get_context_risk_level(context)
        if risk_level is None or risk_level not in matcher.risk_levels:
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
    if matcher.when_permission_mode:
        permission_mode = _get_context_permission_mode(context)
        if permission_mode is None or permission_mode not in matcher.when_permission_mode:
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


def _get_context_risk_level(context: HookContext) -> Optional[str]:
    if context.metadata.get("risk_level"):
        return context.metadata["risk_level"]

    permission_decision = context.permission_decision
    if permission_decision is not None:
        risk_level = getattr(permission_decision, "risk_level", None)
        if risk_level:
            return risk_level

    tool_context = context.tool_context
    if tool_context is not None:
        risk_level = getattr(tool_context, "risk_level", None)
        if risk_level:
            return risk_level

    return None


def _get_context_permission_mode(context: HookContext) -> Optional[str]:
    if context.metadata.get("permission_mode"):
        return context.metadata["permission_mode"]

    permission_decision = context.permission_decision
    if permission_decision is not None:
        permission_mode = getattr(permission_decision, "permission_mode", None)
        if permission_mode:
            return permission_mode
        decision = getattr(permission_decision, "decision", None)
        if decision:
            return decision

    return None


def _evaluate_if_expr(if_expr: str, context: HookContext) -> bool:
    """Evaluate if expression against context using a restricted AST interpreter."""
    if not if_expr:
        return True

    try:
        tree = ast.parse(if_expr, mode="eval")
        return bool(_eval_ast_node(tree.body, context))
    except Exception as e:
        logger.warning(f"Failed to evaluate if expression '{if_expr}': {e}")
        return False


def _eval_ast_node(node: ast.AST, context: HookContext) -> Any:
    if isinstance(node, ast.BoolOp):
        values = [_eval_ast_node(value, context) for value in node.values]
        if isinstance(node.op, ast.And):
            return all(values)
        if isinstance(node.op, ast.Or):
            return any(values)
        raise ValueError(f"Unsupported boolean operator: {type(node.op).__name__}")

    if isinstance(node, ast.UnaryOp):
        if isinstance(node.op, ast.Not):
            return not _eval_ast_node(node.operand, context)
        raise ValueError(f"Unsupported unary operator: {type(node.op).__name__}")

    if isinstance(node, ast.Compare):
        left = _eval_ast_node(node.left, context)
        for op, comparator in zip(node.ops, node.comparators):
            right = _eval_ast_node(comparator, context)
            if isinstance(op, ast.Eq):
                ok = left == right
            elif isinstance(op, ast.NotEq):
                ok = left != right
            elif isinstance(op, ast.In):
                ok = left in right
            elif isinstance(op, ast.NotIn):
                ok = left not in right
            else:
                raise ValueError(f"Unsupported comparison operator: {type(op).__name__}")
            if not ok:
                return False
            left = right
        return True

    if isinstance(node, ast.Attribute):
        base = _eval_ast_node(node.value, context)
        return _resolve_attribute(base, node.attr)

    if isinstance(node, ast.Name):
        if node.id == "context":
            return _SafeContextProxy(context)
        if node.id in {"True", "False", "None"}:
            return {"True": True, "False": False, "None": None}[node.id]
        raise ValueError(f"Unsupported name: {node.id}")

    if isinstance(node, ast.Constant):
        return node.value

    if isinstance(node, ast.List):
        return [_eval_ast_node(elt, context) for elt in node.elts]

    if isinstance(node, ast.Tuple):
        return tuple(_eval_ast_node(elt, context) for elt in node.elts)

    if isinstance(node, ast.Dict):
        return {
            _eval_ast_node(key, context): _eval_ast_node(value, context)
            for key, value in zip(node.keys, node.values)
        }

    if isinstance(node, ast.Call):
        if isinstance(node.func, ast.Attribute) and node.func.attr == "get":
            target = _eval_ast_node(node.func.value, context)
            if not isinstance(target, dict):
                raise ValueError("Only dict.get() is allowed")
            args = [_eval_ast_node(arg, context) for arg in node.args]
            if len(args) not in {1, 2}:
                raise ValueError("dict.get() accepts 1 or 2 arguments")
            return target.get(*args)
        raise ValueError("Function calls are not allowed")

    raise ValueError(f"Unsupported expression node: {type(node).__name__}")


def _resolve_attribute(base: Any, attr: str) -> Any:
    if attr.startswith("__"):
        raise AttributeError(f"Access to attribute '{attr}' not allowed")
    if isinstance(base, _SafeContextProxy):
        return getattr(base, attr)
    if isinstance(base, dict):
        if attr not in base:
            raise AttributeError(f"Key '{attr}' not found")
        return base[attr]
    raise AttributeError(f"Attribute access not allowed on {type(base).__name__}")


def _build_safe_namespace(context: HookContext) -> dict:
    """Build a safe namespace for expression evaluation.

    Kept for compatibility with older tests/helpers.
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
