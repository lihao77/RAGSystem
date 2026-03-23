#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
time_aggregate.py - Time-granularity aggregation of attribute trends

Function: Aggregate an entity's attribute values by time granularity
          (day / week / month / year) to reveal trends.
          Supports fuzzy attribute name matching and numeric value parsing
          (handles values like "199.70米", "3.9亿元").
Usage:
  python scripts/time_aggregate.py --entity "潘厂水库" --attr "水位" \
      --start 2020-01-01 --end 2020-12-31 --interval month --agg avg
  python scripts/time_aggregate.py --entity "L-450100" --attr "降雨量" \
      --start 2023-06-01 --end 2023-09-30 --interval week --agg sum
  python scripts/time_aggregate.py --entity "潘厂水库" --attr "水位" --fuzzy
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
    Extract a float from strings like "199.70米", "3.9亿元", "528800人".
    Returns float if parseable, else None.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    m = re.match(r'^([+-]?\d+\.?\d*)', s)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass
    return None


def find_fuzzy_attr_names(session, entity_id, base_attr):
    """Find attribute names containing the keyword for this entity."""
    cypher = """
    MATCH (s:State)-[ha:hasAttribute]->(:Attribute)
    WHERE s.id CONTAINS $eid AND ha.type CONTAINS $keyword
    RETURN ha.type AS attr_name, count(*) AS cnt
    ORDER BY cnt DESC LIMIT 10
    """
    rows = session.run(cypher, eid=entity_id, keyword=base_attr).data()
    return [(r["attr_name"], r["cnt"]) for r in rows]


def resolve_attr_names(session, entity_id, attr_name, fuzzy=False):
    """
    Resolve attribute name(s). Returns (list_of_names, suggestion_msg).
    """
    exact_count = session.run(
        "MATCH (s:State)-[ha:hasAttribute]->(:Attribute) "
        "WHERE s.id CONTAINS $eid AND ha.type = $attr RETURN count(*) AS cnt",
        eid=entity_id, attr=attr_name
    ).single()["cnt"]

    if exact_count > 0:
        return [attr_name], None

    candidates = find_fuzzy_attr_names(session, entity_id, attr_name)
    if not candidates:
        all_attrs = session.run(
            "MATCH (s:State)-[ha:hasAttribute]->(:Attribute) "
            "WHERE s.id CONTAINS $eid "
            "RETURN ha.type AS attr_name, count(*) AS cnt ORDER BY cnt DESC LIMIT 20",
            eid=entity_id
        ).data()
        suggestion = (
            f"Attribute '{attr_name}' not found. "
            f"Available: {[r['attr_name'] for r in all_attrs]}"
        )
        return [], suggestion

    if fuzzy:
        names = [c[0] for c in candidates]
        return names, f"Exact '{attr_name}' not found; using fuzzy matches: {names}"
    else:
        names = [c[0] for c in candidates]
        return [], (
            f"Exact '{attr_name}' not found. "
            f"Similar: {names}. Use --fuzzy to auto-expand."
        )


# Cypher date-bucket expressions for each interval
INTERVAL_BUCKET = {
    "day":   "toString(s.start_time)",
    "week":  "toString(date.truncate('week', s.start_time))",
    "month": "toString(date.truncate('month', s.start_time))",
    "year":  "toString(date.truncate('year', s.start_time))",
}

AGG_FUNCTIONS = {
    "sum": "sum(num_val)",
    "avg": "avg(num_val)",
    "max": "max(num_val)",
    "min": "min(num_val)",
    "count": "count(num_val)"
}


def time_aggregate(entity_keyword, attr_name, start_date=None, end_date=None,
                   interval="month", agg_method="avg", limit=200, fuzzy=False):
    """
    Aggregate an attribute over time buckets for an entity.
    Numeric parsing handles unit-bearing strings ("199.70米" → 199.70).
    """
    driver = get_driver()
    bucket_expr = INTERVAL_BUCKET.get(interval, INTERVAL_BUCKET["month"])
    agg_func = AGG_FUNCTIONS.get(agg_method, AGG_FUNCTIONS["avg"])

    result = {
        "entity_keyword": entity_keyword,
        "attr_name": attr_name,
        "time_range": {"start": start_date, "end": end_date},
        "interval": interval,
        "agg_method": agg_method,
        "buckets": [],
        "stats": {}
    }

    try:
        with driver.session() as session:
            # Resolve attribute names
            attr_names, suggestion = resolve_attr_names(session, entity_keyword, attr_name, fuzzy)
            if suggestion:
                result["attr_suggestion"] = suggestion
            if not attr_names:
                result["bucket_count"] = 0
                return result
            result["resolved_attr_names"] = attr_names

            time_clauses = []
            params = {"eid": entity_keyword, "attr_names": attr_names, "lim": limit}
            if start_date:
                time_clauses.append("s.start_time >= date($start_date)")
                params["start_date"] = start_date
            if end_date:
                time_clauses.append("s.end_time <= date($end_date)")
                params["end_date"] = end_date
            time_filter = ("AND " + " AND ".join(time_clauses)) if time_clauses else ""

            # Step 1: Fetch raw values (Cypher toFloat fails on "199米"; do it in Python)
            raw_cypher = f"""
            MATCH (s:State)-[ha:hasAttribute]->(attr:Attribute)
            WHERE s.id CONTAINS $eid
              AND ha.type IN $attr_names
              AND s.start_time IS NOT NULL
              {time_filter}
            RETURN {bucket_expr} AS time_bucket,
                   attr.value AS raw_val
            ORDER BY time_bucket ASC
            LIMIT $lim
            """
            raw_rows = session.run(raw_cypher, **params).data()

        # Step 2: Parse numerics in Python and aggregate per bucket
        from collections import defaultdict
        bucket_vals = defaultdict(list)
        non_numeric_count = 0
        for r in raw_rows:
            bucket = r["time_bucket"]
            num = parse_numeric(neo4j_to_python(r["raw_val"]))
            if num is not None:
                bucket_vals[bucket].append(num)
            else:
                non_numeric_count += 1

        if non_numeric_count > 0 and not bucket_vals:
            result["attr_suggestion"] = (
                result.get("attr_suggestion", "") +
                f" All {non_numeric_count} values are non-numeric (cannot aggregate)."
            ).strip()

        # Apply aggregation per bucket
        def apply_agg(vals, method):
            if not vals:
                return None
            if method == "sum":
                return round(sum(vals), 4)
            elif method == "avg":
                return round(sum(vals) / len(vals), 4)
            elif method == "max":
                return max(vals)
            elif method == "min":
                return min(vals)
            elif method == "count":
                return len(vals)
            return None

        buckets = []
        agg_values = []
        for bucket in sorted(bucket_vals.keys()):
            vals = bucket_vals[bucket]
            agg_val = apply_agg(vals, agg_method)
            buckets.append({
                "time_bucket": bucket,
                "agg_value": agg_val,
                "record_count": len(vals)
            })
            if agg_val is not None:
                agg_values.append(agg_val)

        result["buckets"] = buckets
        result["bucket_count"] = len(buckets)

        if agg_values:
            result["stats"] = {
                "overall_max": max(agg_values),
                "overall_min": min(agg_values),
                "overall_mean": round(sum(agg_values) / len(agg_values), 4),
                "peak_bucket": buckets[agg_values.index(max(agg_values))]["time_bucket"]
            }

    finally:
        driver.close()

    return result


def main():
    parser = argparse.ArgumentParser(description="Time-granularity aggregation of entity attribute")
    parser.add_argument("--entity", required=True, help="Entity name or ID keyword")
    parser.add_argument("--attr", required=True, help="Attribute name (e.g. 水位, 降雨量)")
    parser.add_argument("--start", default=None, help="Start date YYYY-MM-DD")
    parser.add_argument("--end", default=None, help="End date YYYY-MM-DD")
    parser.add_argument("--interval", choices=["day", "week", "month", "year"],
                        default="month", help="Time bucket size (default: month)")
    parser.add_argument("--agg", choices=["sum", "avg", "max", "min", "count"],
                        default="avg", help="Aggregation method (default: avg)")
    parser.add_argument("--limit", type=int, default=200, help="Max raw records (default: 200)")
    parser.add_argument("--fuzzy", action="store_true",
                        help="Use CONTAINS match when exact attribute name not found")
    args = parser.parse_args()

    try:
        data = time_aggregate(
            args.entity, args.attr,
            start_date=args.start,
            end_date=args.end,
            interval=args.interval,
            agg_method=args.agg,
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
