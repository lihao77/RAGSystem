# -*- coding: utf-8 -*-
"""
守护 Agent 系统数据模型

定义社交平台适配器、消息路由、定时调度和心跳监控所需的核心模型。
"""

from typing import Optional, Dict, Any, List
from enum import Enum

from tools.contracts.permission_modes import PermissionPolicy

try:
    from pydantic import BaseModel, Field, model_validator
    _HAS_MODEL_VALIDATOR = True
except ImportError:  # pydantic v1
    from pydantic import BaseModel, Field, root_validator
    model_validator = None
    _HAS_MODEL_VALIDATOR = False


# ==================== 枚举 ====================

class PlatformType(str, Enum):
    """社交平台类型"""
    FEISHU = "feishu"
    WECHAT = "wechat"
    DINGTALK = "dingtalk"


class AdapterStatus(str, Enum):
    """适配器连接状态"""
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    ERROR = "error"


# ==================== 平台连接配置 ====================

class PlatformConnection(BaseModel):
    """单个社交平台的连接配置"""
    enabled: bool = Field(default=False, description="是否启用该平台")
    app_id: Optional[str] = Field(default=None, description="应用 ID")
    app_secret: Optional[str] = Field(default=None, description="应用密钥")
    token: Optional[str] = Field(default=None, description="回调验证 Token")
    encoding_aes_key: Optional[str] = Field(default=None, description="消息加解密密钥")
    webhook_url: Optional[str] = Field(default=None, description="入站 Webhook URL（仅接收）")
    session_id: Optional[str] = Field(default=None, description="平台级 session ID（覆盖 agent 级配置）")
    extra: Dict[str, Any] = Field(default_factory=dict, description="平台特有参数")


# ==================== 定时任务 ====================

class CronTask(BaseModel):
    """定时任务配置"""
    task_id: str = Field(description="任务唯一 ID")
    name: str = Field(default="", description="任务名称")
    cron: str = Field(description="标准 5 段 cron 表达式")
    task: str = Field(description="传给 Agent 的任务文本")
    team_name: str = Field(description="执行该任务的 team 名称（对应 teams/<name>.yaml）")
    entry_agent: Optional[str] = Field(default=None, description="入口 Agent 名称（留空则用 team 的 default_entry）")
    push_platform: Optional[PlatformType] = Field(
        default=None, description="执行结果推送的平台（None 表示不推送）"
    )
    push_chat_id: Optional[str] = Field(
        default=None, description="推送目标的 chat_id"
    )
    enabled: bool = Field(default=True, description="是否启用")
    last_run: Optional[float] = Field(default=None, description="上次执行时间戳")
    next_run: Optional[float] = Field(default=None, description="下次执行时间戳")
    last_result: Optional[str] = Field(default=None, description="上次执行结果摘要")


# ==================== 消息模型 ====================

class IncomingMessage(BaseModel):
    """统一入站消息（社交平台 → 系统）"""
    message_id: str = Field(description="消息唯一 ID")
    platform: PlatformType = Field(description="来源平台")
    chat_id: str = Field(description="平台侧会话 ID（群/个人）")
    user_id: str = Field(description="平台侧用户 ID")
    user_name: Optional[str] = Field(default=None, description="用户昵称")
    content: str = Field(description="消息文本内容")
    raw_payload: Dict[str, Any] = Field(
        default_factory=dict, description="平台原始回调数据"
    )
    timestamp: float = Field(description="消息时间戳")


class OutgoingMessage(BaseModel):
    """统一出站消息（系统 → 社交平台）"""
    platform: PlatformType = Field(description="目标平台")
    chat_id: str = Field(description="平台侧会话 ID")
    content: str = Field(description="消息内容")
    message_type: str = Field(default="text", description="消息类型: text/markdown")


# ==================== 心跳状态 ====================

class HeartbeatStatus(BaseModel):
    """单个适配器的心跳状态快照"""
    platform: PlatformType = Field(description="平台类型")
    status: AdapterStatus = Field(default=AdapterStatus.DISCONNECTED)
    last_heartbeat: Optional[float] = Field(default=None, description="上次心跳时间戳")
    latency_ms: Optional[float] = Field(default=None, description="响应延迟(ms)")
    error: Optional[str] = Field(default=None, description="最近错误信息")
    reconnect_attempts: int = Field(default=0, description="重连尝试次数")


# ==================== 守护 Agent 配置 ====================

class DaemonAgentConfig(BaseModel):
    """单个守护机器人的配置（以 team 为执行单元）"""
    team_name: str = Field(description="team 名称（对应 CONFIG_ROOT/agents/teams/<team_name>.yaml）")
    entry_agent: Optional[str] = Field(default=None, description="入口 Agent 名称（留空则用 team 的 default_entry）")
    session_id: Optional[str] = Field(default=None, description="自定义 session ID（留空则按 team_name 自动派生）")
    permissions: PermissionPolicy = Field(
        default_factory=PermissionPolicy,
        description="复用系统统一权限策略模型",
    )
    platforms: Dict[PlatformType, PlatformConnection] = Field(
        default_factory=dict, description="各平台连接配置"
    )
    cron_tasks: List[CronTask] = Field(
        default_factory=list, description="定时任务列表"
    )
    heartbeat_interval: int = Field(
        default=30, ge=5, description="心跳间隔秒数"
    )
    enabled: bool = Field(default=True, description="是否启用")


# ==================== 系统配置根 ====================

class DaemonSystemConfig(BaseModel):
    """守护子系统的配置根"""
    enabled: bool = Field(default=False, description="全局开关")
    agents: List[DaemonAgentConfig] = Field(
        default_factory=list, description="守护 Agent 列表"
    )
    default_session_ttl: int = Field(
        default=86400, description="守护会话 TTL（秒）"
    )

    @staticmethod
    def _ensure_unique_enabled_platforms(agents: List[DaemonAgentConfig]) -> None:
        used_platforms: Dict[PlatformType, str] = {}
        for agent in agents:
            if not agent.enabled:
                continue
            for platform, conn in agent.platforms.items():
                if not conn.enabled:
                    continue
                existing_team = used_platforms.get(platform)
                if existing_team and existing_team != agent.team_name:
                    raise ValueError(
                        f'平台 {platform.value} 只能被一个已启用 team 占用，冲突 team: {existing_team}, {agent.team_name}'
                    )
                used_platforms[platform] = agent.team_name

    if _HAS_MODEL_VALIDATOR:
        @model_validator(mode='after')
        def validate_unique_enabled_platforms(self):
            self._ensure_unique_enabled_platforms(self.agents)
            return self
    else:
        @root_validator(pre=False, allow_reuse=True)
        def validate_unique_enabled_platforms(cls, values):
            cls._ensure_unique_enabled_platforms(values.get('agents') or [])
            return values
