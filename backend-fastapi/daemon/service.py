# -*- coding: utf-8 -*-
"""
守护 Agent 系统统一服务门面。

管理消息网关、定时调度和心跳监控的完整生命周期，
复用现有 AgentApiRuntimeService 执行守护任务。
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
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
from tools.contracts.permission_modes import PermissionMode, PermissionPolicy
from daemon.gateway.base import PlatformAdapter
from daemon.gateway.router import MessageRouter
from daemon.scheduler.engine import CronScheduler
from daemon.heartbeat import HeartbeatMonitor
from daemon.utils import json_safe, model_dump, model_validate

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
        self._session_lock: asyncio.Lock = asyncio.Lock()
        self._heartbeat_history: Dict[PlatformType, List[HeartbeatStatus]] = {}

    # ── 配置加载 ──────────────────────────────────────

    _DAEMON_CONFIG_PATH: Optional[Path] = None

    def _resolve_config_path(self) -> Path:
        """Resolve daemon config at call time so tests and RAG_DATA_ROOT overrides can redirect it."""
        if self._DAEMON_CONFIG_PATH is not None:
            return Path(self._DAEMON_CONFIG_PATH)
        from core.path_resolution import CONFIG_ROOT
        return CONFIG_ROOT / 'daemon' / 'daemon.yaml'

    def _validate_config(self, config: DaemonSystemConfig) -> DaemonSystemConfig:
        """重新校验配置，确保约束在运行时修改后仍生效。"""
        return model_validate(DaemonSystemConfig, model_dump(config))

    def load_config(self) -> DaemonSystemConfig:
        """从 CONFIG_ROOT/daemon/daemon.yaml 加载配置。"""
        config_path = self._resolve_config_path()
        if config_path.exists():
            with open(config_path, 'r', encoding='utf-8') as f:
                raw = yaml.safe_load(f) or {}
            self._config = model_validate(DaemonSystemConfig, raw)
        else:
            self._config = DaemonSystemConfig()
            logger.info('守护配置文件不存在，使用默认配置（disabled）')

        return self._config

    # 运行时字段，不应持久化到 YAML
    _RUNTIME_FIELDS = frozenset({'last_run', 'next_run', 'last_result'})

    def save_config(self, new_config: DaemonSystemConfig) -> None:
        """保存配置到 YAML 文件并热更新内存。运行时字段（last_run/next_run/last_result）不会被持久化。"""
        validated_config = self._validate_config(new_config)
        config_path = self._resolve_config_path()
        config_path.parent.mkdir(parents=True, exist_ok=True)

        raw = json_safe(model_dump(validated_config))
        # 剥离运行时字段，避免脏数据写入 YAML
        for agent in raw.get('agents', []):
            for task in agent.get('cron_tasks', []):
                for field in self._RUNTIME_FIELDS:
                    task.pop(field, None)

        with open(config_path, 'w', encoding='utf-8') as f:
            yaml.dump(raw, f, default_flow_style=False, allow_unicode=True)

        self._config = validated_config
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

    async def _reload_scheduler(self) -> None:
        """按当前配置重建 Cron 调度器。"""
        if self._scheduler:
            await self._scheduler.stop()
            self._scheduler = None

        if not self._running:
            return

        all_tasks = self.get_cron_tasks(enabled_only=True)
        if not all_tasks:
            return

        self._scheduler = CronScheduler(
            tasks=all_tasks,
            daemon_service=self,
        )
        await self._scheduler.start()
        logger.info('Cron 调度器已重载，共 %d 个任务', len(all_tasks))

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
                try:
                    adapter = self._create_adapter(platform, conn)
                except NotImplementedError as e:
                    logger.warning('跳过未实现的平台 [%s]: %s', platform.value, e)
                    continue
                if adapter:
                    # 当前配置约束为每个平台仅允许一个 enabled team 占用
                    self._adapters[platform] = adapter
                    try:
                        await adapter.connect()
                        logger.info('平台适配器已连接: %s', platform.value)
                    except Exception as e:
                        logger.error('平台适配器连接失败 [%s]: %s', platform.value, e)

        has_connected = any(
            a.status == AdapterStatus.CONNECTED
            for a in self._adapters.values()
        )
        if not self._adapters or not has_connected:
            logger.warning('所有平台适配器连接失败或无适配器，守护服务标记为未运行')
        self._running = bool(self._adapters and has_connected)

        # 3. 启动 Cron 调度器
        await self._reload_scheduler()

        # 4. 启动心跳监控
        if self._adapters:
            heartbeat_interval = 30
            for agent_cfg in cfg.agents:
                if agent_cfg.enabled and agent_cfg.heartbeat_interval:
                    heartbeat_interval = agent_cfg.heartbeat_interval
                    break
            self._heartbeat = HeartbeatMonitor(
                adapters=self._adapters,
                interval=heartbeat_interval,
                daemon_service=self,
                on_cycle=self._periodic_session_eviction,
            )
            await self._heartbeat.start()
            logger.info('心跳监控已启动，间隔 %ds', heartbeat_interval)

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
            if platform == PlatformType.FEISHU:
                from daemon.gateway.feishu import FeishuAdapter
                return FeishuAdapter(conn, incoming_handler=self.handle_incoming_message)
            else:
                raise NotImplementedError(
                    f'平台 {platform.value} 的适配器尚未实现。'
                    f'当前仅支持: feishu'
                )
        except NotImplementedError:
            raise
        except Exception as e:
            logger.error('创建适配器失败 [%s]: %s', platform.value, e)
            return None

    def get_adapter(self, platform: PlatformType) -> Optional[PlatformAdapter]:
        """获取指定平台适配器。"""
        return self._adapters.get(platform)

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
        status = adapter.status
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
        """执行定时任务，返回 Agent 响应内容。

        复用 AgentExecutionAdapter（与 Web 前端同一入口），
        Cron 场景挂载全量自动放行的审批处理器。
        """
        session_id: Optional[str] = None
        try:
            from runtime.container import get_current_runtime_container
            container = get_current_runtime_container()
            if not container:
                logger.error('RuntimeContainer 未初始化')
                return None

            runtime_svc = container.get_agent_api_runtime_service()

            session_id = await self._get_or_create_session(
                f"cron:{task.task_id}", task.team_name, task.entry_agent
            )

            # ── 注入统一权限策略（cron 复用系统 PermissionPolicy）──
            from tools.permission_manager import set_session_permission_override, clear_session_permission_override
            from agents.events.bus import EventType
            from daemon.approval_handler import DaemonApprovalHandler

            _agent_config = self._get_agent_config(task.team_name)
            _perm_policy = (_agent_config.permissions if _agent_config else None) or self._build_default_daemon_permission_policy()
            _perm_policy_copy = model_validate(PermissionPolicy, model_dump(_perm_policy))
            set_session_permission_override(session_id, _perm_policy_copy)

            # ── 通过 AgentExecutionAdapter 启动执行 ──
            from execution.adapters.agent_execution import AgentExecutionAdapter

            adapter = AgentExecutionAdapter(
                execution_service=container.get_execution_service(),
                agent_execution_service=runtime_svc.get_agent_execution_service(),
            )
            started = adapter.start_stream_execution(
                task=task.task,
                session_id=session_id,
                user_id=None,
                llm_override=None,
                request_id=None,
                conversation_store=runtime_svc.get_conversation_store(),
                orchestrator=runtime_svc.create_execution_orchestrator(session_id=session_id),
                history_loader=None,
                source='daemon.cron',
            )

            if not started.started:
                logger.error('Cron 任务启动失败 [%s]: %s', task.task_id, started.error_message)
                task.last_result = f'ERROR: {started.error_message}'
                clear_session_permission_override(session_id)
                return None

            session_manager = container.get_session_manager()
            event_bus = session_manager.get_or_create(started.run_id, session_id=session_id)

            cron_handler = DaemonApprovalHandler(
                daemon_service=self,
                session_id=session_id,
                platform=task.push_platform or PlatformType.FEISHU,
                chat_id=task.push_chat_id or f'cron:{task.task_id}',
                permission_config=_perm_policy,
                main_loop=asyncio.get_running_loop(),
            )
            _cron_sub_id = event_bus.subscribe(
                event_types=[EventType.USER_APPROVAL_REQUIRED],
                handler=cron_handler.on_approval_required,
            )

            # ── 消费事件流 ──
            from daemon.utils import wait_for_run_end

            try:
                response_content = await asyncio.to_thread(wait_for_run_end, event_bus, session_id)

                if response_content and task.push_platform and task.push_chat_id:
                    await self.send_message(OutgoingMessage(
                        platform=task.push_platform,
                        chat_id=task.push_chat_id,
                        content=response_content,
                    ))

                task.last_run = time.time()
                task.last_result = (response_content or '')[:200]
                return response_content

            finally:
                try:
                    event_bus.unsubscribe(_cron_sub_id)
                except Exception:
                    pass
                cron_handler.cleanup()
                clear_session_permission_override(session_id)
                try:
                    from agents.context.session_cache import flush_session
                    flush_session(session_id)
                except Exception:
                    pass
                try:
                    from agents.events.session_manager import cleanup_run
                    cleanup_run(started.run_id)
                except Exception:
                    pass

        except Exception as e:
            logger.error('Cron 任务执行失败 [%s]: %s', task.task_id, e)
            task.last_result = f'ERROR: {e}'
            # 确保异常路径也清理 session 级覆盖
            if session_id:
                try:
                    clear_session_permission_override(session_id)
                except Exception:
                    pass
            return None

    # ── Session 管理 ──────────────────────────────────

    @staticmethod
    def _derive_session_id(chat_id: str, team_name: str) -> str:
        """确定性 session ID：同一 chat_id + team_name 始终映射到同一 session，重启不丢失。"""
        key = f"daemon:{team_name}:{chat_id}"
        return f"daemon_{hashlib.sha256(key.encode()).hexdigest()[:16]}"

    async def _get_or_create_session(
        self,
        chat_id: str,
        team_name: str,
        entry_agent: Optional[str] = None,
        configured_session_id: Optional[str] = None,
    ) -> str:
        """获取或创建守护 session。

        优先使用 configured_session_id（显式配置），否则按 chat_id + team_name 确定性派生。
        """
        now = time.time()
        # 快速路径：持锁检查缓存，避免不必要的 I/O
        async with self._session_lock:
            self._evict_expired_sessions(now)
            if chat_id in self._daemon_sessions:
                self._session_timestamps[chat_id] = now
                return self._daemon_sessions[chat_id]
            session_id = configured_session_id or self._derive_session_id(chat_id, team_name)

        # 慢路径：锁外执行 I/O（create_session 是幂等的，重复调用无害）
        try:
            from runtime.container import get_current_runtime_container
            container = get_current_runtime_container()
            runtime_svc = container.get_agent_api_runtime_service()
            store = runtime_svc.get_conversation_store()

            metadata: Dict[str, Any] = {
                'source': 'daemon',
                'chat_id': chat_id,
                'team': team_name,
            }
            if entry_agent:
                metadata['entry_agent'] = entry_agent
            store.create_session(session_id=session_id, metadata=metadata)
        except Exception as e:
            logger.error('创建守护 session 失败: %s', e)

        # 写回缓存时再加锁
        async with self._session_lock:
            self._daemon_sessions[chat_id] = session_id
            self._session_timestamps[chat_id] = now
        return session_id

    def _evict_expired_sessions(self, now: float) -> None:
        """清理超过 TTL 的守护 session（懒惰清理）。调用方需持有 _session_lock。"""
        ttl = self.config.default_session_ttl
        expired = [
            chat_id for chat_id, ts in list(self._session_timestamps.items())
            if now - ts > ttl
        ]
        for chat_id in expired:
            self._daemon_sessions.pop(chat_id, None)
            self._session_timestamps.pop(chat_id, None)
        if expired:
            logger.debug('清理过期守护 session %d 个', len(expired))

    async def _periodic_session_eviction(self) -> None:
        """供 HeartbeatMonitor 周期触发的 session TTL 清理入口。"""
        async with self._session_lock:
            self._evict_expired_sessions(time.time())

    def _build_default_daemon_permission_policy(self) -> PermissionPolicy:
        """守护场景默认复用系统标准权限策略。"""
        return PermissionPolicy(mode=PermissionMode.STANDARD)

    def _find_agent_config_for_platform(self, platform: PlatformType) -> Optional[DaemonAgentConfig]:
        """查找指定平台对应的已启用 agent 配置。"""
        # 精确匹配：消息来源平台在 agent 的 platforms 中且已启用
        for agent_cfg in self.config.agents:
            if not agent_cfg.enabled:
                continue
            conn = agent_cfg.platforms.get(platform)
            if conn and conn.enabled:
                return agent_cfg
        # fallback：取第一个已启用的配置
        for agent_cfg in self.config.agents:
            if agent_cfg.enabled:
                return agent_cfg
        return None

    async def resolve_session_id_for_message(
        self, message: IncomingMessage,
    ) -> tuple:
        """为入站消息解析 session_id 和对应的 agent 配置。

        Session ID 优先级：platform.session_id > agent.session_id > auto_derive(team_name)

        Returns:
            (session_id, agent_config)
        """
        agent_config = self._find_agent_config_for_platform(message.platform)
        if not agent_config:
            raise ValueError(f'未找到平台 {message.platform.value} 对应的 agent 配置')

        # 解析 session_id 优先级
        conn = agent_config.platforms.get(message.platform)
        platform_session_id = getattr(conn, 'session_id', None) if conn else None
        agent_session_id = getattr(agent_config, 'session_id', None)
        configured_session_id = platform_session_id or agent_session_id

        session_id = await self._get_or_create_session(
            message.chat_id,
            agent_config.team_name,
            agent_config.entry_agent,
            configured_session_id=configured_session_id,
        )
        return session_id, agent_config

    # ── 状态查询 ──────────────────────────────────────

    def get_status(self) -> Dict[str, Any]:
        """返回守护系统整体状态。"""
        cfg = self.config
        adapter_statuses = {
            p.value: adapter.status.value
            for p, adapter in self._adapters.items()
        }
        cron_tasks = [
            {
                'task_id': t.task_id,
                'name': t.name,
                'cron': t.cron,
                'enabled': t.enabled,
                'last_run': t.last_run,
                'next_run': t.next_run,
            }
            for t in self.get_cron_tasks()
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
                'status': adapter.status.value if adapter else 'disconnected',
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
        """热更新配置并持久化到 YAML 文件。"""
        self.save_config(new_config)

    # ── Cron 任务管理 ─────────────────────────────────

    def _get_agent_config(self, team_name: str) -> Optional[DaemonAgentConfig]:
        for agent_cfg in self.config.agents:
            if agent_cfg.team_name == team_name:
                return agent_cfg
        return None

    def _get_cron_task(self, task_id: str) -> Optional[CronTask]:
        for agent_cfg in self.config.agents:
            for task in agent_cfg.cron_tasks:
                if task.task_id == task_id:
                    return task
        return None

    def get_cron_tasks(self, enabled_only: bool = False) -> List[CronTask]:
        """获取所有 Cron 任务。"""
        tasks: List[CronTask] = []
        for agent_cfg in self.config.agents:
            for task in agent_cfg.cron_tasks:
                if not enabled_only or task.enabled:
                    tasks.append(task)
        return tasks

    async def add_cron_task(self, task: CronTask) -> None:
        """添加 Cron 任务并持久化。"""
        if self._get_cron_task(task.task_id):
            raise ValueError(f'任务已存在: {task.task_id}')

        agent_cfg = self._get_agent_config(task.team_name)
        if not agent_cfg:
            raise ValueError(f'守护机器人不存在: {task.team_name}')

        agent_cfg.cron_tasks.append(task)
        self.save_config(self.config)
        await self._reload_scheduler()

    # update_cron_task 允许修改的字段白名单
    _UPDATABLE_CRON_FIELDS = frozenset({
        'name', 'cron', 'task', 'team_name', 'entry_agent',
        'push_platform', 'push_chat_id', 'enabled',
    })

    async def update_cron_task(self, task_id: str, updates: Dict[str, Any]) -> Optional[CronTask]:
        """更新 Cron 任务并持久化。"""
        task = self._get_cron_task(task_id)
        if not task:
            return None

        filtered = {k: v for k, v in updates.items() if k in self._UPDATABLE_CRON_FIELDS}
        old_team_name = task.team_name
        for key, val in filtered.items():
            setattr(task, key, val)

        if task.team_name != old_team_name:
            old_agent_cfg = self._get_agent_config(old_team_name)
            new_agent_cfg = self._get_agent_config(task.team_name)
            if not new_agent_cfg:
                raise ValueError(f'守护机器人不存在: {task.team_name}')
            if old_agent_cfg:
                old_agent_cfg.cron_tasks = [t for t in old_agent_cfg.cron_tasks if t.task_id != task_id]
            new_agent_cfg.cron_tasks.append(task)

        self.save_config(self.config)
        updated_task = self._get_cron_task(task_id)
        await self._reload_scheduler()
        return updated_task

    async def delete_cron_task(self, task_id: str) -> bool:
        """删除 Cron 任务并持久化。"""
        for agent_cfg in self.config.agents:
            before = len(agent_cfg.cron_tasks)
            agent_cfg.cron_tasks = [t for t in agent_cfg.cron_tasks if t.task_id != task_id]
            if len(agent_cfg.cron_tasks) < before:
                self.save_config(self.config)
                await self._reload_scheduler()
                return True
        return False

    async def trigger_cron_task(self, task_id: str) -> Optional[str]:
        """手动触发 Cron 任务。"""
        task = self._get_cron_task(task_id)
        if not task:
            return None
        return await self.execute_cron_task(task)

    def get_cron_history(self, task_id: str, limit: int = 20) -> List[Dict[str, Any]]:
        """获取 Cron 任务执行历史。"""
        if self._scheduler:
            return self._scheduler.get_history(task_id, limit=limit)
        return []
