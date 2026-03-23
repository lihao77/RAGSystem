#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
spatial_bindmap.py - 空间分析主脚本

操作:
  buffer   — 缓冲区分析（中心点+半径，查找区域内要素）
  nearest  — 最近邻查询（查找最近 N 个要素）
  bindmap  — 多要素叠加查询（输出 bindmap_ready 可直接喂 create_bindmap）

用法:
  python scripts/spatial_bindmap.py --operation buffer --location "南宁市" --radius 50 --types hospital,shelter
  python scripts/spatial_bindmap.py --operation buffer --lat 22.82 --lng 108.37 --radius 50 --types hydrological_station,hospital,shelter
  python scripts/spatial_bindmap.py --operation nearest --location "桂林市" --type hospital --top-k 5
  python scripts/spatial_bindmap.py --operation bindmap --location "南宁市" --radius 80 --types hydrological_station,hospital,shelter
"""

import sys
import os
import json
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _shared import (
    resolve_location, load_geodata_features, error_exit,
    features_in_radius, nearest_features, build_marker_layer,
    FEATURE_LABELS, FEATURE_MARKER_COLORS,
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

    output = {
        "operation": "buffer",
        "center": center,
        "radius_km": args.radius,
        "summary": summary,
        "results": results,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


def do_nearest(args):
    center, err = resolve_location(args)
    if err:
        error_exit(err)

    ftype = args.type
    features, err = load_geodata_features(ftype)
    if err:
        error_exit(err)

    found = nearest_features(features, center["lat"], center["lng"], args.top_k)

    output = {
        "operation": "nearest",
        "origin": center,
        "type": ftype,
        "top_k": args.top_k,
        "results": found,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


def do_bindmap(args):
    center, err = resolve_location(args)
    if err:
        error_exit(err)

    types = [t.strip() for t in args.types.split(",")]
    summary = {}
    layers = []

    for ftype in types:
        features, err = load_geodata_features(ftype)
        if err:
            error_exit(err)
        found = features_in_radius(features, center["lat"], center["lng"], args.radius)
        label = FEATURE_LABELS.get(ftype, ftype)
        count = len(found)
        summary[ftype] = count

        if found:
            layer = build_marker_layer(found, f"{label}({count})")
            layers.append(layer)

    title = f"{center['name']}周边{args.radius}km应急资源分布"

    output = {
        "operation": "bindmap",
        "center": center,
        "radius_km": args.radius,
        "summary": summary,
        "bindmap_ready": {
            "layers": layers,
            "title": title,
        },
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="GIS 空间分析")
    parser.add_argument("--operation", required=True,
                        choices=["buffer", "nearest", "bindmap"],
                        help="操作类型")
    parser.add_argument("--lat", type=float, help="中心点纬度")
    parser.add_argument("--lng", type=float, help="中心点经度")
    parser.add_argument("--location", help="地名（自动解析坐标）")
    parser.add_argument("--radius", type=float, default=50.0, help="查询半径（km），默认 50")
    parser.add_argument("--types", help="要素类型列表，逗号分隔（buffer/bindmap 用）")
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
    elif args.operation == "bindmap":
        if not args.types:
            error_exit("bindmap 操作需要 --types 参数")
        do_bindmap(args)


if __name__ == "__main__":
    main()
