#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""通用数据加载：JSON 字符串 / CSV 文件 / JSON 文件 → 记录列表。"""

import csv
import json
import os
import sys


def _dataframe_from_payload(content):
    """将 dict/list 规范化为记录列表 (list[dict])。"""
    if isinstance(content, list):
        return content
    if isinstance(content, dict):
        if "results" in content:
            return _dataframe_from_payload(content["results"])
        # 列式字典 → 行式
        keys = list(content.keys())
        if keys and isinstance(content[keys[0]], list):
            length = len(content[keys[0]])
            return [{k: content[k][i] for k in keys} for i in range(length)]
        raise ValueError("字典数据无法转换为表格")
    raise ValueError("数据格式错误：需要列表或字典")


def load_records(data_str):
    """
    从 JSON 字符串或文件路径加载数据，返回 list[dict]。

    支持：
    - JSON 字符串（数组或对象）
    - .json 文件路径
    - .csv 文件路径
    """
    if not data_str or not data_str.strip():
        raise ValueError("数据为空")

    data_str = data_str.strip()

    # 尝试 JSON 字符串
    if data_str.startswith("[") or data_str.startswith("{"):
        try:
            content = json.loads(data_str)
            records = _dataframe_from_payload(content)
            if not records:
                raise ValueError("数据为空")
            return records
        except json.JSONDecodeError:
            pass

    # 尝试文件路径
    if os.path.exists(data_str):
        if data_str.endswith(".csv"):
            with open(data_str, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                records = list(reader)
                if not records:
                    raise ValueError("CSV 文件为空")
                return records
        else:
            with open(data_str, "r", encoding="utf-8") as f:
                content = json.load(f)
                records = _dataframe_from_payload(content)
                if not records:
                    raise ValueError("文件数据为空")
                return records

    raise ValueError(f"数据既不是有效的 JSON 字符串，也不是存在的文件路径: {data_str[:100]}")
