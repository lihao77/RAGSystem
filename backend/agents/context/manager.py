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
from typing import List, Dict, Any, Optional
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class ContextConfig:
    """上下文管理配置"""
    # 预算
    max_tokens: int = 8000          # 由 budget.py 计算传入
    model_name: Optional[str] = None  # 用于 tiktoken 选择 encoding

    # 压缩触发
    compression_trigger_ratio: float = 0.85  # history tokens 达该比例时触发 LLM 压缩

    # LLM 摘要
    summarize_max_tokens: int = 300          # 摘要 token 上限

    # 降级
    preserve_recent_turns: int = 3           # 滑动窗口降级时强制保留的最近 N 轮


class ContextManager:
    """
    上下文管理器（精简版）

    保留静态工具方法和辅助方法，压缩逻辑已移入 ContextPipeline。
    """

    def __init__(self, config: Optional[ContextConfig] = None):
        self.config = config or ContextConfig()
        self.logger = logging.getLogger(f"{__name__}.ContextManager")
        from .token_counter import TokenCounter
        self._token_counter = TokenCounter(model_name=self.config.model_name)

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
        compression_meta = parsed_metadata[compression_idx]
        # replaces_up_to_seq：摘要所覆盖的最后一条原始消息的 seq。
        # 有此字段时，只隐藏 seq ≤ replaces_up_to_seq 的消息，从而保留
        # segment 之后、摘要之前的 remaining 消息（避免跨会话丢失）。
        replaces_up_to_seq = compression_meta.get("replaces_up_to_seq")
        out = []

        # 添加摘要消息
        out.append({
            "role": "system",
            "content": compression_msg.get("content", ""),
            "metadata": {"compression": True}
        })

        # 输出「摘要之后的消息」
        if summary_seq is not None:
            # 有 seq：优先用 replaces_up_to_seq 决定边界，回退到 summary_seq
            cutoff = replaces_up_to_seq if replaces_up_to_seq is not None else summary_seq
            for m, meta in zip(messages, parsed_metadata):
                if meta.get("compression"):
                    continue  # 跳过所有压缩摘要消息本身
                if m.get("seq") is not None and m["seq"] > cutoff:
                    out.append({
                        "role": m.get("role", "user"),
                        "content": m.get("content", ""),
                        "metadata": meta
                    })
        else:
            # seq is None（in-memory 摘要）：按列表位置，输出所有出现在该摘要之后的消息
            for idx in range(compression_idx + 1, len(messages)):
                m = messages[idx]
                meta = parsed_metadata[idx]
                out.append({
                    "role": m.get("role", "user"),
                    "content": m.get("content", ""),
                    "metadata": meta
                })

        return out

    def _estimate_tokens(self, messages: List[Dict[str, Any]]) -> int:
        """
        计算消息列表的 token 数量。

        优先使用 tiktoken 精确计数，不可用时降级到启发式估算。
        """
        return self._token_counter.count_messages(messages)

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

        # 【字符串内容】直接输出，不做 JSON 序列化（避免转义）
        if isinstance(pure_data, str):
            prefix = f"✅ {summary}\n\n" if summary else "✅ 执行成功\n\n"
            if len(pure_data) <= self.LARGE_DATA_THRESHOLD:
                return f"{prefix}{pure_data}"
            else:
                return f"{prefix}{pure_data[:self.LARGE_DATA_THRESHOLD]}\n...（内容过长，已截断）"

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
            if isinstance(pure_data, str):
                # 已经是字符串（如某些工具直接返回文本）：直接写，不再套一层 json.dump
                f.write(pure_data)
            else:
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
