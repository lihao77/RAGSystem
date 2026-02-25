# -*- coding: utf-8 -*-
"""
智能体基类 - 所有智能体的抽象基类
"""

from abc import ABC, abstractmethod
from typing import Dict, List, Any, Optional, Tuple
import json
import logging

from .models import AgentResponse
from .context import AgentContext

from ..context import ContextManager, ContextConfig

logger = logging.getLogger(__name__)


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
        self.context_manager = ContextManager()
        self.tools: List[Dict[str, Any]] = []

    @abstractmethod
    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        """执行任务（子类必须实现）"""
        pass

    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        """判断是否能处理该任务（子类可以重写）"""
        return True

    def before_execute(self, task: str, context: AgentContext):
        """执行前钩子"""
        self.logger.info(f"[{self.name}] 开始执行任务: {task}")
        context.push_agent(self.name)

    def after_execute(self, task: str, context: AgentContext, result: AgentResponse):
        """执行后钩子"""
        context.pop_agent()
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
            'tools': [tool.get('function', {}).get('name') for tool in self.tools]
        }
        if self.agent_config:
            info['config'] = {
                'enabled': self.agent_config.enabled,
                'llm': self.agent_config.llm.to_dict(),
                'custom_params': self.agent_config.custom_params
            }
        return info

    def _log_prefix(self, llm_config: Optional[Dict[str, Any]] = None, display_name: Optional[str] = None) -> str:
        """返回带模型名的日志前缀"""
        name = display_name if display_name is not None else self.name
        if llm_config and (llm_config.get('model_name') or llm_config.get('provider')):
            extra = llm_config.get('model_name') or llm_config.get('provider')
            return f"[{name} {extra}]"
        return f"[{name}]"

    def get_llm_config(self, context: Optional[AgentContext] = None) -> Dict[str, Any]:
        """获取 LLM 配置（优先智能体配置，支持请求级覆盖，支持从 ModelAdapter 继承）"""
        config = {}
        if self.agent_config and self.agent_config.llm:
            # 传递 model_adapter 以支持从 Provider 配置继承 max_context_tokens
            config = self.agent_config.llm.merge_with_default(
                self.system_config,
                model_adapter=self.model_adapter
            )
        elif self.system_config:
            llm_config = getattr(self.system_config, 'llm', None)
            if llm_config:
                config = {
                    'provider': getattr(llm_config, 'provider', None),
                    'provider_type': getattr(llm_config, 'provider_type', None),
                    'model_name': getattr(llm_config, 'model_name', None),
                    'temperature': getattr(llm_config, 'temperature', 0.7),
                    'max_tokens': getattr(llm_config, 'max_tokens', 4096),
                    'max_context_tokens': getattr(llm_config, 'max_context_tokens', None)
                }
        if not config:
            self.logger.warning(f"[{self.name}] 未配置 LLM，使用默认配置")
            config = {'temperature': 0.7, 'max_tokens': 4096}
        override = getattr(context, 'llm_override', None) if context else None
        if override:
            agent_llm = self.agent_config.llm if (self.agent_config and self.agent_config.llm) else None
            for key in ('provider', 'provider_type', 'model_name'):
                from_agent = agent_llm is not None and getattr(agent_llm, key, None) is not None
                if not from_agent and override.get(key):
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

    def compress_context_if_needed(
        self,
        context: AgentContext,
        publisher = None,
        config: Optional[ContextConfig] = None
    ) -> List[Dict[str, Any]]:
        """
        检查并执行上下文压缩（公共方法）

        Args:
            context: 智能体上下文
            publisher: 事件发布器（可选）
            config: 上下文配置（可选，默认使用 context_manager 的配置）

        Returns:
            解析后的消息列表（用于 LLM 请求）
        """
        if config is None:
            config = self.context_manager.config

        # 1. 转换 context.conversation_history 为字典格式
        history_with_meta = []
        for msg in context.conversation_history:
            history_with_meta.append({
                "role": msg.role,
                "content": msg.content,
                "metadata": msg.metadata or {}
            })

        # 2. 解析压缩视图
        from ..context import ContextManager
        resolved = ContextManager.resolve_compression_view(history_with_meta)

        # 3. 检查是否需要压缩
        max_tokens = config.max_tokens
        trigger_ratio = getattr(config, "compression_trigger_ratio", 0.85)
        compress_oldest_n = getattr(config, "compress_oldest_n", 4)

        estimated_tokens = self.context_manager._estimate_tokens(resolved)

        if (
            estimated_tokens >= max_tokens * trigger_ratio
            or len(resolved) >= config.max_history_turns * 2 - 2
        ):
            self.logger.info(
                f"触发上下文压缩: tokens={estimated_tokens}/{max_tokens} "
                f"({estimated_tokens/max_tokens*100:.1f}%), "
                f"消息数={len(resolved)}"
            )

            # 4. 确定被摘要段
            start_idx = 0
            if resolved and (resolved[0].get("metadata") or {}).get("compression"):
                start_idx = 1  # 跳过已有摘要

            segment = resolved[start_idx : start_idx + compress_oldest_n]

            if segment:
                # 5. 生成摘要（使用 LLM）
                summary_content = self._generate_compression_summary(
                    segment=segment,
                    resolved=resolved,
                    context=context,
                    config=config
                )

                if summary_content:
                    # 6. 应用压缩（LLM 摘要成功）
                    resolved = self._apply_compression(
                        summary_content=summary_content,
                        segment=segment,
                        history_with_meta=history_with_meta,
                        context=context,
                        fallback=False
                    )

                    # 7. 发布事件（由 routes/agent.py 的订阅者持久化到 DB）
                    if publisher:
                        publisher.compression_summary(summary_content)

                else:
                    # 8. 降级策略：规则压缩
                    self.logger.warning("摘要生成失败，使用降级策略")

                    # 降级策略 1：强制滑动窗口
                    windowed_messages = self.context_manager._apply_sliding_window(history_with_meta)

                    # 降级策略 2：添加规则摘要消息
                    rule_summary = f"[历史摘要]\n（共 {len(segment)} 条消息已通过规则压缩，保留最近对话）"

                    # 应用降级压缩
                    resolved = self._apply_fallback_compression(
                        rule_summary=rule_summary,
                        windowed_messages=windowed_messages,
                        context=context
                    )

                    # 发布降级事件（由 routes/agent.py 的订阅者持久化到 DB）
                    if publisher:
                        publisher.compression_summary(rule_summary)

        return resolved

    def _generate_compression_summary(
        self,
        segment: List[Dict[str, Any]],
        resolved: List[Dict[str, Any]],
        context: AgentContext,
        config: ContextConfig
    ) -> str:
        """
        生成压缩摘要（使用 LLM）

        Args:
            segment: 被摘要的消息段
            resolved: 解析后的完整消息列表
            context: 智能体上下文
            config: 上下文配置

        Returns:
            摘要内容（成功）或空字符串（失败）
        """
        def _llm_callback(msgs):
            """LLM 摘要回调"""
            llm_config = self.get_llm_config(context)
            provider = llm_config.get('provider')
            provider_type = llm_config.get('provider_type')

            if not provider:
                return ""

            # 构建摘要请求
            lines = []
            for m in msgs:
                role = m.get("role", "user")
                content = (m.get("content") or "").strip()
                if content:
                    # 截断过长内容
                    lines.append(f"{role}: {content[:500]}" + ("..." if len(content) > 500 else ""))

            text = "\n".join(lines) or "（无内容）"

            # 如果已有历史摘要，提取它
            existing_summary = ""
            if resolved and (resolved[0].get("metadata") or {}).get("compression"):
                existing_summary = resolved[0].get("content", "")

            # 构建请求
            if existing_summary:
                prompt = f"""以下是之前的对话摘要：
{existing_summary}

以下是新的对话内容：
{text}

请将上述历史摘要和新对话合并为一段简短摘要，保留关键事实和结论。只输出摘要正文，不要其他说明。"""
            else:
                prompt = f"""请将以下对话压缩为一段简短摘要，保留关键事实和结论。只输出摘要正文，不要其他说明。

{text}"""

            req = [
                {"role": "system", "content": "你是一个对话摘要助手。"},
                {"role": "user", "content": prompt}
            ]

            try:
                resp = self.model_adapter.chat_completion(
                    messages=req,
                    provider=provider,
                    provider_type=provider_type,
                    temperature=0.2,
                    max_tokens=getattr(config, "summarize_max_tokens", 200),
                )

                if getattr(resp, "error", None):
                    self.logger.warning(f"LLM 摘要失败: {resp.error}")
                    return ""

                return (resp.content or "").strip()
            except Exception as e:
                self.logger.warning(f"LLM 摘要异常: {e}")
                return ""

        summary_content = self.context_manager._generate_summary(
            segment,
            llm_callback=_llm_callback
        )

        if summary_content:
            # 确保摘要有标记
            if not summary_content.startswith("[历史摘要]"):
                summary_content = "[历史摘要]\n" + summary_content

            self.logger.info(f"生成摘要成功: {len(summary_content)} 字符")

        return summary_content

    def _apply_compression(
        self,
        summary_content: str,
        segment: List[Dict[str, Any]],
        history_with_meta: List[Dict[str, Any]],
        context: AgentContext,
        fallback: bool = False
    ) -> List[Dict[str, Any]]:
        """
        应用压缩（LLM 摘要成功）

        Args:
            summary_content: 摘要内容
            segment: 被摘要的消息段
            history_with_meta: 完整历史消息
            context: 智能体上下文
            fallback: 是否为降级摘要

        Returns:
            解析后的消息列表
        """
        # 构造摘要消息
        summary_message = {
            "role": "system",
            "content": summary_content,
            "metadata": {"compression": True, "fallback": fallback}
        }

        # 找到被摘要段的最后一条消息在 history_with_meta 中的位置
        last_summarized_msg = segment[-1] if segment else None
        remaining_messages = []

        if last_summarized_msg:
            # 在 history_with_meta 中找到这条消息的索引
            found_idx = -1
            for idx, m in enumerate(history_with_meta):
                if (
                    m.get("role") == last_summarized_msg.get("role")
                    and m.get("content") == last_summarized_msg.get("content")
                ):
                    found_idx = idx
                    break

            if found_idx >= 0:
                remaining_messages = history_with_meta[found_idx + 1:]
            else:
                # 降级：保留所有消息
                remaining_messages = history_with_meta
        else:
            remaining_messages = history_with_meta

        updated_raw = [summary_message] + remaining_messages

        # 写回 context
        from .models import Message
        context.conversation_history = [
            Message(
                role=m.get("role", "user"),
                content=m.get("content", ""),
                metadata=m.get("metadata") or {}
            )
            for m in updated_raw
            if m.get("role") in ("user", "assistant", "system")
        ]

        # 重算视图
        from ..context import ContextManager
        resolved = ContextManager.resolve_compression_view(updated_raw)

        self.logger.info(
            f"压缩完成: {len(history_with_meta)} -> {len(updated_raw)} 条原始消息, "
            f"{len(resolved)} 条解析后消息"
        )

        return resolved

    def _apply_fallback_compression(
        self,
        rule_summary: str,
        windowed_messages: List[Dict[str, Any]],
        context: AgentContext
    ) -> List[Dict[str, Any]]:
        """
        应用降级压缩（规则摘要）

        Args:
            rule_summary: 规则摘要内容
            windowed_messages: 滑动窗口后的消息
            context: 智能体上下文

        Returns:
            解析后的消息列表
        """
        summary_message = {
            "role": "system",
            "content": rule_summary,
            "metadata": {"compression": True, "fallback": True}
        }

        updated_raw = [summary_message] + windowed_messages

        # 写回 context
        from .models import Message
        context.conversation_history = [
            Message(
                role=m.get("role", "user"),
                content=m.get("content", ""),
                metadata=m.get("metadata") or {}
            )
            for m in updated_raw
            if m.get("role") in ("user", "assistant", "system")
        ]

        # 重算视图
        from ..context import ContextManager
        resolved = ContextManager.resolve_compression_view(updated_raw)

        self.logger.info(
            f"降级压缩完成: {len(windowed_messages)} 条原始消息, "
            f"{len(resolved)} 条解析后消息"
        )

        return resolved

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__}(name='{self.name}')>"


class AgentExecutionError(Exception):
    """智能体执行错误"""

    def __init__(self, agent_name: str, message: str, original_error: Optional[Exception] = None):
        self.agent_name = agent_name
        self.message = message
        self.original_error = original_error
        super().__init__(f"[{agent_name}] {message}")
