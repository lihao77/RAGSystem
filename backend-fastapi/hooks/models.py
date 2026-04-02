"""Core data models for the hook system."""

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

from tools.runtime.models import ToolUseContext, PermissionDecision


@dataclass(frozen=True)
class HookContext:
    """Read-only context passed to hook handlers.

    Contains all information about the current execution state,
    including tool context, agent state, and event metadata.
    """

    event_name: str
    phase: str  # before_permission / after_permission / before_execute / after_execute / on_error
    timestamp: float

    # Session/execution identifiers
    session_id: Optional[str] = None
    run_id: Optional[str] = None
    request_id: Optional[str] = None

    # Agent context
    agent_name: Optional[str] = None
    agent_display_name: Optional[str] = None
    caller: Optional[str] = None
    user_role: Optional[str] = None

    # Tool context
    tool_name: Optional[str] = None
    tool_call_id: Optional[str] = None
    parent_call_id: Optional[str] = None
    round: Optional[int] = None
    order: Optional[int] = None
    round_index: Optional[int] = None

    # Security context
    workspace_trust: str = "trusted"
    source: str = "runtime"

    # Rich context objects
    tool_context: Optional[ToolUseContext] = None
    permission_decision: Optional[PermissionDecision] = None

    # Snapshots (immutable views)
    input_snapshot: Mapping[str, Any] = field(default_factory=dict)
    result_snapshot: Mapping[str, Any] = field(default_factory=dict)
    error_snapshot: Mapping[str, Any] = field(default_factory=dict)

    # Additional metadata
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass
class HookResult:
    """Result returned by hook handlers.

    Phase 1: Conservative - observation and decision only, no mutation.
    """

    # Execution control
    continue_execution: bool = True
    block_execution: bool = False
    block_reason: str = ""

    # Permission override (can only narrow, not widen)
    permission_decision: Optional[str] = None  # allow / ask / deny

    # Additional context for AI or downstream hooks
    additional_context: list[str] = field(default_factory=list)

    # UI enhancements
    ui_message: Optional[str] = None
    ui_metadata: dict[str, Any] = field(default_factory=dict)

    # Metadata and tags
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    # Progress reporting
    broadcast_progress: Optional[str] = None


@dataclass(frozen=True)
class HookBackendDefinition:
    """Defines how a hook is executed."""

    type: str  # function / prompt / callback
    target: str  # module:function for function type
    config: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class HookMatcher:
    """Structured matcher for filtering hook execution."""

    # Tool/agent filters
    tool_names: tuple[str, ...] = ()
    agent_names: tuple[str, ...] = ()
    callers: tuple[str, ...] = ()

    # Security filters
    risk_levels: tuple[str, ...] = ()
    workspace_trust: tuple[str, ...] = ()

    # Session filters
    session_ids: tuple[str, ...] = ()
    user_roles: tuple[str, ...] = ()

    # Result filters
    when_result_success: Optional[bool] = None
    when_permission_mode: tuple[str, ...] = ()

    # Source filters
    sources: tuple[str, ...] = ()
    tags: tuple[str, ...] = ()


@dataclass(frozen=True)
class HookDefinition:
    """Complete definition of a hook."""

    id: str
    name: str
    description: str
    enabled: bool
    source: str  # system / agent / session
    priority: int  # higher = earlier execution

    # Event matching
    events: tuple[str, ...]
    matcher: HookMatcher
    backend: HookBackendDefinition

    # Optional fields
    if_expr: Optional[str] = None  # lightweight expression for secondary filtering
    timeout_ms: int = 1000
    fail_open: bool = True  # True for observation hooks, False for decision hooks

    # UI metadata
    ui_title: Optional[str] = None
    ui_description: Optional[str] = None
    broadcast: bool = True

    # Tags
    tags: tuple[str, ...] = ()
