#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
query_features.py - 查询广西地理要素（水文站/医院/避难所）

用法:
  python scripts/query_features.py --type hydrological_station --city 桂林市
  python scripts/query_features.py --type hospital --lat 25.27 --lng 110.29 --radius 80
  python scripts/query_features.py --type shelter --city 南宁市
"""

import sys
import json
import argparse
import math
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_DATA_DIR = os.path.join(_HERE, "..", "data")

FEATURE_FILES = {
    "hydrological_station": "hydrological_stations.json",
    "hospital": "hospitals.json",
    "shelter": "shelters.json",
}

FEATURE_LABELS = {
    "hydrological_station": "水文站",
    "hospital": "医院",
    "shelter": "应急避难所",
}


def _load_features(feature_type: str):
    filename = FEATURE_FILES.get(feature_type)
    if not filename:
        print(json.dumps({
            "error": f"不支持的要素类型: {feature_type}，支持: {list(FEATURE_FILES.keys())}",
        }, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)

    path = os.path.join(_DATA_DIR, filename)
    if not os.path.exists(path):
        print(json.dumps({
            "error": f"数据文件不存在: {path}",
        }, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)

    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _haversine_km(lat1, lng1, lat2, lng2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def query_by_city(features, city: str):
    city_norm = city.rstrip("市") if city else ""
    return [f for f in features if city_norm in f.get("city", "")]


def query_by_radius(features, lat: float, lng: float, radius_km: float):
    results = []
    for f in features:
        f_lat, f_lng = f.get("lat"), f.get("lng")
        if f_lat is None or f_lng is None:
            continue
        dist = _haversine_km(lat, lng, f_lat, f_lng)
        if dist <= radius_km:
            results.append({**f, "distance_km": round(dist, 2)})
    results.sort(key=lambda x: x["distance_km"])
    return results


def main():
    parser = argparse.ArgumentParser(description="查询广西地理要素")
    parser.add_argument("--type", required=True,
                        choices=list(FEATURE_FILES.keys()),
                        help="要素类型: hydrological_station / hospital / shelter")
    parser.add_argument("--city", help="按城市过滤（地级市名称）")
    parser.add_argument("--lat", type=float, help="中心点纬度（与 --lng/--radius 配合使用）")
    parser.add_argument("--lng", type=float, help="中心点经度")
    parser.add_argument("--radius", type=float, default=50.0, help="查询半径（km），默认 50")
    args = parser.parse_args()

    features = _load_features(args.type)
    label = FEATURE_LABELS[args.type]

    if args.lat is not None and args.lng is not None:
        # 按坐标+半径查询
        results = query_by_radius(features, args.lat, args.lng, args.radius)
        output = {
            "type": args.type,
            "label": label,
            "query": {"lat": args.lat, "lng": args.lng, "radius_km": args.radius},
            "total": len(results),
            "results": results,
        }
    elif args.city:
        results = query_by_city(features, args.city)
        output = {
            "type": args.type,
            "label": label,
            "query": {"city": args.city},
            "total": len(results),
            "results": results,
        }
    else:
        # 返回全部
        output = {
            "type": args.type,
            "label": label,
            "query": {"all": True},
            "total": len(features),
            "results": features,
        }

    if args.type == "hydrological_station" and output["results"]:
        output["note"] = (
            "warning_level 字段为警戒水位（m），可直接传入 assess_flood_risk 工具的 warning_level 参数"
        )

    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
