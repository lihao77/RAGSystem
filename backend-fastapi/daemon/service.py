# -*- coding: utf-8 -*-
"""
守护 Agent 系统统一服务门面。

管理消息网关、定时调度和心跳监控的完整生命周期，
复用现有 AgentApiRuntimeService 执行守护任务。
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

from daemon.models import (
    AdapterStatus,
    CronTask,
    DaemonAgentConfig,
    DaemonSystemConfig,
    HeartbeatStatus,
    IncomingMessage,
    OutgoingMessage,
    PlatformType,
)
from daemon.gateway.base import PlatformAdapter
from daemon.gateway.router import MessageRouter
from daemon.scheduler.engine import CronScheduler
from daemon.heartbeat import HeartbeatMonitor

logger = logging.getLogger(__name__)


class DaemonService:
    """守护 Agent 子系统统一入口。"""

    def __init__(self):
        self._config: Optional[DaemonSystemConfig] = None
        self._router: Optional[MessageRouter] = None
        self._adapters: Dict[PlatformType, PlatformAdapter] = {}
        self._scheduler: Optional[CronScheduler] = None
        self._heartbeat: Optional[HeartbeatMonitor] = None
        self._running: bool = False
        self._daemon_sessions: Dict[str, str] = {}  # chat_id -> session_id
        self._session_timestamps: Dict[str, float] = {}  # chat_id -> last_active timestamp
        self._heartbeat_history: Dict[PlatformType, List[HeartbeatStatus]] = {}

    # ── 配置加载 ──────────────────────────────────────

    def _resolve_config_path(self) -> Path:
        """解析配置文件路径。"""
        try:
            from config import get_config
            cfg = get_config()
            config_root = getattr(cfg, 'config_root', None)
            if not config_root:
                config_root = Path.home() / '.ragsystem' / 'config'
            else:
                config_root = Path(config_root)
        except Exception:
            config_root = Path.home() / '.ragsystem' / 'config'
        return config_root / 'daemon' / 'daemon.yaml'

    def load_config(self) -> DaemonSystemConfig:
        """从 CONFIG_ROOT/daemon/daemon.yaml 加载配置。"""
        config_path = self._resolve_config_path()
        if config_path.exists():
            with open(config_path, 'r', encoding='utf-8') as f:
                raw = yaml.safe_load(f) or {}
            self._config = DaemonSystemConfig.model_validate(raw)
        else:
            self._config = DaemonSystemConfig()
            logger.info('守护配置文件不存在，使用默认配置（disabled）')

        return self._config

    def save_config(self, new_config: DaemonSystemConfig) -> None:
        """保存配置到 YAML 文件并热更新内存。"""
        config_path = self._resolve_config_path()
        config_path.parent.mkdir(parents=True, exist_ok=True)

        raw = new_config.model_dump(mode='json')
        with open(config_path, 'w', encoding='utf-8') as f:
            yaml.dump(raw, f, default_flow_style=False, allow_unicode=True)

        self._config = new_config
        logger.info('守护配置已保存到 %s', config_path)

    @property
    def config(self) -> DaemonSystemConfig:
        if self._config is None:
            self.load_config()
        return self._config

    @property
    def running(self) -> bool:
        return self._running

    # ── 生命周期 ──────────────────────────────────────

    async def start(self) -> None:
        """启动守护子系统。"""
        if self._running:
            logger.warning('守护系统已在运行中')
            return

        cfg = self.config
        if not cfg.enabled:
            logger.info('守护系统未启用（daemon.enabled=false）')
            return

        logger.info('正在启动守护 Agent 系统...')

        # 1. 初始化消息路由器
        self._router = MessageRouter(daemon_service=self)

        # 2. 实例化并连接各平台适配器
        for agent_cfg in cfg.agents:
            if not agent_cfg.enabled:
                continue
            for platform, conn in agent_cfg.platforms.items():
                if not conn.enabled:
                    continue
                adapter = self._create_adapter(platform, conn)
                if adapter:
                    # 先注册，即使连接失败也能查询状态
                    self._adapters[platform] = adapter
                    try:
                        await adapter.connect()
                        logger.info('平台适配器已连接: %s', platform.value)
                    except Exception as e:
                        logger.error('平台适配器连接失败 [%s]: %s', platform.value, e)

        # 3. 启动 Cron 调度器
        all_tasks = []
        for agent_cfg in cfg.agents:
            all_tasks.extend(agent_cfg.cron_tasks)
        if all_tasks:
            self._scheduler = CronScheduler(
                tasks=all_tasks,
                daemon_service=self,
            )
            await self._scheduler.start()
            logger.info('Cron 调度器已启动，共 %d 个任务', len(all_tasks))

        # 4. 启动心跳监控
        if self._adapters:
            heartbeat_interval = 30
            for agent_cfg in cfg.agents:
                if agent_cfg.heartbeat_interval:
                    heartbeat_interval = agent_cfg.heartbeat_interval
                    break
            self._heartbeat = HeartbeatMonitor(
                adapters=self._adapters,
                interval=heartbeat_interval,
                daemon_service=self,
            )
            await self._heartbeat.start()
            logger.info('心跳监控已启动，间隔 %ds', heartbeat_interval)

        self._running = True
        logger.info('守护 Agent 系统启动完成')

    async def stop(self) -> None:
        """停止守护子系统。"""
        if not self._running:
            return

        logger.info('正在停止守护 Agent 系统...')

        if self._heartbeat:
            await self._heartbeat.stop()
        if self._scheduler:
            await self._scheduler.stop()
        for platform, adapter in self._adapters.items():
            try:
                await adapter.disconnect()
            except Exception as e:
                logger.error('断开适配器失败 [%s]: %s', platform.value, e)

        self._adapters.clear()
        self._router = None
        self._heartbeat = None
        self._scheduler = None
        self._running = False
        logger.info('守护 Agent 系统已停止')

    # ── 适配器工厂 ────────────────────────────────────

    def _create_adapter(
        self, platform: PlatformType, conn: Any
    ) -> Optional[PlatformAdapter]:
        """按平台类型创建适配器实例。"""
        try:
            if platform == PlatformType.WECHAT:
                from daemon.gateway.wechat import WeChatAdapter
                return WeChatAdapter(conn)
            elif platform == PlatformType.DINGTALK:
                from daemon.gateway.dingtalk import DingTalkAdapter
                return DingTalkAdapter(conn)
            elif platform == PlatformType.FEISHU:
                from daemon.gateway.feishu import FeishuAdapter
                return FeishuAdapter(conn, incoming_handler=self.handle_incoming_message)
            else:
                logger.warning('不支持的平台类型: %s', platform)
                return None
        except Exception as e:
            logger.error('创建适配器失败 [%s]: %s', platform.value, e)
            return None

    # ── 消息路由 ──────────────────────────────────────

    async def handle_incoming_message(self, message: IncomingMessage) -> None:
        """处理入站消息（由 PlatformAdapter 调用）。"""
        if not self._router:
            logger.error('消息路由器未初始化')
            return
        await self._router.route_incoming(message)

    async def send_message(self, message: OutgoingMessage) -> bool:
        """通过指定平台发送消息。"""
        adapter = self._adapters.get(message.platform)
        if not adapter:
            logger.warning('平台适配器未配置: %s（请检查 daemon.yaml 中的 platforms 配置）', message.platform.value)
            return False
        status = adapter.get_status()
        if status != AdapterStatus.CONNECTED:
            logger.warning('平台适配器未连接: %s（当前状态: %s，请检查凭证配置）', message.platform.value, status.value)
            return False
        try:
            return await adapter.send_message(message)
        except Exception as e:
            logger.error('发送消息失败 [%s]: %s', message.platform.value, e)
            return False

    # ── Cron 触发 ─────────────────────────────────────

    async def execute_cron_task(self, task: CronTask) -> Optional[str]:
        """执行定时任务，返回 Agent 响应内容。"""
        try:
            from runtime.container import get_current_runtime_container
            container = get_current_runtime_container()
            if not container:
                logger.error('RuntimeContainer 未初始化')
                return None

            runtime_svc = container.get_agent_api_runtime_service()
            exec_svc = runtime_svc.get_agent_execution_service()

            # 为 cron 任务创建或复用 session（绑定 team）
            session_id = self._get_or_create_session(
                f"cron:{task.task_id}", task.team_name, task.entry_agent
            )

            result = await asyncio.to_thread(
                exec_svc.invoke_agent,
                mode='root',
                agent_name=task.entry_agent,  # None 时由 team default_entry 自动路由
                task=task.task,
                session_id=session_id,
                source='daemon.cron',
                persist_user_message=True,
                persist_final_answer=True,
            )

            response_content = (
                result.response.content
                if result.response and result.response.success
                else None
            )

            # 如果配置了推送，发送到社交平台
            if response_content and task.push_platform and task.push_chat_id:
                await self.send_message(OutgoingMessage(
                    platform=task.push_platform,
                    chat_id=task.push_chat_id,
                    content=response_content,
                ))

            task.last_run = time.time()
            task.last_result = (response_content or '')[:200]
            return response_content

        except Exception as e:
            logger.error('Cron 任务执行失败 [%s]: %s', task.task_id, e)
            task.last_result = f'ERROR: {e}'
            return None

    # ── Session 管理 ──────────────────────────────────

    def _get_or_create_session(self, chat_id: str, team_name: str, entry_agent: Optional[str] = None) -> str:
        """获取或创建守护 session，并维护 last_active 用于 TTL 清理。"""
        now = time.time()
        self._evict_expired_sessions(now)

        if chat_id in self._daemon_sessions:
            self._session_timestamps[chat_id] = now
            return self._daemon_sessions[chat_id]

        try:
            from runtime.container import get_current_runtime_container
            container = get_current_runtime_container()
            runtime_svc = container.get_agent_api_runtime_service()
            store = runtime_svc.get_conversation_store()

            session_id = f"daemon_{uuid.uuid4().hex[:12]}"
            metadata: Dict[str, Any] = {
                'source': 'daemon',
                'chat_id': chat_id,
                'team': team_name,
            }
            if entry_agent:
                metadata['entry_agent'] = entry_agent
            store.create_session(
                session_id=session_id,
                metadata=metadata,
            )
            self._daemon_sessions[chat_id] = session_id
            self._session_timestamps[chat_id] = now
            return session_id
        except Exception as e:
            logger.error('创建守护 session 失败: %s', e)
            return f"daemon_fallback_{uuid.uuid4().hex[:8]}"

    def _evict_expired_sessions(self, now: float) -> None:
        """清理超过 TTL 的守护 session（懒惰清理）。"""
        ttl = self.config.default_session_ttl
        expired = [
            chat_id for chat_id, ts in self._session_timestamps.items()
            if now - ts > ttl
        ]
        for chat_id in expired:
            self._daemon_sessions.pop(chat_id, None)
            self._session_timestamps.pop(chat_id, None)
        if expired:
            logger.debug('清理过期守护 session %d 个', len(expired))

    # ── 状态查询 ──────────────────────────────────────

    def get_status(self) -> Dict[str, Any]:
        """返回守护系统整体状态。"""
        cfg = self.config
        adapter_statuses = {
            p.value: adapter.get_status().value
            for p, adapter in self._adapters.items()
        }
        cron_tasks = []
        if self._scheduler:
            cron_tasks = [
                {
                    'task_id': t.task_id,
                    'name': t.name,
                    'cron': t.cron,
                    'enabled': t.enabled,
                    'last_run': t.last_run,
                    'next_run': t.next_run,
                }
                for t in self._scheduler.get_all_tasks()
            ]

        return {
            'running': self._running,
            'enabled': cfg.enabled,
            'adapter_count': len(self._adapters),
            'adapters': adapter_statuses,
            'cron_tasks': cron_tasks,
            'daemon_sessions': len(self._daemon_sessions),
        }

    def get_agent_status(self, team_name: str) -> Optional[Dict[str, Any]]:
        """返回单个守护机器人（team）的状态。"""
        cfg = self.config
        agent_cfg = None
        for ac in cfg.agents:
            if ac.team_name == team_name:
                agent_cfg = ac
                break
        if not agent_cfg:
            return None

        platforms = {}
        for p in agent_cfg.platforms:
            adapter = self._adapters.get(p)
            platforms[p.value] = {
                'enabled': agent_cfg.platforms[p].enabled,
                'status': adapter.get_status().value if adapter else 'disconnected',
            }

        return {
            'team_name': team_name,
            'entry_agent': agent_cfg.entry_agent,
            'enabled': agent_cfg.enabled,
            'platforms': platforms,
            'cron_task_count': len(agent_cfg.cron_tasks),
            'heartbeat_interval': agent_cfg.heartbeat_interval,
        }

    def record_heartbeat(self, status: HeartbeatStatus) -> None:
        """记录心跳状态（由 HeartbeatMonitor 调用）。"""
        history = self._heartbeat_history.setdefault(status.platform, [])
        history.append(status)
        # 只保留最近 100 条
        if len(history) > 100:
            self._heartbeat_history[status.platform] = history[-100:]

    def get_heartbeat_history(
        self, platform: PlatformType, limit: int = 20
    ) -> List[Dict[str, Any]]:
        """获取心跳历史。"""
        history = self._heartbeat_history.get(platform, [])
        return [
            {
                'status': h.status.value,
                'timestamp': h.last_heartbeat,
                'latency_ms': h.latency_ms,
                'error': h.error,
                'reconnect_attempts': h.reconnect_attempts,
            }
            for h in history[-limit:]
        ]

    def update_config(self, new_config: DaemonSystemConfig) -> None:
        """热更新配置（不重启守护系统）。"""
        self._config = new_config

    # ── Cron 任务管理 ─────────────────────────────────

    def get_cron_tasks(self) -> List[CronTask]:
        """获取所有 Cron 任务。"""
        if self._scheduler:
            return self._scheduler.get_all_tasks()
        return []

    def add_cron_task(self, task: CronTask) -> None:
        """添加 Cron 任务。"""
        if self._scheduler:
            self._scheduler.add_task(task)

    def update_cron_task(self, task_id: str, updates: Dict[str, Any]) -> Optional[CronTask]:
        """更新 Cron 任务。"""
        if self._scheduler:
            return self._scheduler.update_task(task_id, updates)
        return None

    def delete_cron_task(self, task_id: str) -> bool:
        """删除 Cron 任务。"""
        if self._scheduler:
            return self._scheduler.delete_task(task_id)
        return False

    async def trigger_cron_task(self, task_id: str) -> Optional[str]:
        """手动触发 Cron 任务。"""
        if self._scheduler:
            task = self._scheduler.get_task(task_id)
            if task:
                return await self.execute_cron_task(task)
        return None
