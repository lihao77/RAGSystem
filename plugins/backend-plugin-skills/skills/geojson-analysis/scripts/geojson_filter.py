#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GeoJSON 属性/几何类型过滤器。"""

import argparse
import json
import sys
from pathlib import Path


def _load_data(raw: str) -> dict:
    """从文件路径或 JSON 字符串加载 GeoJSON。"""
    p = Path(raw)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return json.loads(raw)


def _parse_condition(expr: str):
    """解析 'field op value' 条件表达式。"""
    parts = expr.split(None, 2)
    if len(parts) < 2:
        raise ValueError(f"条件格式错误: {expr!r}，需要 'field op [value]'")
    field, op = parts[0], parts[1].lower()
    value = parts[2] if len(parts) > 2 else None
    return field, op, value


def _cast_numeric(val: str):
    """尝试转为数值。"""
    try:
        return int(val)
    except (ValueError, TypeError):
        pass
    try:
        return float(val)
    except (ValueError, TypeError):
        return val


def _match(props: dict, field: str, op: str, raw_value: str | None) -> bool:
    """单条件匹配。"""
    actual = props.get(field)

    if op == "not_null":
        return actual is not None

    if actual is None:
        return False

    if op == "eq":
        return str(actual) == raw_value or actual == _cast_numeric(raw_value)
    if op == "ne":
        return str(actual) != raw_value and actual != _cast_numeric(raw_value)
    if op in ("gt", "gte", "lt", "lte"):
        try:
            a, b = float(actual), float(raw_value)
        except (ValueError, TypeError):
            a, b = str(actual), str(raw_value)
        if op == "gt":
            return a > b
        if op == "gte":
            return a >= b
        if op == "lt":
            return a < b
        return a <= b
    if op == "in":
        candidates = [v.strip() for v in raw_value.split(",")]
        return str(actual) in candidates
    if op == "contains":
        return raw_value in str(actual)
    raise ValueError(f"未知操作符: {op}")


def _filter_features(data: dict, conditions: list, geometry_types: list | None) -> dict:
    """过滤 FeatureCollection。"""
    features = data.get("features", [])
    result = []
    for f in features:
        props = f.get("properties") or {}
        geom = f.get("geometry") or {}
        # 几何类型过滤
        if geometry_types and geom.get("type") not in geometry_types:
            continue
        # 属性条件过滤（AND）
        if conditions:
            ok = True
            for field, op, val in conditions:
                if not _match(props, field, op, val):
                    ok = False
                    break
            if not ok:
                continue
        result.append(f)
    return {
        "type": "FeatureCollection",
        "features": result,
        "metadata": {
            "original_count": len(features),
            "filtered_count": len(result),
        },
    }


def main():
    parser = argparse.ArgumentParser(description="GeoJSON 属性/几何类型过滤")
    parser.add_argument("--data", required=True, help="GeoJSON 文件路径或 JSON 字符串")
    parser.add_argument("--where", nargs="*", default=[], help="过滤条件: 'field op value'")
    parser.add_argument("--geometry-types", default=None, help="几何类型，逗号分隔")
    args = parser.parse_args()

    data = _load_data(args.data)
    conditions = [_parse_condition(w) for w in args.where]
    geom_types = [t.strip() for t in args.geometry_types.split(",")] if args.geometry_types else None

    result = _filter_features(data, conditions, geom_types)
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
