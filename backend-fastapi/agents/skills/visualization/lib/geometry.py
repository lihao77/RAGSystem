#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""WKT/GeoJSON 解析 + centroid 计算。零依赖纯 Python。"""

import json
import re


def _split_top_level(text):
    parts = []
    depth = 0
    start = 0
    for idx, ch in enumerate(text):
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        elif ch == ',' and depth == 0:
            parts.append(text[start:idx].strip())
            start = idx + 1
    tail = text[start:].strip()
    if tail:
        parts.append(tail)
    return parts


def _strip_outer_parens(text):
    text = text.strip()
    if not (text.startswith('(') and text.endswith(')')):
        return text
    depth = 0
    for idx, ch in enumerate(text):
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
            if depth == 0 and idx != len(text) - 1:
                return text
    return text[1:-1].strip()


def _parse_coord_pair(token):
    parts = token.strip().split()
    if len(parts) < 2:
        raise ValueError("坐标对格式无效")
    return [float(parts[0]), float(parts[1])]


def _parse_coord_sequence(text):
    return [_parse_coord_pair(part) for part in _split_top_level(text)]


def _parse_wkt_geometry(text):
    match = re.match(
        r'^\s*(?:SRID=\d+;\s*)?([A-Z]+)(?:\s+Z|(?:\s+M)|(?:\s+ZM))?\s*(\(.*\))\s*$',
        text, re.IGNORECASE,
    )
    if not match:
        return None
    geom_type = match.group(1).upper()
    body = match.group(2).strip()
    try:
        if geom_type == 'POINT':
            coords = _parse_coord_pair(_strip_outer_parens(body))
            return {"type": "Point", "coordinates": coords}
        if geom_type == 'LINESTRING':
            coords = _parse_coord_sequence(_strip_outer_parens(body))
            return {"type": "LineString", "coordinates": coords}
        if geom_type == 'POLYGON':
            rings = [_parse_coord_sequence(_strip_outer_parens(ring))
                     for ring in _split_top_level(_strip_outer_parens(body))]
            return {"type": "Polygon", "coordinates": rings}
        if geom_type == 'MULTIPOINT':
            inner = _strip_outer_parens(body)
            parts = _split_top_level(inner)
            if parts and all(p.strip().startswith('(') for p in parts):
                coords = [_parse_coord_pair(_strip_outer_parens(p)) for p in parts]
            else:
                coords = _parse_coord_sequence(inner)
            return {"type": "MultiPoint", "coordinates": coords}
        if geom_type == 'MULTILINESTRING':
            lines = [_parse_coord_sequence(_strip_outer_parens(line))
                     for line in _split_top_level(_strip_outer_parens(body))]
            return {"type": "MultiLineString", "coordinates": lines}
        if geom_type == 'MULTIPOLYGON':
            polygons = []
            for polygon in _split_top_level(_strip_outer_parens(body)):
                rings = [_parse_coord_sequence(_strip_outer_parens(ring))
                         for ring in _split_top_level(_strip_outer_parens(polygon))]
                polygons.append(rings)
            return {"type": "MultiPolygon", "coordinates": polygons}
    except (TypeError, ValueError):
        return None
    return None


def compute_centroid(geo_type, coordinates):
    """纯 Python 坐标均值计算 centroid，返回 [lat, lng]。"""
    points = []
    depth_map = {"Point": 0, "LineString": 1, "Polygon": 2,
                 "MultiPoint": 1, "MultiLineString": 2, "MultiPolygon": 3}
    depth = depth_map.get(geo_type, 0)

    def _collect(coords, d):
        if d == 0:
            points.append(coords)
        else:
            for item in coords:
                _collect(item, d - 1)

    _collect(coordinates, depth)
    if not points:
        return [0, 0]
    avg_lng = sum(p[0] for p in points) / len(points)
    avg_lat = sum(p[1] for p in points) / len(points)
    return [avg_lat, avg_lng]


def parse_geometry(raw):
    """
    统一解析几何数据，支持 WKT 和 GeoJSON。

    返回 {"type", "coordinates", "centroid": [lat, lng]} 或 None。
    """
    if raw is None:
        return None

    if isinstance(raw, dict):
        geo_type = raw.get("type")
        coords = raw.get("coordinates")
        if geo_type and coords is not None:
            return {"type": geo_type, "coordinates": coords,
                    "centroid": compute_centroid(geo_type, coords)}
        return None

    if not isinstance(raw, str):
        return None

    raw = raw.strip()
    if not raw:
        return None

    wkt_geom = _parse_wkt_geometry(raw)
    if wkt_geom is not None:
        centroid = compute_centroid(wkt_geom["type"], wkt_geom["coordinates"])
        return {"type": wkt_geom["type"], "coordinates": wkt_geom["coordinates"],
                "centroid": centroid}

    if raw.startswith("{"):
        try:
            obj = json.loads(raw)
            geo_type = obj.get("type")
            coords = obj.get("coordinates")
            if geo_type and coords is not None:
                return {"type": geo_type, "coordinates": coords,
                        "centroid": compute_centroid(geo_type, coords)}
        except (json.JSONDecodeError, TypeError):
            pass

    return None
