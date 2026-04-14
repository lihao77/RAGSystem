"""Hook executor - core orchestration and result merging."""

import asyncio
import importlib
import logging
import time
from typing import List, Optional

from hooks.broadcast import broadcast_hook_event
from hooks.matcher import get_matching_hooks
from hooks.models import (
    ApprovalHookResult,
    ContextHookResult,
    DecisionHookResult,
    ErrorHookResult,
    HookContext,
    HookDefinition,
    HookResult,
    ObservationHookResult,
)
from hooks.registry import get_hook_registry

logger = logging.getLogger(__name__)

_EVENT_RESULT_TYPES = {
    "tool.before_permission": DecisionHookResult,
    "tool.after_permission": DecisionHookResult,
    "tool.before_execute": ContextHookResult,
    "tool.after_execute": ObservationHookResult,
    "tool.on_error": ErrorHookResult,
    "approval.required": ApprovalHookResult,
    "approval.resolved": ApprovalHookResult,
    "approval.denied": ApprovalHookResult,
    "approval.error": ApprovalHookResult,
}

_EMPTY_RESULT_BY_EVENT = {
    "tool.before_permission": DecisionHookResult,
    "tool.after_permission": DecisionHookResult,
    "tool.before_execute": ContextHookResult,
    "tool.after_execute": ObservationHookResult,
    "tool.on_error": ErrorHookResult,
    "approval.required": ApprovalHookResult,
    "approval.resolved": ApprovalHookResult,
    "approval.denied": ApprovalHookResult,
    "approval.error": ApprovalHookResult,
}


async def run_hooks(context: HookContext) -> HookResult:
    """Execute all matching hooks for the given context.

    Main entry point for hook execution. Handles:
    - Hook matching and filtering
    - Execution with timeout
    - Result merging
    - Broadcasting hook lifecycle events

    Args:
        context: Current execution context

    Returns:
        Merged HookResult from all executed hooks
    """
    registry = get_hook_registry()
    candidate_hooks = registry.get_hooks_for_event(context.event_name)

    if not candidate_hooks:
        return _empty_result_for_event(context.event_name)

    matching_hooks = get_matching_hooks(context.event_name, context, candidate_hooks)

    if not matching_hooks:
        return _empty_result_for_event(context.event_name)

    logger.info(
        "Executing %d hooks for event %s",
        len(matching_hooks),
        context.event_name,
    )

    results = []
    for hook in matching_hooks:
        result = await _execute_single_hook(hook, context)
        results.append(result)

        if result.block_execution:
            logger.info("Hook %s blocked execution: %s", hook.id, result.block_reason)
            break

    merged = _merge_hook_results(results, matching_hooks, event_name=context.event_name)
    return merged


async def _execute_single_hook(
    hook: HookDefinition, context: HookContext
) -> HookResult:
    """Execute a single hook with timeout and error handling."""
    start_time = time.time()

    if hook.broadcast:
        await broadcast_hook_event(
            event_type="hook.started",
            hook_id=hook.id,
            hook_name=hook.name,
            matched_event=context.event_name,
            backend=hook.backend.type,
            context=context,
        )

    try:
        timeout_seconds = hook.timeout_ms / 1000.0
        raw_result = await asyncio.wait_for(
            _dispatch_hook_backend(hook, context), timeout=timeout_seconds
        )
        result = _validate_hook_result(raw_result, hook=hook, context=context)

        duration_ms = (time.time() - start_time) * 1000

        if hook.broadcast and getattr(result, "broadcast_progress", None):
            await broadcast_hook_event(
                event_type="hook.progress",
                hook_id=hook.id,
                hook_name=hook.name,
                matched_event=context.event_name,
                backend=hook.backend.type,
                context=context,
                progress_message=result.broadcast_progress,
            )

        if hook.broadcast:
            await broadcast_hook_event(
                event_type="hook.response",
                hook_id=hook.id,
                hook_name=hook.name,
                matched_event=context.event_name,
                backend=hook.backend.type,
                context=context,
                decision=_get_decision_summary(result),
                duration_ms=duration_ms,
                ui_message=getattr(result, "ui_message", None),
            )

        return result

    except asyncio.TimeoutError:
        duration_ms = (time.time() - start_time) * 1000
        logger.warning("Hook %s timed out after %sms", hook.id, hook.timeout_ms)

        if hook.broadcast:
            await broadcast_hook_event(
                event_type="hook.error",
                hook_id=hook.id,
                hook_name=hook.name,
                matched_event=context.event_name,
                backend=hook.backend.type,
                context=context,
                error_message=f"Timeout after {hook.timeout_ms}ms",
                duration_ms=duration_ms,
            )

        if hook.fail_open:
            return _empty_result_for_event(context.event_name)
        return HookResult(
            block_execution=True,
            block_reason=f"Hook {hook.name} timed out",
        )

    except Exception as e:
        duration_ms = (time.time() - start_time) * 1000
        logger.error("Hook %s failed: %s", hook.id, e, exc_info=True)

        if hook.broadcast:
            await broadcast_hook_event(
                event_type="hook.error",
                hook_id=hook.id,
                hook_name=hook.name,
                matched_event=context.event_name,
                backend=hook.backend.type,
                context=context,
                error_message=str(e),
                duration_ms=duration_ms,
            )

        if hook.fail_open:
            return _empty_result_for_event(context.event_name)
        return HookResult(
            block_execution=True,
            block_reason=f"Hook {hook.name} failed: {str(e)}",
        )


async def _dispatch_hook_backend(
    hook: HookDefinition, context: HookContext
) -> HookResult:
    """Dispatch hook execution to the appropriate backend."""
    if hook.backend.type == "function":
        return await _execute_function_backend(hook, context)
    elif hook.backend.type == "prompt":
        return await _execute_prompt_backend(hook, context)
    elif hook.backend.type == "callback":
        return await _execute_callback_backend(hook, context)
    else:
        logger.error("Unsupported hook backend type: %s", hook.backend.type)
        return _empty_result_for_event(context.event_name)


async def _execute_function_backend(
    hook: HookDefinition, context: HookContext
) -> HookResult:
    """Execute a Python function hook handler."""
    try:
        module_path, function_name = hook.backend.target.rsplit(":", 1)
        module = importlib.import_module(module_path)
        handler = getattr(module, function_name)

        if asyncio.iscoroutinefunction(handler):
            result = await handler(context, hook.backend.config)
        else:
            result = handler(context, hook.backend.config)

        return result

    except Exception as e:
        logger.error("Failed to execute function backend %s: %s", hook.backend.target, e)
        raise


async def _execute_prompt_backend(
    hook: HookDefinition, context: HookContext
) -> HookResult:
    """Execute a prompt-based hook (returns additional context)."""
    prompt_text = hook.backend.config.get("prompt", "")
    if not prompt_text:
        return _empty_result_for_event(context.event_name)

    formatted_prompt = prompt_text.format(
        tool_name=context.tool_name or "",
        agent_name=context.agent_name or "",
        caller=context.caller or "",
    )

    return ContextHookResult(additional_context=[formatted_prompt])


async def _execute_callback_backend(
    hook: HookDefinition, context: HookContext
) -> HookResult:
    """Execute a callback hook (observation only, no decision)."""
    logger.debug("Callback hook %s observed event %s", hook.id, context.event_name)
    return _empty_result_for_event(context.event_name)


def _merge_hook_results(
    results: List[HookResult], hooks: List[HookDefinition], *, event_name: str
) -> HookResult:
    """Merge multiple hook results into a single result."""
    if not results:
        return _empty_result_for_event(event_name)

    merged = _empty_result_for_event(event_name)

    for result in results:
        if result.block_execution:
            merged.block_execution = True
            merged.block_reason = result.block_reason
            merged.continue_execution = False
            break

    if isinstance(merged, DecisionHookResult):
        permission_priority = {"deny": 3, "ask": 2, "allow": 1}
        best_permission = None
        best_priority = 0

        for result in results:
            permission_decision = getattr(result, "permission_decision", None)
            if permission_decision:
                priority = permission_priority.get(permission_decision, 0)
                if priority > best_priority:
                    best_priority = priority
                    best_permission = permission_decision

        merged.permission_decision = best_permission

    if hasattr(merged, "additional_context"):
        seen_context = set()
        for result in results:
            for ctx in getattr(result, "additional_context", []):
                if ctx not in seen_context:
                    merged.additional_context.append(ctx)
                    seen_context.add(ctx)

    if hasattr(merged, "ui_message"):
        for result in results:
            ui_message = getattr(result, "ui_message", None)
            if ui_message:
                merged.ui_message = ui_message
                break

    if hasattr(merged, "ui_metadata"):
        for result in results:
            merged.ui_metadata.update(getattr(result, "ui_metadata", {}))

    if hasattr(merged, "tags"):
        seen_tags = set()
        for result in results:
            for tag in getattr(result, "tags", []):
                if tag not in seen_tags:
                    merged.tags.append(tag)
                    seen_tags.add(tag)

    if hasattr(merged, "metadata"):
        for result in results:
            merged.metadata.update(getattr(result, "metadata", {}))

    if hasattr(merged, "broadcast_progress"):
        for result in results:
            progress = getattr(result, "broadcast_progress", None)
            if progress:
                merged.broadcast_progress = progress
                break

    return merged


def _validate_hook_result(result: HookResult, *, hook: HookDefinition, context: HookContext) -> HookResult:
    expected_type = _EVENT_RESULT_TYPES.get(context.event_name, HookResult)
    if isinstance(result, expected_type):
        return result

    if not isinstance(result, HookResult):
        message = (
            f"Hook handler {hook.backend.target} returned invalid result type: {type(result)}; "
            f"expected {expected_type.__name__}"
        )
    else:
        message = (
            f"Hook handler {hook.backend.target} returned {type(result).__name__} for "
            f"{context.event_name}; expected {expected_type.__name__}"
        )

    if hook.fail_open:
        logger.warning(message)
        return _empty_result_for_event(context.event_name)
    raise TypeError(message)


def _empty_result_for_event(event_name: str) -> HookResult:
    result_type = _EMPTY_RESULT_BY_EVENT.get(event_name, HookResult)
    return result_type()


def _get_decision_summary(result: HookResult) -> str:
    """Get a summary string of the hook decision."""
    if result.block_execution:
        return "block"
    permission_decision = getattr(result, "permission_decision", None)
    if permission_decision:
        return f"permission:{permission_decision}"
    if getattr(result, "additional_context", None):
        return "context"
    return "continue"
