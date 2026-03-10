# -*- coding: utf-8 -*-
"""Tool observation formatting helpers."""

from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any, Dict


class ObservationFormatter:
    """
    Format tool responses into compact observations for the next LLM turn.
    """

    LARGE_DATA_THRESHOLD = 8000
    SUMMARY_MAX_LENGTH = 300

    def __init__(self, data_save_dir: str = "./static/temp_data"):
        self.data_save_dir = data_save_dir
        self.logger = logging.getLogger(f"{__name__}.ObservationFormatter")

    def format(
        self,
        result: Any,
        tool_name: str = None,
        is_skills_tool: bool = False,
        no_truncate: bool = False,
    ) -> str:
        del tool_name, no_truncate

        if isinstance(result, dict) and not result.get("success"):
            return f"❌ 错误: {result.get('error', '未知错误')}"

        if is_skills_tool:
            return self._format_skills_result(result)

        if isinstance(result, dict) and result.get("success"):
            return self._format_standard_response(result)

        return str(result)

    def _format_skills_result(self, result: Dict[str, Any]) -> str:
        if not isinstance(result, dict):
            return str(result)

        data = result.get("data", {})
        pure_data = data.get("results", data)
        summary = data.get("summary", "")

        if isinstance(pure_data, dict):
            skill_content = pure_data.get("main_content") or pure_data.get("content")
            if skill_content:
                return f"✅ {summary}\n\n{skill_content}" if summary else skill_content

        return json.dumps(data, ensure_ascii=False, indent=2)

    def _estimate_size_fast(self, data: Any) -> int:
        if isinstance(data, str):
            return len(data)

        if isinstance(data, list):
            if len(data) == 0:
                return 2
            if len(data) <= 10:
                return len(json.dumps(data, ensure_ascii=False))

            sample = data[:10]
            sample_size = len(json.dumps(sample, ensure_ascii=False))
            return int(sample_size * (len(data) / len(sample)))

        if isinstance(data, dict):
            if len(data) == 0:
                return 2
            if len(data) <= 10:
                return len(json.dumps(data, ensure_ascii=False))

            sample = dict(list(data.items())[:10])
            sample_size = len(json.dumps(sample, ensure_ascii=False))
            return int(sample_size * (len(data) / len(sample)))

        return len(str(data))

    def _format_standard_response(self, result: Dict[str, Any]) -> str:
        data = result.get("data", {})
        pure_data = data.get("results", data)
        summary = data.get("summary", "")
        metadata = data.get("metadata", {})
        answer = data.get("answer")
        approval_message = result.get("approval_message", "")

        estimated_size = self._estimate_size_fast(pure_data)
        self.logger.debug(
            "数据大小估算: %s 字符（阈值: %s）",
            estimated_size,
            self.LARGE_DATA_THRESHOLD,
        )

        if isinstance(pure_data, str):
            prefix = f"✅ {summary}\n\n" if summary else "✅ 执行成功\n\n"
            if approval_message:
                prefix += f"👤 用户批注: {approval_message}\n\n"
            return f"{prefix}{pure_data}"

        if estimated_size < self.LARGE_DATA_THRESHOLD:
            content_str = (
                json.dumps(pure_data, ensure_ascii=False)
                if isinstance(pure_data, (dict, list))
                else str(pure_data)
            )

            if answer:
                prefix = f"✅ {answer}\n\n"
                if approval_message:
                    prefix += f"👤 用户批注: {approval_message}\n\n"
                return f"{prefix}📊 数据详情:\n```json\n{content_str[:2000]}\n```"

            prefix = f"✅ {summary}\n\n" if summary else "✅ 执行成功\n\n"
            if approval_message:
                prefix += f"👤 用户批注: {approval_message}\n\n"
            return f"{prefix}```json\n{content_str}\n```"

        file_name = f"data_{uuid.uuid4().hex[:8]}.json"
        os.makedirs(self.data_save_dir, exist_ok=True)
        file_path = os.path.join(self.data_save_dir, file_name)

        with open(file_path, "w", encoding="utf-8") as file_obj:
            if isinstance(pure_data, str):
                file_obj.write(pure_data)
            else:
                json.dump(pure_data, file_obj, ensure_ascii=False, indent=2)

        meta_info_parts = []
        if summary:
            meta_info_parts.append(summary)

        if metadata:
            total_count = metadata.get("total_count")
            data_type = metadata.get("data_type", "List")
            fields = metadata.get("fields", [])

            if total_count:
                meta_info_parts.append(f"{data_type}: {total_count} 条记录")

            if fields:
                field_names = [field["name"] for field in fields[:5]]
                field_str = ", ".join(field_names)
                if len(fields) > 5:
                    field_str += f" 等 {len(fields)} 个字段"
                meta_info_parts.append(f"字段: {field_str}")

        meta_info = " | ".join(meta_info_parts) if meta_info_parts else "数据量过大"

        parts = []
        if answer:
            parts.append(f"✅ {answer}\n")
        if approval_message:
            parts.append(f"👤 用户批注: {approval_message}\n")

        parts.append(f"📁 数据已存储: {file_path}")
        parts.append(f"📊 {meta_info}")
        parts.append("💡 后续工具可直接使用此文件路径作为参数")

        if metadata.get("sample"):
            sample = metadata["sample"]
            sample_str = json.dumps(sample, ensure_ascii=False)
            if len(sample_str) > 200:
                sample_str = sample_str[:200] + "..."
            parts.append(f"📝 样本: {sample_str}")

        return "\n".join(parts)
