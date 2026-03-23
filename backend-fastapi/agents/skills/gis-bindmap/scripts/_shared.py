#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
_shared.py - gis-bindmap Skill 共享工具函数
"""

import math
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SKILL_DIR = os.path.join(_HERE, "..")
_GEODATA_DIR = os.path.join(_HERE, "..", "..", "guangxi-geodata", "data")

FEATURE_FILES = {
    "hydrological_station": "hydrological_stations.json",
    "hospital": "hospitals.json",
    "shelter": "shelters.json",
}

FEATURE_LABELS = {
    "hydrological_station": "水文站",
    "hospital": "医院",
    "shelter": "避难所",
}

FEATURE_MARKER_COLORS = {
    "hydrological_station": "blue",
    "hospital": "red",
    "shelter": "green",
}


def haversine_km(lat1, lng1, lat2, lng2):
    """Haversine 距离计算（单位: km）"""
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def load_geodata_features(feature_type):
    """加载 guangxi-geodata/data/ 下的 JSON 数据"""
    filename = FEATURE_FILES.get(feature_type)
    if not filename:
        return None, f"不支持的要素类型: {feature_type}，支持: {list(FEATURE_FILES.keys())}"
    path = os.path.join(_GEODATA_DIR, filename)
    if not os.path.exists(path):
        return None, f"数据文件不存在: {path}"
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f), None


def load_river_topology():
    """加载本 Skill 的 river_topology.json"""
    path = os.path.join(_SKILL_DIR, "data", "river_topology.json")
    if not os.path.exists(path):
        return None, f"河流拓扑数据不存在: {path}"
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f), None


def geocode_location(name):
    """调用 guangxi-geodata 的 _geodata.py 解析地名坐标"""
    geodata_scripts = os.path.join(_HERE, "..", "..", "guangxi-geodata", "scripts")
    sys.path.insert(0, geodata_scripts)
    try:
        from _geodata import GUANGXI_CITIES, GUANGXI_DISTRICTS
    finally:
        sys.path.pop(0)

    # 精确匹配城市
    if name in GUANGXI_CITIES:
        info = GUANGXI_CITIES[name]
        return {"lat": info["lat"], "lng": info["lng"], "name": name}, None

    # 别名匹配城市
    for city, info in GUANGXI_CITIES.items():
        if name in info.get("aliases", []):
            return {"lat": info["lat"], "lng": info["lng"], "name": city}, None

    # 精确匹配区县
    if name in GUANGXI_DISTRICTS:
        info = GUANGXI_DISTRICTS[name]
        return {"lat": info["lat"], "lng": info["lng"], "name": name}, None

    # 别名匹配区县
    for dist, info in GUANGXI_DISTRICTS.items():
        if name in info.get("aliases", []):
            return {"lat": info["lat"], "lng": info["lng"], "name": dist}, None

    # 模糊匹配：去掉"市"/"区"/"县"后缀
    stripped = name.rstrip("市区县")
    for city, info in GUANGXI_CITIES.items():
        if stripped in city or any(stripped in a for a in info.get("aliases", [])):
            return {"lat": info["lat"], "lng": info["lng"], "name": city}, None
    for dist, info in GUANGXI_DISTRICTS.items():
        if stripped in dist or any(stripped in a for a in info.get("aliases", [])):
            return {"lat": info["lat"], "lng": info["lng"], "name": dist}, None

    return None, f"无法解析地名: {name}"


def resolve_location(args):
    """从 argparse 参数中解析位置（优先 lat/lng，其次 location 地名）"""
    if args.lat is not None and args.lng is not None:
        name = getattr(args, "location", None) or f"{args.lat},{args.lng}"
        return {"lat": args.lat, "lng": args.lng, "name": name}, None
    location = getattr(args, "location", None)
    if location:
        return geocode_location(location)
    return None, "必须指定 --lat/--lng 或 --location"


def error_exit(msg):
    """输出错误 JSON 并退出"""
    print(json.dumps({"error": msg}, ensure_ascii=False))
    sys.exit(1)


def features_in_radius(features, center_lat, center_lng, radius_km):
    """查找半径内的要素，按距离排序"""
    results = []
    for f in features:
        f_lat, f_lng = f.get("lat"), f.get("lng")
        if f_lat is None or f_lng is None:
            continue
        dist = haversine_km(center_lat, center_lng, f_lat, f_lng)
        if dist <= radius_km:
            results.append({**f, "distance_km": round(dist, 2)})
    results.sort(key=lambda x: x["distance_km"])
    return results


def nearest_features(features, center_lat, center_lng, top_k=5):
    """查找最近的 N 个要素"""
    scored = []
    for f in features:
        f_lat, f_lng = f.get("lat"), f.get("lng")
        if f_lat is None or f_lng is None:
            continue
        dist = haversine_km(center_lat, center_lng, f_lat, f_lng)
        scored.append({**f, "distance_km": round(dist, 2)})
    scored.sort(key=lambda x: x["distance_km"])
    return scored[:top_k]


def make_wkt_point(lng, lat):
    """生成 WKT POINT 字符串"""
    return f"POINT ({lng} {lat})"


def build_marker_layer(items, label, name_field="name", value_field="value"):
    """构建 bindmap 图层"""
    data = []
    for item in items:
        entry = {
            "name": item.get(name_field, item.get("name", "")),
            "value": item.get(value_field, 1),
            "geometry": make_wkt_point(item["lng"], item["lat"]),
        }
        # 保留额外字段
        for k in ("city", "level", "capacity", "type", "river",
                   "warning_level", "distance_km", "grade"):
            if k in item:
                entry[k] = item[k]
        data.append(entry)
    return {
        "data": json.dumps(data, ensure_ascii=False),
        "map_type": "marker",
        "label": label,
        "name_field": "name",
        "value_field": "value",
    }
