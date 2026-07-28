#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
entity_detail.py - Entity detail query

Function: Query complete attributes, labels, and associated states for an entity.
Usage:
  python scripts/entity_detail.py --entity "潘厂水库"
  python scripts/entity_detail.py --entity "F-450381-潘厂水库"
  python scripts/entity_detail.py --entity "南宁市" --include-states
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


def query_entity_detail(entity_keyword, include_states=False, state_limit=20):
    driver = get_driver()
    result = {}
    try:
        with driver.session() as session:
            # 1. Find base entity by name or ID
            entity_cypher = """
            MATCH (e:entity)
            WHERE e.name = $kw OR e.id = $kw OR e.id CONTAINS $kw
            RETURN e.id AS id, e.name AS name, labels(e) AS labels,
                   properties(e) AS props
            LIMIT 5
            """
            entities = session.run(entity_cypher, kw=entity_keyword).data()
            if not entities:
                return {"error": f"No entity found for: {entity_keyword}"}

            best = entities[0]
            props = neo4j_to_python(best.get("props", {}))
            props.pop("geometry", None)  # Skip WKT geometry for brevity

            entity_id = best["id"]
            result["entity"] = {
                "id": entity_id,
                "name": best["name"],
                "labels": [l for l in best["labels"] if l != "entity"],
                "properties": props,
                "total_matches": len(entities),
                "other_matches": [e["name"] for e in entities[1:]]
            }

            # 2. Attribute summary across all states
            attr_cypher = """
            MATCH (s:State)-[ha:hasAttribute]->(attr:Attribute)
            WHERE s.id CONTAINS $eid
            RETURN ha.type AS attr_name, count(*) AS record_count,
                   collect(attr.value)[..3] AS sample_values
            ORDER BY record_count DESC
            """
            attrs = session.run(attr_cypher, eid=entity_id).data()
            result["attribute_summary"] = [
                {
                    "attr_name": a["attr_name"],
                    "record_count": a["record_count"],
                    "sample_values": neo4j_to_python(a["sample_values"])
                }
                for a in attrs
            ]

            # 3. State count and time range
            time_cypher = """
            MATCH (s:State)
            WHERE s.id CONTAINS $eid
            RETURN count(s) AS state_count,
                   min(s.start_time) AS earliest,
                   max(s.end_time) AS latest
            """
            time_info = session.run(time_cypher, eid=entity_id).single()
            if time_info:
                result["time_coverage"] = {
                    "state_count": time_info["state_count"],
                    "earliest": neo4j_to_python(time_info["earliest"]),
                    "latest": neo4j_to_python(time_info["latest"])
                }

            # 4. Causal relation count
            causal_cypher = """
            MATCH (s:State)-[r:hasRelation]-(s2:State)
            WHERE s.id CONTAINS $eid
            RETURN count(DISTINCT r) AS causal_count,
                   collect(DISTINCT r.type)[..5] AS relation_types
            """
            causal = session.run(causal_cypher, eid=entity_id).single()
            if causal:
                result["causal_relations"] = {
                    "count": causal["causal_count"],
                    "types": causal["relation_types"]
                }

            # 5. Optionally return recent states with attributes
            if include_states:
                states_cypher = """
                MATCH (s:State)
                WHERE s.id CONTAINS $eid
                OPTIONAL MATCH (s)-[ha:hasAttribute]->(attr:Attribute)
                WITH s, collect({name: ha.type, value: attr.value}) AS attrs
                ORDER BY s.start_time DESC
                LIMIT $lim
                RETURN s.id AS state_id, s.state_type AS state_type,
                       s.start_time AS start_time, s.end_time AS end_time,
                       attrs
                """
                states = session.run(states_cypher, eid=entity_id, lim=state_limit).data()
                result["recent_states"] = [
                    {
                        "id": s["state_id"],
                        "state_type": s["state_type"],
                        "start_time": neo4j_to_python(s["start_time"]),
                        "end_time": neo4j_to_python(s["end_time"]),
                        "attributes": [
                            a for a in neo4j_to_python(s["attrs"]) if a.get("name")
                        ]
                    }
                    for s in states
                ]

    finally:
        driver.close()

    return result


def main():
    parser = argparse.ArgumentParser(description="Query entity detail from knowledge graph")
    parser.add_argument("--entity", required=True, help="Entity name or ID keyword")
    parser.add_argument("--include-states", action="store_true",
                        help="Include recent states in output")
    parser.add_argument("--state-limit", type=int, default=20,
                        help="Max number of recent states to return (default: 20)")
    args = parser.parse_args()

    try:
        data = query_entity_detail(
            args.entity,
            include_states=args.include_states,
            state_limit=args.state_limit
        )
        print(json.dumps({"success": True, "data": data}, ensure_ascii=False, indent=2))
        return 0
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    sys.exit(main())
