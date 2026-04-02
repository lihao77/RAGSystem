"""Hook configuration loader.

Loads hook definitions from YAML configuration files.
Handles system-level and agent-level configuration merging.
"""

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

from hooks.models import (
    HookBackendDefinition,
    HookDefinition,
    HookMatcher,
)

logger = logging.getLogger(__name__)


class HookConfigLoader:
    """Loads and validates hook configurations from YAML files."""

    def __init__(self, config_dir: Path):
        """Initialize the config loader.

        Args:
            config_dir: Directory containing hooks.yaml
        """
        self.config_dir = config_dir
        self.hooks_file = config_dir / "hooks.yaml"

    def load_system_hooks(self) -> List[HookDefinition]:
        """Load system-level hook definitions.

        Returns:
            List of HookDefinition objects
        """
        if not self.hooks_file.exists():
            logger.warning(f"Hooks config file not found: {self.hooks_file}")
            return []

        try:
            with open(self.hooks_file, "r", encoding="utf-8") as f:
                config = yaml.safe_load(f)

            if not config:
                return []

            # Get defaults
            defaults = config.get("defaults", {})

            # Parse hooks
            hooks_config = config.get("hooks", [])
            hooks = []

            for hook_config in hooks_config:
                try:
                    hook = self._parse_hook_definition(hook_config, defaults)
                    hooks.append(hook)
                except Exception as e:
                    logger.error(
                        f"Failed to parse hook {hook_config.get('id', 'unknown')}: {e}"
                    )
                    continue

            logger.info(f"Loaded {len(hooks)} system hooks from {self.hooks_file}")
            return hooks

        except Exception as e:
            logger.error(f"Failed to load hooks config: {e}", exc_info=True)
            return []

    def _parse_hook_definition(
        self, config: Dict[str, Any], defaults: Dict[str, Any]
    ) -> HookDefinition:
        """Parse a single hook definition from config.

        Args:
            config: Hook configuration dict
            defaults: Default values

        Returns:
            HookDefinition object
        """
        # Required fields
        hook_id = config["id"]
        name = config.get("name", hook_id)
        description = config.get("description", "")
        events = tuple(config["events"])
        backend_config = config["backend"]

        # Optional fields with defaults
        enabled = config.get("enabled", defaults.get("enabled", True))
        source = config.get("source", "system")
        priority = config.get("priority", 100)
        timeout_ms = config.get("timeout_ms", defaults.get("timeout_ms", 1000))
        fail_open = config.get(
            "fail_open",
            defaults.get("fail_mode", "closed_for_decision_open_for_observation")
            == "open",
        )
        broadcast = config.get("broadcast", defaults.get("broadcast", True))

        # Parse matcher
        matcher_config = config.get("matcher", {})
        matcher = self._parse_matcher(matcher_config)

        # Parse if expression
        if_expr = config.get("if")

        # Parse backend
        backend = self._parse_backend(backend_config)

        # UI metadata
        ui_config = config.get("ui", {})
        ui_title = ui_config.get("title")
        ui_description = ui_config.get("description")

        # Tags
        tags = tuple(config.get("tags", []))

        return HookDefinition(
            id=hook_id,
            name=name,
            description=description,
            enabled=enabled,
            source=source,
            priority=priority,
            events=events,
            matcher=matcher,
            if_expr=if_expr,
            backend=backend,
            timeout_ms=timeout_ms,
            fail_open=fail_open,
            ui_title=ui_title,
            ui_description=ui_description,
            broadcast=broadcast,
            tags=tags,
        )

    def _parse_matcher(self, config: Dict[str, Any]) -> HookMatcher:
        """Parse matcher configuration.

        Args:
            config: Matcher configuration dict

        Returns:
            HookMatcher object
        """
        return HookMatcher(
            tool_names=tuple(config.get("tool_names", [])),
            agent_names=tuple(config.get("agent_names", [])),
            callers=tuple(config.get("callers", [])),
            risk_levels=tuple(config.get("risk_levels", [])),
            workspace_trust=tuple(config.get("workspace_trust", [])),
            session_ids=tuple(config.get("session_ids", [])),
            user_roles=tuple(config.get("user_roles", [])),
            when_result_success=config.get("when_result_success"),
            when_permission_mode=tuple(config.get("when_permission_mode", [])),
            sources=tuple(config.get("sources", [])),
            tags=tuple(config.get("tags", [])),
        )

    def _parse_backend(self, config: Dict[str, Any]) -> HookBackendDefinition:
        """Parse backend configuration.

        Args:
            config: Backend configuration dict

        Returns:
            HookBackendDefinition object
        """
        backend_type = config["type"]
        target = config["target"]
        backend_config = config.get("config", {})

        return HookBackendDefinition(
            type=backend_type,
            target=target,
            config=backend_config,
        )

    def load_agent_overrides(
        self, agent_config: Dict[str, Any]
    ) -> tuple[List[str], List[str], Dict[str, int]]:
        """Load agent-level hook configuration overrides.

        Args:
            agent_config: Agent configuration dict

        Returns:
            Tuple of (disable_ids, enable_ids, priority_overrides)
        """
        hooks_config = agent_config.get("hooks", {})

        disable_ids = hooks_config.get("disable_ids", [])
        enable_ids = hooks_config.get("enable_ids", [])
        priority_overrides = hooks_config.get("priority_overrides", {})

        return disable_ids, enable_ids, priority_overrides


def load_hooks_config(config_dir: Optional[Path] = None) -> List[HookDefinition]:
    """Load hook configurations from the default location.

    Args:
        config_dir: Optional config directory path

    Returns:
        List of HookDefinition objects
    """
    if config_dir is None:
        # Default to config/yaml directory
        from pathlib import Path

        config_dir = Path(__file__).parent.parent / "config" / "yaml"

    loader = HookConfigLoader(config_dir)
    return loader.load_system_hooks()
