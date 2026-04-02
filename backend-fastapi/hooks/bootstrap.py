"""Hook system bootstrap - loads and registers hooks at startup."""

import logging
from pathlib import Path

from hooks.config_loader import load_hooks_config
from hooks.registry import get_hook_registry

logger = logging.getLogger(__name__)


def bootstrap_hook_system(config_dir: Path = None) -> None:
    """Bootstrap the hook system at application startup.

    Loads system-level hook definitions and registers them.

    Args:
        config_dir: Optional config directory path
    """
    try:
        logger.info("Bootstrapping hook system...")

        # Load system hooks
        hooks = load_hooks_config(config_dir)

        if not hooks:
            logger.warning("No hooks loaded from configuration")
            return

        # Register hooks
        registry = get_hook_registry()
        for hook in hooks:
            registry.register(hook)

        logger.info(f"Hook system bootstrapped successfully: {len(hooks)} hooks registered")

    except Exception as e:
        logger.error(f"Failed to bootstrap hook system: {e}", exc_info=True)
        # Don't fail application startup if hooks fail to load
