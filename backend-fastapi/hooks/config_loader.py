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
    WorkspaceTrustConfig,
    WorkspaceTrustRule,
)

logger = logging.getLogger(__name__)


_DECISION_EVENTS = {
    "tool.before_permission",
    "tool.after_permission",
    "approval.required",
    "approval.resolved",
    "approval.denied",
    "approval.error",
}

_WORKSPACE_TRUST_VALUES = {"trusted", "untrusted"}


class HookConfigLoader:
    """Loads and validates hook configurations from YAML files."""

    def __init__(self, config_dir: Path):
        """Initialize the config loader.

        Args:
            config_dir: Directory containing hooks.yaml
        """
        self.config_dir = config_dir
        self.hooks_file = config_dir / "hooks.yaml"
        self.workspace_trust_config = WorkspaceTrustConfig()

    def load_system_hooks(self) -> List[HookDefinition]:
        """Load system-level hook definitions.

        Returns:
            List of HookDefinition objects
        """
        if not self.hooks_file.exists():
            logger.warning(f"Hooks config file not found: {self.hooks_file}")
            self.workspace_trust_config = WorkspaceTrustConfig()
            return []

        try:
            with open(self.hooks_file, "r", encoding="utf-8") as f:
                config = yaml.safe_load(f)

            if not config:
                self.workspace_trust_config = WorkspaceTrustConfig()
                return []

            self.workspace_trust_config = self._parse_workspace_trust_config(
                config.get("workspace_trust", {})
            )

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
            self.workspace_trust_config = WorkspaceTrustConfig()
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
        fail_open = config.get("fail_open")
        if fail_open is None:
            fail_open = self._resolve_default_fail_open(events, defaults)
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

    def _resolve_default_fail_open(
        self, events: tuple[str, ...], defaults: Dict[str, Any]
    ) -> bool:
        fail_mode = defaults.get("fail_mode", "closed_for_decision_open_for_observation")
        if fail_mode == "open":
            return True
        if fail_mode == "closed":
            return False
        if fail_mode == "closed_for_decision_open_for_observation":
            return not any(event in _DECISION_EVENTS for event in events)
        return False

    def _parse_workspace_trust_config(self, config: Dict[str, Any]) -> WorkspaceTrustConfig:
        default = config.get("default", "trusted")
        if default not in _WORKSPACE_TRUST_VALUES:
            raise ValueError(f"Invalid workspace_trust.default: {default}")

        rules: list[WorkspaceTrustRule] = []
        for rule in config.get("rules", []):
            matcher = rule.get("matcher", {})
            workspace_root_prefix = matcher.get("workspace_root_prefix")
            trust = rule.get("trust")
            if not workspace_root_prefix:
                raise ValueError("workspace_trust rule missing matcher.workspace_root_prefix")
            if trust not in _WORKSPACE_TRUST_VALUES:
                raise ValueError(f"Invalid workspace_trust rule trust: {trust}")
            rules.append(
                WorkspaceTrustRule(
                    workspace_root_prefix=str(workspace_root_prefix),
                    trust=trust,
                )
            )

        return WorkspaceTrustConfig(default=default, rules=tuple(rules))

    def resolve_workspace_trust(self, workspace_root: Optional[str]) -> str:
        if workspace_root:
            normalized_root = self._normalize_path(workspace_root)
            for rule in self.workspace_trust_config.rules:
                normalized_prefix = self._normalize_path(rule.workspace_root_prefix)
                if self._path_matches_prefix(normalized_root, normalized_prefix):
                    return rule.trust
        return self.workspace_trust_config.default

    @staticmethod
    def _path_matches_prefix(path: str, prefix: str) -> bool:
        if path == prefix:
            return True
        return path.startswith(f"{prefix}/")

    @staticmethod
    def _normalize_path(value: str) -> str:
        return str(Path(value)).replace("\\", "/").rstrip("/").lower()

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


_DEFAULT_CONFIG_DIR = Path(__file__).parent.parent / "config" / "yaml"


def resolve_workspace_trust(workspace_root: Optional[str], config_dir: Optional[Path] = None) -> str:
    """Resolve workspace trust from configured prefix rules."""
    if config_dir is None:
        config_dir = _DEFAULT_CONFIG_DIR
    loader = HookConfigLoader(config_dir)
    loader.load_system_hooks()
    return loader.resolve_workspace_trust(workspace_root)
