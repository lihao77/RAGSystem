#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
temporal_extract.py - Temporal data extraction for an entity

Function: Extract time-series data for a specific attribute of an entity
          within a given time range.
          Supports fuzzy attribute name matching and numeric value parsing
          (handles values like "199.70米", "3.9亿元").
Usage:
  python scripts/temporal_extract.py --entity "潘厂水库" --attr "水位" \
      --start 2020-01-01 --end 2020-12-31
  python scripts/temporal_extract.py --entity "L-450100" --attr "降雨量" \
      --start 2023-06-01 --end 2023-09-30
  python scripts/temporal_extract.py --entity "潘厂水库" --attr "水位" --fuzzy
"""

import sys
import os
import re
import json
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


def parse_numeric(value):
    """
    Try to extract a float from strings like "199.70米", "3.9亿元", "528800人".
    Returns float if parseable, else None.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    # Extract leading number (possibly with decimal point)
    m = re.match(r'^([+-]?\d+\.?\d*)', s)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass
    return None


def find_fuzzy_attr_names(session, entity_id, base_attr):
    """
    Find all attribute names in the KG that CONTAIN the base_attr keyword
    for this entity. Returns list of (attr_name, count) sorted by count desc.
    """
    cypher = """
    MATCH (s:State)-[ha:hasAttribute]->(attr:Attribute)
    WHERE s.id CONTAINS $eid AND ha.type CONTAINS $keyword
    RETURN ha.type AS attr_name, count(*) AS cnt
    ORDER BY cnt DESC
    LIMIT 10
    """
    rows = session.run(cypher, eid=entity_id, keyword=base_attr).data()
    return [(r["attr_name"], r["cnt"]) for r in rows]


def resolve_attr_names(session, entity_id, attr_name, fuzzy=False):
    """
    Resolve the attribute name(s) to use.
    - Exact match first; if no results and fuzzy=True, fall back to CONTAINS match.
    Returns (list_of_attr_names, suggestion_msg).
    """
    # Check exact match count
    exact_cypher = """
    MATCH (s:State)-[ha:hasAttribute]->(:Attribute)
    WHERE s.id CONTAINS $eid AND ha.type = $attr
    RETURN count(*) AS cnt
    """
    exact_count = session.run(exact_cypher, eid=entity_id, attr=attr_name).single()["cnt"]

    if exact_count > 0:
        return [attr_name], None

    # No exact match — try fuzzy
    candidates = find_fuzzy_attr_names(session, entity_id, attr_name)
    if not candidates:
        # Broader: list all attrs for this entity
        all_attrs_cypher = """
        MATCH (s:State)-[ha:hasAttribute]->(:Attribute)
        WHERE s.id CONTAINS $eid
        RETURN ha.type AS attr_name, count(*) AS cnt
        ORDER BY cnt DESC LIMIT 20
        """
        all_attrs = session.run(all_attrs_cypher, eid=entity_id).data()
        suggestion = (
            f"Attribute '{attr_name}' not found. "
            f"Available attributes: {[r['attr_name'] for r in all_attrs]}"
        )
        return [], suggestion

    if fuzzy:
        names = [c[0] for c in candidates]
        suggestion = f"Exact '{attr_name}' not found; using fuzzy matches: {names}"
        return names, suggestion
    else:
        names = [c[0] for c in candidates]
        suggestion = (
            f"Exact '{attr_name}' not found. "
            f"Similar attributes: {names}. "
            f"Use --fuzzy to auto-expand."
        )
        return [], suggestion


def extract_temporal_series(entity_keyword, attr_name, start_date=None, end_date=None,
                             limit=500, fuzzy=False):
    """
    Extract attribute time series for a given entity.

    Params:
        entity_keyword : entity name or ID fragment
        attr_name      : attribute name (exact or fuzzy keyword)
        start_date     : "YYYY-MM-DD" or None
        end_date       : "YYYY-MM-DD" or None
        limit          : max records
        fuzzy          : if True, expand attr_name to CONTAINS variants when exact not found
    """
    driver = get_driver()
    result = {
        "entity_keyword": entity_keyword,
        "attr_name": attr_name,
        "time_range": {"start": start_date, "end": end_date},
        "series": [],
        "stats": {}
    }
    try:
        with driver.session() as session:
            # Resolve attribute names (with optional fuzzy fallback)
            attr_names, suggestion = resolve_attr_names(session, entity_keyword, attr_name, fuzzy)
            if suggestion:
                result["attr_suggestion"] = suggestion
            if not attr_names:
                result["record_count"] = 0
                return result

            result["resolved_attr_names"] = attr_names

            # Build time filters
            time_clauses = []
            params = {"eid": entity_keyword, "lim": limit}
            if start_date:
                time_clauses.append("s.start_time >= date($start_date)")
                params["start_date"] = start_date
            if end_date:
                time_clauses.append("s.end_time <= date($end_date)")
                params["end_date"] = end_date
            where_time = ("AND " + " AND ".join(time_clauses)) if time_clauses else ""

            # Use IN list for resolved attr names
            params["attr_names"] = attr_names

            cypher = f"""
            MATCH (s:State)-[ha:hasAttribute]->(attr:Attribute)
            WHERE s.id CONTAINS $eid
              AND ha.type IN $attr_names
              {where_time}
            RETURN s.id AS state_id,
                   ha.type AS matched_attr,
                   s.start_time AS start_time,
                   s.end_time AS end_time,
                   s.time AS time_label,
                   attr.value AS value
            ORDER BY s.start_time ASC
            LIMIT $lim
            """
            records = session.run(cypher, **params).data()

            series = []
            numeric_values = []
            for r in records:
                raw_value = neo4j_to_python(r["value"])
                numeric = parse_numeric(raw_value)
                entry = {
                    "state_id": r["state_id"],
                    "matched_attr": r["matched_attr"],
                    "start_time": neo4j_to_python(r["start_time"]),
                    "end_time": neo4j_to_python(r["end_time"]),
                    "time_label": neo4j_to_python(r["time_label"]),
                    "value": raw_value,
                    "numeric_value": numeric
                }
                series.append(entry)
                if numeric is not None:
                    numeric_values.append(numeric)

            result["series"] = series
            result["record_count"] = len(series)

            if numeric_values:
                numeric_values.sort()
                n = len(numeric_values)
                result["stats"] = {
                    "count": n,
                    "min": numeric_values[0],
                    "max": numeric_values[-1],
                    "mean": round(sum(numeric_values) / n, 4),
                    "median": numeric_values[n // 2],
                    "note": "numeric_value parsed from raw string (units stripped)"
                }
            else:
                result["stats"] = {"count": len(series), "note": "Non-numeric values, no stats"}

    finally:
        driver.close()

    return result


def main():
    parser = argparse.ArgumentParser(description="Extract temporal attribute series from knowledge graph")
    parser.add_argument("--entity", required=True, help="Entity name or ID keyword")
    parser.add_argument("--attr", required=True, help="Attribute name (e.g. 水位, 降雨量)")
    parser.add_argument("--start", default=None, help="Start date YYYY-MM-DD")
    parser.add_argument("--end", default=None, help="End date YYYY-MM-DD")
    parser.add_argument("--limit", type=int, default=500, help="Max records (default: 500)")
    parser.add_argument("--fuzzy", action="store_true",
                        help="Use CONTAINS match when exact attribute name not found")
    args = parser.parse_args()

    try:
        data = extract_temporal_series(
            args.entity, args.attr,
            start_date=args.start,
            end_date=args.end,
            limit=args.limit,
            fuzzy=args.fuzzy
        )
        print(json.dumps({"success": True, "data": data}, ensure_ascii=False, indent=2))
        return 0
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    sys.exit(main())
