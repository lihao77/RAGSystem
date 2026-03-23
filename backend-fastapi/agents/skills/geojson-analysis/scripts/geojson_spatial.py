#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GeoJSON 空间查询（buffer/bbox）。"""

import argparse
import json
import math
import sys
from pathlib import Path

_EARTH_RADIUS_KM = 6371.0


def _load_data(raw: str) -> dict:
    p = Path(raw)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return json.loads(raw)


def _centroid(geom: dict) -> tuple[float, float] | None:
    """粗略质心：取所有坐标的平均值 (lng, lat)。"""
    coords = geom.get("coordinates")
    if not coords:
        return None
    flat = []
    _flatten_coords(coords, flat)
    if not flat:
        return None
    avg_lng = sum(p[0] for p in flat) / len(flat)
    avg_lat = sum(p[1] for p in flat) / len(flat)
    return avg_lng, avg_lat


def _flatten_coords(coords, out: list):
    if not isinstance(coords, list) or len(coords) == 0:
        return
    if isinstance(coords[0], (int, float)):
        out.append(coords)
        return
    for c in coords:
        _flatten_coords(c, out)


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = math.radians
    dlat = r(lat2 - lat1)
    dlng = r(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(r(lat1)) * math.cos(r(lat2)) * math.sin(dlng / 2) ** 2
    return _EARTH_RADIUS_KM * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _in_bbox(lng: float, lat: float, bbox: list[float]) -> bool:
    """bbox = [min_lng, min_lat, max_lng, max_lat]"""
    return bbox[0] <= lng <= bbox[2] and bbox[1] <= lat <= bbox[3]


def _query_buffer(data: dict, center_lat: float, center_lng: float, radius_km: float) -> dict:
    features = data.get("features", [])
    result = []
    for f in features:
        geom = f.get("geometry") or {}
        c = _centroid(geom)
        if c is None:
            continue
        dist = _haversine_km(center_lat, center_lng, c[1], c[0])
        if dist <= radius_km:
            f_copy = dict(f)
            props = dict(f_copy.get("properties") or {})
            props["_distance_km"] = round(dist, 2)
            f_copy["properties"] = props
            result.append(f_copy)
    result.sort(key=lambda x: x["properties"].get("_distance_km", 0))
    return {
        "type": "FeatureCollection",
        "features": result,
        "metadata": {
            "query_type": "buffer",
            "center": [center_lng, center_lat],
            "radius_km": radius_km,
            "original_count": len(features),
            "matched_count": len(result),
        },
    }


def _query_bbox(data: dict, bbox: list[float]) -> dict:
    features = data.get("features", [])
    result = []
    for f in features:
        geom = f.get("geometry") or {}
        c = _centroid(geom)
        if c is None:
            continue
        if _in_bbox(c[0], c[1], bbox):
            result.append(f)
    return {
        "type": "FeatureCollection",
        "features": result,
        "metadata": {
            "query_type": "bbox",
            "bbox": bbox,
            "original_count": len(features),
            "matched_count": len(result),
        },
    }


def main():
    parser = argparse.ArgumentParser(description="GeoJSON 空间查询")
    parser.add_argument("--data", required=True, help="GeoJSON 文件路径或 JSON 字符串")
    parser.add_argument("--query-type", required=True, choices=["buffer", "bbox"])
    parser.add_argument("--center-lat", type=float, help="缓冲区中心纬度")
    parser.add_argument("--center-lng", type=float, help="缓冲区中心经度")
    parser.add_argument("--radius-km", type=float, help="缓冲区半径（公里）")
    parser.add_argument("--bbox", help="矩形范围: min_lng,min_lat,max_lng,max_lat")
    args = parser.parse_args()

    data = _load_data(args.data)

    if args.query_type == "buffer":
        if args.center_lat is None or args.center_lng is None or args.radius_km is None:
            parser.error("buffer 查询需要 --center-lat, --center-lng, --radius-km")
        result = _query_buffer(data, args.center_lat, args.center_lng, args.radius_km)
    else:
        if args.bbox is None:
            parser.error("bbox 查询需要 --bbox")
        bbox = [float(v.strip()) for v in args.bbox.split(",")]
        if len(bbox) != 4:
            parser.error("--bbox 需要 4 个值: min_lng,min_lat,max_lng,max_lat")
        result = _query_bbox(data, bbox)

    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
