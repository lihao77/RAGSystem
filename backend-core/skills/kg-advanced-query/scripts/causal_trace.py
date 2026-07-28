#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
causal_trace.py - Causal chain tracing

Function: Trace the cause-and-effect chain of an event (upstream causes or
          downstream consequences). When no event states are found, returns
          diagnostic information with candidate entities.

Anchor resolution strategy (layered, stops at first non-empty result):
  Layer 1 - State ID / entity_ids / state_type direct match (fast path)
  Layer 2 - All states reachable from matched base entities via hasState+nextState
  Layer 3 - Any state connected to matched entities via contain relation

Usage:
  python scripts/causal_trace.py --event "洪水" --direction upstream --depth 3
  python scripts/causal_trace.py --event "E-450000-20200529-FLOOD" \
      --direction downstream --depth 2
  python scripts/causal_trace.py --event "堤坝溃决" --direction both --depth 2
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


def _state_row(r):
    return {
        "id": r["sid"],
        "state_type": r["state_type"],
        "start_time": neo4j_to_python(r["start_time"]),
        "entity_ids": neo4j_to_python(r["entity_ids"]) if r["entity_ids"] else []
    }


def resolve_anchors(session, event_keyword):
    """
    Resolve anchor state IDs using a three-layer strategy.

    Layer 1: States whose ID / entity_ids / state_type directly match the keyword.
    Layer 2: All states reachable from base entities matching the keyword
             (via hasState + nextState* chain). Handles the case where
             'E-450000-20200529-FLOOD' is an entity ID but states are named
             differently (e.g. 'ES-E-450000-...-FLOOD-...').
    Layer 3: States connected to matched entities via contain relation.

    Returns (list_of_state_ids, anchor_detail_list, layer_used)
    """
    # --- Layer 1: direct match ---
    L1 = session.run("""
        MATCH (s:State)
        WHERE s.id CONTAINS $kw
           OR ANY(eid IN s.entity_ids WHERE eid CONTAINS $kw)
           OR (s.state_type IS NOT NULL AND s.state_type CONTAINS $kw)
        RETURN s.id AS sid, s.state_type AS state_type,
               s.start_time AS start_time, s.entity_ids AS entity_ids
        LIMIT 20
    """, kw=event_keyword).data()

    if L1:
        ids = list({r["sid"] for r in L1})
        return ids, [_state_row(r) for r in L1], "layer1_direct"

    # --- Layer 2: base entity → hasState → nextState* ---
    L2 = session.run("""
        MATCH (e:entity)
        WHERE e.id = $kw OR e.id CONTAINS $kw OR e.name CONTAINS $kw
        MATCH (e)-[:hasState]->(s0:State)
        OPTIONAL MATCH (s0)-[:nextState*0..50]->(s:State)
        WITH COALESCE(s, s0) AS s
        RETURN s.id AS sid, s.state_type AS state_type,
               s.start_time AS start_time, s.entity_ids AS entity_ids
        LIMIT 50
    """, kw=event_keyword).data()

    if L2:
        ids = list({r["sid"] for r in L2})
        return ids, [_state_row(r) for r in L2], "layer2_entity_states"

    # --- Layer 3: contain relation ---
    L3 = session.run("""
        MATCH (e:entity)
        WHERE e.id = $kw OR e.id CONTAINS $kw OR e.name CONTAINS $kw
        MATCH (e)-[:hasState]->(s0:State)
        MATCH (parent:State)-[:contain]->(s0)
        RETURN parent.id AS sid, parent.state_type AS state_type,
               parent.start_time AS start_time, parent.entity_ids AS entity_ids
        LIMIT 20
    """, kw=event_keyword).data()

    if L3:
        ids = list({r["sid"] for r in L3})
        return ids, [_state_row(r) for r in L3], "layer3_contain"

    return [], [], None


def diagnose_no_anchors(session, event_keyword):
    """Diagnostic info when no anchor states were found at all."""
    diag = {}

    entities = session.run(
        "MATCH (e:事件:entity) WHERE e.name CONTAINS $kw OR e.id CONTAINS $kw "
        "RETURN e.id AS id, e.name AS name LIMIT 10",
        kw=event_keyword
    ).data()
    diag["matching_event_entities"] = [{"id": e["id"], "name": e["name"]} for e in entities]

    causal_states = session.run(
        "MATCH (s:State)-[:hasRelation]-() "
        "WHERE ANY(eid IN s.entity_ids WHERE eid CONTAINS $kw) OR s.id CONTAINS $kw "
        "RETURN s.id AS sid, s.state_type AS state_type, "
        "s.start_time AS start_time, s.entity_ids AS entity_ids LIMIT 10",
        kw=event_keyword
    ).data()
    diag["states_with_causal_relations"] = [_state_row(r) for r in causal_states]

    all_events = session.run(
        "MATCH (e:事件:entity) RETURN e.name AS name, e.id AS id "
        "ORDER BY e.name ASC LIMIT 30"
    ).data()
    diag["all_event_entities_sample"] = [{"id": e["id"], "name": e["name"]} for e in all_events]

    total = session.run("MATCH ()-[r:hasRelation]->() RETURN count(r) AS total").single()
    diag["total_causal_relations_in_kg"] = total["total"] if total else 0

    diag["suggestion"] = (
        f"No states found for '{event_keyword}'. "
        "Try: (1) Use an event entity name from 'matching_event_entities'. "
        "(2) Use a full entity ID like 'E-450000-20200529-FLOOD'. "
        "(3) Use a state_type keyword like '洪涝' or '暴雨'. "
        "(4) Use a state ID from 'states_with_causal_relations'."
    )
    return diag


def diagnose_no_chains(session, anchor_ids, direction, max_depth, layer_used):
    """
    When anchor states exist but no causal chains were found,
    probe the neighborhood to explain why and suggest alternatives.
    """
    diag = {"anchor_ids": anchor_ids, "anchor_layer": layer_used}

    # Check whether any of the anchor states have ANY hasRelation edges at all
    has_any = session.run("""
        MATCH (s:State)-[r:hasRelation]-(other:State)
        WHERE s.id IN $ids
        RETURN s.id AS sid, type(r) AS rel_type,
               other.id AS other_id, other.state_type AS other_type,
               r.type AS causal_type
        LIMIT 20
    """, ids=anchor_ids).data()

    diag["anchor_direct_relations"] = [
        {
            "anchor": r["sid"],
            "direction": "outgoing" if r["rel_type"] else "unknown",
            "related_state": r["other_id"],
            "related_state_type": r["other_type"],
            "causal_type": r["causal_type"]
        }
        for r in has_any
    ]

    if has_any:
        diag["suggestion"] = (
            f"Anchor states have direct hasRelation edges (shown above), but the "
            f"requested direction='{direction}' / depth={max_depth} didn't match. "
            "Try: (1) direction='both'. "
            "(2) The causal edges may point in the opposite direction. "
            "(3) Increase --depth."
        )
    else:
        # Check states connected via contain that might have relations
        contain_related = session.run("""
            MATCH (s:State)
            WHERE s.id IN $ids
            MATCH (parent:State)-[:contain]->(s)
            OPTIONAL MATCH (parent)-[r:hasRelation]-(other:State)
            RETURN parent.id AS parent_id, parent.state_type AS parent_type,
                   other.id AS other_id, r.type AS causal_type
            LIMIT 10
        """, ids=anchor_ids).data()

        diag["contain_parent_relations"] = [
            {
                "parent": r["parent_id"],
                "parent_type": r["parent_type"],
                "related_state": r["other_id"],
                "causal_type": r["causal_type"]
            }
            for r in contain_related if r["other_id"]
        ]

        if contain_related and any(r["other_id"] for r in contain_related):
            parent_ids = list({r["parent_id"] for r in contain_related if r["parent_id"]})
            diag["suggestion"] = (
                f"Anchor states have no direct hasRelation edges. "
                f"But their parent (contain) states do: {parent_ids[:3]}. "
                "Try passing the parent state ID as --event, or use direction='both'."
            )
        else:
            diag["suggestion"] = (
                f"Anchor states ({anchor_ids[:3]}) have no hasRelation edges "
                f"and no connected parent states with causal links. "
                "The causal relations for this event may not exist in the KG. "
                "Use explore.py --list-events to find events with richer causal data."
            )
    return diag


def build_chain_entry(dir_label, anchor_id, ns, rs):
    chain_nodes = [
        {
            "id": neo4j_to_python(n.get("id")),
            "state_type": neo4j_to_python(n.get("state_type")),
            "start_time": neo4j_to_python(n.get("start_time")),
            "end_time": neo4j_to_python(n.get("end_time")),
            "entity_ids": neo4j_to_python(n.get("entity_ids")) or []
        }
        for n in ns
    ]
    chain_rels = []
    for rel in rs:
        # Neo4j Relationship object: rel.start_node, rel.end_node are Node objects;
        # rel.type is the relationship label; rel["type"] is the "type" property.
        try:
            from_id = neo4j_to_python(rel.start_node.get("id"))
            to_id = neo4j_to_python(rel.end_node.get("id"))
            causal_type = neo4j_to_python(rel.get("type"))  # property named "type"
        except (AttributeError, TypeError):
            # Fallback: rel came in as a tuple (start, type_str, end) from .data()
            from_id = str(rel[0]) if len(rel) > 0 else None
            to_id = str(rel[2]) if len(rel) > 2 else None
            causal_type = str(rel[1]) if len(rel) > 1 else None
        chain_rels.append({"from": from_id, "to": to_id, "causal_type": causal_type})

    return {
        "direction": dir_label,
        "anchor": anchor_id,
        "depth": len(ns) - 1,
        "nodes": chain_nodes,
        "relations": chain_rels
    }


def trace_causal_chain(event_keyword, direction="upstream", max_depth=3, limit=50):
    driver = get_driver()
    result = {
        "event_keyword": event_keyword,
        "direction": direction,
        "max_depth": max_depth,
        "anchor_states": [],
        "chains": []
    }
    depth_range = f"1..{max_depth}"

    try:
        with driver.session() as session:
            anchor_ids, anchor_detail, layer_used = resolve_anchors(session, event_keyword)

            if not anchor_ids:
                result["diagnosis"] = diagnose_no_anchors(session, event_keyword)
                result["chain_count"] = 0
                return result

            result["anchor_states"] = anchor_detail
            result["anchor_layer"] = layer_used

            all_chains = []
            for anchor_id in anchor_ids:
                queries = []
                if direction in ("upstream", "both"):
                    queries.append(("upstream", f"""
                        MATCH p = (cause:State)-[:hasRelation*{depth_range}]->
                                  (target:State {{id: $anchor}})
                        RETURN nodes(p) AS ns, relationships(p) AS rs
                        LIMIT $lim
                    """))
                if direction in ("downstream", "both"):
                    queries.append(("downstream", f"""
                        MATCH p = (source:State {{id: $anchor}})-[:hasRelation*{depth_range}]->
                                  (effect:State)
                        RETURN nodes(p) AS ns, relationships(p) AS rs
                        LIMIT $lim
                    """))

                for dir_label, cypher in queries:
                    # Use .data() only for nodes; fetch relationships separately
                    # to avoid tuple-vs-object issues with relationships(p)
                    raw = session.run(cypher, anchor=anchor_id, lim=limit)
                    for record in raw:
                        ns = record["ns"]   # list of Node objects
                        rs = record["rs"]   # list of Relationship objects
                        all_chains.append(
                            build_chain_entry(dir_label, anchor_id, ns, rs)
                        )

            result["chains"] = all_chains
            result["chain_count"] = len(all_chains)

            if not all_chains:
                result["diagnosis"] = diagnose_no_chains(
                    session, anchor_ids, direction, max_depth, layer_used
                )

    finally:
        driver.close()

    return result


def main():
    parser = argparse.ArgumentParser(description="Trace causal chain in knowledge graph")
    parser.add_argument("--event", required=True, help="Event name, entity ID, or state keyword")
    parser.add_argument("--direction", choices=["upstream", "downstream", "both"],
                        default="upstream", help="Trace direction (default: upstream)")
    parser.add_argument("--depth", type=int, default=3, help="Max traversal depth (default: 3)")
    parser.add_argument("--limit", type=int, default=50, help="Max chains per anchor (default: 50)")
    args = parser.parse_args()

    try:
        data = trace_causal_chain(
            args.event,
            direction=args.direction,
            max_depth=args.depth,
            limit=args.limit
        )
        print(json.dumps({"success": True, "data": data}, ensure_ascii=False, indent=2))
        return 0
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    sys.exit(main())
