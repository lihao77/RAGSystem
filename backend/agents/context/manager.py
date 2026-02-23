# -*- coding: utf-8 -*-
"""
智能体上下文管理器

提供对话历史的智能管理，包括：
1. 滑动窗口管理（保留最近 N 轮对话）
2. Token 估算和限制
3. 历史摘要（可选）
4. 消息压缩策略
"""

import json
import logging
from typing import List, Dict, Any, Optional, Callable
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class ContextConfig:
    """上下文管理配置"""
    max_history_turns: int = 10  # 最大保留轮数
    max_tokens: int = 8000  # 最大 token 数（估算）
    keep_system_prompt: bool = True  # 是否始终保留 system prompt
    compression_strategy: str = "sliding_window"  # 压缩策略: sliding_window, smart, summarize

    # 智能压缩策略配置
    preserve_tool_results: bool = True  # 是否保留工具调用结果
    preserve_recent_turns: int = 3  # 始终保留最近 N 轮对话
    importance_threshold: float = 0.5  # 重要性阈值（0-1）

    # 摘要策略配置（compression_strategy=summarize 时使用）
    summarize_use_llm: bool = True  # 是否使用 LLM 生成摘要
    summarize_max_tokens: int = 200  # 摘要最大 token 数

    # 持久化智能压缩触发（加载/执行中接近上限时）
    compression_trigger_ratio: float = 0.85  # 达到 max_tokens 的该比例时触发
    compress_oldest_n: int = 4  # 首次压缩时取最早 N 条做摘要


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
            elif self.config.compression_strategy == "smart":
                conversation_messages = self._apply_smart_compression(conversation_messages)
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

    @staticmethod
    def resolve_compression_view(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        解析持久化压缩视图：若存在 compression 消息，用最后一条摘要顶替其前全部消息。

        改进：
        1. 支持 seq=None 的 in-memory 摘要（同请求内生成的摘要优先）
        2. 当 summary_seq is None 时，按列表位置输出后续消息
        3. ✨ 缓存 JSON 解析结果，避免重复解析 metadata（性能优化）

        输入：来自 store 的原始列表，按 seq 有序，每项含 seq, role, content, metadata。
        返回：给 LLM/填 context 用的消息列表（摘要顶替「该摘要之前的所有内容」）。
        """
        if not messages:
            return []

        compression_msg = None
        compression_idx = -1

        # ✨ 性能优化：预解析所有 metadata，避免重复 json.loads()
        parsed_metadata = []
        for m in messages:
            meta = m.get("metadata") or {}
            if isinstance(meta, str):
                try:
                    meta = json.loads(meta) if meta else {}
                except Exception:
                    meta = {}
            parsed_metadata.append(meta)

        # 查找最后一条有效的压缩摘要
        for idx, (m, meta) in enumerate(zip(messages, parsed_metadata)):
            if meta.get("compression"):
                # 选取有效摘要的逻辑：
                # 1. 若当前没有摘要，选当前
                # 2. 若当前 m.get("seq") is None（in-memory 摘要），选当前（覆盖已有）
                # 3. 若已有 compression_msg.get("seq") is None 而当前有 seq，保留已有（in-memory 优先）
                # 4. 否则两者都有 seq 时，取 m["seq"] > compression_msg["seq"] 时选当前
                if compression_msg is None:
                    compression_msg = m
                    compression_idx = idx
                elif m.get("seq") is None:
                    # in-memory 摘要优先
                    compression_msg = m
                    compression_idx = idx
                elif compression_msg.get("seq") is None and m.get("seq") is not None:
                    # 保留已有 in-memory 摘要
                    pass
                elif m.get("seq") is not None and compression_msg.get("seq") is not None and m["seq"] > compression_msg["seq"]:
                    compression_msg = m
                    compression_idx = idx

        if compression_msg is None:
            return list(messages)

        summary_seq = compression_msg.get("seq")
        out = []

        # 添加摘要消息
        out.append({
            "role": "system",
            "content": compression_msg.get("content", ""),
            "metadata": {"compression": True}
        })

        # 输出「摘要之后的消息」
        if summary_seq is not None:
            # 有 seq：按 seq > summary_seq 过滤
            for m, meta in zip(messages, parsed_metadata):
                if m.get("seq") is not None and m["seq"] > summary_seq:
                    out.append({
                        "role": m.get("role", "user"),
                        "content": m.get("content", ""),
                        "metadata": meta  # ✨ 使用缓存的解析结果
                    })
        else:
            # seq is None（in-memory 摘要）：按列表位置，输出所有出现在该摘要之后的消息
            for idx in range(compression_idx + 1, len(messages)):
                m = messages[idx]
                meta = parsed_metadata[idx]
                out.append({
                    "role": m.get("role", "user"),
                    "content": m.get("content", ""),
                    "metadata": meta  # ✨ 使用缓存的解析结果
                })

        return out

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

    def _apply_smart_compression(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        智能压缩策略：基于重要性保留消息

        策略：
        1. 始终保留最近 N 轮对话（保持对话连贯性）
        2. 保留包含工具调用结果的消息（重要数据）
        3. 保留高重要性评分的消息
        4. 丢弃低重要性的纯文本对话

        Args:
            messages: 完整消息列表

        Returns:
            压缩后的消息列表
        """
        if len(messages) == 0:
            return messages

        # 1. 计算每条消息的重要性评分
        scored_messages = []
        for idx, msg in enumerate(messages):
            importance = self._calculate_message_importance(msg, idx, len(messages))
            scored_messages.append({
                'message': msg,
                'importance': importance,
                'index': idx
            })

        # 2. 强制保留最近 N 轮对话
        recent_count = self.config.preserve_recent_turns * 2
        must_keep_indices = set(range(max(0, len(messages) - recent_count), len(messages)))

        # 3. 提取包含工具结果的消息索引
        tool_result_indices = self._extract_tool_result_indices(messages)

        # 4. 按重要性排序，选择要保留的消息
        kept_items = []
        for item in scored_messages:
            idx = item['index']

            # 必须保留：最近对话或工具结果
            if idx in must_keep_indices:
                kept_items.append(item)
            elif self.config.preserve_tool_results and idx in tool_result_indices:
                kept_items.append(item)
            # 可选保留：高重要性消息
            elif item['importance'] >= self.config.importance_threshold:
                kept_items.append(item)

        # 5. 按原始顺序排序
        kept_items.sort(key=lambda x: x['index'])

        # 6. 检查 token 是否仍然超标
        kept_messages = [item['message'] for item in kept_items]
        estimated_tokens = self._estimate_tokens(kept_messages)

        # 如果仍然超标，进一步压缩：对工具结果进行摘要
        if estimated_tokens > self.config.max_tokens:
            self.logger.info(f"智能压缩后仍超标（{estimated_tokens} tokens），对工具结果进行摘要")
            kept_messages = self._summarize_tool_results(kept_messages, tool_result_indices)

        # 7. 添加省略提示
        omitted_count = len(messages) - len(kept_messages)
        if omitted_count > 0:
            ellipsis_message = {
                "role": "user",
                "content": f"[智能压缩：已省略 {omitted_count} 条低重要性消息，保留了工具调用结果和关键对话]"
            }
            kept_messages.insert(0, ellipsis_message)

        self.logger.info(
            f"智能压缩完成: {len(messages)} -> {len(kept_messages)} 条消息 "
            f"(保留率: {len(kept_messages)/len(messages)*100:.1f}%)"
        )

        return kept_messages

    def _calculate_message_importance(self, message: Dict[str, Any], index: int, total: int) -> float:
        """
        计算消息的重要性评分（0-1）

        评分标准：
        - 位置权重：越靠后越重要（最近对话更重要）
        - 内容权重：包含特定标志的消息更重要
        - 长度权重：内容较长的消息可能更重要

        Args:
            message: 消息对象
            index: 消息在列表中的索引
            total: 消息总数

        Returns:
            重要性评分（0-1）
        """
        content = message.get('content', '')
        role = message.get('role', '')

        # 基础评分：位置权重（0.2 - 0.5）
        # 最近的消息基础分更高
        position_score = 0.2 + (index / total) * 0.3

        # 内容评分（0 - 0.5）
        content_score = 0.0

        # 用户消息更重要（需保留用于上下文）
        if role == 'user':
            content_score += 0.3

        # 包含最终答案的消息最重要
        if 'final_answer' in content or '"final_answer"' in content:
            content_score += 0.4

        # 包含工具调用结果的标志（高重要性）
        tool_markers = ['✅', '📊', '📁', 'Agent 执行结果', 'tool_name', '数据已存储']
        if any(marker in content for marker in tool_markers):
            content_score += 0.4

        # 包含错误或警告（高重要性）
        error_markers = ['❌', '错误', 'Error', 'error', '失败']
        if any(marker in content for marker in error_markers):
            content_score += 0.3

        # 包含思考过程（中等重要性，略降以避免过多 thought 占用）
        thought_markers = ['思考', 'thought', '分析', '决策']
        if any(marker in content for marker in thought_markers):
            content_score += 0.1

        # 系统提示（低重要性）
        if '[系统提示' in content or '[智能压缩' in content or '[历史摘要]' in content:
            content_score -= 0.2

        # 长度权重（0 - 0.2）
        # 内容较长可能包含更多信息
        length_score = min(len(content) / 1000, 1.0) * 0.2

        # 总分 = 位置 + 内容 + 长度
        total_score = position_score + content_score + length_score

        # 限制在 0-1 范围内
        return max(0.0, min(1.0, total_score))

    def _extract_tool_result_indices(self, messages: List[Dict[str, Any]]) -> set:
        """
        提取包含工具调用结果的消息索引

        Args:
            messages: 消息列表

        Returns:
            包含工具结果的消息索引集合
        """
        tool_result_indices = set()

        # 标志：表示消息包含工具调用结果
        tool_markers = [
            '✅', '📊', '📁', '❌',  # Emoji 标志
            'Agent 执行结果', 'Agent', 'tool_name',  # 文本标志
            '数据已存储', '数据详情',  # ObservationFormatter 输出标志
            '```json',  # JSON 数据块
        ]

        for idx, msg in enumerate(messages):
            content = msg.get('content', '')

            # 检查是否包含工具结果标志
            if any(marker in content for marker in tool_markers):
                tool_result_indices.add(idx)

            # 检查是否是 assistant 消息且内容较长（可能是 ReAct 轮次结果）
            if msg.get('role') == 'assistant' and len(content) > 500:
                tool_result_indices.add(idx)

        return tool_result_indices

    def _summarize_tool_results(
        self,
        messages: List[Dict[str, Any]],
        tool_result_indices: set
    ) -> List[Dict[str, Any]]:
        """
        对工具调用结果进行摘要（进一步压缩）

        策略：
        1. 保留工具结果的元数据和摘要
        2. 截断详细的 JSON 数据
        3. 保留文件引用路径

        Args:
            messages: 消息列表
            tool_result_indices: 工具结果消息索引

        Returns:
            摘要后的消息列表
        """
        import re

        summarized = []

        for idx, msg in enumerate(messages):
            if idx not in tool_result_indices:
                # 非工具结果消息：直接保留
                summarized.append(msg)
                continue

            # 工具结果消息：进行摘要
            content = msg.get('content', '')

            # 1. 保留文件引用（重要）
            file_refs = re.findall(r'数据已存储:\s*([^\n]+)', content)

            # 2. 提取摘要信息
            summary_parts = []

            # 提取 ✅ 行（执行成功提示）
            success_lines = [line for line in content.split('\n') if line.strip().startswith('✅')]
            summary_parts.extend(success_lines[:2])  # 最多保留 2 行

            # 提取 📊 行（元数据）
            meta_lines = [line for line in content.split('\n') if '📊' in line or '📁' in line]
            summary_parts.extend(meta_lines)

            # 3. 构建压缩后的内容
            compressed_content = '\n'.join(summary_parts)

            # 添加文件引用
            if file_refs:
                compressed_content += f"\n📁 数据文件: {file_refs[0]}"

            # 添加省略提示
            if len(compressed_content) < len(content) * 0.5:
                compressed_content += "\n💡 [详细数据已省略，可通过文件路径访问]"

            # 创建压缩后的消息
            summarized.append({
                'role': msg.get('role'),
                'content': compressed_content or content[:200] + "..."  # 降级：至少保留前 200 字符
            })

        return summarized

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

    def _generate_summary(
        self,
        messages: List[Dict[str, Any]],
        llm_callback: Optional[Callable[[List[Dict[str, Any]]], str]] = None
    ) -> str:
        """
        对一段消息生成摘要，供持久化压缩使用。
        若传入 llm_callback(messages) -> str，则调用 LLM 生成摘要；否则返回规则兜底摘要。
        """
        if llm_callback is not None:
            try:
                return llm_callback(messages) or ""
            except Exception as e:
                self.logger.warning("LLM 摘要失败，使用兜底摘要: %s", e)
        return "[历史摘要]\n（共 {} 条消息已压缩）".format(len(messages))

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

    def _estimate_size_fast(self, data: Any) -> int:
        """
        快速估算数据大小（避免完整序列化）

        策略：
        - 字符串：直接返回长度
        - 列表：采样前 10 个元素，推算总大小
        - 字典：采样前 10 个键值对，推算总大小

        Args:
            data: 要估算的数据

        Returns:
            估算的字符数
        """
        import json

        if isinstance(data, str):
            return len(data)

        elif isinstance(data, list):
            if len(data) == 0:
                return 2  # "[]"

            # 如果列表较小，直接序列化
            if len(data) <= 10:
                return len(json.dumps(data, ensure_ascii=False))

            # 采样前 10 个元素
            sample = data[:10]
            sample_size = len(json.dumps(sample, ensure_ascii=False))

            # 推算总大小（线性外推）
            estimated_total = sample_size * (len(data) / len(sample))
            return int(estimated_total)

        elif isinstance(data, dict):
            if len(data) == 0:
                return 2  # "{}"

            # 如果字典较小，直接序列化
            if len(data) <= 10:
                return len(json.dumps(data, ensure_ascii=False))

            # 采样前 10 个键值对
            sample = dict(list(data.items())[:10])
            sample_size = len(json.dumps(sample, ensure_ascii=False))

            # 推算总大小
            estimated_total = sample_size * (len(data) / len(sample))
            return int(estimated_total)

        else:
            # 其他类型（数字、布尔等）
            return len(str(data))

    def _format_standard_response(self, result: Dict[str, Any], tool_name: str = None) -> str:
        """
        格式化标准化工具响应（优化版）

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

        # 🎯 优化：先快速估算大小，避免不必要的完整序列化
        estimated_size = self._estimate_size_fast(pure_data)

        self.logger.debug(f"数据大小估算: {estimated_size} 字符（阈值: {self.LARGE_DATA_THRESHOLD}）")

        # 【小数据】直接返回（此时才进行完整序列化）
        if estimated_size < self.LARGE_DATA_THRESHOLD:
            # 仅在需要时才完整序列化
            content_str = json.dumps(pure_data, ensure_ascii=False) if isinstance(pure_data, (dict, list)) else str(pure_data)

            if answer:
                # 查询类工具：返回 answer + 数据详情
                return f"✅ {answer}\n\n📊 数据详情:\n```json\n{content_str[:500]}\n```"
            else:
                # 普通工具：返回摘要 + 数据
                prefix = f"✅ {summary}\n\n" if summary else "✅ 执行成功\n\n"
                return f"{prefix}```json\n{content_str}\n```"

        # 【大数据】保存文件并返回引用（跳过序列化）
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
