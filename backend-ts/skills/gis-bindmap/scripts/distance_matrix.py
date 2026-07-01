#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
distance_matrix.py - 距离矩阵计算

用法:
  python scripts/distance_matrix.py --sources '[{"name":"南宁市","lat":22.82,"lng":108.37}]' --targets-type shelter
  python scripts/distance_matrix.py --sources-type hydrological_station --sources-city "桂林市" --targets-type hospital
"""

import sys
import os
import json
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _shared import (
    haversine_km, load_geodata_features, error_exit, FEATURE_LABELS,
)


def load_sources(args):
    """解析源点列表"""
    if args.sources:
        try:
            sources = json.loads(args.sources)
        except json.JSONDecodeError as e:
            error_exit(f"--sources JSON 解析失败: {e}")
        for s in sources:
            if "lat" not in s or "lng" not in s:
                error_exit(f"源点缺少 lat/lng: {s}")
        return sources

    if args.sources_type:
        features, err = load_geodata_features(args.sources_type)
        if err:
            error_exit(err)
        if args.sources_city:
            city_norm = args.sources_city.rstrip("市")
            features = [f for f in features if city_norm in f.get("city", "")]
        if not features:
            error_exit(f"未找到源点数据（type={args.sources_type}, city={args.sources_city}）")
        return features

    error_exit("必须指定 --sources 或 --sources-type")


def load_targets(args):
    """解析目标点列表"""
    if args.targets:
        try:
            targets = json.loads(args.targets)
        except json.JSONDecodeError as e:
            error_exit(f"--targets JSON 解析失败: {e}")
        return targets

    if args.targets_type:
        features, err = load_geodata_features(args.targets_type)
        if err:
            error_exit(err)
        if args.targets_city:
            city_norm = args.targets_city.rstrip("市")
            features = [f for f in features if city_norm in f.get("city", "")]
        if not features:
            error_exit(f"未找到目标点数据（type={args.targets_type}, city={args.targets_city}）")
        return features

    error_exit("必须指定 --targets 或 --targets-type")


def main():
    parser = argparse.ArgumentParser(description="距离矩阵计算")
    parser.add_argument("--sources", help="源点 JSON 数组")
    parser.add_argument("--sources-type", help="从数据文件加载源点的要素类型")
    parser.add_argument("--sources-city", help="源点城市过滤")
    parser.add_argument("--targets", help="目标点 JSON 数组")
    parser.add_argument("--targets-type", help="从数据文件加载目标点的要素类型")
    parser.add_argument("--targets-city", help="目标点城市过滤")
    args = parser.parse_args()

    sources = load_sources(args)
    targets = load_targets(args)

    source_names = [s.get("name", f"src_{i}") for i, s in enumerate(sources)]
    target_names = [t.get("name", f"tgt_{i}") for i, t in enumerate(targets)]

    matrix = []
    nearest_per_source = []
    for i, s in enumerate(sources):
        row = []
        min_dist = float("inf")
        min_target = ""
        for j, t in enumerate(targets):
            dist = round(haversine_km(s["lat"], s["lng"], t["lat"], t["lng"]), 2)
            row.append(dist)
            if dist < min_dist:
                min_dist = dist
                min_target = target_names[j]
        matrix.append(row)
        nearest_per_source.append({
            "source": source_names[i],
            "nearest_target": min_target,
            "distance_km": min_dist,
        })

    output = {
        "sources": source_names,
        "targets": target_names,
        "matrix": matrix,
        "nearest_per_source": nearest_per_source,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
