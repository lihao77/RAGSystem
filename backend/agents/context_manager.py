# -*- coding: utf-8 -*-
"""
智能体上下文管理器

提供对话历史的智能管理，包括：
1. 滑动窗口管理（保留最近 N 轮对话）
2. Token 估算和限制
3. 历史摘要（可选）
4. 消息压缩策略
"""

import logging
from typing import List, Dict, Any, Optional
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class ContextConfig:
    """上下文管理配置"""
    max_history_turns: int = 10  # 最大保留轮数
    max_tokens: int = 8000  # 最大 token 数（估算）
    keep_system_prompt: bool = True  # 是否始终保留 system prompt
    compression_strategy: str = "sliding_window"  # 压缩策略: sliding_window, summarize


class ContextManager:
    """
    上下文管理器

    负责管理智能体的对话历史，防止超出模型上下文限制
    """

    def __init__(self, config: Optional[ContextConfig] = None):
        """
        初始化上下文管理器

        Args:
            config: 上下文配置
        """
        self.config = config or ContextConfig()
        self.logger = logging.getLogger(f"{__name__}.ContextManager")

    def manage_messages(
        self,
        messages: List[Dict[str, Any]],
        system_prompt: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        管理消息列表，确保不超出上下文限制

        Args:
            messages: 原始消息列表
            system_prompt: 系统提示词（可选，如果提供则始终保留）

        Returns:
            压缩后的消息列表
        """
        if len(messages) == 0:
            return messages

        # 1. 分离系统消息和对话消息
        system_messages = []
        conversation_messages = []

        for msg in messages:
            if msg.get('role') == 'system':
                system_messages.append(msg)
            else:
                conversation_messages.append(msg)

        # 2. 估算当前 token 数
        estimated_tokens = self._estimate_tokens(messages)

        # 3. 如果超出限制，应用压缩策略
        if estimated_tokens > self.config.max_tokens or len(conversation_messages) > self.config.max_history_turns * 2:
            self.logger.info(
                f"上下文过长（估算 {estimated_tokens} tokens，{len(conversation_messages)} 条消息），"
                f"应用 {self.config.compression_strategy} 压缩策略"
            )

            if self.config.compression_strategy == "sliding_window":
                conversation_messages = self._apply_sliding_window(conversation_messages)
            elif self.config.compression_strategy == "summarize":
                conversation_messages = self._apply_summarize(conversation_messages)

        # 4. 重新组合消息
        result = []

        # 保留系统消息
        if self.config.keep_system_prompt and system_messages:
            result.extend(system_messages)

        # 添加对话消息
        result.extend(conversation_messages)

        self.logger.info(
            f"上下文管理完成: {len(messages)} -> {len(result)} 条消息, "
            f"估算 {self._estimate_tokens(result)} tokens"
        )

        return result

    def _apply_sliding_window(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        应用滑动窗口策略：保留最近 N 轮对话

        1 轮 = 1 个 user 消息 + 1 个 assistant 消息
        """
        max_messages = self.config.max_history_turns * 2

        if len(messages) <= max_messages:
            return messages

        # 保留最近的 N 轮
        kept_messages = messages[-max_messages:]

        # 添加省略提示
        ellipsis_message = {
            "role": "user",
            "content": f"[系统提示：为节省上下文，已省略前 {len(messages) - max_messages} 条历史消息]"
        }

        return [ellipsis_message] + kept_messages

    def _apply_summarize(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        应用摘要策略：将旧消息摘要，保留最近对话

        TODO: 需要 LLM 支持，暂时回退到滑动窗口
        """
        self.logger.warning("摘要策略暂未实现，回退到滑动窗口策略")
        return self._apply_sliding_window(messages)

    def _estimate_tokens(self, messages: List[Dict[str, Any]]) -> int:
        """
        估算消息列表的 token 数量

        使用简单的启发式估算：
        - 中文: 1 字符 ≈ 1.5 token
        - 英文: 1 单词 ≈ 1.3 token
        - JSON: 按字符数 / 3

        Args:
            messages: 消息列表

        Returns:
            估算的 token 数
        """
        total_tokens = 0

        for msg in messages:
            content = msg.get('content', '')

            if not content:
                continue

            # 简单估算：每个字符约 1.2 个 token（中英文混合）
            # 这是一个保守估计，实际可以使用 tiktoken 库精确计算
            char_count = len(content)

            # 检查是否包含大量 JSON（工具调用结果）
            if content.strip().startswith('{') or content.strip().startswith('['):
                # JSON 内容，token 数较少
                total_tokens += char_count // 3
            else:
                # 普通文本
                total_tokens += int(char_count * 1.2)

        return total_tokens

    def extract_recent_turns(
        self,
        messages: List[Dict[str, Any]],
        n_turns: int = 3
    ) -> List[Dict[str, Any]]:
        """
        提取最近 N 轮对话（用于上下文传递）

        Args:
            messages: 完整消息列表
            n_turns: 保留轮数

        Returns:
            最近 N 轮的消息
        """
        # 过滤掉 system 消息
        conversation = [msg for msg in messages if msg.get('role') != 'system']

        # 保留最近 N 轮
        max_messages = n_turns * 2
        return conversation[-max_messages:] if len(conversation) > max_messages else conversation

    def format_context_summary(self, messages: List[Dict[str, Any]]) -> str:
        """
        生成上下文摘要（用于日志或调试）

        Args:
            messages: 消息列表

        Returns:
            摘要字符串
        """
        if not messages:
            return "空上下文"

        system_count = sum(1 for msg in messages if msg.get('role') == 'system')
        user_count = sum(1 for msg in messages if msg.get('role') == 'user')
        assistant_count = sum(1 for msg in messages if msg.get('role') == 'assistant')

        estimated_tokens = self._estimate_tokens(messages)

        return (
            f"消息总数: {len(messages)} "
            f"(system: {system_count}, user: {user_count}, assistant: {assistant_count}), "
            f"估算 tokens: {estimated_tokens}"
        )


class ObservationFormatter:
    """
    工具观察结果格式化器

    负责将工具返回结果格式化为紧凑、易读的观察文本
    """

    # 大数据阈值（字符数）
    LARGE_DATA_THRESHOLD = 2000

    # 摘要长度限制
    SUMMARY_MAX_LENGTH = 300

    def __init__(self, data_save_dir: str = "./static/temp_data"):
        """
        初始化格式化器

        Args:
            data_save_dir: 大数据文件保存目录
        """
        self.data_save_dir = data_save_dir
        self.logger = logging.getLogger(f"{__name__}.ObservationFormatter")

    def format(
        self,
        result: Any,
        tool_name: str = None,
        is_skills_tool: bool = False
    ) -> str:
        """
        格式化工具执行结果

        Args:
            result: 工具返回结果
            tool_name: 工具名称
            is_skills_tool: 是否为 Skills 相关工具

        Returns:
            格式化后的观察文本
        """
        # 1. 处理错误响应
        if isinstance(result, dict) and not result.get('success'):
            return f"❌ 错误: {result.get('error', '未知错误')}"

        # 2. 处理 Skills 工具（特殊逻辑）
        if is_skills_tool:
            return self._format_skills_result(result)

        if tool_name == "query_emergency_plan":
            return result.get('data', '无数据返回')

        # 3. 处理标准化工具响应
        if isinstance(result, dict) and result.get('success'):
            return self._format_standard_response(result, tool_name)

        # 4. 兼容非标准响应
        return str(result)

    def _format_skills_result(self, result: Dict[str, Any]) -> str:
        """
        格式化 Skills 工具返回结果

        Skills 工具返回的是 Markdown 内容，应该直接呈现给 AI
        """
        if not isinstance(result, dict):
            return str(result)

        data = result.get('data', {})
        pure_data = data.get('results', data)
        summary = data.get('summary', '')

        # 提取 Skill 内容
        if isinstance(pure_data, dict):
            skill_content = pure_data.get('main_content') or pure_data.get('content')
            if skill_content:
                return f"✅ {summary}\n\n{skill_content}" if summary else skill_content

        # 回退：返回完整 data
        import json
        return json.dumps(data, ensure_ascii=False, indent=2)

    def _format_standard_response(self, result: Dict[str, Any], tool_name: str = None) -> str:
        """
        格式化标准化工具响应

        标准格式：
        {
            "success": true,
            "data": {
                "results": ...,
                "metadata": {...},
                "summary": "...",
                "answer": "..."
            }
        }
        """
        import json
        import os
        import uuid

        data = result.get('data', {})
        pure_data = data.get('results', data)
        summary = data.get('summary', '')
        metadata = data.get('metadata', {})
        answer = data.get('answer')

        # 转换为字符串以判断大小
        content_str = json.dumps(pure_data, ensure_ascii=False) if isinstance(pure_data, (dict, list)) else str(pure_data)

        # 【小数据】直接返回
        if len(content_str) < self.LARGE_DATA_THRESHOLD:
            if answer:
                # 查询类工具：返回 answer + 数据详情
                return f"✅ {answer}\n\n📊 数据详情:\n```json\n{json.dumps(pure_data, ensure_ascii=False, indent=2)[:500]}\n```"
            else:
                # 普通工具：返回摘要 + 数据
                prefix = f"✅ {summary}\n\n" if summary else "✅ 执行成功\n\n"
                return f"{prefix}```json\n{json.dumps(pure_data, ensure_ascii=False, indent=2)}\n```"

        # 【大数据】保存文件并返回引用
        file_name = f"data_{uuid.uuid4().hex[:8]}.json"
        os.makedirs(self.data_save_dir, exist_ok=True)
        file_path = os.path.join(self.data_save_dir, file_name)

        # 保存纯净数据
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(pure_data, f, ensure_ascii=False, indent=2)

        # 构建紧凑的元数据提示
        meta_info_parts = []

        if summary:
            meta_info_parts.append(summary)

        # 从 metadata 提取关键信息
        if metadata:
            total_count = metadata.get('total_count')
            data_type = metadata.get('data_type', 'List')
            fields = metadata.get('fields', [])

            if total_count:
                meta_info_parts.append(f"{data_type}: {total_count} 条记录")

            if fields:
                field_names = [f['name'] for f in fields[:5]]
                field_str = ', '.join(field_names)
                if len(fields) > 5:
                    field_str += f" 等 {len(fields)} 个字段"
                meta_info_parts.append(f"字段: {field_str}")

        meta_info = " | ".join(meta_info_parts) if meta_info_parts else "数据量过大"

        # 构建返回信息（紧凑格式）
        parts = []

        if answer:
            parts.append(f"✅ {answer}\n")

        parts.append(f"📁 数据已存储: {file_path}")
        parts.append(f"📊 {meta_info}")
        parts.append(f"💡 后续工具可直接使用此文件路径作为参数")

        # 显示样本数据（可选）
        if metadata.get('sample'):
            sample = metadata['sample']
            sample_str = json.dumps(sample, ensure_ascii=False)
            if len(sample_str) > 200:
                sample_str = sample_str[:200] + "..."
            parts.append(f"📝 样本: {sample_str}")

        return "\n".join(parts)
