"""Built-in hook handlers for common use cases."""

from hooks.builtin.tool_hooks import (
    handle_risk_audit,
    handle_high_risk_approval_enhancement,
    handle_test_logger,
)

__all__ = [
    "handle_risk_audit",
    "handle_high_risk_approval_enhancement",
    "handle_test_logger",
]
