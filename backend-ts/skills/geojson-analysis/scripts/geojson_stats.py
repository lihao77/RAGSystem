#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GeoJSON 统计分析。"""

import argparse
import json
import math
import sys
from pathlib import Path


def _load_data(raw: str) -> dict:
    p = Path(raw)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return json.loads(raw)


def _numeric_stats(values: list[float]) -> dict:
    if not values:
        return {"count": 0}
    s = sorted(values)
    return {
        "count": len(s),
        "min": s[0],
        "max": s[-1],
        "sum": round(sum(s), 4),
        "mean": round(sum(s) / len(s), 4),
        "median": round(s[len(s) // 2], 4),
    }


def _flatten_coords(coords, out: list):
    if not isinstance(coords, list) or len(coords) == 0:
        return
    if isinstance(coords[0], (int, float)):
        out.append(coords)
        return
    for c in coords:
        _flatten_coords(c, out)


def _ring_area_sq_km(ring: list[list[float]]) -> float:
    """Shoelace 公式近似计算多边形环面积（平方公里）。"""
    if len(ring) < 3:
        return 0.0
    r = math.radians
    area = 0.0
    for i in range(len(ring)):
        j = (i + 1) % len(ring)
        xi, yi = r(ring[i][0]), r(ring[i][1])
        xj, yj = r(ring[j][0]), r(ring[j][1])
        area += xi * yj - xj * yi
    earth_r = 6371.0
    # 近似：在赤道附近 1 弧度 ≈ earth_r km
    return abs(area) / 2.0 * earth_r * earth_r


def _polygon_area(coords: list) -> float:
    """计算 Polygon 面积（外环 - 内环）。"""
    if not coords:
        return 0.0
    area = _ring_area_sq_km(coords[0])
    for hole in coords[1:]:
        area -= _ring_area_sq_km(hole)
    return abs(area)


def _segment_length_km(p1: list[float], p2: list[float]) -> float:
    r = math.radians
    dlat = r(p2[1] - p1[1])
    dlng = r(p2[0] - p1[0])
    a = math.sin(dlat / 2) ** 2 + math.cos(r(p1[1])) * math.cos(r(p2[1])) * math.sin(dlng / 2) ** 2
    return 6371.0 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _linestring_length(coords: list[list[float]]) -> float:
    total = 0.0
    for i in range(len(coords) - 1):
        total += _segment_length_km(coords[i], coords[i + 1])
    return total


def _compute_feature_area(geom: dict) -> float | None:
    gt = geom.get("type", "")
    coords = geom.get("coordinates", [])
    if gt == "Polygon":
        return round(_polygon_area(coords), 4)
    if gt == "MultiPolygon":
        return round(sum(_polygon_area(p) for p in coords), 4)
    return None


def _compute_feature_length(geom: dict) -> float | None:
    gt = geom.get("type", "")
    coords = geom.get("coordinates", [])
    if gt == "LineString":
        return round(_linestring_length(coords), 4)
    if gt == "MultiLineString":
        return round(sum(_linestring_length(ls) for ls in coords), 4)
    return None


def _collect_stats(data: dict, stats_fields: list[str], group_by: str | None,
                   compute_area: bool, compute_length: bool) -> dict:
    features = data.get("features", [])

    # 按分组收集
    groups: dict[str, list] = {}
    for f in features:
        props = f.get("properties") or {}
        geom = f.get("geometry") or {}
        key = str(props.get(group_by, "__all__")) if group_by else "__all__"
        if key not in groups:
            groups[key] = []
        entry = dict(props)
        if compute_area:
            a = _compute_feature_area(geom)
            if a is not None:
                entry["_area_sq_km"] = a
        if compute_length:
            l = _compute_feature_length(geom)
            if l is not None:
                entry["_length_km"] = l
        groups[key].append(entry)

    # 统计
    result = {"feature_count": len(features), "groups": {}}
    all_fields = list(stats_fields)
    if compute_area:
        all_fields.append("_area_sq_km")
    if compute_length:
        all_fields.append("_length_km")

    for gk, entries in groups.items():
        group_result = {"count": len(entries), "fields": {}}
        for field in all_fields:
            vals = []
            for e in entries:
                v = e.get(field)
                if v is not None:
                    try:
                        vals.append(float(v))
                    except (ValueError, TypeError):
                        pass
            if vals:
                group_result["fields"][field] = _numeric_stats(vals)
        result["groups"][gk] = group_result

    # 非分组模式简化输出
    if not group_by and "__all__" in result["groups"]:
        result["stats"] = result["groups"]["__all__"]["fields"]
        del result["groups"]

    return result


def main():
    parser = argparse.ArgumentParser(description="GeoJSON 统计分析")
    parser.add_argument("--data", required=True, help="GeoJSON 文件路径或 JSON 字符串")
    parser.add_argument("--stats-fields", default="", help="统计字段，逗号分隔")
    parser.add_argument("--group-by", default=None, help="分组字段")
    parser.add_argument("--compute-area", action="store_true", help="计算面积（平方公里）")
    parser.add_argument("--compute-length", action="store_true", help="计算线长（公里）")
    args = parser.parse_args()

    data = _load_data(args.data)
    fields = [f.strip() for f in args.stats_fields.split(",") if f.strip()]

    result = _collect_stats(data, fields, args.group_by, args.compute_area, args.compute_length)
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
