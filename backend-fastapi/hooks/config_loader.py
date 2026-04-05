"""Hook configuration loader.

Loads hook definitions from system config and merges agent-level overrides.
"""

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

from config import get_config
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

_DEFAULT_HOOK_DEFAULTS: Dict[str, Any] = {
    "enabled": True,
    "timeout_ms": 1000,
    "fail_mode": "closed_for_decision_open_for_observation",
    "broadcast": True,
}

_DEFAULT_SYSTEM_HOOKS: List[Dict[str, Any]] = [
    {
        "id": "tool-risk-audit",
        "name": "High-Risk Tool Audit",
        "description": "Audit all high-risk tool executions for security and compliance",
        "enabled": True,
        "source": "system",
        "priority": 100,
        "events": ["tool.after_execute"],
        "matcher": {
            "tool_names": ["execute_bash", "write_memory", "edit_file", "write_file"],
            "callers": ["direct"],
        },
        "backend": {
            "type": "function",
            "target": "hooks.builtin.tool_hooks:handle_risk_audit",
        },
    },
    {
        "id": "approval-ui-enhancement",
        "name": "Approval UI Enhancement",
        "description": "Enhance approval prompts with additional context and warnings",
        "enabled": True,
        "source": "system",
        "priority": 200,
        "events": ["approval.required"],
        "matcher": {
            "risk_levels": ["high", "critical"],
        },
        "backend": {
            "type": "function",
            "target": "hooks.builtin.tool_hooks:handle_high_risk_approval_enhancement",
        },
    },
    {
        "id": "bash-command-validation",
        "name": "Bash Command Validation",
        "description": "Validate bash commands for dangerous patterns",
        "enabled": True,
        "source": "system",
        "priority": 300,
        "events": ["tool.before_permission"],
        "matcher": {
            "tool_names": ["execute_bash"],
        },
        "backend": {
            "type": "function",
            "target": "hooks.builtin.tool_hooks:handle_bash_command_validation",
        },
        "fail_open": False,
    },
    {
        "id": "memory-write-guard",
        "name": "Memory Write Guard",
        "description": "Add context about memory write operations",
        "enabled": True,
        "source": "system",
        "priority": 150,
        "events": ["tool.before_execute"],
        "matcher": {
            "tool_names": ["write_memory"],
        },
        "backend": {
            "type": "function",
            "target": "hooks.builtin.tool_hooks:handle_memory_write_guard",
        },
    },
]


class HookConfigLoader:
    """Loads and validates hook configurations from system config."""

    def __init__(self, config_dir: Path | None = None):
        self.config_dir = config_dir
        self.workspace_trust_config = WorkspaceTrustConfig()

    def _load_system_config(self) -> Dict[str, Any]:
        if self.config_dir is not None:
            config_file = self.config_dir / "config.yaml"
            if config_file.exists():
                try:
                    with open(config_file, "r", encoding="utf-8") as f:
                        raw = yaml.safe_load(f) or {}
                    return raw.get("hooks", {}) or {}
                except Exception as e:
                    logger.error(f"Failed to load hook config from {config_file}: {e}", exc_info=True)
                    return {}
        try:
            config = get_config()
            hooks_config = getattr(config, "hooks", None)
            if hooks_config is None:
                return {}
            if hasattr(hooks_config, "model_dump"):
                return hooks_config.model_dump()
            return dict(hooks_config)
        except Exception as e:
            logger.error(f"Failed to load hook config from app config: {e}", exc_info=True)
            return {}

    def load_system_hooks(self) -> List[HookDefinition]:
        """Load system-level hook definitions."""
        config = self._load_system_config()
        enabled = config.get("enabled", True)
        if not enabled:
            self.workspace_trust_config = self._parse_workspace_trust_config(
                config.get("workspace_trust", {})
            )
            logger.info("Hook system disabled by system config")
            return []

        self.workspace_trust_config = self._parse_workspace_trust_config(
            config.get("workspace_trust", {})
        )
        hooks: List[HookDefinition] = []
        for hook_config in _DEFAULT_SYSTEM_HOOKS:
            try:
                hook = self._parse_hook_definition(hook_config, _DEFAULT_HOOK_DEFAULTS)
                hooks.append(hook)
            except Exception as e:
                logger.error(
                    f"Failed to build default hook {hook_config.get('id', 'unknown')}: {e}"
                )
                continue

        logger.info("Loaded %d system hooks from app config", len(hooks))
        return hooks

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
            matcher = rule.get("matcher", {}) if isinstance(rule, dict) else {}
            workspace_root_prefix = rule.get("workspace_root_prefix") or matcher.get("workspace_root_prefix")
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
    """Load hook configurations from system config."""
    loader = HookConfigLoader(config_dir)
    return loader.load_system_hooks()


_DEFAULT_CONFIG_DIR: Path | None = None


def resolve_workspace_trust(workspace_root: Optional[str], config_dir: Optional[Path] = None) -> str:
    """Resolve workspace trust from configured prefix rules."""
    loader = HookConfigLoader(config_dir or _DEFAULT_CONFIG_DIR)
    loader.load_system_hooks()
    return loader.resolve_workspace_trust(workspace_root)
