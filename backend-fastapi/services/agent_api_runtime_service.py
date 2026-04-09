# -*- coding: utf-8 -*-
"""
Agent API 运行时支持服务。

合并了原 AgentRuntimeService（orchestrator 初始化/热重载）和
AgentChatApplication（会话历史、配置访问）的职责。
"""

from __future__ import annotations

import copy
import logging
from pathlib import Path
from typing import Optional, List, Dict

from runtime.dependencies import get_runtime_dependency
from core.path_resolution import get_session_workspace_root, get_workspace_memory_key
from agents import AgentContext
from agents.events import get_session_manager
from agents.task_registry import get_task_registry
from services.conversation_store import ConversationStore
from services.memory_store import MemoryStore
from agents.config import get_config_manager

logger = logging.getLogger(__name__)


class AgentApiRuntimeService:
    """为 Agent API 路由提供会话存储与 orchestrator 访问。"""

    def __init__(
        self,
        conversation_store: Optional[ConversationStore] = None,
        task_registry_getter=None,
        session_manager_getter=None,
        session_application=None,
        collaboration_application=None,
        config_getter=None,
        config_manager_getter=None,
        default_adapter_getter=None,
    ):
        self._conversation_store = conversation_store or ConversationStore()
        self._memory_store = MemoryStore()
        self._task_registry_getter = task_registry_getter or get_task_registry
        self._session_manager_getter = session_manager_getter or get_session_manager
        self._metrics_collector = None
        self._team_orchestrators: Dict[str, object] = {}  # team_name -> orchestrator 缓存（"_default_" 表示 active team）

        from config import get_config
        from model_adapter import get_default_adapter
        from agents import get_config_manager as get_agent_config_manager

        self._config_getter = config_getter or get_config
        self._config_manager_getter = config_manager_getter or get_agent_config_manager
        self._default_adapter_getter = default_adapter_getter or get_default_adapter

        # 延迟构建 session / collaboration application
        from application.agent_session import AgentSessionApplication
        self._session_application = session_application or AgentSessionApplication(
            conversation_store=self._conversation_store,
        )
        if collaboration_application is not None:
            self._collaboration_application = collaboration_application
        else:
            from application.agent_collaboration import AgentCollaborationApplication
            self._collaboration_application = AgentCollaborationApplication(
                runtime_service=self,
                session_application=self._session_application,
            )

    # ── conversation store ──────────────────────────────

    def get_conversation_store(self) -> ConversationStore:
        return self._conversation_store

    def _get_session_workspace_root(self, session_id: str | None) -> Optional[str]:
        normalized_session_id = (session_id or '').strip()
        if not normalized_session_id:
            logger.debug('session workspace_root 查询跳过：session_id 为空')
            return None
        session = self._conversation_store.get_session(normalized_session_id) or {}
        metadata = session.get('metadata') or {}
        workspace_root = metadata.get('workspace_root')
        resolved_workspace_root = workspace_root.strip() if isinstance(workspace_root, str) and workspace_root.strip() else str(get_session_workspace_root(normalized_session_id))
        logger.debug(
            'session workspace_root 查询: session_id=%s workspace_root=%s metadata_keys=%s',
            normalized_session_id,
            resolved_workspace_root,
            sorted(metadata.keys()),
        )
        return resolved_workspace_root

    def _normalize_session_entry_agent(self, entry_agent: str | None, orchestrator=None) -> Optional[str]:
        normalized_entry_agent = entry_agent.strip() if isinstance(entry_agent, str) and entry_agent.strip() else None
        if normalized_entry_agent is None:
            return None

        lowered = normalized_entry_agent.lower()
        if lowered == 'default':
            return None
        if lowered == 'orchestrator':
            normalized_entry_agent = 'orchestrator_agent'

        registry = getattr(orchestrator, 'registry', None) if orchestrator is not None else None
        if registry is not None and registry.get(normalized_entry_agent) is None:
            logger.warning('忽略无效 session entry_agent: raw=%s normalized=%s', entry_agent, normalized_entry_agent)
            return None
        return normalized_entry_agent

    def _get_session_entry_agent(self, session_id: str | None, orchestrator=None) -> Optional[str]:
        normalized_session_id = (session_id or '').strip()
        if not normalized_session_id:
            logger.debug('session entry_agent 查询跳过：session_id 为空')
            return None
        session = self._conversation_store.get_session(normalized_session_id) or {}
        metadata = session.get('metadata') or {}
        entry_agent = metadata.get('entry_agent')
        resolved_entry_agent = self._normalize_session_entry_agent(entry_agent, orchestrator)
        logger.debug(
            'session entry_agent 查询: session_id=%s raw_entry_agent=%s resolved_entry_agent=%s metadata_keys=%s',
            normalized_session_id,
            entry_agent,
            resolved_entry_agent,
            sorted(metadata.keys()),
        )
        return resolved_entry_agent

    def _get_session_team(self, session_id: str | None) -> Optional[str]:
        normalized_session_id = (session_id or '').strip()
        if not normalized_session_id:
            logger.debug('session team 查询跳过：session_id 为空')
            return None
        session = self._conversation_store.get_session(normalized_session_id) or {}
        metadata = session.get('metadata') or {}
        team = metadata.get('team')
        resolved_team = team.strip() if isinstance(team, str) and team.strip() else None
        logger.debug(
            'session team 查询: session_id=%s team=%s metadata_keys=%s',
            normalized_session_id,
            resolved_team,
            sorted(metadata.keys()),
        )
        return resolved_team

    def _resolve_session_configs(self, session_id: str | None):
        config_manager = self._config_manager_getter() or get_config_manager()
        session_team = self._get_session_team(session_id)
        if not session_team:
            return None
        try:
            configs = config_manager.get_team_configs(session_team)
            logger.debug(
                'execution orchestrator 使用 session team 配置: session_id=%s team=%s agents=%s',
                session_id,
                session_team,
                sorted(configs.keys()),
            )
            return configs
        except Exception:
            logger.warning(
                'session team 不存在或加载失败，回退 active_team: session_id=%s team=%s',
                session_id,
                session_team,
                exc_info=True,
            )
            return None

    def _resolve_agent_config_for_session(self, session_id: str | None, agent_name: str | None):
        if not agent_name:
            return None
        config_manager = self._config_manager_getter() or get_config_manager()
        session_configs = self._resolve_session_configs(session_id)
        if session_configs is not None:
            return session_configs.get(agent_name)
        return config_manager.get_config(agent_name)

    def _apply_session_runtime_overrides(self, orchestrator, session_id: str | None):
        workspace_root = self._get_session_workspace_root(session_id)
        if workspace_root:
            injected_agents = []
            for agent in getattr(orchestrator, 'agents', {}).values():
                agent_config = getattr(agent, 'agent_config', None)
                if agent_config is None:
                    continue
                copied_config = copy.deepcopy(agent_config)
                custom_params = getattr(copied_config, 'custom_params', None)
                copied_params = dict(custom_params) if isinstance(custom_params, dict) else {}
                copied_params['workspace_root'] = workspace_root
                copied_config.custom_params = copied_params
                agent.agent_config = copied_config
                injected_agents.append(getattr(agent, 'name', '<unknown>'))
            logger.debug(
                'execution orchestrator 注入 workspace_root: session_id=%s workspace_root=%s agents=%s',
                session_id,
                workspace_root,
                injected_agents,
            )
        else:
            logger.debug('execution orchestrator 未注入 workspace_root: session_id=%s', session_id)

        entry_agent = self._get_session_entry_agent(session_id, orchestrator)
        if entry_agent:
            orchestrator.set_default_entry_agent(entry_agent)
            logger.debug(
                'execution orchestrator 覆盖默认入口: session_id=%s entry_agent=%s',
                session_id,
                entry_agent,
            )
        else:
            logger.debug('execution orchestrator 未覆盖默认入口: session_id=%s', session_id)
        return orchestrator

    def _get_memory_workspace_key(self, session_id: str | None) -> Optional[str]:
        workspace_root = self._get_session_workspace_root(session_id)
        return get_workspace_memory_key(workspace_root)

    def _build_memory_scope_specs(self, *, memory_config, session_id: str, agent_name: Optional[str]):
        allowed_scopes = set(getattr(memory_config, 'allowed_scopes', []) or ['team', 'session'])
        workspace_key = self._get_memory_workspace_key(session_id)
        team_name = self._get_session_team(session_id)
        scope_specs = []
        if 'team' in allowed_scopes and team_name:
            scope_specs.append(('team', {'scope': 'team', 'team_name': team_name}))
        if 'session' in allowed_scopes:
            scope_specs.append(('session', {'scope': 'session', 'session_id': session_id}))
        if 'agent' in allowed_scopes and agent_name and team_name:
            scope_specs.append(('agent', {'scope': 'agent', 'agent_name': agent_name, 'team_name': team_name}))
        if 'workspace' in allowed_scopes and workspace_key:
            scope_specs.append(('workspace', {'scope': 'workspace', 'workspace_key': workspace_key}))
        return scope_specs


    def load_history_into_context(
        self,
        context: AgentContext,
        session_id: str,
        limit: int = 200,
        thread_key: Optional[str] = None,
    ) -> None:
        try:
            raw_messages = self._conversation_store.get_recent_messages(
                session_id=session_id,
                limit=limit,
                thread_key=thread_key,
            )
        except Exception as e:
            logger.warning('加载历史失败，使用空历史: %s', e)
            return
        for item in raw_messages:
            if item.get('role') not in {'user', 'assistant', 'system'}:
                continue
            meta = item.get('metadata') or {}
            context.add_message(
                role=item['role'],
                content=item['content'],
                metadata=dict(meta),
                seq=item.get('seq'),
            )

    def build_context(
        self,
        *,
        session_id: str,
        user_id: Optional[str] = None,
        limit: int = 200,
        run_id: Optional[str] = None,
        request_id: Optional[str] = None,
        llm_override: Optional[dict] = None,
        llm_tier: Optional[str] = None,
        thread_key: str = 'root',
        parent_run_id: Optional[str] = None,
        parent_call_id: Optional[str] = None,
        call_id: Optional[str] = None,
        memory_query: Optional[str] = None,
        agent_name: Optional[str] = None,
        current_user_input: Optional[str] = None,
        current_attachments: Optional[List[dict]] = None,
    ) -> AgentContext:
        resolved_thread_key = (thread_key or 'root').strip() or 'root'
        normalized_llm_tier = (llm_tier or '').strip().lower() or None
        context = AgentContext(
            session_id=session_id,
            user_id=user_id,
            llm_override=llm_override,
            requested_llm_tier=normalized_llm_tier,
        )
        context.metadata['thread_key'] = resolved_thread_key
        context.metadata['conversation_scope'] = 'root' if resolved_thread_key == 'root' else 'child'
        session_workspace_root = self._get_session_workspace_root(session_id)
        if session_workspace_root:
            context.metadata['workspace_root'] = session_workspace_root
        session_entry_agent = self._get_session_entry_agent(session_id)
        if session_entry_agent:
            context.metadata['entry_agent'] = session_entry_agent
        session_team = self._get_session_team(session_id)
        if session_team:
            context.metadata['team'] = session_team
        if run_id:
            context.metadata['run_id'] = run_id
            context.metadata['event_bus'] = self.get_run_event_bus(run_id, session_id=session_id)
        if request_id:
            context.metadata['request_id'] = request_id
        if normalized_llm_tier:
            context.metadata['requested_llm_tier'] = normalized_llm_tier
        if parent_run_id:
            context.metadata['parent_run_id'] = parent_run_id
        if parent_call_id:
            context.metadata['parent_call_id'] = parent_call_id
        if call_id:
            context.metadata['call_id'] = call_id
        if agent_name:
            context.metadata['agent_name'] = agent_name
        if current_user_input is not None:
            context.metadata['current_user_input'] = current_user_input
        if current_attachments:
            context.metadata['current_attachments'] = list(current_attachments)
        memory_config = None
        if agent_name:
            agent_config = self._resolve_agent_config_for_session(session_id, agent_name)
            memory_config = getattr(agent_config, 'memory', None) if agent_config else None
        if memory_config:
            allowed_scopes = list(getattr(memory_config, 'allowed_scopes', []) or [])
            write_scopes = list(getattr(memory_config, 'write_scopes', []) or [])
            archive_scopes = list(getattr(memory_config, 'archive_scopes', []) or [])
            context.metadata['memory_scope_capabilities'] = {
                'allowed_scopes': allowed_scopes,
                'write_scopes': write_scopes,
                'archive_scopes': archive_scopes,
            }
        self.load_history_into_context(
            context,
            session_id=session_id,
            limit=limit,
            thread_key=resolved_thread_key,
        )
        memory_enabled = bool(memory_config and (
            (getattr(memory_config, 'allowed_scopes', []) or [])
            or (getattr(memory_config, 'write_scopes', []) or [])
            or (getattr(memory_config, 'archive_scopes', []) or [])
        ))
        if memory_enabled and getattr(memory_config, 'auto_inject', True):
            scope_specs = self._build_memory_scope_specs(
                memory_config=memory_config,
                session_id=session_id,
                agent_name=agent_name,
            )
            memory_indices = {}
            for scope_name, scope_spec in scope_specs:
                content = self._memory_store.load_index_head(**scope_spec)
                if content:
                    memory_indices[scope_name] = content
            if memory_indices:
                context.metadata['memory_indices'] = memory_indices
            if memory_query is not None and scope_specs:
                retrieved = self._memory_store.search_memories(
                    scope_chain=[scope_spec for _, scope_spec in scope_specs],
                    query=memory_query,
                    limit=5,
                )
                context.metadata['retrieved_memories'] = [
                    {
                        'name': item.name,
                        'description': item.description,
                        'scope': item.scope,
                        'memory_type': item.memory_type,
                        'file_name': item.file_name,
                        'file_path': item.file_path,
                    }
                    for item in retrieved
                ]
        return context

    # ── orchestrator（原 AgentRuntimeService） ───────────

    def get_orchestrator(self):
        return self._build_orchestrator(scope='catalog')

    def create_execution_orchestrator(self, *, session_id: Optional[str] = None):
        """为单次执行获取 orchestrator。按 team 缓存，session 级 override 通过浅拷贝隔离。"""
        session_team = self._get_session_team(session_id)
        cache_key = (session_team or '').strip() or '_default_'

        if cache_key not in self._team_orchestrators:
            session_configs = self._resolve_session_configs(session_id)
            orchestrator = self._build_orchestrator(scope='execution', configs=session_configs)
            self._team_orchestrators[cache_key] = orchestrator
            logger.debug('构建并缓存 execution orchestrator: team=%s', cache_key)

        base_orchestrator = self._team_orchestrators[cache_key]
        # 每次请求独立 copy，避免 _apply_session_runtime_overrides 原地修改污染缓存
        orchestrator = copy.copy(base_orchestrator)
        return self._apply_session_runtime_overrides(orchestrator, session_id)

    def get_metrics_collector(self):
        if self._metrics_collector is None:
            from agents.monitoring import MetricsCollector
            self._metrics_collector = MetricsCollector()
        return self._metrics_collector

    def _build_orchestrator(self, *, scope: str, configs: Optional[Dict[str, object]] = None, force_reload: bool = False):
        from agents.config.loader import AgentLoader
        from agents.core.orchestrator import AgentOrchestrator
        from agents.core.registry import AgentRegistry
        from mcp import get_mcp_manager

        try:
            system_config = self._config_getter()
            adapter = self._default_adapter_getter()

            orchestrator = AgentOrchestrator(
                model_adapter=adapter,
                registry=AgentRegistry(),
            )

            loader = AgentLoader(
                model_adapter=adapter,
                system_config=system_config,
                orchestrator=orchestrator,
                config_manager=self._config_manager_getter() or get_config_manager(),
                mcp_manager_getter=get_mcp_manager,
            )
            if force_reload:
                loader.invalidate_caches()
            agents = loader.load_all_agents(configs=configs)
            orchestrator.set_default_entry_agent(loader.resolve_default_entry_agent_name(configs=configs))

            for agent_name, agent in agents.items():
                orchestrator.register_agent(agent)
                logger.info('已注册智能体: %s', agent_name)

            try:
                metrics_collector = self.get_metrics_collector()
                session_manager = self._session_manager_getter()

                orchestrator._metrics_collector = metrics_collector
                orchestrator._session_manager = session_manager

                logger.info('✓ 性能指标收集器已初始化')
            except Exception as error:
                logger.warning('性能指标收集器初始化失败（不影响核心功能）: %s', error)

            registered_agents = orchestrator.list_agents()
            log_fn = logger.info if scope == 'catalog' else logger.debug
            log_fn(
                'Orchestrator 实例构建成功 scope=%s loaded=%s registered=%s',
                scope,
                len(agents),
                len(registered_agents),
            )
            if scope == 'catalog':
                logger.info('已加载的智能体列表: %s', list(agents.keys()))
                logger.info('已注册的智能体列表: %s', [a['name'] for a in registered_agents])
            return orchestrator
        except Exception as error:
            logger.error('Orchestrator 初始化失败: %s', error, exc_info=True)
            raise

    def reload_agents(self) -> bool:
        try:
            self._team_orchestrators.clear()
            self._build_orchestrator(scope='catalog', force_reload=True)
            logger.info('智能体重新加载完成')
            return True
        except Exception as error:
            logger.error('重新加载智能体失败: %s', error, exc_info=True)
            return False

    # ── 配置访问 ────────────────────────────────────────

    def get_system_config(self):
        return self._config_getter()

    def get_config_manager(self):
        return self._config_manager_getter()

    def get_default_adapter(self):
        return self._default_adapter_getter()

    def get_agent_execution_service(self):
        from services.agent_execution_service import AgentExecutionService
        return AgentExecutionService(runtime_service=self)

    # ── 任务 / 会话管理 ────────────────────────────────

    def get_task_registry(self):
        return self._task_registry_getter()

    def get_session_manager(self):
        return self._session_manager_getter()

    def get_run_event_bus(self, run_id: str, *, session_id: Optional[str] = None):
        return self.get_session_manager().get_or_create(run_id, session_id=session_id)

    def get_session_event_bus(self, session_id: str):
        return self.get_session_manager().get_by_session(session_id)

    def get_session_application(self):
        return self._session_application

    def get_collaboration_application(self):
        return self._collaboration_application


def get_agent_api_runtime_service() -> AgentApiRuntimeService:
    return get_runtime_dependency(container_getter='get_agent_api_runtime_service')
