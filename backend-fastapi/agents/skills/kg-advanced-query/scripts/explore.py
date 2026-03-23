#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
explore.py - Knowledge graph exploration and data availability check

Function: Before querying, use this script to understand what data is available
          for an entity or region: available attribute names, time range, data
          volume, sample values. Eliminates guesswork about attribute names.
Usage:
  python scripts/explore.py --entity "潘厂水库"
  python scripts/explore.py --entity "L-45" --attr "人口"
  python scripts/explore.py --region "广西" --time-range
  python scripts/explore.py --list-events
  python scripts/explore.py --global-attrs
"""

import sys
import os
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


def explore_entity(session, entity_keyword, attr_filter=None):
    """
    Show all available attributes for an entity, with time range and sample values.
    """
    result = {"mode": "entity", "entity_keyword": entity_keyword}

    # 1. Find matching base entities
    entity_rows = session.run(
        "MATCH (e:entity) WHERE e.name CONTAINS $kw OR e.id CONTAINS $kw OR e.id = $kw "
        "RETURN e.id AS id, e.name AS name, labels(e) AS labels LIMIT 10",
        kw=entity_keyword
    ).data()
    result["matching_entities"] = [
        {"id": r["id"], "name": r["name"],
         "type": [l for l in r["labels"] if l != "entity"]}
        for r in entity_rows
    ]

    # 2. State count and overall time range
    time_row = session.run(
        "MATCH (s:State) WHERE s.id CONTAINS $kw "
        "RETURN count(s) AS state_count, "
        "min(s.start_time) AS earliest, max(s.end_time) AS latest",
        kw=entity_keyword
    ).single()
    if time_row:
        result["data_overview"] = {
            "state_count": time_row["state_count"],
            "earliest": neo4j_to_python(time_row["earliest"]),
            "latest": neo4j_to_python(time_row["latest"])
        }

    # 3. Available attributes (with optional filter)
    if attr_filter:
        attr_cypher = (
            "MATCH (s:State)-[ha:hasAttribute]->(attr:Attribute) "
            "WHERE s.id CONTAINS $kw AND ha.type CONTAINS $af "
            "RETURN ha.type AS attr_name, count(*) AS record_count, "
            "min(s.start_time) AS earliest, max(s.end_time) AS latest, "
            "collect(attr.value)[..3] AS samples "
            "ORDER BY record_count DESC LIMIT 20"
        )
        attr_rows = session.run(attr_cypher, kw=entity_keyword, af=attr_filter).data()
    else:
        attr_cypher = (
            "MATCH (s:State)-[ha:hasAttribute]->(attr:Attribute) "
            "WHERE s.id CONTAINS $kw "
            "RETURN ha.type AS attr_name, count(*) AS record_count, "
            "min(s.start_time) AS earliest, max(s.end_time) AS latest, "
            "collect(attr.value)[..3] AS samples "
            "ORDER BY record_count DESC LIMIT 30"
        )
        attr_rows = session.run(attr_cypher, kw=entity_keyword).data()

    result["available_attributes"] = [
        {
            "attr_name": r["attr_name"],
            "record_count": r["record_count"],
            "time_range": {
                "earliest": neo4j_to_python(r["earliest"]),
                "latest": neo4j_to_python(r["latest"])
            },
            "sample_values": neo4j_to_python(r["samples"])
        }
        for r in attr_rows
    ]

    return result


def explore_region_time_range(session, region_keyword):
    """Show time range coverage per attribute for a region."""
    result = {"mode": "region_time_range", "region_keyword": region_keyword}

    rows = session.run(
        "MATCH (s:State)-[ha:hasAttribute]->(attr:Attribute) "
        "WHERE s.id CONTAINS $kw "
        "RETURN ha.type AS attr_name, count(*) AS cnt, "
        "min(s.start_time) AS earliest, max(s.end_time) AS latest, "
        "count(DISTINCT s.id) AS distinct_states "
        "ORDER BY cnt DESC LIMIT 30",
        kw=region_keyword
    ).data()

    result["attribute_coverage"] = [
        {
            "attr_name": r["attr_name"],
            "total_records": r["cnt"],
            "distinct_states": r["distinct_states"],
            "time_range": {
                "earliest": neo4j_to_python(r["earliest"]),
                "latest": neo4j_to_python(r["latest"])
            }
        }
        for r in rows
    ]
    return result


def list_events(session):
    """List all event entities with their states and time ranges."""
    result = {"mode": "list_events"}

    rows = session.run(
        "MATCH (e:事件:entity) "
        "OPTIONAL MATCH (s:State) WHERE s.id CONTAINS e.id "
        "RETURN e.id AS id, e.name AS name, "
        "count(s) AS state_count, "
        "min(s.start_time) AS earliest "
        "ORDER BY earliest DESC LIMIT 50"
    ).data()

    result["events"] = [
        {
            "id": r["id"],
            "name": r["name"],
            "state_count": r["state_count"],
            "earliest_state": neo4j_to_python(r["earliest"])
        }
        for r in rows
    ]
    result["total"] = len(result["events"])
    return result


def global_attrs(session):
    """Show all attribute types across the entire knowledge graph with counts."""
    result = {"mode": "global_attributes"}

    rows = session.run(
        "MATCH ()-[ha:hasAttribute]->() "
        "RETURN ha.type AS attr_name, count(*) AS cnt "
        "ORDER BY cnt DESC LIMIT 50"
    ).data()

    result["all_attributes"] = [
        {"attr_name": r["attr_name"], "total_records": r["cnt"]}
        for r in rows
    ]
    result["total_attr_types"] = len(result["all_attributes"])
    return result


def main():
    parser = argparse.ArgumentParser(
        description="Explore knowledge graph data availability before querying"
    )
    parser.add_argument("--entity", default=None,
                        help="Entity name or ID keyword to explore")
    parser.add_argument("--attr", default=None,
                        help="Filter attributes by keyword (use with --entity)")
    parser.add_argument("--region", default=None,
                        help="Region keyword for time range coverage (use with --time-range)")
    parser.add_argument("--time-range", action="store_true",
                        help="Show time range coverage per attribute for a region")
    parser.add_argument("--list-events", action="store_true",
                        help="List all event entities in the knowledge graph")
    parser.add_argument("--global-attrs", action="store_true",
                        help="List all attribute types in the knowledge graph with counts")
    args = parser.parse_args()

    driver = get_driver()
    try:
        with driver.session() as session:
            if args.entity:
                data = explore_entity(session, args.entity, attr_filter=args.attr)
            elif args.region and args.time_range:
                data = explore_region_time_range(session, args.region)
            elif args.list_events:
                data = list_events(session)
            elif args.global_attrs:
                data = global_attrs(session)
            else:
                data = {"error": "Please specify one of: --entity, --region --time-range, "
                                 "--list-events, --global-attrs"}
    finally:
        driver.close()

    print(json.dumps({"success": True, "data": data}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
