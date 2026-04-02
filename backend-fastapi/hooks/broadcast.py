"""Hook event broadcasting to the event bus."""

import logging
from typing import Any, Dict, Optional

from hooks.models import HookContext

logger = logging.getLogger(__name__)


async def broadcast_hook_event(
    event_type: str,
    hook_id: str,
    hook_name: str,
    matched_event: str,
    backend: str,
    context: HookContext,
    decision: Optional[str] = None,
    duration_ms: Optional[float] = None,
    ui_message: Optional[str] = None,
    error_message: Optional[str] = None,
) -> None:
    """Broadcast a hook lifecycle event to the event bus.

    Events:
    - hook.started: Hook execution started
    - hook.progress: Hook execution progress (optional)
    - hook.response: Hook execution completed
    - hook.error: Hook execution failed

    Args:
        event_type: Type of hook event
        hook_id: Hook identifier
        hook_name: Human-readable hook name
        matched_event: The original event that triggered this hook
        backend: Hook backend type (function/prompt/callback)
        context: Hook execution context
        decision: Hook decision summary (block/permission:X/context/continue)
        duration_ms: Execution duration in milliseconds
        ui_message: UI message from hook result
        error_message: Error message if hook failed
    """
    try:
        # Import here to avoid circular dependency
        from agents.events.bus import EventBus, Event, EventType

        event_bus = EventBus()

        # Build event payload
        payload: Dict[str, Any] = {
            "hook_id": hook_id,
            "hook_name": hook_name,
            "matched_event": matched_event,
            "backend": backend,
            "event_phase": context.phase,
        }

        # Add context identifiers
        if context.session_id:
            payload["session_id"] = context.session_id
        if context.run_id:
            payload["run_id"] = context.run_id
        if context.request_id:
            payload["request_id"] = context.request_id
        if context.tool_call_id:
            payload["tool_call_id"] = context.tool_call_id

        # Add agent/tool context
        if context.agent_name:
            payload["agent_name"] = context.agent_name
        if context.tool_name:
            payload["tool_name"] = context.tool_name
        if context.caller:
            payload["caller"] = context.caller

        # Add event-specific fields
        if decision:
            payload["decision"] = decision
        if duration_ms is not None:
            payload["duration_ms"] = duration_ms
        if ui_message:
            payload["ui_message"] = ui_message
        if error_message:
            payload["error_message"] = error_message

        # Map hook event type to EventType
        event_type_map = {
            "hook.started": EventType.HOOK_STARTED,
            "hook.progress": EventType.HOOK_PROGRESS,
            "hook.response": EventType.HOOK_RESPONSE,
            "hook.error": EventType.HOOK_ERROR,
        }

        mapped_event_type = event_type_map.get(event_type)
        if not mapped_event_type:
            logger.warning(f"Unknown hook event type: {event_type}")
            return

        # Create and publish event
        event = Event(
            type=mapped_event_type,
            data=payload,
            session_id=context.session_id,
        )

        # Publish event (EventBus.publish returns None, use publish_async)
        result = event_bus.publish_async(event)
        if result is not None:
            await result

        logger.debug(f"Broadcasted hook event: {event_type} for hook {hook_id}")

    except Exception as e:
        # Don't let broadcasting errors break hook execution
        logger.error(f"Failed to broadcast hook event {event_type}: {e}", exc_info=True)
