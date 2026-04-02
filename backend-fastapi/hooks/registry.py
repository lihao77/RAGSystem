"""Hook registry for managing and retrieving hook definitions."""

import logging
from typing import Dict, List, Optional

from hooks.models import HookDefinition

logger = logging.getLogger(__name__)


class HookRegistry:
    """Central registry for all hook definitions.

    Manages hook registration, indexing by event, and priority sorting.
    Handles merging of system-level and agent-level configurations.
    """

    def __init__(self):
        self._hooks: Dict[str, HookDefinition] = {}
        self._event_index: Dict[str, List[str]] = {}  # event_name -> [hook_ids]

    def register(self, hook: HookDefinition) -> None:
        """Register a hook definition."""
        if hook.id in self._hooks:
            logger.warning(f"Hook {hook.id} already registered, overwriting")

        self._hooks[hook.id] = hook

        # Index by events
        for event in hook.events:
            if event not in self._event_index:
                self._event_index[event] = []
            if hook.id not in self._event_index[event]:
                self._event_index[event].append(hook.id)

        logger.debug(f"Registered hook: {hook.id} for events: {hook.events}")

    def unregister(self, hook_id: str) -> None:
        """Unregister a hook by ID."""
        if hook_id not in self._hooks:
            return

        hook = self._hooks[hook_id]

        # Remove from event index
        for event in hook.events:
            if event in self._event_index:
                self._event_index[event] = [
                    hid for hid in self._event_index[event] if hid != hook_id
                ]

        del self._hooks[hook_id]
        logger.debug(f"Unregistered hook: {hook_id}")

    def get_hook(self, hook_id: str) -> Optional[HookDefinition]:
        """Get a hook definition by ID."""
        return self._hooks.get(hook_id)

    def get_hooks_for_event(self, event_name: str) -> List[HookDefinition]:
        """Get all enabled hooks for a specific event, sorted by priority.

        Returns hooks in descending priority order (higher priority first).
        """
        hook_ids = self._event_index.get(event_name, [])
        hooks = [self._hooks[hid] for hid in hook_ids if hid in self._hooks]

        # Filter enabled hooks
        enabled_hooks = [h for h in hooks if h.enabled]

        # Sort by priority (descending) then by registration order
        enabled_hooks.sort(key=lambda h: (-h.priority, hook_ids.index(h.id)))

        return enabled_hooks

    def get_all_hooks(self) -> List[HookDefinition]:
        """Get all registered hooks."""
        return list(self._hooks.values())

    def clear(self) -> None:
        """Clear all registered hooks."""
        self._hooks.clear()
        self._event_index.clear()
        logger.debug("Cleared all hooks from registry")

    def apply_agent_overrides(
        self,
        agent_name: str,
        disable_ids: List[str],
        enable_ids: List[str],
        priority_overrides: Dict[str, int],
    ) -> None:
        """Apply agent-level hook configuration overrides.

        Args:
            agent_name: Name of the agent applying overrides
            disable_ids: Hook IDs to disable for this agent
            enable_ids: Hook IDs to enable for this agent
            priority_overrides: Hook ID -> new priority mapping
        """
        for hook_id in disable_ids:
            if hook_id in self._hooks:
                hook = self._hooks[hook_id]
                # Create a new hook with enabled=False
                self._hooks[hook_id] = HookDefinition(
                    id=hook.id,
                    name=hook.name,
                    description=hook.description,
                    enabled=False,
                    source=hook.source,
                    priority=hook.priority,
                    events=hook.events,
                    matcher=hook.matcher,
                    if_expr=hook.if_expr,
                    backend=hook.backend,
                    timeout_ms=hook.timeout_ms,
                    fail_open=hook.fail_open,
                    ui_title=hook.ui_title,
                    ui_description=hook.ui_description,
                    broadcast=hook.broadcast,
                    tags=hook.tags,
                )
                logger.debug(f"Agent {agent_name} disabled hook: {hook_id}")

        for hook_id in enable_ids:
            if hook_id in self._hooks:
                hook = self._hooks[hook_id]
                self._hooks[hook_id] = HookDefinition(
                    id=hook.id,
                    name=hook.name,
                    description=hook.description,
                    enabled=True,
                    source=hook.source,
                    priority=hook.priority,
                    events=hook.events,
                    matcher=hook.matcher,
                    if_expr=hook.if_expr,
                    backend=hook.backend,
                    timeout_ms=hook.timeout_ms,
                    fail_open=hook.fail_open,
                    ui_title=hook.ui_title,
                    ui_description=hook.ui_description,
                    broadcast=hook.broadcast,
                    tags=hook.tags,
                )
                logger.debug(f"Agent {agent_name} enabled hook: {hook_id}")

        for hook_id, new_priority in priority_overrides.items():
            if hook_id in self._hooks:
                hook = self._hooks[hook_id]
                self._hooks[hook_id] = HookDefinition(
                    id=hook.id,
                    name=hook.name,
                    description=hook.description,
                    enabled=hook.enabled,
                    source=hook.source,
                    priority=new_priority,
                    events=hook.events,
                    matcher=hook.matcher,
                    if_expr=hook.if_expr,
                    backend=hook.backend,
                    timeout_ms=hook.timeout_ms,
                    fail_open=hook.fail_open,
                    ui_title=hook.ui_title,
                    ui_description=hook.ui_description,
                    broadcast=hook.broadcast,
                    tags=hook.tags,
                )
                logger.debug(
                    f"Agent {agent_name} overrode priority for {hook_id}: {new_priority}"
                )


# Global registry instance
_global_registry: Optional[HookRegistry] = None


def get_hook_registry() -> HookRegistry:
    """Get the global hook registry instance."""
    global _global_registry
    if _global_registry is None:
        _global_registry = HookRegistry()
    return _global_registry


def reset_hook_registry() -> None:
    """Reset the global hook registry (mainly for testing)."""
    global _global_registry
    _global_registry = None
