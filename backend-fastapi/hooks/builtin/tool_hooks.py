"""Built-in hook handlers for tool runtime events."""

import logging
from typing import Any, Dict

from hooks.models import HookContext, HookResult

logger = logging.getLogger(__name__)


def handle_risk_audit(context: HookContext, config: Dict[str, Any]) -> HookResult:
    """Audit high-risk tool executions.

    Logs tool execution details for security and compliance.
    This is an observation-only hook that doesn't affect execution.

    Args:
        context: Hook execution context
        config: Hook configuration

    Returns:
        Empty HookResult (observation only)
    """
    # Log audit trail
    audit_entry = {
        "event": context.event_name,
        "phase": context.phase,
        "tool_name": context.tool_name,
        "agent_name": context.agent_name,
        "caller": context.caller,
        "session_id": context.session_id,
        "run_id": context.run_id,
        "timestamp": context.timestamp,
    }

    # Add tool context if available
    if context.tool_context:
        audit_entry["risk_level"] = getattr(context.tool_context, "risk_level", None)
        audit_entry["source"] = getattr(context.tool_context, "source", None)

    # Add result info for after_execute phase
    if context.phase == "after_execute":
        audit_entry["result_success"] = context.result_snapshot.get("success")
        audit_entry["result_preview"] = context.result_snapshot.get("preview", "")[:200]

    logger.info(f"[AUDIT] High-risk tool execution: {audit_entry}")

    # Return empty result - this is observation only
    return HookResult(
        tags=["audited"],
        metadata={"audit_logged": True},
    )


def handle_high_risk_approval_enhancement(
    context: HookContext, config: Dict[str, Any]
) -> HookResult:
    """Enhance approval UI for high-risk tools.

    Adds additional context and warnings to the approval prompt
    for tools that require user confirmation.

    Args:
        context: Hook execution context
        config: Hook configuration

    Returns:
        HookResult with UI enhancements
    """
    tool_name = context.tool_name or "unknown"

    # Build enhanced UI message
    ui_message = f"⚠️ High-risk operation: {tool_name}\n\n"

    # Add tool-specific warnings
    if tool_name == "execute_bash":
        ui_message += (
            "This command will execute in your system shell. "
            "Please review carefully for:\n"
            "- File system modifications\n"
            "- Network operations\n"
            "- Process management\n"
        )
    elif tool_name in ["write_file", "edit_file"]:
        ui_message += (
            "This operation will modify files on disk. "
            "Ensure you have backups if needed.\n"
        )
    elif tool_name == "write_memory":
        ui_message += (
            "This will persist information to the memory system. "
            "Review the content for sensitive data.\n"
        )

    # Add context about the agent making the request
    if context.agent_name:
        ui_message += f"\nRequested by agent: {context.agent_display_name or context.agent_name}"

    # Build UI metadata
    ui_metadata = {
        "risk_level": "high",
        "requires_review": True,
        "tool_category": _get_tool_category(tool_name),
    }

    return HookResult(
        ui_message=ui_message,
        ui_metadata=ui_metadata,
        tags=["approval_enhanced"],
    )


def _get_tool_category(tool_name: str) -> str:
    """Get the category of a tool for UI display."""
    if tool_name == "execute_bash":
        return "system"
    elif tool_name in ["write_file", "edit_file", "read_file"]:
        return "filesystem"
    elif tool_name in ["write_memory", "read_memory_entry", "archive_memory"]:
        return "memory"
    elif tool_name in ["call_agent", "send_message"]:
        return "agent"
    else:
        return "other"


def handle_test_logger(context: HookContext, config: Dict[str, Any]) -> HookResult:
    """Test hook handler: Log all tool executions.

    This is a test hook to demonstrate the hook system in action.

    Args:
        context: Hook execution context
        config: Hook configuration

    Returns:
        HookResult with logging metadata
    """
    # Build log message
    phase_emoji = {
        "before_execute": "▶️",
        "after_execute": "✅",
    }.get(context.phase, "🔧")

    log_message = (
        f"{phase_emoji} [{context.phase}] "
        f"Tool: {context.tool_name} | "
        f"Agent: {context.agent_name or 'unknown'} | "
        f"Caller: {context.caller}"
    )

    # Add result info for after_execute
    if context.phase == "after_execute":
        success = context.result_snapshot.get("success", False)
        status_emoji = "✅" if success else "❌"
        log_message += f" | Status: {status_emoji}"

    logger.info(f"[TEST HOOK] {log_message}")

    # Return result with metadata
    return HookResult(
        tags=["test_logged"],
        metadata={
            "test_hook": "tool_logger",
            "logged_at": context.timestamp,
            "tool_name": context.tool_name,
            "phase": context.phase,
        },
    )


def handle_bash_command_validation(
    context: HookContext, config: Dict[str, Any]
) -> HookResult:
    """Validate bash commands before execution.

    Checks for potentially dangerous patterns and can block execution.

    Args:
        context: Hook execution context
        config: Hook configuration

    Returns:
        HookResult with potential block decision
    """
    # Only run on before_execute phase
    if context.phase != "before_execute":
        return HookResult()

    # Get command from input snapshot
    command = context.input_snapshot.get("command", "")
    if not command:
        return HookResult()

    # Check for dangerous patterns
    dangerous_patterns = [
        "rm -rf /",
        "dd if=/dev/zero",
        ":(){ :|:& };:",  # fork bomb
        "mkfs.",
        "format ",
    ]

    for pattern in dangerous_patterns:
        if pattern in command:
            return HookResult(
                block_execution=True,
                block_reason=f"Dangerous command pattern detected: {pattern}",
                ui_message=f"⛔ Command blocked: Contains dangerous pattern '{pattern}'",
                tags=["blocked", "dangerous_command"],
            )

    # Check for untrusted workspace
    if context.workspace_trust == "untrusted":
        # In untrusted workspace, require approval for all bash commands
        return HookResult(
            permission_decision="ask",
            ui_message="⚠️ Bash command in untrusted workspace requires approval",
            tags=["untrusted_workspace"],
        )

    return HookResult()


def handle_memory_write_guard(
    context: HookContext, config: Dict[str, Any]
) -> HookResult:
    """Guard memory write operations.

    Adds context about what's being written to memory.

    Args:
        context: Hook execution context
        config: Hook configuration

    Returns:
        HookResult with additional context
    """
    # Only run on before_execute phase
    if context.phase != "before_execute":
        return HookResult()

    # Get memory write details
    memory_type = context.input_snapshot.get("type", "unknown")
    name = context.input_snapshot.get("name", "unknown")

    additional_context = [
        f"Writing to memory: type={memory_type}, name={name}",
        "This will persist across conversations.",
    ]

    return HookResult(
        additional_context=additional_context,
        tags=["memory_write"],
    )
