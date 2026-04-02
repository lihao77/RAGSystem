"""Core data models for the hook system."""

from dataclasses import dataclass, field
from typing import Any, Literal, Mapping, Optional

from tools.runtime.models import PermissionDecision, ToolUseContext

WorkspaceTrustValue = Literal["trusted", "untrusted"]


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
    workspace_trust: WorkspaceTrustValue = "trusted"
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
    """Minimal common result returned by hook handlers."""

    continue_execution: bool = True
    block_execution: bool = False
    block_reason: str = ""


@dataclass
class DecisionHookResult(HookResult):
    """Hook result for tool.before_permission / tool.after_permission."""

    permission_decision: Optional[str] = None  # allow / ask / deny
    ui_message: Optional[str] = None
    ui_metadata: dict[str, Any] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    broadcast_progress: Optional[str] = None


@dataclass
class ContextHookResult(HookResult):
    """Hook result for tool.before_execute."""

    additional_context: list[str] = field(default_factory=list)
    ui_message: Optional[str] = None
    ui_metadata: dict[str, Any] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    broadcast_progress: Optional[str] = None


@dataclass
class ObservationHookResult(HookResult):
    """Hook result for tool.after_execute."""

    additional_context: list[str] = field(default_factory=list)
    ui_message: Optional[str] = None
    ui_metadata: dict[str, Any] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    broadcast_progress: Optional[str] = None


@dataclass
class ErrorHookResult(HookResult):
    """Hook result for tool.on_error."""

    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    broadcast_progress: Optional[str] = None


@dataclass
class ApprovalHookResult(HookResult):
    """Hook result for approval.* lifecycle events.

    Approval hooks are UI/audit enhancements only.
    """

    ui_message: Optional[str] = None
    ui_metadata: dict[str, Any] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


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


@dataclass(frozen=True)
class WorkspaceTrustRule:
    workspace_root_prefix: str
    trust: WorkspaceTrustValue


@dataclass(frozen=True)
class WorkspaceTrustConfig:
    default: WorkspaceTrustValue = "trusted"
    rules: tuple[WorkspaceTrustRule, ...] = ()
