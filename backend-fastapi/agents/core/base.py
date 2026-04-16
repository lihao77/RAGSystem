# -*- coding: utf-8 -*-
"""
智能体基类 - 所有智能体的抽象基类
"""

from abc import ABC, abstractmethod
from typing import Callable, ClassVar, Dict, List, Any, Optional, Tuple
import concurrent.futures
import json
import logging
import re
import threading
import time
import uuid
from dataclasses import dataclass, field

from .models import AgentResponse
from .context import AgentContext
from . import prompting as core_prompting


class InterruptedError(Exception):
    """Agent 执行被用户中断"""
    pass


@dataclass
class WaitingRequest:
    """工具返回后标记需要进入 waiting loop。"""
    background_task_ids: List[str] = field(default_factory=list)
    run_id: Optional[str] = None
    timeout_ms: Optional[int] = None
    pending_tool_calls: List[Dict[str, Any]] = field(default_factory=list)


def parse_llm_json(content: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """
    从 LLM 返回文本中解析 JSON，支持多种常见变形。
    Returns:
        (parsed_dict, None) 成功；(None, error_message) 失败。
    """
    if not content or not isinstance(content, str):
        return None, "空或非字符串响应"
    raw = content.strip()
    if not raw:
        return None, "空响应"
    raw = raw.lstrip("\ufeff")  # BOM
    last_error: Optional[str] = None
    stripped = ""

    def try_parse(s: str, strict: bool = True) -> Optional[Dict[str, Any]]:
        nonlocal last_error
        try:
            return json.loads(s, strict=strict)
        except json.JSONDecodeError as e:
            last_error = str(e)
            return None

    out = try_parse(raw)
    if out is not None:
        return out, None

    if raw.startswith("```"):
        lines = raw.split("\n")
        if lines[0].strip().startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        stripped = "\n".join(lines).strip()
        if stripped:
            out = try_parse(stripped)
            if out is not None:
                return out, None
            out = try_parse(stripped, strict=False)
            if out is not None:
                return out, None

    first = raw.find("{")
    last = raw.rfind("}")
    if first != -1 and last != -1 and last > first:
        segment = raw[first : last + 1]
        out = try_parse(segment)
        if out is not None:
            return out, None
        out = try_parse(segment, strict=False)
        if out is not None:
            return out, None

    out = try_parse(raw, strict=False)
    if out is not None:
        return out, None

    if raw.startswith("```") and stripped:
        out = try_parse(stripped, strict=False)
        if out is not None:
            return out, None

    return None, last_error or "JSON 解析失败"


class BaseAgent(ABC):
    """
    智能体基类 - 所有智能体必须继承此类并实现 execute 方法
    """

    # 系统提示词缓存已迁移到 context.metadata（跟随 session），
    # 由 ContextPipeline._prepare_messages_full 统一管理。

    def __init__(
        self,
        name: str,
        description: str,
        capabilities: Optional[List[str]] = None,
        model_adapter = None,
        agent_config = None,
        system_config = None
    ):
        self.name = name
        self.description = description
        self.capabilities = capabilities or []
        self.model_adapter = model_adapter
        self.llm_adapter = model_adapter
        self.logger = logging.getLogger(f"Agent.{name}")
        self.agent_config = agent_config
        self.system_config = system_config
        self.tools: List[Dict[str, Any]] = []
        self.available_tools: List[Dict[str, Any]] = []
        self.available_skills: List[Any] = []
        self.context_pipeline = None
        self.result_normalizer = None
        self.observation_policy = None
        self.prompt_materializer = None
        self.max_rounds: Optional[int] = None
        self.base_prompt = ""
        self.display_name = name

    @abstractmethod
    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        """执行任务（子类必须实现）"""
        pass

    def execute_stream(self, task: str, context: AgentContext) -> AgentResponse:
        """向后兼容的流式入口；默认复用 execute。"""
        return self.execute(task, context)

    def stream_execute(self, task: str, context: AgentContext) -> AgentResponse:
        """向后兼容别名。"""
        return self.execute(task, context)

    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        """判断是否能处理该任务（子类可以重写）"""
        return True

    def before_execute(self, task: str, context: AgentContext):
        """执行前钩子"""
        self.logger.debug(f"[{self.name}] 开始执行任务: {task}")

    def after_execute(self, task: str, context: AgentContext, result: AgentResponse):
        """执行后钩子"""
        self.logger.info(
            f"[{self.name}] 任务完成: success={result.success}, "
            f"time={result.execution_time:.2f}s"
        )

    def get_info(self) -> Dict[str, Any]:
        """获取智能体信息"""
        info = {
            'name': self.name,
            'description': self.description,
            'capabilities': self.capabilities,
            'tools': [tool.get('function', {}).get('name') for tool in (self.available_tools or self.tools)]
        }
        if self.agent_config:
            info['config'] = {
                'enabled': self.agent_config.enabled,
                'llm_tiers': {
                    k: v.to_dict() for k, v in (self.agent_config.llm_tiers or {}).items()
                } if self.agent_config.llm_tiers else None,
                'custom_params': self.agent_config.custom_params
            }
        return info

    def _format_skills_description(self) -> str:
        """
        格式化 Skills 说明（仅列出 name 和 description）。

        具体使用流程由各 Skill 的主文件（SKILL.md）定义。
        """
        available_skills = getattr(self, 'available_skills', [])
        if not available_skills:
            return "当前无可用的领域知识。"

        lines = ["可用 Skills：", ""]
        for idx, skill in enumerate(available_skills, 1):
            lines.append(f"### Skill {idx}: {skill.name}")
            lines.append(f"**适用场景**: {skill.description}")
            lines.append("")
        return "\n".join(lines)

    def _build_agent_specific_prompt_sections(self) -> List[str]:
        return []

    @staticmethod
    def _is_image_attachment(attachment: Dict[str, Any]) -> bool:
        mime = str((attachment or {}).get('mime') or '')
        kind = str((attachment or {}).get('kind') or '')
        return mime.startswith('image/') or kind == 'image'

    @classmethod
    def _split_current_attachments(cls, attachments: List[Dict[str, Any]]) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        image_attachments: List[Dict[str, Any]] = []
        file_references: List[Dict[str, Any]] = []
        for attachment in attachments or []:
            if cls._is_image_attachment(attachment):
                image_attachments.append(dict(attachment))
            else:
                file_references.append(dict(attachment))
        return image_attachments, file_references

    @staticmethod
    def _build_file_references_context_suffix(file_references: List[Dict[str, Any]]) -> str:
        if not file_references:
            return ''
        lines = [
            '[普通文件附件引用]',
        ]
        for item in file_references:
            lines.append(
                '- '
                f"file_id={item.get('file_id') or ''} | "
                f"name={item.get('original_name') or item.get('stored_name') or 'attachment'} | "
                f"mime={item.get('mime') or 'unknown'} | "
                f"size={item.get('size') or 'unknown'} | "
                f"file_path={item.get('stored_path') or ''}"
            )
        return '\n'.join(lines)

    def _build_system_prompt(self) -> str:
        """构建完整系统提示词（静态段 + 动态段）。

        缓存由 ContextPipeline 在 metadata 中统一管理，
        此方法仅负责构建，不再做进程级缓存。
        """
        if not isinstance(self, BaseAgent):
            return core_prompting.build_shared_system_prompt(self)

        static_part = core_prompting.build_static_system_prompt(self)
        dynamic_part = core_prompting.build_dynamic_system_prompt(self)
        parts = [p for p in [static_part, dynamic_part] if p.strip()]
        return "\n\n".join(parts)

    def _log_prefix(self, llm_config: Optional[Dict[str, Any]] = None, display_name: Optional[str] = None) -> str:
        """返回带模型名的日志前缀"""
        name = display_name if display_name is not None else self.name
        if llm_config and (llm_config.get('model_name') or llm_config.get('provider')):
            extra = llm_config.get('model_name') or llm_config.get('provider')
            return f"[{name} {extra}]"
        return f"[{name}]"

    def get_llm_config(self, context: Optional[AgentContext] = None, task_type: Optional[str] = None) -> Dict[str, Any]:
        """
        获取 LLM 配置（优先智能体配置，支持请求级覆盖，支持从 ModelAdapter 继承）

        Args:
            context: 智能体上下文（可选）
            task_type: 任务类型（可选），支持 'fast'/'default'/'powerful'，用于多层级模型路由

        Returns:
            LLM 配置字典
        """
        requested_tier = getattr(context, 'requested_llm_tier', None) if context else None
        effective_tier = (task_type or requested_tier or 'default' or '').strip().lower() or 'default'
        def _merge_agent_llm(llm_config_obj):
            if not llm_config_obj:
                return {}
            return llm_config_obj.merge_with_default(
                self.system_config,
                model_adapter=self.model_adapter,
            )

        config = {}
        llm_tiers = getattr(self.agent_config, 'llm_tiers', None) if self.agent_config else None
        if llm_tiers:
            tier_config = llm_tiers.get(effective_tier)
            if tier_config:
                config = _merge_agent_llm(tier_config)
                if self.logger:
                    self.logger.debug("[%s] 使用 %s 层级模型: %s", self.name, effective_tier, config.get('model_name', 'default'))
            elif effective_tier != 'default':
                default_tier_config = llm_tiers.get('default')
                if default_tier_config:
                    config = _merge_agent_llm(default_tier_config)
                    if self.logger:
                        self.logger.debug("[%s] %s 层级未配置，回退到 default 层级", self.name, effective_tier)

        if not config and self.system_config:
            llm_config = getattr(self.system_config, 'llm', None)
            if llm_config:
                config = {
                    'provider': getattr(llm_config, 'provider', None),
                    'provider_type': getattr(llm_config, 'provider_type', None),
                    'model_name': getattr(llm_config, 'model_name', None),
                    'temperature': getattr(llm_config, 'temperature', 0.7),
                    'max_completion_tokens': getattr(llm_config, 'max_completion_tokens', 4096),
                    'max_context_tokens': getattr(llm_config, 'max_context_tokens', None),
                }
                for key, value in (getattr(llm_config, 'extra_params', None) or {}).items():
                    if key not in config:
                        config[key] = value
        if not config:
            self.logger.warning(f"[{self.name}] 未配置 LLM，使用默认配置")
            config = {
                'temperature': 0.7,
                'max_completion_tokens': 4096,
            }

        override = getattr(context, 'llm_override', None) if context else None
        if override:
            for key in ('provider', 'provider_type', 'model_name'):
                if override.get(key):
                    config[key] = override[key]
        return config

    def get_custom_param(self, key: str, default: Any = None) -> Any:
        """获取自定义参数"""
        if self.agent_config and self.agent_config.custom_params:
            return self.agent_config.custom_params.get(key, default)
        return default

    def is_tool_enabled(self, tool_name: str) -> bool:
        """检查工具是否启用"""
        if self.agent_config and self.agent_config.tools:
            enabled_tools = self.agent_config.tools.enabled_tools
            return not enabled_tools or tool_name in enabled_tools
        return True

    def _setup_react_runtime(
        self,
        *,
        available_tools: Optional[List[Dict[str, Any]]] = None,
        available_skills: Optional[List[Any]] = None,
        event_bus = None,
        builtin_tool_getter: Optional[Callable[[List[Dict[str, Any]]], List[Dict[str, Any]]]] = None,
        budget_profile_name: str = "worker",
        fallback_multiplier: Optional[float] = None,
        runtime_label: Optional[str] = None,
    ) -> None:
        """初始化 ReAct 运行时的公共组件。"""
        from agents.context.budget import (
            DEFAULT_MAX_COMPLETION_TOKENS,
            compute_context_budget,
            get_context_budget_profile,
        )
        from agents.artifacts import ArtifactStore
        from agents.context.config import ContextConfig
        from agents.context.observation_policy import ObservationPolicy
        from agents.context.pipeline import ContextPipeline
        from agents.context.prompt_materializer import PromptMaterializer
        from agents.monitoring.observation_window import ObservationWindowCollector
        from tools.runtime.result_normalizer import ToolResultNormalizer

        base_tools = list(available_tools or [])

        self.available_tools = base_tools
        self.available_skills = list(available_skills or [])

        behavior_config = self.agent_config.custom_params.get('behavior', {}) if self.agent_config else {}
        self.max_rounds = behavior_config.get('rounds')
        self.base_prompt = behavior_config.get('system_prompt', '')
        budget_profile = get_context_budget_profile(
            behavior_config.get('budget_profile') or budget_profile_name
        )

        llm_config = self.get_llm_config()
        model_max_completion_tokens = (
            llm_config.get('max_completion_tokens')
            or llm_config.get('max_tokens', DEFAULT_MAX_COMPLETION_TOKENS)
        )
        model_context_window = llm_config.get('max_context_tokens')

        max_context_tokens = compute_context_budget(
            model_context_window=model_context_window,
            max_completion_tokens=model_max_completion_tokens,
            explicit_budget=behavior_config.get('max_context_tokens'),
            fallback_multiplier=behavior_config.get(
                'fallback_multiplier',
                fallback_multiplier if fallback_multiplier is not None else budget_profile.fallback_multiplier,
            ),
        )

        # waiting/keepalive: 从系统配置读取默认值，允许 agent behavior 覆盖
        from config.models import WaitingConfig as _WaitingConfigModel
        try:
            from config.base import ConfigManager
            _sys_waiting = ConfigManager().get_config().waiting
        except Exception:
            _sys_waiting = _WaitingConfigModel()

        context_config = ContextConfig(
            max_tokens=max_context_tokens,
            budget_profile=budget_profile.name,
            model_name=llm_config.get('model_name'),
            compression_trigger_ratio=behavior_config.get(
                'compression_trigger_ratio',
                budget_profile.compression_trigger_ratio,
            ),
            summarize_max_tokens=behavior_config.get(
                'summarize_max_tokens',
                budget_profile.summarize_max_tokens,
            ),
            preserve_recent_turns=behavior_config.get(
                'preserve_recent_turns',
                budget_profile.preserve_recent_turns,
            ),
            local_cache_ttl_seconds=behavior_config.get(
                'waiting_local_cache_ttl_seconds',
                _sys_waiting.local_cache_ttl_seconds,
            ),
            waiting_enabled=behavior_config.get(
                'waiting_enabled',
                _sys_waiting.enabled,
            ),
            waiting_poll_interval_seconds=behavior_config.get(
                'waiting_poll_interval_seconds',
                _sys_waiting.default_poll_interval_seconds,
            ),
            waiting_idle_timeout_seconds=behavior_config.get(
                'waiting_idle_timeout_seconds',
                _sys_waiting.idle_wait_timeout_seconds,
            ),
            allow_provider_keepalive=behavior_config.get(
                'allow_provider_keepalive',
                _sys_waiting.allow_provider_keepalive,
            ),
            keepalive_interval_seconds=behavior_config.get(
                'waiting_keepalive_interval_seconds',
                _sys_waiting.keepalive_interval_seconds,
            ),
            keepalive_grace_seconds=behavior_config.get(
                'waiting_keepalive_grace_seconds',
                _sys_waiting.keepalive_grace_seconds,
            ),
            max_hidden_keepalive_rounds=behavior_config.get(
                'waiting_max_keepalive_rounds',
                _sys_waiting.max_keepalive_rounds,
            ),
            hidden_keepalive_token_budget=behavior_config.get(
                'hidden_keepalive_token_budget',
                _sys_waiting.hidden_keepalive_token_budget,
            ),
        )
        observation_window = ObservationWindowCollector()
        self.context_pipeline = ContextPipeline(
            config=context_config,
            model_adapter=self.model_adapter,
            get_llm_config_fn=lambda task_type=None: self.get_llm_config(task_type=task_type),
            logger=self.logger,
            observation_window=observation_window,
            agent_name=self.name,
        )
        data_save_dir = behavior_config.get('data_save_dir') or None
        artifact_store = ArtifactStore(
            base_dir=data_save_dir,
            observation_window=observation_window,
        )
        self.result_normalizer = ToolResultNormalizer(
            observation_window=observation_window,
        )
        self.observation_policy = ObservationPolicy(
            max_context_tokens=context_config.max_tokens,
            budget_profile=budget_profile.name,
            inline_text_limit=behavior_config.get('observation_inline_text_limit'),
            inline_json_limit=behavior_config.get('observation_inline_json_limit'),
            summarize_limit=behavior_config.get('observation_summarize_limit'),
            artifact_ttl_seconds=behavior_config.get('observation_artifact_ttl_seconds'),
        )
        self.prompt_materializer = PromptMaterializer(
            artifact_store=artifact_store,
            observation_window=observation_window,
            large_data_threshold=self.observation_policy.large_data_threshold,
        )

        label = runtime_label or self.__class__.__name__
        self.logger.debug(
            "%s '%s' 运行时初始化完成，可用工具: %s，可用 Skills: %s，模型输出限制: %s tokens，上下文窗口: %s，上下文预算: %s tokens",
            label,
            self.name,
            len(self.available_tools),
            len(self.available_skills),
            model_max_completion_tokens,
            model_context_window or '未配置',
            max_context_tokens,
        )
        self.logger.debug("%s '%s' 使用上下文预算档位: %s", label, self.name, budget_profile.name)

    def _resolve_event_bus(self, context: AgentContext, event_bus = None):
        """获取当前 run 的事件总线。"""
        if event_bus is not None:
            return event_bus
        if hasattr(context, 'metadata'):
            context_event_bus = context.metadata.get('event_bus')
            if context_event_bus is not None:
                return context_event_bus
            run_id = context.metadata.get('run_id')
            if run_id:
                from agents.events.session_manager import get_run_event_bus
                return get_run_event_bus(run_id, session_id=getattr(context, 'session_id', None))
        return None

    def _ensure_publisher(
        self,
        context: AgentContext,
        *,
        event_bus = None,
        call_id: Optional[str] = None,
        parent_call_id: Optional[str] = None,
        force_new: bool = False,
    ):
        """为当前执行构建 EventPublisher。"""
        from agents.events import EventPublisher

        resolved_event_bus = self._resolve_event_bus(context, event_bus=event_bus)
        current_session_id = getattr(context, 'session_id', None)
        if call_id is None:
            call_id = f"call_{uuid.uuid4()}"
        if parent_call_id is None and hasattr(context, 'metadata'):
            parent_call_id = context.metadata.get('parent_call_id') or context.metadata.get('parent_task_id')

        del force_new
        if resolved_event_bus is None:
            return None
        return EventPublisher(
            agent_name=self.name,
            agent_display_name=self.display_name or self.name,
            session_id=current_session_id,
            trace_id=context.metadata.get('trace_id') if hasattr(context, 'metadata') else None,
            span_id=context.metadata.get('span_id') if hasattr(context, 'metadata') else None,
            call_id=call_id,
            parent_call_id=parent_call_id,
            event_bus=resolved_event_bus,
        )

    def _handle_user_input_request(
        self,
        arguments: Dict[str, Any],
        event_bus,
        session_id: Optional[str],
        tool_call_id: str,
        publisher=None,
        parent_call_id: Optional[str] = None,
        log_label: Optional[str] = None,
    ) -> Optional[str]:
        """处理 request_user_input 伪工具调用。"""
        from agents.events import EventType
        from agents.events.bus import Event
        from agents.task_registry import get_task_registry

        prompt = arguments.get('prompt', '请提供额外信息')
        input_type = arguments.get('input_type', 'text')
        options = arguments.get('options', [])

        input_id = str(uuid.uuid4())
        registry = get_task_registry()
        wait_evt = registry.add_pending_input(session_id, input_id) if session_id else None

        if publisher:
            publisher.tool_call_start(
                call_id=tool_call_id,
                tool_name='request_user_input',
                arguments=arguments,
                parent_call_id=parent_call_id,
                agent_display_name=self.display_name or self.name,
            )

        if event_bus:
            event_bus.publish(Event(
                type=EventType.USER_INPUT_REQUIRED,
                session_id=session_id,
                agent_name=self.name,
                data={
                    "input_id": input_id,
                    "tool_call_id": tool_call_id,
                    "prompt": prompt,
                    "input_type": input_type,
                    "options": options,
                }
            ))

        prefix = log_label or self.display_name or self.name
        self.logger.info("[%s] 等待用户输入 input_id=%s prompt=%r", prefix, input_id, prompt[:60])

        if wait_evt is None:
            self.logger.warning("request_user_input: 缺少 session_id，无法等待用户输入")
            if publisher:
                publisher.tool_call_end(
                    call_id=tool_call_id,
                    tool_name='request_user_input',
                    result='（无 session，跳过）',
                    parent_call_id=parent_call_id,
                    agent_display_name=self.display_name or self.name,
                )
            return ""

        started_at = time.time()
        from utils.timeout_pause import pause_current, resume_current

        pause_current()
        try:
            wait_evt.wait()
        finally:
            resume_current()
        value = registry.get_input_result(session_id, input_id)

        if publisher:
            publisher.tool_call_end(
                call_id=tool_call_id,
                tool_name='request_user_input',
                result=value if value else '（已取消）',
                execution_time=time.time() - started_at,
                parent_call_id=parent_call_id,
                agent_display_name=self.display_name or self.name,
            )

        self.logger.info("[%s] 用户输入已接收 input_id=%s", prefix, input_id)
        return value if value != "" else None

    def _publish_visualization_candidate(self, candidate: Dict[str, Any]) -> None:
        """[Deprecated] 新架构下不再通过 SSE 推送可视化数据。"""
        pass

    def _publish_deferred_visualizations(self, candidates: Optional[List[Dict[str, Any]]]) -> None:
        """[Deprecated] 新架构下不再通过 SSE 推送可视化数据。"""
        pass

    def _get_runtime_log_label(self) -> str:
        """返回运行时日志展示名。"""
        return "ReAct"

    def _prepare_execution_state(
        self,
        task: str,
        context: AgentContext,
        start_time: float,
    ) -> Dict[str, Any]:
        """准备一次标准 ReAct 执行的初始状态。"""
        event_bus = self._resolve_event_bus(context)
        current_call_id = None
        parent_call_id = None
        run_id = None
        if hasattr(context, 'metadata'):
            current_call_id = context.metadata.get('call_id')
            parent_call_id = context.metadata.get('parent_call_id') or context.metadata.get('parent_task_id')
            run_id = context.metadata.get('run_id')
        if not current_call_id:
            current_call_id = f"call_{uuid.uuid4()}"
        if not run_id:
            run_id = str(uuid.uuid4())

        publisher = self._ensure_publisher(
            context,
            event_bus=event_bus,
            call_id=current_call_id,
            parent_call_id=parent_call_id,
        )
        if publisher:
            metadata = {}
            if self.max_rounds is not None:
                metadata['max_rounds'] = self.max_rounds
            publisher.agent_start(task, metadata=metadata)

        user_message: Dict[str, Any] = {"role": "user", "content": task}
        current_attachments = []
        if hasattr(context, 'metadata'):
            current_attachments = list(context.metadata.get('current_attachments') or [])
        image_attachments, file_references = self._split_current_attachments(current_attachments)
        if file_references:
            content_suffix = self._build_file_references_context_suffix(file_references)
            user_message['content'] = f"{task}\n\n{content_suffix}" if task else content_suffix
        if image_attachments or file_references:
            user_message['metadata'] = {}
        if image_attachments:
            user_message['metadata']['attachments'] = image_attachments
        if file_references:
            user_message['metadata']['file_references'] = file_references

        return {
            'start_time': start_time,
            'event_bus': event_bus,
            'publisher': publisher,
            'call_id': current_call_id,
            'parent_call_id': parent_call_id,
            'run_id': run_id,
            'current_session': [user_message],
            'tool_calls_history': [],
            'rounds': 0,
        }

    def _publish_context_usage(self, token_stats: Dict[str, int], rounds: int, publisher) -> None:
        """发布上下文用量事件。"""
        if not publisher:
            return
        from agents.events.bus import EventType

        publisher._publish(EventType.CONTEXT_USAGE, {
            'used_tokens': token_stats['used_tokens'],
            'system_prompt_tokens': token_stats['system_prompt_tokens'],
            'total_tokens': token_stats['total_tokens'],
            'budget_tokens': token_stats['budget_tokens'],
            'round': rounds,
        })

    def _format_assistant_context_message(
        self,
        intent: str,
        actions: Optional[List[Dict[str, Any]]],
        final_answer: Optional[str],
        full_response: str,
    ) -> str:
        """返回适合上下文存储的 assistant 消息内容（原始 LLM 输出）。"""
        return (full_response or "").strip()

    def _on_assistant_message(
        self,
        intent: str,
        actions: Optional[List[Dict[str, Any]]],
        full_response: str,
        final_answer: str,
        rounds: int,
        state: Dict[str, Any],
    ) -> None:
        """处理一轮模型返回后的 assistant 消息。"""
        publisher = state.get('publisher')
        if not publisher or final_answer:
            return
        content = self._format_assistant_context_message(
            intent=intent,
            actions=actions,
            final_answer=final_answer,
            full_response=full_response,
        )
        if not content:
            return
        publisher.react_intermediate(
            role="assistant",
            content=content,
            round=rounds,
            msg_type="intent",
        )

    def _resolve_references(self, arguments: Any, results_snapshot: Dict[int, Any], current_idx: int) -> Any:
        """占位符替换。子类可覆盖以定制替换策略。默认无操作。"""
        return arguments

    def _format_tool_observation(
        self,
        result: Any,
        *,
        tool_name: str | None = None,
        session_id: str | None = None,
        is_skills_tool: bool = False,
    ) -> str:
        """Format normalized tool results into observation text."""
        if (
            self.result_normalizer is None
            or self.observation_policy is None
            or self.prompt_materializer is None
        ):
            raise RuntimeError("Observation formatting runtime is not configured")

        normalized = self.result_normalizer.normalize(result, tool_name=tool_name)
        decision = self.observation_policy.decide(
            normalized,
            is_skills_tool=is_skills_tool,
        )
        return self.prompt_materializer.materialize_tool_observation(
            normalized,
            decision,
            tool_name=tool_name or "",
            is_skills_tool=is_skills_tool,
            session_id=session_id,
        )

    def _build_background_notification_observation(
        self,
        payload: Dict[str, Any],
        *,
        timeout: bool = False,
    ) -> str:
        """构建 <task-notification> XML，对标 Claude Code 的通知格式。"""
        task_id = payload.get('background_task_id') or payload.get('task_id') or 'unknown'
        status = payload.get('status') or ('running' if timeout else 'completed')
        output_path = payload.get('output_path') or payload.get('background_output_path') or ''
        return_code = payload.get('return_code')
        result_type = payload.get('result_type')
        summary = payload.get('summary') or payload.get('description') or ''

        parts = [f'<task-notification>']
        parts.append(f'<task-id>{task_id}</task-id>')
        if output_path:
            parts.append(f'<output-file>{output_path}</output-file>')
        parts.append(f'<status>{status}</status>')
        if return_code is not None:
            parts.append(f'<return-code>{return_code}</return-code>')
        if result_type:
            parts.append(f'<result-type>{result_type}</result-type>')
        if summary:
            parts.append(f'<summary>{summary}</summary>')
        parts.append('</task-notification>')
        return '\n'.join(parts)

    def _emit_background_notification_observation(
        self,
        observation: str,
        *,
        state: Dict[str, Any],
        rounds: Optional[int],
    ) -> None:
        if not observation:
            return
        state['current_session'].append({
            'role': 'user',
            'content': observation,
        })
        publisher = state.get('publisher')
        if publisher:
            publisher.react_intermediate(
                role='user',
                content=observation,
                round=rounds or 1,
                msg_type='observation',
            )

    def _drain_pending_notifications(
        self,
        context: AgentContext,
        state: Dict[str, Any],
        rounds: int,
    ) -> None:
        """消费 session 级后台完成通知队列（对标 Claude Code 的 dequeue task-notification）。

        调用时机：run 开头、每轮推理开头、每次工具执行后。
        """
        from agents.task_registry import get_task_registry

        session_id = getattr(context, 'session_id', None)
        if not session_id:
            return
        registry = get_task_registry()
        notifications = registry.drain_session_notifications(session_id)
        if not notifications:
            return
        self.logger.debug("drain_pending_notifications: 消费 %d 条通知 session=%s", len(notifications), session_id)
        for payload in notifications:
            observation = self._build_background_notification_observation(payload)
            self._emit_background_notification_observation(
                observation,
                state=state,
                rounds=rounds,
            )

    @staticmethod
    def _extract_wait_signal(result: Any) -> Optional[Dict[str, Any]]:
        if result is None:
            return None
        if isinstance(result, dict):
            content = result.get('content')
            metadata = result.get('metadata')
        else:
            content = getattr(result, 'content', None)
            metadata = getattr(result, 'metadata', None)

        for payload in (content, metadata):
            if not isinstance(payload, dict) or not payload.get('suggest_wait'):
                continue
            background_task_id = payload.get('background_task_id')
            if not background_task_id:
                continue
            return {
                'background_task_id': background_task_id,
                'wait_timeout_ms': payload.get('wait_timeout_ms'),
            }
        return None

    @staticmethod
    def _compact_text(value: Any, *, max_chars: int = 220) -> str:
        text = "" if value is None else str(value)
        text = re.sub(r"\s+", " ", text).strip()
        if len(text) <= max_chars:
            return text
        return text[: max_chars - 3].rstrip() + "..."

    # 依赖检测正则，与 result_references._PLACEHOLDER_PATTERN 保持一致
    _DEP_PATTERN = re.compile(r'\{result_?(\d+)', re.IGNORECASE)

    @staticmethod
    def _action_has_unmet_deps(arguments: Any, completed: set) -> bool:
        """检查 arguments 中是否存在尚未完成的 result_N 依赖（N 不在 completed 中）。"""
        text = json.dumps(arguments) if not isinstance(arguments, str) else arguments
        for m in BaseAgent._DEP_PATTERN.finditer(text):
            if int(m.group(1)) not in completed:
                return True
        return False

    @staticmethod
    def _build_execution_batches(actions: List[Dict[str, Any]]) -> List[List[Tuple[int, Dict[str, Any]]]]:
        """
        将 actions 分组为顺序执行的批次。
        同一批次内的 action 互不依赖，可并行执行。
        批次间保持串行（后批依赖前批结果）。
        """
        batches: List[List[Tuple[int, Dict[str, Any]]]] = []
        completed: set = set()  # 已分配到前批的 idx（1-based）

        remaining = [(idx, action) for idx, action in enumerate(actions, 1)]
        while remaining:
            batch: List[Tuple[int, Dict[str, Any]]] = []
            next_remaining: List[Tuple[int, Dict[str, Any]]] = []
            for idx, action in remaining:
                arguments = action.get('arguments', {})
                if BaseAgent._action_has_unmet_deps(arguments, completed):
                    next_remaining.append((idx, action))
                else:
                    batch.append((idx, action))
            if not batch:
                # 剩余全部有依赖但无法满足（循环依赖或引用不存在），强制串行推进
                batch.append(remaining[0])
                next_remaining = remaining[1:]
            completed.update(idx for idx, _ in batch)
            batches.append(batch)
            remaining = next_remaining
        return batches

    _MAX_PARALLEL_WORKERS = 8

    def _execute_single_action(
        self,
        idx: int,
        action: Dict[str, Any],
        results: Dict[int, Any],
        lock: threading.Lock,
        context: AgentContext,
        state: Dict[str, Any],
        rounds: int,
        log_prefix: str,
    ) -> Tuple[int, str]:
        """执行单个 action，返回 (idx, observation_str)。线程安全。子类可覆盖 _resolve_references 定制占位符替换。"""
        from tools.runtime.response_builder import error_result
        from tools.refs.result_references import (
            detect_unresolved_placeholders,
            result_event_payload,
        )
        from tools.runtime.executor import execute_tool
        from tools.tool_registry import get_tool_registry

        tool_registry = get_tool_registry()
        event_bus = state.get('event_bus')
        publisher = state.get('publisher')
        current_session_id = getattr(context, 'session_id', None)

        tool_name = action.get('tool')
        arguments = action.get('arguments', {})

        # 工具名校验
        available_tool_names = {
            t.get('function', {}).get('name') for t in (self.available_tools or [])
        }
        if available_tool_names and tool_name not in available_tool_names:
            error_msg = f"无效的工具名称: {tool_name}（未在当前 Agent 可用工具列表中）"
            self.logger.warning(f"{log_prefix} {error_msg}")
            with lock:
                results[idx] = error_result(error_msg, tool_name=tool_name)
            return idx, f"[{tool_name}]\n错误: {error_msg}"

        # 占位符替换
        with lock:
            snapshot = dict(results)
        if snapshot:
            original_arguments = arguments
            try:
                arguments = self._resolve_references(arguments, snapshot, idx)
                if arguments != original_arguments:
                    self.logger.debug(
                        f"{log_prefix} 占位符替换: {original_arguments} -> {arguments}"
                    )
            except Exception as error:
                self.logger.warning(
                    "%s 占位符替换失败，沿用原始参数: %s", log_prefix, error
                )

        self.logger.debug(
            f"{log_prefix} [{idx}] 执行工具: {tool_name}, 参数: {arguments}"
        )
        tool_call_id = f"tool_{uuid.uuid4()}"

        # 未替换占位符检测
        unresolved = detect_unresolved_placeholders(arguments)
        if unresolved:
            observation = (
                f"[{tool_name}] 参数中包含未替换的占位符: {', '.join(unresolved)}，"
                "请检查引用路径是否正确"
            )
            with lock:
                results[idx] = error_result(observation, tool_name=tool_name)
            return idx, observation

        self._check_interrupt(context)

        if publisher:
            with lock:
                publisher.tool_call_start(
                    call_id=tool_call_id,
                    tool_name=tool_name,
                    arguments=arguments,
                    parent_call_id=state.get('call_id'),
                    round=rounds,
                    agent_display_name=self.display_name or self.name,
                )

        tool_started_at = time.time()
        result = execute_tool(
            tool_name,
            arguments,
            agent_config=self.agent_config,
            event_bus=event_bus,
            session_id=current_session_id,
            team_name=context.metadata.get('team') if hasattr(context, 'metadata') else None,
            workspace_root=context.metadata.get('workspace_root') if hasattr(context, 'metadata') else None,
            run_id=context.metadata.get('run_id') if hasattr(context, 'metadata') else None,
            cancel_event=context.metadata.get('cancel_event') if hasattr(context, 'metadata') else None,
            parent_call_id=state.get('call_id'),
            current_agent_name=self.name,
            tool_call_id=tool_call_id,
            round=rounds,
            order=idx,
            round_index=idx,
        )
        elapsed_time = time.time() - tool_started_at
        is_skills_tool = tool_name in tool_registry.get_skill_tool_names()
        wait_signal = self._extract_wait_signal(result)
        observation = "" if wait_signal else self._format_tool_observation(
            result,
            tool_name=tool_name,
            session_id=current_session_id,
            is_skills_tool=is_skills_tool,
        )

        if publisher:
            preview_text = f"[{tool_name}]\n{observation}" if observation else ""
            tool_success = getattr(result, 'success', True) if result is not None else True
            approval_message = (
                result.metadata.get('approval_message', '')
                if result and hasattr(result, 'metadata')
                else ''
            )
            if not wait_signal:
                with lock:
                    publisher.tool_call_end(
                        call_id=tool_call_id,
                        tool_name=tool_name,
                        result=preview_text,
                        result_preview=preview_text,
                        raw_result=result_event_payload(result),
                        raw_result_ref={
                            'session_id': current_session_id,
                            'call_id': tool_call_id,
                            'tool_name': tool_name,
                        },
                        execution_time=elapsed_time,
                        parent_call_id=state.get('call_id'),
                        success=tool_success,
                        round=rounds,
                        agent_display_name=self.display_name or self.name,
                        approval_message=approval_message,
                    )

        with lock:
            results[idx] = result
            state.setdefault('tool_calls_history', []).append({
                'tool_name': tool_name,
                'arguments': arguments,
                'result': result,
                'order': idx,
                'tool_call_id': tool_call_id,
                'parent_call_id': state.get('call_id'),
                'round': rounds,
                'agent_display_name': self.display_name or self.name,
                'current_session_id': current_session_id,
                'tool_started_at': tool_started_at,
                'elapsed_time': elapsed_time,
                'approval_message': approval_message if publisher else '',
            })

        return idx, f"[{tool_name}]\n{observation}" if observation else ""

    def _handle_actions(
        self,
        actions: List[Dict[str, Any]],
        context: AgentContext,
        state: Dict[str, Any],
        rounds: int,
        log_prefix: str,
    ) -> Optional[WaitingRequest]:
        """动作处理：对无依赖的工具并行执行，有占位符依赖的批次间串行。

        Returns:
            WaitingRequest if any tool result suggests background waiting, else None.
        """
        from tools.runtime.response_builder import error_result

        publisher = state.get('publisher')
        observations: List[str] = [None] * (len(actions) + 1)  # idx 1-based
        results: Dict[int, Any] = {}
        lock = threading.Lock()
        total = len(actions)

        batches = self._build_execution_batches(actions)
        for batch in batches:
            self._check_interrupt(context)

            if len(batch) == 1:
                idx, action = batch[0]
                tool_name = action.get('tool')
                if not tool_name:
                    continue
                try:
                    result_idx, obs = self._execute_single_action(
                        idx, action, results, lock, context, state, rounds, log_prefix,
                    )
                    observations[result_idx] = obs
                except Exception as exc:
                    self.logger.error(f"{log_prefix} 工具执行异常 (action {idx}): {exc}", exc_info=True)
                    observations[idx] = f"[{action.get('tool', '?')}] 执行异常: {exc}"
                    with lock:
                        results[idx] = error_result(str(exc), tool_name=action.get('tool', '?'))
            else:
                # 并行执行批次内所有工具
                self.logger.debug(
                    f"{log_prefix} 并行执行 {len(batch)} 个工具: "
                    f"{[a.get('tool') for _, a in batch]}"
                )
                valid_batch = [(idx, a) for idx, a in batch if a.get('tool')]
                with concurrent.futures.ThreadPoolExecutor(
                    max_workers=min(len(valid_batch), self._MAX_PARALLEL_WORKERS)
                ) as executor:
                    futures = {
                        executor.submit(
                            self._execute_single_action,
                            idx, action, results, lock,
                            context, state, rounds, log_prefix,
                        ): (idx, action)
                        for idx, action in valid_batch
                    }
                    for future in concurrent.futures.as_completed(futures):
                        f_idx, f_action = futures[future]
                        try:
                            result_idx, obs = future.result()
                            observations[result_idx] = obs
                        except Exception as exc:
                            self.logger.error(
                                f"{log_prefix} 工具执行异常 (action {f_idx}): {exc}", exc_info=True
                            )
                            observations[f_idx] = f"[{f_action.get('tool', '?')}] 执行异常: {exc}"
                            with lock:
                                results[f_idx] = error_result(
                                    str(exc), tool_name=f_action.get('tool', '?')
                                )

        # 按原始 action 顺序排列 tool_calls_history
        history = state.get('tool_calls_history', [])
        history.sort(key=lambda x: x.get('order', 0))

        ordered_observations = [
            observations[i] for i in range(1, total + 1) if observations[i]
        ]
        combined_observations = "\n\n".join(ordered_observations)
        if combined_observations:
            state['current_session'].append({
                "role": "user",
                "content": combined_observations,
            })
        if publisher and combined_observations:
            publisher.react_intermediate(
                role="user",
                content=combined_observations,
                round=rounds,
                msg_type="observation",
            )

        # 检查是否有工具结果建议进入等待态
        return self._build_waiting_request_from_results(results, state)

    def _build_waiting_request_from_results(
        self, results: Dict[int, Any], state: Dict[str, Any],
    ) -> Optional[WaitingRequest]:
        """扫描本轮工具结果，提取需要等待的后台任务 ID。"""
        bg_task_ids = []
        timeout_ms = None
        pending_tool_calls = []
        history_by_order = {
            item.get('order'): item for item in state.get('tool_calls_history', [])
        }
        for order, result in results.items():
            wait_signal = self._extract_wait_signal(result)
            if not wait_signal:
                continue
            bg_task_ids.append(wait_signal['background_task_id'])
            if timeout_ms is None and wait_signal.get('wait_timeout_ms') is not None:
                timeout_ms = wait_signal.get('wait_timeout_ms')
            history_item = history_by_order.get(order)
            if history_item:
                pending_tool_calls.append(history_item)
        if not bg_task_ids:
            return None
        return WaitingRequest(
            background_task_ids=bg_task_ids,
            run_id=state.get('run_id'),
            timeout_ms=timeout_ms,
            pending_tool_calls=pending_tool_calls,
        )

    def _run_waiting_loop(
        self,
        waiting_request: WaitingRequest,
        context: AgentContext,
        state: Dict[str, Any],
        rounds: int,
        log_prefix: str,
    ) -> None:
        """在同一 run 内等待后台任务完成，支持事件唤醒 + poll 兜底 + hidden keepalive。"""
        from agents.task_registry import get_task_registry, BackgroundWaitState
        from tools.runtime.background_tasks import get_background_task_manager
        from utils.timeout_pause import pause_current, resume_current

        config = self.context_pipeline.config
        registry = get_task_registry()
        bg_manager = get_background_task_manager()
        task_id = state.get('_execution', {}).get('task_id') or context.metadata.get('task_id', '')
        wait_id = str(uuid.uuid4())
        publisher = state.get('publisher')

        poll_interval = config.waiting_poll_interval_seconds
        idle_timeout = config.waiting_idle_timeout_seconds
        timeout_override_ms = waiting_request.timeout_ms
        if timeout_override_ms is not None:
            try:
                idle_timeout = max(0.1, float(timeout_override_ms) / 1000.0)
            except (TypeError, ValueError):
                idle_timeout = config.waiting_idle_timeout_seconds
        keepalive_interval = config.keepalive_interval_seconds
        keepalive_grace = config.keepalive_grace_seconds
        max_keepalive = config.max_hidden_keepalive_rounds
        allow_provider_keepalive = config.allow_provider_keepalive

        bg_wait_state = BackgroundWaitState(
            wait_id=wait_id,
            task_ids=list(waiting_request.background_task_ids),
            deadline_at=time.time() + idle_timeout,
            poll_interval_seconds=poll_interval,
            keepalive_interval_seconds=keepalive_interval,
            pending_task_ids=list(waiting_request.background_task_ids),
        )

        evt = registry.add_task_pending_wait(task_id, wait_id, bg_wait_state)
        if evt is None:
            self.logger.warning("%s 无法注册后台等待（task_id=%s 不存在）", log_prefix, task_id)
            return

        # 先立即 poll 一次，防止订阅建立前任务已完成
        completed_early = self._poll_background_tasks(
            bg_manager, bg_wait_state, wait_id, task_id, registry,
        )
        if completed_early:
            self._append_waiting_observation(
                wait_id,
                task_id,
                registry,
                bg_manager,
                state,
                bg_wait_state,
                waiting_request.pending_tool_calls,
                rounds,
            )
            return

        last_keepalive_at = time.time()
        keepalive_count = 0

        pause_current()
        try:
            while True:
                # 计算下次唤醒：取 poll 和 keepalive 触发时间的最小值
                now = time.time()
                next_poll = poll_interval
                next_keepalive = max(0.0, (keepalive_interval - keepalive_grace) - (now - last_keepalive_at))
                sleep_time = min(next_poll, next_keepalive)
                sleep_time = max(0.1, min(sleep_time, poll_interval))

                # 事件驱动唤醒
                awoken = evt.wait(timeout=sleep_time)

                # 检查中断
                cancel_event = context.metadata.get('cancel_event')
                if cancel_event and cancel_event.is_set():
                    registry.clear_task_waiting(task_id, wait_id)
                    self.logger.debug("%s waiting loop 被取消", log_prefix)
                    raise InterruptedError("等待后台任务期间被用户取消")

                if awoken:
                    # 事件唤醒：检查结果
                    result = registry.get_task_wait_result(task_id, wait_id)
                    if result.get('status') == 'cancelled':
                        self.logger.debug("%s waiting loop 被系统取消", log_prefix)
                        raise InterruptedError("等待后台任务期间被系统取消")
                    completed_payloads = result.get('completed_payloads') or []
                    completed_task_ids = result.get('completed_task_ids') or []
                    if not completed_task_ids:
                        single_bg_tid = result.get('background_task_id')
                        if single_bg_tid:
                            completed_task_ids = [single_bg_tid]
                    for bg_tid in completed_task_ids:
                        if bg_tid not in bg_wait_state.completed_task_ids:
                            bg_wait_state.completed_task_ids.append(bg_tid)
                        if bg_tid in bg_wait_state.pending_task_ids:
                            bg_wait_state.pending_task_ids.remove(bg_tid)
                    if completed_payloads:
                        session_id = getattr(context, 'session_id', None)
                        if session_id:
                            for payload in completed_payloads:
                                registry.add_session_notification(session_id, payload)
                    self._append_waiting_observation(
                        wait_id,
                        task_id,
                        registry,
                        bg_manager,
                        state,
                        bg_wait_state,
                        waiting_request.pending_tool_calls,
                        rounds,
                    )
                    return

                # poll 兜底
                now = time.time()
                bg_wait_state.last_poll_at = now
                completed = self._poll_background_tasks(
                    bg_manager, bg_wait_state, wait_id, task_id, registry,
                )
                if completed:
                    self._append_waiting_observation(
                        wait_id,
                        task_id,
                        registry,
                        bg_manager,
                        state,
                        bg_wait_state,
                        waiting_request.pending_tool_calls,
                        rounds,
                    )
                    return

                # 超时检查
                if bg_wait_state.deadline_at and now >= bg_wait_state.deadline_at:
                    self.logger.warning("%s waiting loop 超时（%.0fs）", log_prefix, idle_timeout)
                    bg_wait_state.wake_reason = 'timeout'
                    timeout_observation = self._append_waiting_observation(
                        wait_id,
                        task_id,
                        registry,
                        bg_manager,
                        state,
                        bg_wait_state,
                        waiting_request.pending_tool_calls,
                        rounds,
                    )
                    if not timeout_observation:
                        state['current_session'].append({
                            "role": "user",
                            "content": f"[system] 等待后台任务超时（{idle_timeout:.0f}s），任务仍在运行中。",
                        })
                    return

                # hidden keepalive
                if not allow_provider_keepalive:
                    continue
                if (now - last_keepalive_at) >= (keepalive_interval - keepalive_grace):
                    if keepalive_count < max_keepalive:
                        self._run_hidden_keepalive(context, state, log_prefix)
                        last_keepalive_at = time.time()
                        keepalive_count += 1
                        bg_wait_state.last_keepalive_at = last_keepalive_at
                        bg_wait_state.keepalive_count = keepalive_count
        finally:
            resume_current()

    def _poll_background_tasks(
        self,
        bg_manager,
        bg_wait_state,
        wait_id: str,
        task_id: str,
        registry,
    ) -> bool:
        """轮询后台任务状态，返回是否全部完成。"""
        completed_payloads = []
        all_done = True
        for bg_tid in bg_wait_state.task_ids:
            bg_task = bg_manager.get_task(bg_tid)
            if bg_task is None:
                continue
            if bg_task.is_done():
                if bg_tid not in bg_wait_state.completed_task_ids:
                    bg_wait_state.completed_task_ids.append(bg_tid)
                    if bg_tid in bg_wait_state.pending_task_ids:
                        bg_wait_state.pending_task_ids.remove(bg_tid)
                completed_payloads.append({
                    'task_id': bg_tid,
                    'background_task_id': bg_tid,
                    'status': bg_task.status,
                    'return_code': bg_task.return_code,
                    'result_type': bg_task.result_type,
                    'output_path': str(bg_task.output_path) if getattr(bg_task, 'output_path', None) else None,
                    'completed_at': bg_task.completed_at,
                    'success': bg_task.status == 'completed',
                    'summary': f"后台任务 {bg_tid} 已完成，输出已写入文件",
                })
            else:
                all_done = False
        if all_done and bg_wait_state.completed_task_ids:
            bg_wait_state.wake_reason = 'poll'
            registry.resolve_task_wait(task_id, wait_id, {
                'status': 'completed',
                'completed_task_ids': bg_wait_state.completed_task_ids,
                'completed_payloads': completed_payloads,
            })
            return True
        return False

    def _append_waiting_observation(
        self,
        wait_id: str,
        task_id: str,
        registry,
        bg_manager,
        state: Dict[str, Any],
        bg_wait_state,
        pending_tool_calls: Optional[List[Dict[str, Any]]] = None,
        rounds: Optional[int] = None,
    ) -> str:
        """后台任务完成或超时后，将统一 notification observation 回灌到当前 session。"""
        del pending_tool_calls
        payloads: List[dict] = []
        for bg_tid in bg_wait_state.completed_task_ids:
            snapshot = bg_manager.get_task_snapshot(bg_tid) or {}
            payload = {
                'task_id': bg_tid,
                'background_task_id': bg_tid,
                'status': snapshot.get('status', 'completed'),
                'return_code': snapshot.get('return_code'),
                'result_type': snapshot.get('result_type'),
                'output_path': snapshot.get('output_path'),
                'completed_at': snapshot.get('completed_at'),
                'success': snapshot.get('status') == 'completed',
                'summary': f"后台任务 {bg_tid} 已完成，输出已写入文件",
            }
            payloads.append(payload)

        if not payloads:
            for bg_tid in bg_wait_state.pending_task_ids or bg_wait_state.task_ids:
                snapshot = bg_manager.get_task_snapshot(bg_tid) or {}
                payloads.append({
                    'task_id': bg_tid,
                    'background_task_id': bg_tid,
                    'status': snapshot.get('status', 'running'),
                    'return_code': snapshot.get('return_code'),
                    'result_type': snapshot.get('result_type'),
                    'output_path': snapshot.get('output_path'),
                    'completed_at': snapshot.get('completed_at'),
                    'success': False,
                    'summary': f"后台任务 {bg_tid} 仍在运行",
                })

        timeout = bg_wait_state.wake_reason == 'timeout'
        parts = [
            self._build_background_notification_observation(payload, timeout=timeout)
            for payload in payloads
        ]
        observation = "\n\n".join(part for part in parts if part)
        self._emit_background_notification_observation(
            observation,
            state=state,
            rounds=rounds,
        )
        registry.clear_task_waiting(task_id, wait_id)
        return observation

    def _run_hidden_keepalive(
        self,
        context: AgentContext,
        state: Dict[str, Any],
        log_prefix: str,
    ) -> None:
        """隐藏 keepalive：发送极小请求续命 provider KV cache，不落库不可见。

        构造当前稳定前缀 + 一条隐藏指令，走非流式 chat_completion，
        极小 token budget，不带 tools，结果不写入 session/store。
        """
        try:
            config = self.context_pipeline.config
            if not config.allow_provider_keepalive:
                self.logger.debug("%s keepalive 跳过：配置已禁用", log_prefix)
                return

            llm_config = self.get_llm_config(context, task_type='default')
            provider_name = llm_config.get('provider', '')
            if not provider_name:
                self.logger.debug("%s keepalive 跳过：无 provider", log_prefix)
                return

            # 构造消息快照（只读，不修改 session）
            prepared = self.context_pipeline.prepare_execution_messages(
                system_prompt=self._build_system_prompt(),
                context=context,
                current_session=state['current_session'],
                publisher=None,  # 不发布事件
                llm_config=llm_config,
            )
            messages = list(prepared.messages)

            # 追加隐藏 keepalive 指令（不落库）
            messages.append({
                'role': 'user',
                'content': '[keepalive] 请回复 OK。',
            })

            response = self.model_adapter.chat_completion(
                messages=messages,
                provider=provider_name,
                model=llm_config.get('model_name'),
                temperature=0.0,
                max_tokens=config.hidden_keepalive_token_budget,
                provider_type=llm_config.get('provider_type'),
            )

            if response and not getattr(response, 'error', None):
                self.logger.debug("%s hidden keepalive 成功", log_prefix)
            else:
                err = getattr(response, 'error', 'unknown')
                self.logger.debug("%s hidden keepalive 失败: %s", log_prefix, err)

            # 刷新本地缓存时间戳
            cache = self.context_pipeline._session_cache(context)
            cache['t'] = time.time()

        except Exception as exc:
            self.logger.debug("%s hidden keepalive 异常: %s", log_prefix, exc)

    def _handle_no_action(
        self,
        llm_result: Any,
        context: AgentContext,
        state: Dict[str, Any],
        rounds: int,
        log_prefix: str,
    ) -> None:
        """处理既无 action 也无最终答案的场景。"""
        del context, rounds
        parse_fail_hint = f"（工具参数解析失败: {llm_result.error}）" if llm_result.error else ""
        self.logger.warning(f"{log_prefix} LLM 既没有调用工具也没有给出最终答案{parse_fail_hint}")
        state['current_session'].append({
            "role": "user",
            "content": (
                f"工具参数解析失败{parse_fail_hint}，请使用 XML 子标签格式传递参数，例如：\n"
                "<tools>\n<tool name=\"工具名\">\n  <参数名>值</参数名>\n</tool>\n</tools>\n"
                "多行文本或含特殊字符的参数值用 CDATA 包裹：<参数名><![CDATA[内容]]></参数名>"
            ) if llm_result.error else "请直接输出 <final_answer> 或 <tools>。"
        })

    def _handle_llm_error(
        self,
        error_message: str,
        context: AgentContext,
        state: Dict[str, Any],
        start_time: float,
    ) -> AgentResponse:
        """处理 LLM 调用错误。"""
        del context
        publisher = state.get('publisher')
        if publisher:
            publisher.agent_error(error=error_message, error_type="LLMError")
        state['_run_status'] = 'error'
        state['_run_summary'] = error_message
        return AgentResponse(
            success=False,
            content="",
            error=error_message,
            agent_name=self.name,
            execution_time=time.time() - start_time,
        )

    def _handle_final_answer(
        self,
        final_answer: str,
        context: AgentContext,
        state: Dict[str, Any],
        start_time: float,
    ) -> AgentResponse:
        """处理最终答案。"""
        del context

        publisher = state.get('publisher')
        if publisher:
            publisher.final_answer(final_answer)
            publisher.agent_end(
                result=final_answer,
                execution_time=time.time() - start_time,
            )

        state['_run_status'] = 'success'
        state['_run_summary'] = f"任务完成，共 {state.get('rounds', 0)} 轮推理"
        return AgentResponse(
            success=True,
            content=final_answer,
            agent_name=self.name,
            execution_time=time.time() - start_time,
            tool_calls=state.get('tool_calls_history', []),
            metadata={
                'rounds': state.get('rounds', 0),
                'reasoning_steps': [
                    msg for msg in state.get('current_session', [])
                    if msg.get('role') == 'assistant'
                ],
            },
        )

    def _handle_max_rounds(
        self,
        context: AgentContext,
        state: Dict[str, Any],
        start_time: float,
    ) -> AgentResponse:
        """处理达到最大轮数的情况。"""
        del context
        self.logger.warning(f"{self._log_prefix(None, self._get_runtime_log_label())} 达到最大轮数 {self.max_rounds}")
        final_content = "抱歉，经过多轮分析后仍无法给出完整答案。建议重新描述问题或提供更多信息。"
        publisher = state.get('publisher')
        if publisher:
            publisher.final_answer(final_content)
            publisher.agent_end(
                result=final_content,
                execution_time=time.time() - start_time,
            )
        state['_run_status'] = 'max_rounds'
        state['_run_summary'] = f"达到最大轮数 {self.max_rounds}"
        return AgentResponse(
            success=True,
            content=final_content,
            agent_name=self.name,
            execution_time=time.time() - start_time,
            tool_calls=state.get('tool_calls_history', []),
            metadata={
                'rounds': state.get('rounds', 0),
                'max_rounds_reached': True,
            },
        )

    def _handle_interrupted(
        self,
        error: InterruptedError,
        context: AgentContext,
        state: Dict[str, Any],
        start_time: float,
    ) -> AgentResponse:
        """处理中断。"""
        del context
        self.logger.info(f"任务被用户中断: {error}")
        publisher = state.get('publisher')
        if publisher:
            publisher.agent_error(error=str(error), error_type="InterruptedError")
            publisher.agent_end(
                result="[已停止生成]",
                execution_time=time.time() - start_time,
            )
        state['_run_status'] = 'interrupted'
        state['_run_summary'] = '用户中断执行'
        return AgentResponse(
            success=False,
            content="[已停止生成]",
            error="interrupted",
            agent_name=self.name,
            execution_time=time.time() - start_time,
        )

    def _handle_execution_error(
        self,
        error: Exception,
        context: AgentContext,
        state: Dict[str, Any],
        start_time: float,
    ) -> AgentResponse:
        """处理未捕获异常。"""
        del context
        self.logger.error(f"执行任务失败: {error}", exc_info=True)
        publisher = state.get('publisher')
        if publisher:
            publisher.agent_error(error=str(error), error_type="ExecutionError")
            publisher.agent_end(
                result=str(error),
                execution_time=time.time() - start_time,
            )
        state['_run_status'] = 'error'
        state['_run_summary'] = f"执行失败: {error}"
        return AgentResponse(
            success=False,
            content=str(error),
            error=str(error),
            agent_name=self.name,
            execution_time=time.time() - start_time,
        )

    def _cleanup_execution(
        self,
        context: AgentContext,
        state: Dict[str, Any],
    ) -> None:
        """清理执行态资源，统一发布 run_end 事件。"""
        del context
        publisher = state.get('publisher')
        run_id = state.get('run_id')
        parent_call_id = state.get('parent_call_id')
        # 仅顶层 Agent 发布 run_end
        if publisher and run_id and not parent_call_id:
            run_status = state.get('_run_status', 'error')
            run_summary = state.get('_run_summary', '')
            publisher.run_end(
                run_id=run_id,
                status=run_status,
                summary=run_summary,
                metadata={
                    "agent_name": getattr(self, 'name', ''),
                    "agent_display_name": getattr(self, 'display_name', None) or getattr(self, 'name', ''),
                },
            )

    def _execute_react_task(self, task: str, context: AgentContext) -> AgentResponse:
        """统一的 ReAct 主循环。"""
        from agents.streaming import StreamExecutor

        start_time = time.time()
        state: Dict[str, Any] = {}
        try:
            state = self._prepare_execution_state(task, context, start_time)
            current_session = state['current_session']
            publisher = state.get('publisher')

            # 顶层 Agent 发布 run_start（子类无论怎么重写 _prepare_execution_state 都会走到这里）
            if publisher and not state.get('parent_call_id'):
                publisher.run_start(
                    run_id=state['run_id'],
                    metadata={
                        "task": task,
                        "agent_name": getattr(self, 'name', ''),
                        "agent_display_name": getattr(self, 'display_name', None) or getattr(self, 'name', ''),
                    },
                )

            # 消费 session 级后台完成通知（含上次 run 遗留的）
            self._drain_pending_notifications(context, state, 1)

            while True:
                if self.max_rounds is not None and state['rounds'] >= self.max_rounds:
                    return self._handle_max_rounds(context, state, start_time)
                state['rounds'] += 1
                rounds = state['rounds']
                self._drain_pending_notifications(context, state, rounds)

                self._check_interrupt(context)
                llm_config = self.get_llm_config(context, task_type='default')
                log_prefix = self._log_prefix(llm_config, self._get_runtime_log_label())
                self.logger.debug(f"{log_prefix} 第 {rounds} 轮推理")

                prepared = self.context_pipeline.prepare_execution_messages(
                    system_prompt=self._build_system_prompt(),
                    context=context,
                    current_session=state['current_session'],
                    publisher=publisher,
                    llm_config=llm_config,
                )
                managed_messages = prepared.messages
                self.logger.debug(f"{log_prefix} {self.context_pipeline.format_summary(managed_messages)}")
                self._publish_context_usage(
                    {
                        'used_tokens': prepared.total_tokens,
                        'system_prompt_tokens': prepared.system_tokens,
                        'total_tokens': prepared.total_tokens,
                        'budget_tokens': prepared.budget_tokens,
                    },
                    rounds,
                    publisher,
                )

                stream_executor = StreamExecutor(
                    model_adapter=self.model_adapter,
                    publisher=publisher,
                    agent_logger=self.logger,
                )
                result = stream_executor.execute_llm_stream(
                    messages=managed_messages,
                    llm_config=llm_config,
                    round_num=rounds,
                    cancel_event=context.metadata.get('cancel_event'),
                )

                self._check_interrupt(context)

                if result.error:
                    if result.error == 'interrupted':
                        raise InterruptedError("LLM 调用被中断")
                    return self._handle_llm_error(
                        f"LLM 调用失败: {result.error}",
                        context,
                        state,
                        start_time,
                    )

                intent = result.intent
                actions = result.actions or []
                final_answer = result.answer
                full_response = result.full_response
                if actions and final_answer:
                    self.logger.debug("%s 同轮同时返回了 actions 与 answer，当前轮先忽略 answer", log_prefix)
                    final_answer = None

                if intent:
                    self.logger.debug(f"{log_prefix} Intent: {intent[:100]}...")
                elif actions:
                    self.logger.debug(f"{log_prefix} Actions: {len(actions)} tool(s): {[a.get('tool_name', '?') for a in actions]}")
                elif final_answer:
                    self.logger.debug(f"{log_prefix} Answer: {final_answer[:100]}...")

                assistant_message = self._format_assistant_context_message(
                    intent=intent,
                    actions=actions,
                    final_answer=final_answer,
                    full_response=full_response,
                )
                current_session.append({
                    "role": "assistant",
                    "content": assistant_message,
                })
                self._on_assistant_message(intent, actions, full_response, final_answer, rounds, state)

                if actions:
                    self.logger.debug(f"{log_prefix} 执行 {len(actions)} 个动作")
                    waiting_request = self._handle_actions(actions, context, state, rounds, log_prefix)
                    # 工具执行后立即 drain，避免后台完成通知要等到下一轮才注入
                    self._drain_pending_notifications(context, state, rounds)
                    if (
                        self.context_pipeline.config.waiting_enabled
                        and waiting_request
                        and waiting_request.background_task_ids
                    ):
                        self.logger.debug(
                            f"{log_prefix} 进入 waiting loop，等待后台任务: {waiting_request.background_task_ids}"
                        )
                        self._run_waiting_loop(waiting_request, context, state, rounds, log_prefix)
                    continue

                if final_answer:
                    return self._handle_final_answer(final_answer, context, state, start_time)

                self._handle_no_action(result, context, state, rounds, log_prefix)
        except InterruptedError as error:
            try:
                return self._handle_interrupted(error, context, state, start_time)
            except Exception as handler_error:
                self.logger.error("处理中断收尾失败: %s", handler_error, exc_info=True)
                publisher = state.get('publisher')
                if publisher:
                    try:
                        publisher.agent_end(
                            result="[已停止生成]",
                            execution_time=time.time() - start_time,
                        )
                    except Exception:
                        pass
                state['_run_status'] = 'interrupted'
                state['_run_summary'] = '用户中断执行'
                return AgentResponse(
                    success=False,
                    content="[已停止生成]",
                    error="interrupted",
                    agent_name=self.name,
                    execution_time=time.time() - start_time,
                )
        except Exception as error:
            try:
                return self._handle_execution_error(error, context, state, start_time)
            except Exception as handler_error:
                self.logger.error("处理执行异常收尾失败: %s", handler_error, exc_info=True)
                publisher = state.get('publisher')
                if publisher:
                    try:
                        publisher.agent_end(
                            result=str(error),
                            execution_time=time.time() - start_time,
                        )
                    except Exception:
                        pass
                state['_run_status'] = 'error'
                state['_run_summary'] = f"执行失败: {error}"
                return AgentResponse(
                    success=False,
                    content="",
                    error=str(error),
                    agent_name=self.name,
                    execution_time=time.time() - start_time,
                )
        finally:
            try:
                self._worktree_auto_snapshot(context, state)
            except Exception:
                pass
            try:
                self._cleanup_execution(context, state)
            except Exception as cleanup_error:
                self.logger.warning("清理执行态资源失败: %s", cleanup_error, exc_info=True)

    def _worktree_auto_snapshot(self, context: AgentContext, state: dict):
        """root agent run 结束时，在 worktree 里自动 commit 形成 snapshot。"""
        if state.get('parent_call_id'):
            return
        session_id = context.metadata.get('session_id') if hasattr(context, 'metadata') else None
        workspace_root = context.metadata.get('workspace_root') if hasattr(context, 'metadata') else None
        if not session_id or not workspace_root:
            return
        try:
            from utils.worktree import create_snapshot, worktree_exists
            if worktree_exists(session_id):
                create_snapshot(workspace_root, run_id=state.get('run_id'))
        except Exception as e:
            self.logger.debug("worktree auto-snapshot 失败: %s", e)

    def _check_interrupt(self, context: AgentContext):
        """检查是否被用户中断"""
        cancel_event = context.metadata.get('cancel_event') if hasattr(context, 'metadata') else None
        if cancel_event and cancel_event.is_set():
            raise InterruptedError(f"Agent {self.name} 被用户中断")

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__}(name='{self.name}')>"


class AgentExecutionError(Exception):
    """智能体执行错误"""

    def __init__(self, agent_name: str, message: str, original_error: Optional[Exception] = None):
        self.agent_name = agent_name
        self.message = message
        self.original_error = original_error
        super().__init__(f"[{agent_name}] {message}")
