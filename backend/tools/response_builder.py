# -*- coding: utf-8 -*-
"""
工具响应标准化构造器

统一所有工具的返回格式，确保数据流和控制流清晰分离
"""

from typing import Any, Dict, List, Optional, Union
import pandas as pd


class ToolResponse:
    """
    标准化的工具响应格式

    结构:
    {
        "success": bool,
        "error": str (仅在失败时),
        "data": {
            "results": 纯净数据 (list/dict),      # 核心：可传给下游工具
            "metadata": 元数据 (dict),              # 数据结构信息
            "summary": 简洁摘要 (str),              # Agent 可读描述
            "answer": 完整答案 (str, optional),     # 仅查询类工具
            "debug": 调试信息 (dict, optional)      # 可选调试信息
        }
    }
    """

    @staticmethod
    def success(
        results: Union[List, Dict],
        metadata: Optional[Dict] = None,
        summary: Optional[str] = None,
        answer: Optional[str] = None,
        debug: Optional[Dict] = None
    ) -> Dict:
        """
        构造成功响应

        Args:
            results: 核心数据，必须是纯净的、可传递的数据
            metadata: 元数据字典（total_count, data_type, fields, sample）
            summary: 简洁摘要，如 "查询返回 100 条记录"
            answer: 完整答案（仅查询类工具需要）
            debug: 调试信息（cypher, execution_time 等）

        Returns:
            标准化响应字典
        """
        # 自动生成元数据（如果未提供）
        if metadata is None:
            metadata = ToolResponse._auto_generate_metadata(results)

        # 自动生成摘要（如果未提供）
        if summary is None:
            summary = ToolResponse._auto_generate_summary(results, metadata)

        response = {
            "success": True,
            "data": {
                "results": results,
                "metadata": metadata,
                "summary": summary
            }
        }

        # 可选字段
        if answer is not None:
            response["data"]["answer"] = answer

        if debug is not None:
            response["data"]["debug"] = debug

        return response

    @staticmethod
    def error(error_message: str, debug: Optional[Dict] = None) -> Dict:
        """
        构造失败响应

        Args:
            error_message: 错误信息
            debug: 调试信息（可选）

        Returns:
            错误响应字典
        """
        response = {
            "success": False,
            "error": error_message
        }

        if debug is not None:
            response["debug"] = debug

        return response

    @staticmethod
    def _auto_generate_metadata(results: Union[List, Dict]) -> Dict:
        """
        自动生成元数据

        Returns:
            {
                "total_count": int,
                "data_type": str,
                "fields": list,
                "sample": dict
            }
        """
        metadata = {
            "total_count": 0,
            "data_type": "unknown",
            "fields": [],
            "sample": None
        }

        # 处理列表数据
        if isinstance(results, list):
            metadata["data_type"] = "list"
            metadata["total_count"] = len(results)

            if len(results) > 0:
                first_item = results[0]
                if isinstance(first_item, dict):
                    metadata["fields"] = [
                        {
                            "name": k,
                            "type": type(v).__name__
                        }
                        for k, v in first_item.items()
                    ]
                    metadata["sample"] = first_item

        # 处理字典数据
        elif isinstance(results, dict):
            metadata["data_type"] = "dict"
            metadata["fields"] = [
                {
                    "name": k,
                    "type": type(v).__name__
                }
                for k, v in results.items()
            ]
            # 对于字典，sample 就是它自己（如果不太大）
            if len(str(results)) < 500:
                metadata["sample"] = results

        # 处理 DataFrame
        elif isinstance(results, pd.DataFrame):
            metadata["data_type"] = "dataframe"
            metadata["total_count"] = len(results)
            metadata["fields"] = [
                {
                    "name": col,
                    "type": str(results[col].dtype)
                }
                for col in results.columns
            ]
            if len(results) > 0:
                metadata["sample"] = results.iloc[0].to_dict()

        return metadata

    @staticmethod
    def _auto_generate_summary(results: Union[List, Dict], metadata: Dict) -> str:
        """
        自动生成简洁摘要

        Returns:
            str: 如 "查询返回 100 条记录，包含字段: name, age, city"
        """
        data_type = metadata.get("data_type", "unknown")
        total_count = metadata.get("total_count", 0)
        fields = metadata.get("fields", [])

        if data_type == "list":
            summary = f"查询返回 {total_count} 条记录"
            if fields:
                field_names = [f["name"] for f in fields[:5]]
                summary += f"，包含字段: {', '.join(field_names)}"
                if len(fields) > 5:
                    summary += f" 等 {len(fields)} 个字段"
            return summary

        elif data_type == "dict":
            field_count = len(fields)
            return f"返回字典数据，包含 {field_count} 个字段"

        elif data_type == "dataframe":
            summary = f"返回 DataFrame，{total_count} 行 × {len(fields)} 列"
            return summary

        return "操作成功"


# 便捷函数
def success_response(*args, **kwargs):
    """便捷函数：构造成功响应"""
    return ToolResponse.success(*args, **kwargs)


def error_response(*args, **kwargs):
    """便捷函数：构造错误响应"""
    return ToolResponse.error(*args, **kwargs)
