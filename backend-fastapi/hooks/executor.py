"""Hook executor - core orchestration and result merging."""

import asyncio
import importlib
import logging
import time
from typing import List, Optional

from hooks.models import HookContext, HookDefinition, HookResult
from hooks.matcher import get_matching_hooks
from hooks.registry import get_hook_registry
from hooks.broadcast import broadcast_hook_event

logger = logging.getLogger(__name__)


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
        return HookResult()

    # Filter hooks by matcher and if expression
    matching_hooks = get_matching_hooks(context.event_name, context, candidate_hooks)

    if not matching_hooks:
        return HookResult()

    logger.info(
        f"Executing {len(matching_hooks)} hooks for event {context.event_name}"
    )

    # Execute hooks in priority order
    results = []
    for hook in matching_hooks:
        result = await _execute_single_hook(hook, context)
        results.append(result)

        # Early exit if any hook blocks execution
        if result.block_execution:
            logger.info(f"Hook {hook.id} blocked execution: {result.block_reason}")
            break

    # Merge all results
    merged = _merge_hook_results(results, matching_hooks)

    return merged


async def _execute_single_hook(
    hook: HookDefinition, context: HookContext
) -> HookResult:
    """Execute a single hook with timeout and error handling.

    Args:
        hook: Hook definition to execute
        context: Execution context

    Returns:
        HookResult from the hook handler
    """
    start_time = time.time()

    # Broadcast hook started
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
        # Execute with timeout
        timeout_seconds = hook.timeout_ms / 1000.0
        result = await asyncio.wait_for(
            _dispatch_hook_backend(hook, context), timeout=timeout_seconds
        )

        duration_ms = (time.time() - start_time) * 1000

        # Broadcast hook response
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
                ui_message=result.ui_message,
            )

        return result

    except asyncio.TimeoutError:
        duration_ms = (time.time() - start_time) * 1000
        logger.warning(f"Hook {hook.id} timed out after {hook.timeout_ms}ms")

        # Broadcast hook error
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

        # Fail open or closed based on hook configuration
        if hook.fail_open:
            return HookResult()
        else:
            return HookResult(
                block_execution=True,
                block_reason=f"Hook {hook.name} timed out",
            )

    except Exception as e:
        duration_ms = (time.time() - start_time) * 1000
        logger.error(f"Hook {hook.id} failed: {e}", exc_info=True)

        # Broadcast hook error
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

        # Fail open or closed
        if hook.fail_open:
            return HookResult()
        else:
            return HookResult(
                block_execution=True,
                block_reason=f"Hook {hook.name} failed: {str(e)}",
            )


async def _dispatch_hook_backend(
    hook: HookDefinition, context: HookContext
) -> HookResult:
    """Dispatch hook execution to the appropriate backend.

    Phase 1: Only function backend is supported.

    Args:
        hook: Hook definition
        context: Execution context

    Returns:
        HookResult from the backend
    """
    if hook.backend.type == "function":
        return await _execute_function_backend(hook, context)
    elif hook.backend.type == "prompt":
        return await _execute_prompt_backend(hook, context)
    elif hook.backend.type == "callback":
        return await _execute_callback_backend(hook, context)
    else:
        logger.error(f"Unsupported hook backend type: {hook.backend.type}")
        return HookResult()


async def _execute_function_backend(
    hook: HookDefinition, context: HookContext
) -> HookResult:
    """Execute a Python function hook handler.

    Target format: "module.path:function_name"

    Args:
        hook: Hook definition
        context: Execution context

    Returns:
        HookResult from the handler
    """
    try:
        # Parse target
        module_path, function_name = hook.backend.target.rsplit(":", 1)

        # Import module
        module = importlib.import_module(module_path)

        # Get handler function
        handler = getattr(module, function_name)

        # Call handler (sync or async)
        if asyncio.iscoroutinefunction(handler):
            result = await handler(context, hook.backend.config)
        else:
            result = handler(context, hook.backend.config)

        # Ensure result is HookResult
        if not isinstance(result, HookResult):
            logger.warning(
                f"Hook handler {hook.backend.target} returned non-HookResult: {type(result)}"
            )
            return HookResult()

        return result

    except Exception as e:
        logger.error(f"Failed to execute function backend {hook.backend.target}: {e}")
        raise


async def _execute_prompt_backend(
    hook: HookDefinition, context: HookContext
) -> HookResult:
    """Execute a prompt-based hook (returns additional context).

    Phase 1: Simple implementation - just returns configured prompt text.

    Args:
        hook: Hook definition
        context: Execution context

    Returns:
        HookResult with additional_context
    """
    prompt_text = hook.backend.config.get("prompt", "")
    if not prompt_text:
        return HookResult()

    # Simple template substitution
    formatted_prompt = prompt_text.format(
        tool_name=context.tool_name or "",
        agent_name=context.agent_name or "",
        caller=context.caller or "",
    )

    return HookResult(additional_context=[formatted_prompt])


async def _execute_callback_backend(
    hook: HookDefinition, context: HookContext
) -> HookResult:
    """Execute a callback hook (observation only, no decision).

    Phase 1: Just broadcasts the event, returns empty result.

    Args:
        hook: Hook definition
        context: Execution context

    Returns:
        Empty HookResult
    """
    # Callback hooks just observe, they don't affect execution
    logger.debug(f"Callback hook {hook.id} observed event {context.event_name}")
    return HookResult()


def _merge_hook_results(
    results: List[HookResult], hooks: List[HookDefinition]
) -> HookResult:
    """Merge multiple hook results into a single result.

    Merging rules:
    - block_execution: Any True -> True (first block reason wins)
    - permission_decision: deny > ask > allow > None
    - additional_context: Concatenate and deduplicate
    - ui_message: First non-empty message
    - ui_metadata: Merge all
    - tags/metadata: Merge all

    Args:
        results: List of HookResults to merge
        hooks: Corresponding hook definitions (for priority)

    Returns:
        Merged HookResult
    """
    if not results:
        return HookResult()

    merged = HookResult()

    # Block execution (any block wins, highest priority first)
    for i, result in enumerate(results):
        if result.block_execution:
            merged.block_execution = True
            merged.block_reason = result.block_reason
            merged.continue_execution = False
            break

    # Permission decision (deny > ask > allow)
    permission_priority = {"deny": 3, "ask": 2, "allow": 1}
    best_permission = None
    best_priority = 0

    for result in results:
        if result.permission_decision:
            priority = permission_priority.get(result.permission_decision, 0)
            if priority > best_priority:
                best_priority = priority
                best_permission = result.permission_decision

    merged.permission_decision = best_permission

    # Additional context (deduplicate)
    seen_context = set()
    for result in results:
        for ctx in result.additional_context:
            if ctx not in seen_context:
                merged.additional_context.append(ctx)
                seen_context.add(ctx)

    # UI message (first non-empty)
    for result in results:
        if result.ui_message:
            merged.ui_message = result.ui_message
            break

    # UI metadata (merge all)
    for result in results:
        merged.ui_metadata.update(result.ui_metadata)

    # Tags (deduplicate)
    seen_tags = set()
    for result in results:
        for tag in result.tags:
            if tag not in seen_tags:
                merged.tags.append(tag)
                seen_tags.add(tag)

    # Metadata (merge all)
    for result in results:
        merged.metadata.update(result.metadata)

    return merged


def _get_decision_summary(result: HookResult) -> str:
    """Get a summary string of the hook decision."""
    if result.block_execution:
        return "block"
    elif result.permission_decision:
        return f"permission:{result.permission_decision}"
    elif result.additional_context:
        return "context"
    else:
        return "continue"
