#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
spatial_impact.py - Spatial impact analysis

Function: Given a location or event, find all spatially related entities
          (sub-regions, facilities, co-occurring events) and their state
          attributes within an optional time range.

Uses the spatial relations in the KG:
  - locatedIn  : administrative hierarchy (地点 → 地点, 设施 → 地点)
  - occurredAt : event → 地点

Modes:
  --mode subregions  Find all sub-locations under a region and their states
  --mode facilities  Find all facilities located in a region and their states
  --mode events      Find all events that occurred in a region (or its sub-regions)
  --mode all         All three combined (default)

Usage:
  python scripts/spatial_impact.py --location "南宁市"
  python scripts/spatial_impact.py --location "L-450100" --mode facilities \
      --start 2023-06-01 --end 2023-09-30 --attr "受灾人口"
  python scripts/spatial_impact.py --location "广西" --mode events \
      --start 2020-01-01 --end 2020-12-31
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


def _build_time_filter(params, start_date, end_date, state_alias='s'):
    clauses = []
    if start_date:
        clauses.append(f"{state_alias}.start_time >= date($start_date)")
        params['start_date'] = start_date
    if end_date:
        clauses.append(f"{state_alias}.end_time <= date($end_date)")
        params['end_date'] = end_date
    return ("AND " + " AND ".join(clauses)) if clauses else ""


def resolve_location_id(session, location_keyword):
    """
    Resolve a location keyword to one or more entity IDs.
    Returns list of (entity_id, entity_name).
    """
    rows = session.run(
        "MATCH (e:地点:entity) "
        "WHERE e.name CONTAINS $kw OR e.id = $kw OR e.id CONTAINS $kw "
        "RETURN e.id AS id, e.name AS name LIMIT 10",
        kw=location_keyword
    ).data()
    return [(r['id'], r['name']) for r in rows]


def query_subregions(session, location_id, location_name,
                     start_date, end_date, attr_filter, limit):
    """
    Find all direct sub-locations (locatedIn → this location) and their states.
    """
    params = {'parent_id': location_id, 'lim': limit}
    time_filter = _build_time_filter(params, start_date, end_date)
    attr_clause = "AND ha.type CONTAINS $attr" if attr_filter else ""
    if attr_filter:
        params['attr'] = attr_filter

    cypher = f"""
    MATCH (sub:地点:entity)-[:locatedIn]->(parent:地点:entity {{id: $parent_id}})
    OPTIONAL MATCH (s:State)
    WHERE ANY(eid IN s.entity_ids WHERE eid = sub.id)
      {time_filter}
    OPTIONAL MATCH (s)-[ha:hasAttribute]->(attr:Attribute)
    WHERE ha IS NULL OR (1=1 {attr_clause})
    WITH sub, s, collect({{attr_name: ha.type, value: attr.value}}) AS attrs
    ORDER BY sub.name ASC, s.start_time ASC
    RETURN sub.id AS entity_id, sub.name AS entity_name,
           s.id AS state_id,
           s.start_time AS start_time, s.end_time AS end_time,
           [a IN attrs WHERE a.attr_name IS NOT NULL] AS attributes
    LIMIT $lim
    """
    rows = session.run(cypher, **params).data()

    # Group by entity
    entities = {}
    for r in rows:
        eid = r['entity_id']
        if eid not in entities:
            entities[eid] = {
                'entity_id': eid,
                'entity_name': r['entity_name'],
                'states': []
            }
        if r['state_id']:
            entities[eid]['states'].append({
                'state_id': r['state_id'],
                'start_time': neo4j_to_python(r['start_time']),
                'end_time': neo4j_to_python(r['end_time']),
                'attributes': neo4j_to_python(r['attributes'])
            })

    return {
        'parent_location': {'id': location_id, 'name': location_name},
        'subregion_count': len(entities),
        'subregions': list(entities.values())
    }


def query_facilities(session, location_id, location_name,
                     start_date, end_date, attr_filter, limit):
    """
    Find all facilities located in this region (directly or via sub-locations)
    and their states.
    """
    params = {'loc_id': location_id, 'lim': limit}
    time_filter = _build_time_filter(params, start_date, end_date)
    attr_clause = "AND ha.type CONTAINS $attr" if attr_filter else ""
    if attr_filter:
        params['attr'] = attr_filter

    cypher = f"""
    MATCH (f:设施:entity)-[:locatedIn*1..3]->(loc:地点:entity)
    WHERE loc.id = $loc_id OR loc.id STARTS WITH $loc_id
    OPTIONAL MATCH (s:State)
    WHERE s.id CONTAINS f.id
      {time_filter}
    OPTIONAL MATCH (s)-[ha:hasAttribute]->(attr:Attribute)
    WHERE ha IS NULL OR (1=1 {attr_clause})
    WITH f, s, collect({{attr_name: ha.type, value: attr.value}}) AS attrs
    ORDER BY f.name ASC, s.start_time ASC
    RETURN f.id AS entity_id, f.name AS entity_name, f.facility_type AS facility_type,
           s.id AS state_id,
           s.start_time AS start_time, s.end_time AS end_time,
           [a IN attrs WHERE a.attr_name IS NOT NULL] AS attributes
    LIMIT $lim
    """
    rows = session.run(cypher, **params).data()

    entities = {}
    for r in rows:
        eid = r['entity_id']
        if eid not in entities:
            entities[eid] = {
                'entity_id': eid,
                'entity_name': r['entity_name'],
                'facility_type': r['facility_type'],
                'states': []
            }
        if r['state_id']:
            entities[eid]['states'].append({
                'state_id': r['state_id'],
                'start_time': neo4j_to_python(r['start_time']),
                'end_time': neo4j_to_python(r['end_time']),
                'attributes': neo4j_to_python(r['attributes'])
            })

    return {
        'parent_location': {'id': location_id, 'name': location_name},
        'facility_count': len(entities),
        'facilities': list(entities.values())
    }


def query_events(session, location_id, location_name,
                 start_date, end_date, attr_filter, limit):
    """
    Find all events that occurred at this location or its sub-locations,
    with their state attributes.
    """
    params = {'loc_id': location_id, 'lim': limit}
    time_filter = _build_time_filter(params, start_date, end_date)
    attr_clause = "AND ha.type CONTAINS $attr" if attr_filter else ""
    if attr_filter:
        params['attr'] = attr_filter

    cypher = f"""
    MATCH (e:事件:entity)-[:occurredAt]->(loc:地点:entity)
    WHERE loc.id = $loc_id
       OR loc.id STARTS WITH $loc_id
       OR EXISTS {{
           MATCH (loc)-[:locatedIn*1..3]->(parent:地点:entity {{id: $loc_id}})
       }}
    OPTIONAL MATCH (s:State)
    WHERE s.id CONTAINS e.id
      {time_filter}
    OPTIONAL MATCH (s)-[ha:hasAttribute]->(attr:Attribute)
    WHERE ha IS NULL OR (1=1 {attr_clause})
    WITH e, loc, s, collect({{attr_name: ha.type, value: attr.value}}) AS attrs
    ORDER BY s.start_time ASC
    RETURN e.id AS entity_id, e.name AS entity_name,
           loc.id AS occurred_at_id, loc.name AS occurred_at_name,
           s.id AS state_id, s.state_type AS state_type,
           s.start_time AS start_time, s.end_time AS end_time,
           [a IN attrs WHERE a.attr_name IS NOT NULL] AS attributes
    LIMIT $lim
    """
    rows = session.run(cypher, **params).data()

    entities = {}
    for r in rows:
        eid = r['entity_id']
        if eid not in entities:
            entities[eid] = {
                'entity_id': eid,
                'entity_name': r['entity_name'],
                'occurred_at': {
                    'id': r['occurred_at_id'],
                    'name': r['occurred_at_name']
                },
                'states': []
            }
        if r['state_id']:
            entities[eid]['states'].append({
                'state_id': r['state_id'],
                'state_type': r['state_type'],
                'start_time': neo4j_to_python(r['start_time']),
                'end_time': neo4j_to_python(r['end_time']),
                'attributes': neo4j_to_python(r['attributes'])
            })

    return {
        'parent_location': {'id': location_id, 'name': location_name},
        'event_count': len(entities),
        'events': list(entities.values())
    }


def spatial_impact(location_keyword, mode='all',
                   start_date=None, end_date=None,
                   attr_filter=None, limit=100):
    driver = get_driver()
    result = {
        'location_keyword': location_keyword,
        'mode': mode,
        'time_range': {'start': start_date, 'end': end_date}
    }

    try:
        with driver.session() as session:
            locations = resolve_location_id(session, location_keyword)
            if not locations:
                result['error'] = f"No location found for: {location_keyword}"
                result['suggestion'] = (
                    "Try using an administrative code prefix like 'L-450100' (Nanning), "
                    "'L-45' (Guangxi), or a Chinese place name."
                )
                return result

            result['resolved_locations'] = [
                {'id': lid, 'name': lname} for lid, lname in locations
            ]

            # Use first match as primary
            location_id, location_name = locations[0]

            if mode in ('subregions', 'all'):
                result['subregions'] = query_subregions(
                    session, location_id, location_name,
                    start_date, end_date, attr_filter, limit
                )
            if mode in ('facilities', 'all'):
                result['facilities'] = query_facilities(
                    session, location_id, location_name,
                    start_date, end_date, attr_filter, limit
                )
            if mode in ('events', 'all'):
                result['events'] = query_events(
                    session, location_id, location_name,
                    start_date, end_date, attr_filter, limit
                )

    finally:
        driver.close()

    return result


def main():
    parser = argparse.ArgumentParser(description="Spatial impact analysis for a location")
    parser.add_argument("--location", required=True,
                        help="Location name or ID (e.g. 南宁市, L-450100)")
    parser.add_argument("--mode", choices=["subregions", "facilities", "events", "all"],
                        default="all", help="Query mode (default: all)")
    parser.add_argument("--start", default=None, help="Start date YYYY-MM-DD")
    parser.add_argument("--end", default=None, help="End date YYYY-MM-DD")
    parser.add_argument("--attr", default=None,
                        help="Filter attributes by keyword (e.g. 受灾人口)")
    parser.add_argument("--limit", type=int, default=100,
                        help="Max records per mode (default: 100)")
    args = parser.parse_args()

    try:
        data = spatial_impact(
            args.location,
            mode=args.mode,
            start_date=args.start,
            end_date=args.end,
            attr_filter=args.attr,
            limit=args.limit
        )
        print(json.dumps({"success": True, "data": data}, ensure_ascii=False, indent=2))
        return 0
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    sys.exit(main())
