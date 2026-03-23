#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
geo_export.py - Export geometry data from knowledge graph as GeoJSON

Supports:
  --type boundary --name "南宁市" [--include-children]
  --type river --name "柳江" [--all]
  --type bindmap-layers --name "南宁市" --include boundary,rivers
"""

import sys
import os
import json
import re
import argparse

from neo4j import GraphDatabase
from neo4j.time import Date, DateTime, Time, Duration
from neo4j.spatial import Point


def neo4j_to_python(val):
    """Convert Neo4j types to JSON-serializable Python types."""
    if hasattr(val, '_properties'):
        return {k: neo4j_to_python(v) for k, v in val._properties.items()}
    if isinstance(val, dict):
        return {k: neo4j_to_python(v) for k, v in val.items()}
    if isinstance(val, (list, tuple)):
        return [neo4j_to_python(v) for v in val]
    if isinstance(val, (DateTime, Date, Time)):
        return val.iso_format()
    if isinstance(val, Duration):
        return {'months': val.months, 'days': val.days,
                'seconds': val.seconds, 'nanoseconds': val.nanoseconds}
    if isinstance(val, Point):
        d = {'srid': val.srid, 'x': val.x, 'y': val.y}
        if hasattr(val, 'z'):
            d['z'] = val.z
        return d
    return val


def get_driver():
    uri = os.environ.get('NEO4J_URI', 'bolt://localhost:7687')
    user = os.environ.get('NEO4J_USER', 'neo4j')
    password = os.environ.get('NEO4J_PASSWORD', '')
    return GraphDatabase.driver(uri, auth=(user, password))


# --------------- WKT → GeoJSON ---------------

def _parse_coord_list(text):
    """Parse 'lng1 lat1, lng2 lat2, ...' into [[lng, lat], ...]."""
    coords = []
    for pair in text.split(','):
        parts = pair.strip().split()
        if len(parts) >= 2:
            coords.append([float(parts[0]), float(parts[1])])
    return coords


def _parse_ring(text):
    """Parse a single ring '(lng1 lat1, lng2 lat2, ...)'."""
    text = text.strip().strip('()')
    return _parse_coord_list(text)


def wkt_to_geojson(wkt_str):
    """Convert WKT string to GeoJSON geometry dict.

    Supports: POINT, LINESTRING, POLYGON, MULTIPOLYGON, MULTILINESTRING.
    Handles optional SRID=xxxx; prefix.
    """
    if not wkt_str or not isinstance(wkt_str, str):
        return None

    # Strip SRID prefix
    wkt = re.sub(r'^SRID=\d+;\s*', '', wkt_str.strip(), flags=re.IGNORECASE)

    # Extract type and coordinate body
    m = re.match(r'(\w+)\s*\((.+)\)\s*$', wkt, re.DOTALL)
    if not m:
        return None

    geom_type = m.group(1).upper()
    body = m.group(2)

    if geom_type == 'POINT':
        parts = body.strip().split()
        if len(parts) >= 2:
            return {
                "type": "Point",
                "coordinates": [float(parts[0]), float(parts[1])]
            }

    elif geom_type == 'LINESTRING':
        return {
            "type": "LineString",
            "coordinates": _parse_coord_list(body)
        }

    elif geom_type == 'POLYGON':
        rings = re.findall(r'\(([^()]+)\)', body)
        return {
            "type": "Polygon",
            "coordinates": [_parse_coord_list(r) for r in rings]
        }

    elif geom_type == 'MULTIPOLYGON':
        polygons = []
        # Match each polygon: ((ring1), (ring2))
        poly_matches = re.findall(r'\(\(([^)]*(?:\)[^)]*)*)\)\)', body)
        if not poly_matches:
            # Fallback: split by )), ((
            poly_texts = re.split(r'\)\)\s*,\s*\(\(', body.strip('() '))
            for pt in poly_texts:
                rings = re.findall(r'([^()]+)', pt)
                rings = [r for r in rings if r.strip() and r.strip() != ',']
                polygons.append([_parse_coord_list(r) for r in rings])
        else:
            for pm in poly_matches:
                rings = re.findall(r'([^()]+)', pm)
                rings = [r for r in rings if r.strip() and r.strip() != ',']
                polygons.append([_parse_coord_list(r) for r in rings])
        return {
            "type": "MultiPolygon",
            "coordinates": polygons
        }

    elif geom_type == 'MULTILINESTRING':
        lines = re.findall(r'\(([^()]+)\)', body)
        return {
            "type": "MultiLineString",
            "coordinates": [_parse_coord_list(l) for l in lines]
        }

    return None


# --------------- GeoJSON Feature builder ---------------

def _make_feature(record, geojson_geom):
    """Build a GeoJSON Feature from a Neo4j record and parsed geometry."""
    props = {"name": record.get("name", ""), "id": record.get("id", "")}
    if record.get("geo_description"):
        props["geo_description"] = record["geo_description"]
    return {
        "type": "Feature",
        "properties": props,
        "geometry": geojson_geom,
    }


def _build_bindmap_layer(features, label, map_type):
    """Build a single bindmap_ready layer from GeoJSON features."""
    data_items = []
    for f in features:
        data_items.append({
            "name": f["properties"].get("name", ""),
            "value": 1,
            "geometry": json.dumps(f["geometry"], ensure_ascii=False),
        })
    return {
        "data": json.dumps(data_items, ensure_ascii=False),
        "map_type": map_type,
        "label": label,
        "name_field": "name",
        "value_field": "value",
        "geometry_field": "geometry",
    }


def _geom_to_map_type(geojson_geom):
    """Determine map_type based on geometry type."""
    if not geojson_geom:
        return "marker"
    gtype = geojson_geom.get("type", "")
    if gtype in ("Polygon", "MultiPolygon"):
        return "choropleth"
    if gtype in ("LineString", "MultiLineString"):
        return "geojson"
    return "marker"


# --------------- Query operations ---------------

def do_boundary(session, args):
    """Query administrative boundary geometry."""
    name = args.name

    cypher = """
    MATCH (e:地点:entity)
    WHERE (e.name = $name OR e.name CONTAINS $name OR e.id = $name)
      AND e.geometry IS NOT NULL
    RETURN e.id AS id, e.name AS name, e.geometry AS geometry,
           e.geo_description AS geo_description
    LIMIT 10
    """
    records = [neo4j_to_python(r) for r in session.run(cypher, name=name).data()]

    if not records:
        return {"type": "boundary", "name": name, "features": [],
                "message": f"未找到 '{name}' 的几何数据"}

    features = []
    primary = records[0]
    primary_geom = None
    for rec in records:
        geojson = wkt_to_geojson(rec.get("geometry", ""))
        if geojson:
            features.append(_make_feature(rec, geojson))
            if rec["id"] == primary["id"]:
                primary_geom = geojson

    map_type = _geom_to_map_type(primary_geom)
    result = {
        "type": "boundary",
        "name": primary.get("name", name),
        "entity_id": primary.get("id", ""),
        "geometry_type": primary_geom.get("type", "") if primary_geom else "unknown",
        "features": features,
    }

    # Children
    children_features = []
    if args.include_children:
        child_cypher = """
        MATCH (sub:地点:entity)-[:locatedIn]->(parent:地点:entity)
        WHERE parent.name = $name OR parent.id = $parent_id
        RETURN sub.id AS id, sub.name AS name, sub.geometry AS geometry
        """
        parent_id = primary.get("id", "")
        children = [neo4j_to_python(r) for r in
                     session.run(child_cypher, name=name, parent_id=parent_id).data()]
        for ch in children:
            geojson = wkt_to_geojson(ch.get("geometry", ""))
            if geojson:
                children_features.append(_make_feature(ch, geojson))
        result["children"] = children_features

    # Build bindmap_ready
    layers = []
    if features:
        layers.append(_build_bindmap_layer(features, f"{primary.get('name', name)}行政边界", map_type))
    if children_features:
        child_map_type = _geom_to_map_type(
            wkt_to_geojson(children[0].get("geometry", "")) if children else None
        )
        layers.append(_build_bindmap_layer(children_features, f"{primary.get('name', name)}子区域", child_map_type))

    result["bindmap_ready"] = {
        "layers": layers,
        "title": f"{primary.get('name', name)}行政区划",
    }

    return result


def do_river(session, args):
    """Query river linestring geometry."""
    if args.all:
        cypher = """
        MATCH (e:地点:entity)
        WHERE e.id STARTS WITH 'L-RIVER-' AND e.geometry IS NOT NULL
        RETURN e.id AS id, e.name AS name, e.geometry AS geometry
        """
        records = [neo4j_to_python(r) for r in session.run(cypher).data()]
    else:
        name = args.name
        if not name:
            return {"type": "river", "features": [],
                    "message": "需要 --name 或 --all 参数"}
        cypher = """
        MATCH (e:地点:entity)
        WHERE e.id STARTS WITH 'L-RIVER-'
          AND (e.name CONTAINS $name OR e.id CONTAINS $name)
          AND e.geometry IS NOT NULL
        RETURN e.id AS id, e.name AS name, e.geometry AS geometry
        LIMIT 10
        """
        records = [neo4j_to_python(r) for r in session.run(cypher, name=name).data()]

    if not records:
        label = "所有河流" if args.all else args.name
        return {"type": "river", "name": label, "features": [],
                "message": f"未找到河流几何数据"}

    features = []
    for rec in records:
        geojson = wkt_to_geojson(rec.get("geometry", ""))
        if geojson:
            features.append(_make_feature(rec, geojson))

    title_name = "广西河流" if args.all else records[0].get("name", args.name)
    result = {
        "type": "river",
        "name": title_name,
        "features": features,
        "bindmap_ready": {
            "layers": [_build_bindmap_layer(features, title_name, "geojson")],
            "title": f"{title_name}河流走向",
        },
    }
    return result


def do_bindmap_layers(session, args):
    """Combined query producing multi-layer bindmap output."""
    name = args.name
    if not name:
        return {"type": "bindmap-layers", "features": [],
                "message": "需要 --name 参数"}

    include_set = set()
    if args.include:
        include_set = {s.strip().lower() for s in args.include.split(',')}
    else:
        include_set = {"boundary", "rivers"}

    layers = []

    # Boundary layer
    if "boundary" in include_set:
        cypher = """
        MATCH (e:地点:entity)
        WHERE (e.name = $name OR e.name CONTAINS $name OR e.id = $name)
          AND e.geometry IS NOT NULL
        RETURN e.id AS id, e.name AS name, e.geometry AS geometry,
               e.geo_description AS geo_description
        LIMIT 10
        """
        records = [neo4j_to_python(r) for r in session.run(cypher, name=name).data()]
        features = []
        for rec in records:
            geojson = wkt_to_geojson(rec.get("geometry", ""))
            if geojson:
                features.append(_make_feature(rec, geojson))
        if features:
            map_type = _geom_to_map_type(features[0]["geometry"])
            layers.append(_build_bindmap_layer(
                features, f"{name}行政边界", map_type))

    # Children layer
    if "children" in include_set:
        child_cypher = """
        MATCH (sub:地点:entity)-[:locatedIn]->(parent:地点:entity)
        WHERE parent.name = $name OR parent.name CONTAINS $name
        RETURN sub.id AS id, sub.name AS name, sub.geometry AS geometry
        """
        children = [neo4j_to_python(r) for r in session.run(child_cypher, name=name).data()]
        child_features = []
        for ch in children:
            geojson = wkt_to_geojson(ch.get("geometry", ""))
            if geojson:
                child_features.append(_make_feature(ch, geojson))
        if child_features:
            child_map_type = _geom_to_map_type(child_features[0]["geometry"])
            layers.append(_build_bindmap_layer(
                child_features, f"{name}子区域", child_map_type))

    # Rivers layer
    if "rivers" in include_set:
        river_cypher = """
        MATCH (river:地点:entity)
        WHERE river.id STARTS WITH 'L-RIVER-' AND river.geometry IS NOT NULL
        OPTIONAL MATCH (river)-[:locatedIn*1..3]->(region:地点:entity)
        WHERE region.name = $name OR region.name CONTAINS $name
        WITH river, count(region) AS rel_count
        WHERE rel_count > 0
        RETURN river.id AS id, river.name AS name, river.geometry AS geometry
        """
        rivers = [neo4j_to_python(r) for r in session.run(river_cypher, name=name).data()]
        # Fallback: if spatial relation yields nothing, try name-based match
        if not rivers:
            fallback_cypher = """
            MATCH (e:地点:entity)
            WHERE e.id STARTS WITH 'L-RIVER-' AND e.geometry IS NOT NULL
            RETURN e.id AS id, e.name AS name, e.geometry AS geometry
            """
            rivers = [neo4j_to_python(r) for r in session.run(fallback_cypher).data()]
        river_features = []
        for rv in rivers:
            geojson = wkt_to_geojson(rv.get("geometry", ""))
            if geojson:
                river_features.append(_make_feature(rv, geojson))
        if river_features:
            layers.append(_build_bindmap_layer(
                river_features, f"{name}相关河流", "geojson"))

    result = {
        "type": "bindmap-layers",
        "name": name,
        "layer_count": len(layers),
        "bindmap_ready": {
            "layers": layers,
            "title": f"{name}综合地理底图",
        },
    }
    return result


# --------------- Main ---------------

def main():
    parser = argparse.ArgumentParser(
        description="Export geometry data from knowledge graph as GeoJSON")
    parser.add_argument("--type", required=True,
                        choices=["boundary", "river", "bindmap-layers"],
                        help="Query type: boundary, river, or bindmap-layers")
    parser.add_argument("--name", default=None,
                        help="Location or river name to query")
    parser.add_argument("--include-children", action="store_true",
                        help="Include child regions (boundary mode)")
    parser.add_argument("--all", action="store_true",
                        help="Query all rivers (river mode)")
    parser.add_argument("--include", default=None,
                        help="Comma-separated layers: boundary,rivers,children (bindmap-layers mode)")
    args = parser.parse_args()

    if args.type != "river" and not args.name:
        print(json.dumps({"success": False, "error": "--name 参数是必需的"},
                          ensure_ascii=False, indent=2))
        return 1
    if args.type == "river" and not args.name and not args.all:
        print(json.dumps({"success": False, "error": "需要 --name 或 --all 参数"},
                          ensure_ascii=False, indent=2))
        return 1

    try:
        driver = get_driver()
        try:
            with driver.session() as session:
                if args.type == "boundary":
                    data = do_boundary(session, args)
                elif args.type == "river":
                    data = do_river(session, args)
                elif args.type == "bindmap-layers":
                    data = do_bindmap_layers(session, args)
                else:
                    data = {"error": f"Unknown type: {args.type}"}
        finally:
            driver.close()

        print(json.dumps({"success": True, "data": data},
                          ensure_ascii=False, indent=2))
        return 0
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)},
                          ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    sys.exit(main())
