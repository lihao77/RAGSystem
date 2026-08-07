#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
proximity_analysis.py - 邻近空间分析

操作:
  buffer   — 缓冲区分析（中心点+半径，查找区域内要素）
  nearest  — 最近邻查询（查找最近 N 个要素）
  resources — 多类型应急资源查询并输出 GeoJSON File

用法:
  python scripts/proximity_analysis.py --operation buffer --location "南宁市" --radius 50 --types hospital,shelter
  python scripts/proximity_analysis.py --operation buffer --lat 22.82 --lng 108.37 --radius 50 --types hydrological_station,hospital,shelter
  python scripts/proximity_analysis.py --operation nearest --location "桂林市" --type hospital --top-k 5
  python scripts/proximity_analysis.py --operation resources --location "南宁市" --radius 80 --types hydrological_station,hospital,shelter
"""

import sys
import os
import json
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _shared import (
    resolve_location, load_geodata_features, error_exit,
    features_in_radius, nearest_features, build_point_file,
    FEATURE_LABELS,
)


def do_buffer(args):
    center, err = resolve_location(args)
    if err:
        error_exit(err)

    types = [t.strip() for t in args.types.split(",")]
    results = {}
    summary = {}
    for ftype in types:
        features, err = load_geodata_features(ftype)
        if err:
            error_exit(err)
        found = features_in_radius(features, center["lat"], center["lng"], args.radius)
        label = FEATURE_LABELS.get(ftype, ftype)
        results[ftype] = found
        summary[ftype] = len(found)

    summary["total"] = sum(summary.values())

    data = {
        "operation": "buffer",
        "center": center,
        "radius_km": args.radius,
        "summary": summary,
        "results": results,
    }
    groups = [{"name": "查询中心", "category": "origin", "items": [center]}]
    groups.extend({"name": FEATURE_LABELS.get(key, key), "category": key, "items": value} for key, value in results.items())
    file = build_point_file(groups, f"{center['name']} {args.radius}km 缓冲查询", "buffer-query", {"radius_km": args.radius})
    print(json.dumps({"success": True, "data": data, "file": file}, ensure_ascii=False, indent=2))


def do_nearest(args):
    center, err = resolve_location(args)
    if err:
        error_exit(err)

    ftype = args.type
    features, err = load_geodata_features(ftype)
    if err:
        error_exit(err)

    found = nearest_features(features, center["lat"], center["lng"], args.top_k)

    data = {
        "operation": "nearest",
        "origin": center,
        "type": ftype,
        "top_k": args.top_k,
        "results": found,
    }
    file = build_point_file(
        [
            {"name": "查询起点", "category": "origin", "items": [center]},
            {"name": FEATURE_LABELS.get(ftype, ftype), "category": ftype, "items": found},
        ],
        f"{center['name']}最近{FEATURE_LABELS.get(ftype, ftype)}",
        "nearest-query",
        {"top_k": args.top_k},
    )
    print(json.dumps({"success": True, "data": data, "file": file}, ensure_ascii=False, indent=2))


def do_resources(args):
    center, err = resolve_location(args)
    if err:
        error_exit(err)

    types = [t.strip() for t in args.types.split(",")]
    summary = {}
    groups = [{"name": "查询中心", "category": "origin", "items": [center]}]

    for ftype in types:
        features, err = load_geodata_features(ftype)
        if err:
            error_exit(err)
        found = features_in_radius(features, center["lat"], center["lng"], args.radius)
        label = FEATURE_LABELS.get(ftype, ftype)
        count = len(found)
        summary[ftype] = count

        if found:
            groups.append({"name": label, "category": ftype, "items": found})

    title = f"{center['name']}周边{args.radius}km应急资源分布"

    data = {
        "operation": "resources",
        "center": center,
        "radius_km": args.radius,
        "summary": summary,
    }
    file = build_point_file(groups, title, "resource-query", {"radius_km": args.radius})
    print(json.dumps({"success": True, "data": data, "file": file}, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="GIS 空间分析")
    parser.add_argument("--operation", required=True,
                        choices=["buffer", "nearest", "resources"],
                        help="操作类型")
    parser.add_argument("--lat", type=float, help="中心点纬度")
    parser.add_argument("--lng", type=float, help="中心点经度")
    parser.add_argument("--location", help="地名（自动解析坐标）")
    parser.add_argument("--radius", type=float, default=50.0, help="查询半径（km），默认 50")
    parser.add_argument("--types", help="要素类型列表，逗号分隔（buffer/resources 用）")
    parser.add_argument("--type", help="单个要素类型（nearest 用）")
    parser.add_argument("--top-k", type=int, default=5, help="最近邻数量，默认 5")
    args = parser.parse_args()

    if args.operation == "buffer":
        if not args.types:
            error_exit("buffer 操作需要 --types 参数")
        do_buffer(args)
    elif args.operation == "nearest":
        if not args.type:
            error_exit("nearest 操作需要 --type 参数")
        do_nearest(args)
    elif args.operation == "resources":
        if not args.types:
            error_exit("resources 操作需要 --types 参数")
        do_resources(args)


if __name__ == "__main__":
    main()

