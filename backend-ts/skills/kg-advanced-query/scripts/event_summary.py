#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
event_summary.py - Event impact summary

Function: Given an event keyword or ID, produce a structured damage/impact
          summary by combining causal chain traversal with attribute collection.
          Replaces the two-step workflow of causal_trace + manual Cypher.

What it does in one call:
  1. Resolve anchor states for the event (same 3-layer strategy as causal_trace)
  2. Walk downstream hasRelation chains to find all affected states
  3. Pull all attributes from each affected state
  4. Group results by entity type (地点/设施/事件) and attribute name
  5. Return structured summary + per-entity detail

Usage:
  python scripts/event_summary.py --event "FLOOD" --start 2020-01-01 --end 2020-12-31
  python scripts/event_summary.py --event "E-450000-20200529-FLOOD"
  python scripts/event_summary.py --event "HEAVY_RAIN" --attrs "受灾人口,直接经济损失"
  python scripts/event_summary.py --event "洪水" --depth 2 --start 2023-01-01
"""

import sys
import os
import re
import json
import argparse
from collections import defaultdict

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
    """Extract float from strings like '199.70米', '3.9亿元'."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    m = re.match(r'^([+-]?\d+\.?\d*)', str(value).strip())
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass
    return None


def resolve_anchors(session, event_keyword):
    """
    Three-layer anchor resolution (same logic as causal_trace.py).
    Returns (anchor_ids, layer_used).
    """
    # Layer 1: direct State match
    L1 = session.run("""
        MATCH (s:State)
        WHERE s.id CONTAINS $kw
           OR ANY(eid IN s.entity_ids WHERE eid CONTAINS $kw)
           OR (s.state_type IS NOT NULL AND s.state_type CONTAINS $kw)
        RETURN s.id AS sid LIMIT 20
    """, kw=event_keyword).data()
    if L1:
        return [r['sid'] for r in L1], 'layer1_direct'

    # Layer 2: entity → hasState → nextState*
    L2 = session.run("""
        MATCH (e:entity)
        WHERE e.id = $kw OR e.id CONTAINS $kw OR e.name CONTAINS $kw
        MATCH (e)-[:hasState]->(s0:State)
        OPTIONAL MATCH (s0)-[:nextState*0..50]->(s:State)
        WITH COALESCE(s, s0) AS s
        RETURN s.id AS sid LIMIT 50
    """, kw=event_keyword).data()
    if L2:
        return [r['sid'] for r in L2], 'layer2_entity_states'

    # Layer 3: contain parent
    L3 = session.run("""
        MATCH (e:entity)
        WHERE e.id = $kw OR e.id CONTAINS $kw OR e.name CONTAINS $kw
        MATCH (e)-[:hasState]->(s0:State)
        MATCH (parent:State)-[:contain]->(s0)
        RETURN parent.id AS sid LIMIT 20
    """, kw=event_keyword).data()
    if L3:
        return [r['sid'] for r in L3], 'layer3_contain'

    return [], None


def collect_affected_states(session, anchor_ids, depth, start_date, end_date, limit):
    """
    Walk downstream hasRelation chains from anchor states,
    collect all affected state IDs with their causal distance.
    Returns list of {state_id, depth, causal_type, anchor_id}.
    """
    depth_range = f"1..{depth}"
    params = {'ids': anchor_ids, 'lim': limit}
    time_clauses = []
    if start_date:
        time_clauses.append("effect.start_time >= date($start_date)")
        params['start_date'] = start_date
    if end_date:
        time_clauses.append("effect.end_time <= date($end_date)")
        params['end_date'] = end_date
    time_filter = ("AND " + " AND ".join(time_clauses)) if time_clauses else ""

    cypher = f"""
    UNWIND $ids AS anchor_id
    MATCH (source:State {{id: anchor_id}})
    MATCH p = (source)-[:hasRelation*{depth_range}]->(effect:State)
    WHERE 1=1 {time_filter}
    WITH anchor_id,
         effect,
         length(p) AS chain_depth,
         [r IN relationships(p) | r.type] AS causal_types
    RETURN anchor_id,
           effect.id AS state_id,
           effect.state_type AS state_type,
           effect.start_time AS start_time,
           effect.end_time AS end_time,
           effect.entity_ids AS entity_ids,
           chain_depth,
           causal_types
    ORDER BY chain_depth ASC, effect.start_time ASC
    LIMIT $lim
    """
    rows = session.run(cypher, **params).data()
    return [
        {
            'state_id': r['state_id'],
            'state_type': r['state_type'],
            'start_time': neo4j_to_python(r['start_time']),
            'end_time': neo4j_to_python(r['end_time']),
            'entity_ids': neo4j_to_python(r['entity_ids']) or [],
            'chain_depth': r['chain_depth'],
            'causal_types': r['causal_types'],
            'anchor_id': r['anchor_id']
        }
        for r in rows
    ]


def fetch_state_attributes(session, state_ids, attr_filter_list):
    """
    Fetch all attributes for the given state IDs.
    Returns dict: state_id → list of {attr_name, value, numeric_value}
    """
    if not state_ids:
        return {}

    params = {'ids': state_ids}
    attr_clause = ""
    if attr_filter_list:
        # Match any attribute whose name contains one of the filter keywords
        attr_clause = "AND ANY(kw IN $attr_kws WHERE ha.type CONTAINS kw)"
        params['attr_kws'] = attr_filter_list

    cypher = f"""
    UNWIND $ids AS sid
    MATCH (s:State {{id: sid}})-[ha:hasAttribute]->(attr:Attribute)
    WHERE 1=1 {attr_clause}
    RETURN sid AS state_id, ha.type AS attr_name, attr.value AS value
    """
    rows = session.run(cypher, **params).data()

    result = defaultdict(list)
    for r in rows:
        raw = neo4j_to_python(r['value'])
        result[r['state_id']].append({
            'attr_name': r['attr_name'],
            'value': raw,
            'numeric_value': parse_numeric(raw)
        })
    return dict(result)


def classify_entity_type(entity_ids):
    """Infer entity type from entity_ids list."""
    for eid in (entity_ids or []):
        if eid.startswith('E-'):
            return '事件'
        if eid.startswith('F-'):
            return '设施'
        if eid.startswith('L-'):
            return '地点'
    return '未知'


def build_summary(affected_states, attrs_map):
    """
    Aggregate affected states into a structured summary:
    - by_entity_type: {地点/设施/事件: count}
    - key_attrs: {attr_name: {total, max, count, entities_affected}}
    - timeline: list of {date, event_count}
    """
    by_type = defaultdict(int)
    attr_agg = defaultdict(lambda: {
        'values': [], 'entity_ids_set': set(), 'state_count': 0
    })
    date_counts = defaultdict(int)

    for s in affected_states:
        etype = classify_entity_type(s['entity_ids'])
        by_type[etype] += 1

        if s['start_time']:
            date_counts[str(s['start_time'])[:7]] += 1  # group by month

        for attr in attrs_map.get(s['state_id'], []):
            aname = attr['attr_name']
            attr_agg[aname]['state_count'] += 1
            for eid in s['entity_ids']:
                attr_agg[aname]['entity_ids_set'].add(eid)
            if attr['numeric_value'] is not None:
                attr_agg[aname]['values'].append(attr['numeric_value'])

    key_attrs = {}
    for aname, agg in attr_agg.items():
        vals = agg['values']
        key_attrs[aname] = {
            'state_count': agg['state_count'],
            'entities_affected': len(agg['entity_ids_set']),
            'numeric_summary': {
                'total': round(sum(vals), 4),
                'max': max(vals),
                'min': min(vals),
                'mean': round(sum(vals) / len(vals), 4)
            } if vals else None
        }

    # Sort key_attrs by state_count desc
    key_attrs = dict(
        sorted(key_attrs.items(), key=lambda x: x[1]['state_count'], reverse=True)
    )

    return {
        'affected_state_count': len(affected_states),
        'by_entity_type': dict(by_type),
        'key_attributes': key_attrs,
        'monthly_distribution': dict(sorted(date_counts.items()))
    }


def event_summary(event_keyword, depth=2, start_date=None, end_date=None,
                  attr_keywords=None, limit=200):
    """
    Full event impact summary in one call.
    """
    driver = get_driver()
    result = {
        'event_keyword': event_keyword,
        'depth': depth,
        'time_range': {'start': start_date, 'end': end_date}
    }

    try:
        with driver.session() as session:
            # Step 1: Resolve anchors
            anchor_ids, layer_used = resolve_anchors(session, event_keyword)
            if not anchor_ids:
                result['error'] = f"No states found for event: {event_keyword}"
                result['suggestion'] = (
                    "Try: (1) English event type like 'FLOOD', 'HEAVY_RAIN'. "
                    "(2) Full entity ID like 'E-450000-20200529-FLOOD'. "
                    "(3) Use explore.py --list-events to find valid event names."
                )
                return result

            result['anchor_count'] = len(anchor_ids)
            result['anchor_layer'] = layer_used

            # Also get anchor state details for context
            anchor_detail = session.run("""
                MATCH (s:State) WHERE s.id IN $ids
                OPTIONAL MATCH (s)-[ha:hasAttribute]->(attr:Attribute)
                WITH s, collect({attr_name: ha.type, value: attr.value}) AS attrs
                RETURN s.id AS sid, s.state_type AS state_type,
                       s.start_time AS start_time, s.end_time AS end_time,
                       s.entity_ids AS entity_ids,
                       [a IN attrs WHERE a.attr_name IS NOT NULL] AS attributes
                LIMIT 10
            """, ids=anchor_ids[:10]).data()
            result['anchor_states'] = [
                {
                    'id': r['sid'],
                    'state_type': r['state_type'],
                    'start_time': neo4j_to_python(r['start_time']),
                    'end_time': neo4j_to_python(r['end_time']),
                    'entity_ids': neo4j_to_python(r['entity_ids']) or [],
                    'attributes': neo4j_to_python(r['attributes'])
                }
                for r in anchor_detail
            ]

            # Step 2: Collect affected states downstream
            affected = collect_affected_states(
                session, anchor_ids, depth, start_date, end_date, limit
            )
            result['affected_count'] = len(affected)

            if not affected:
                result['note'] = (
                    "No downstream affected states found. "
                    "The event may only have upstream causes. "
                    "Check anchor_states above for the event's own attributes."
                )
                # Still return anchor attributes as the "impact"
                anchor_attr_map = fetch_state_attributes(
                    session, anchor_ids[:20], attr_keywords
                )
                result['anchor_attributes'] = {
                    sid: attrs for sid, attrs in anchor_attr_map.items() if attrs
                }
                return result

            # Step 3: Fetch attributes for all affected states
            affected_ids = list({s['state_id'] for s in affected})
            attrs_map = fetch_state_attributes(session, affected_ids, attr_keywords)

            # Step 4: Build summary
            result['summary'] = build_summary(affected, attrs_map)

            # Step 5: Per-entity detail (grouped by entity_id)
            entity_detail = defaultdict(lambda: {
                'entity_id': None, 'entity_type': None,
                'states': []
            })
            for s in affected:
                for eid in s['entity_ids']:
                    entity_detail[eid]['entity_id'] = eid
                    entity_detail[eid]['entity_type'] = classify_entity_type([eid])
                    entity_detail[eid]['states'].append({
                        'state_id': s['state_id'],
                        'chain_depth': s['chain_depth'],
                        'causal_types': s['causal_types'],
                        'start_time': s['start_time'],
                        'end_time': s['end_time'],
                        'attributes': attrs_map.get(s['state_id'], [])
                    })

            result['affected_entities'] = list(entity_detail.values())

    finally:
        driver.close()

    return result


def main():
    parser = argparse.ArgumentParser(
        description="Event impact summary: causal chain + attribute collection in one call"
    )
    parser.add_argument("--event", required=True,
                        help="Event keyword, entity ID, or state_type (e.g. FLOOD, HEAVY_RAIN)")
    parser.add_argument("--depth", type=int, default=2,
                        help="Downstream causal chain depth (default: 2)")
    parser.add_argument("--start", default=None, help="Start date YYYY-MM-DD")
    parser.add_argument("--end", default=None, help="End date YYYY-MM-DD")
    parser.add_argument("--attrs", default=None,
                        help="Comma-separated attribute keywords to filter "
                             "(e.g. '受灾人口,直接经济损失'). Empty = all attributes.")
    parser.add_argument("--limit", type=int, default=200,
                        help="Max affected states (default: 200)")
    args = parser.parse_args()

    attr_keywords = [k.strip() for k in args.attrs.split(',')] if args.attrs else None

    try:
        data = event_summary(
            args.event,
            depth=args.depth,
            start_date=args.start,
            end_date=args.end,
            attr_keywords=attr_keywords,
            limit=args.limit
        )
        print(json.dumps({"success": True, "data": data}, ensure_ascii=False, indent=2))
        return 0
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    sys.exit(main())
