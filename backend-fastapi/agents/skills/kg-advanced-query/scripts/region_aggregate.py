#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
region_aggregate.py - Regional aggregation statistics

Function: Aggregate a specific attribute by administrative region.
          When results are empty, returns diagnostic info with available
          attributes and region suggestions.
Usage:
  python scripts/region_aggregate.py --region "广西" --attr "降雨量" \
      --start 2023-06-01 --end 2023-09-30 --agg sum
  python scripts/region_aggregate.py --region "L-45" --attr "受灾人口" \
      --agg max --limit 50
  python scripts/region_aggregate.py --region "L-45" --attr "人口" --fuzzy
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
    """Extract float from strings like '199.70米', '3.9亿元', '528800人'."""
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


def diagnose_empty_region(session, region_keyword, attr_name, time_filter_desc):
    """Provide diagnostic info when no results are found."""
    diag = {}

    # 1. Check if region exists at all
    region_cypher = """
    MATCH (e:entity)
    WHERE e.name CONTAINS $kw OR e.id CONTAINS $kw
    RETURN e.id AS id, e.name AS name, labels(e) AS labels
    LIMIT 10
    """
    regions = session.run(region_cypher, kw=region_keyword).data()
    diag["matching_entities"] = [
        {"id": r["id"], "name": r["name"],
         "labels": [l for l in r["labels"] if l != "entity"]}
        for r in regions
    ]

    # 2. Check what attributes are available in this region (any state)
    attr_cypher = """
    MATCH (s:State)-[ha:hasAttribute]->(:Attribute)
    WHERE s.id CONTAINS $kw
    RETURN ha.type AS attr_name, count(*) AS cnt
    ORDER BY cnt DESC LIMIT 20
    """
    attrs = session.run(attr_cypher, kw=region_keyword).data()
    diag["available_attributes_in_region"] = [
        {"attr_name": r["attr_name"], "count": r["cnt"]} for r in attrs
    ]

    # 3. Check if the attribute exists anywhere in the KG
    global_attr_cypher = """
    MATCH (s:State)-[ha:hasAttribute]->(:Attribute)
    WHERE ha.type CONTAINS $attr
    RETURN ha.type AS attr_name, count(*) AS cnt
    ORDER BY cnt DESC LIMIT 10
    """
    global_attrs = session.run(global_attr_cypher, attr=attr_name).data()
    diag["global_attr_variants"] = [
        {"attr_name": r["attr_name"], "count": r["cnt"]} for r in global_attrs
    ]

    # 4. State count in region
    state_count = session.run(
        "MATCH (s:State) WHERE s.id CONTAINS $kw RETURN count(s) AS cnt",
        kw=region_keyword
    ).single()
    diag["total_states_in_region"] = state_count["cnt"] if state_count else 0

    diag["suggestion"] = (
        f"No results for region='{region_keyword}', attr='{attr_name}'"
        + (f", time={time_filter_desc}" if time_filter_desc else "") + ". "
        "Try: (1) Use --fuzzy for attribute fuzzy match. "
        "(2) Use an attribute from 'available_attributes_in_region'. "
        "(3) Try a broader region keyword (e.g. 'L-45' for all Guangxi). "
        "(4) Remove time range filter."
    )
    return diag


def region_aggregate(region_keyword, attr_name, start_date=None, end_date=None,
                     agg_method="sum", limit=100, fuzzy=False):
    """
    Aggregate an attribute across sub-regions within a region.
    Uses Python-side numeric parsing to handle unit-bearing strings.
    """
    driver = get_driver()
    result = {
        "region_keyword": region_keyword,
        "attr_name": attr_name,
        "time_range": {"start": start_date, "end": end_date},
        "agg_method": agg_method,
        "rows": [],
        "total_entities": 0
    }

    try:
        with driver.session() as session:
            # Resolve attribute name(s)
            # Check exact match
            exact_check = session.run(
                "MATCH (s:State)-[ha:hasAttribute]->(:Attribute) "
                "WHERE s.id CONTAINS $kw AND ha.type = $attr RETURN count(*) AS cnt",
                kw=region_keyword, attr=attr_name
            ).single()["cnt"]

            if exact_check == 0:
                candidates = session.run(
                    "MATCH (s:State)-[ha:hasAttribute]->(:Attribute) "
                    "WHERE s.id CONTAINS $kw AND ha.type CONTAINS $attr "
                    "RETURN ha.type AS n, count(*) AS c ORDER BY c DESC LIMIT 10",
                    kw=region_keyword, attr=attr_name
                ).data()
                candidate_names = [r["n"] for r in candidates]
                if candidate_names and fuzzy:
                    attr_names = candidate_names
                    result["attr_suggestion"] = (
                        f"Exact '{attr_name}' not found; using fuzzy matches: {attr_names}"
                    )
                else:
                    attr_names = [attr_name]  # Will yield no results, triggers diagnosis below
                    if candidate_names:
                        result["attr_suggestion"] = (
                            f"Exact '{attr_name}' not found. "
                            f"Similar: {candidate_names}. Use --fuzzy to auto-expand."
                        )
            else:
                attr_names = [attr_name]

            result["resolved_attr_names"] = attr_names

            # Build time filter
            time_clauses = []
            params = {"region_kw": region_keyword, "attr_names": attr_names, "lim": limit * 10}
            if start_date:
                time_clauses.append("s.start_time >= date($start_date)")
                params["start_date"] = start_date
            if end_date:
                time_clauses.append("s.end_time <= date($end_date)")
                params["end_date"] = end_date
            time_filter = ("AND " + " AND ".join(time_clauses)) if time_clauses else ""
            time_filter_desc = f"{start_date or ''}~{end_date or ''}" if (start_date or end_date) else ""

            # Fetch raw rows
            cypher = f"""
            MATCH (s:State)-[ha:hasAttribute]->(attr:Attribute)
            WHERE s.id CONTAINS $region_kw
              AND ha.type IN $attr_names
              {time_filter}
            UNWIND s.entity_ids AS eid
            OPTIONAL MATCH (e:entity {{id: eid}})
            RETURN COALESCE(e.name, eid) AS entity_name,
                   eid AS entity_id,
                   attr.value AS raw_val
            LIMIT $lim
            """
            raw_rows = session.run(cypher, **params).data()

            if not raw_rows:
                # Fallback: by entity name (e.g. region_keyword = "广西")
                cypher2 = f"""
                MATCH (region:entity)
                WHERE region.name CONTAINS $region_kw OR region.id CONTAINS $region_kw
                MATCH (sub:地点:entity)-[:locatedIn*0..3]->(region)
                MATCH (s:State)-[ha:hasAttribute]->(attr:Attribute)
                WHERE ANY(eid IN s.entity_ids WHERE eid = sub.id)
                  AND ha.type IN $attr_names
                  {time_filter}
                RETURN sub.name AS entity_name, sub.id AS entity_id,
                       attr.value AS raw_val
                LIMIT $lim
                """
                raw_rows = session.run(cypher2, **params).data()

        if not raw_rows:
            with driver.session() as session2:
                result["diagnosis"] = diagnose_empty_region(
                    session2, region_keyword, attr_name, time_filter_desc
                )
            result["total_entities"] = 0
            return result

        # Aggregate in Python (handles unit strings)
        from collections import defaultdict
        entity_vals = defaultdict(list)
        entity_raw = defaultdict(list)
        for r in raw_rows:
            name = r["entity_name"]
            num = parse_numeric(neo4j_to_python(r["raw_val"]))
            if num is not None:
                entity_vals[name].append(num)
            entity_raw[name].append(neo4j_to_python(r["raw_val"]))

        def apply_agg(vals, method):
            if not vals:
                return None
            if method == "sum":   return round(sum(vals), 4)
            if method == "avg":   return round(sum(vals) / len(vals), 4)
            if method == "max":   return max(vals)
            if method == "min":   return min(vals)
            if method == "count": return len(vals)
            return None

        rows = []
        for name, vals in entity_vals.items():
            agg_val = apply_agg(vals, agg_method)
            rows.append({
                "entity_name": name,
                "record_count": len(vals),
                "agg_value": agg_val,
                "sample_values": entity_raw[name][:3]
            })

        rows.sort(key=lambda x: (x["agg_value"] is None, -(x["agg_value"] or 0)))
        rows = rows[:limit]

        result["rows"] = rows
        result["total_entities"] = len(rows)

        agg_vals = [r["agg_value"] for r in rows if r["agg_value"] is not None]
        if agg_vals:
            result["overall"] = {
                "total": round(sum(agg_vals), 4),
                "max": max(agg_vals),
                "min": min(agg_vals),
                "mean": round(sum(agg_vals) / len(agg_vals), 4)
            }

    finally:
        driver.close()

    return result


def main():
    parser = argparse.ArgumentParser(description="Region-level attribute aggregation")
    parser.add_argument("--region", required=True, help="Region name or ID prefix (e.g. 广西, L-45)")
    parser.add_argument("--attr", required=True, help="Attribute name (e.g. 降雨量, 受灾人口)")
    parser.add_argument("--start", default=None, help="Start date YYYY-MM-DD")
    parser.add_argument("--end", default=None, help="End date YYYY-MM-DD")
    parser.add_argument("--agg", choices=["sum", "avg", "max", "min", "count"],
                        default="sum", help="Aggregation method (default: sum)")
    parser.add_argument("--limit", type=int, default=100, help="Max entities returned (default: 100)")
    parser.add_argument("--fuzzy", action="store_true",
                        help="Use CONTAINS match when exact attribute name not found")
    args = parser.parse_args()

    try:
        data = region_aggregate(
            args.region, args.attr,
            start_date=args.start,
            end_date=args.end,
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
