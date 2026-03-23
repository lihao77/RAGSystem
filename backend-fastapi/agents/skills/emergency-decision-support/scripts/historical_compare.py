#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
historical_compare.py - 历史事件对比

通过知识图谱查找历史上相似的洪涝事件，进行对比分析。
用法:
  python scripts/historical_compare.py --location 南宁市 --disaster-type FLOOD --rainfall 200
"""

import sys
import json
import argparse

try:
    from neo4j import GraphDatabase
    from neo4j.time import Date, DateTime, Time, Duration

    HAS_NEO4J = True
except ImportError:
    HAS_NEO4J = False


def neo4j_to_python(val):
    """将 Neo4j 类型转为 JSON 可序列化的 Python 类型。"""
    if not HAS_NEO4J:
        return val
    if isinstance(val, (Date, DateTime)):
        return str(val)
    if isinstance(val, Time):
        return str(val)
    if isinstance(val, Duration):
        return str(val)
    if hasattr(val, '_properties'):
        return {k: neo4j_to_python(v) for k, v in val._properties.items()}
    if isinstance(val, list):
        return [neo4j_to_python(v) for v in val]
    if isinstance(val, dict):
        return {k: neo4j_to_python(v) for k, v in val.items()}
    return val


def get_neo4j_config():
    """读取 Neo4j 连接配置。"""
    import os
    try:
        from dotenv import load_dotenv
        env_path = os.path.join(os.path.dirname(__file__), "..", "..", "..", ".env")
        load_dotenv(env_path)
    except ImportError:
        pass

    return {
        "uri": os.environ.get("NEO4J_URI", "bolt://localhost:7687"),
        "user": os.environ.get("NEO4J_USER", "neo4j"),
        "password": os.environ.get("NEO4J_PASSWORD", ""),
    }


def query_historical_events(args):
    """查询历史洪涝事件并对比。"""
    if not HAS_NEO4J:
        return {
            "success": False,
            "error": "neo4j 驱动未安装，无法查询知识图谱。请安装: pip install neo4j",
        }

    config = get_neo4j_config()
    if not config["password"]:
        return {
            "success": False,
            "error": "未配置 NEO4J_PASSWORD 环境变量",
        }

    # 构建查询
    location_keyword = args.location
    disaster_keyword = args.disaster_type

    cypher = """
    MATCH (e:事件:entity)
    WHERE e.name CONTAINS $disaster_keyword
    OPTIONAL MATCH (e)-[:occurredAt]->(loc:地点:entity)
    WHERE loc.name CONTAINS $location_keyword OR loc.id CONTAINS $location_keyword
    WITH e, collect(DISTINCT loc.name) AS locations
    WHERE size(locations) > 0 OR $location_keyword = ''
    OPTIONAL MATCH (e)-[:hasState]->(s0:State)
    OPTIONAL MATCH (s0)-[:nextState*0..5]->(s:State)
    OPTIONAL MATCH (s)-[ha:hasAttribute]->(attr:Attribute)
    WITH e, locations,
         collect(DISTINCT {time: s.time, attr_type: ha.type, attr_value: attr.value}) AS attributes,
         min(s.start_time) AS earliest,
         max(s.end_time) AS latest
    """

    params = {
        "disaster_keyword": disaster_keyword,
        "location_keyword": location_keyword,
    }

    # 时间过滤
    if args.start:
        cypher += " WHERE earliest >= date($start_date)"
        params["start_date"] = args.start
    if args.end:
        if args.start:
            cypher += " AND latest <= date($end_date)"
        else:
            cypher += " WHERE latest <= date($end_date)"
        params["end_date"] = args.end

    cypher += """
    RETURN e.id AS event_id, e.name AS event_name, locations,
           toString(earliest) AS start_date, toString(latest) AS end_date,
           attributes
    ORDER BY earliest DESC
    LIMIT $limit
    """
    params["limit"] = args.limit

    try:
        driver = GraphDatabase.driver(config["uri"], auth=(config["user"], config["password"]))
        with driver.session() as session:
            records = session.run(cypher, params)
            events = []
            for record in records:
                event = {
                    "event_id": record["event_id"],
                    "event_name": record["event_name"],
                    "locations": neo4j_to_python(record["locations"]),
                    "start_date": neo4j_to_python(record["start_date"]),
                    "end_date": neo4j_to_python(record["end_date"]),
                    "key_attributes": {},
                }
                # 整理属性
                for attr_item in neo4j_to_python(record["attributes"]):
                    atype = attr_item.get("attr_type")
                    avalue = attr_item.get("attr_value")
                    if atype and avalue:
                        event["key_attributes"][atype] = avalue
                events.append(event)
        driver.close()

        # 构建对比结果
        comparison = {
            "location": args.location,
            "disaster_type": args.disaster_type,
            "current_rainfall": args.rainfall,
            "historical_events": events,
            "total_found": len(events),
        }

        # 如果有当前降雨量，做简单对比
        if args.rainfall is not None and events:
            comparison["comparison_notes"] = []
            for evt in events:
                rainfall_attrs = {k: v for k, v in evt["key_attributes"].items() if "降雨" in k}
                if rainfall_attrs:
                    comparison["comparison_notes"].append(
                        f"事件 {evt['event_name']}（{evt['start_date']}）降雨数据: {rainfall_attrs}"
                    )

        return comparison

    except Exception as e:
        return {
            "success": False,
            "error": f"知识图谱查询失败: {type(e).__name__}: {str(e)}",
        }


def main():
    parser = argparse.ArgumentParser(description="历史事件对比")
    parser.add_argument("--location", required=True, help="地点")
    parser.add_argument("--disaster-type", default="FLOOD", help="灾害类型关键词")
    parser.add_argument("--start", default=None, help="起始日期 YYYY-MM-DD")
    parser.add_argument("--end", default=None, help="结束日期 YYYY-MM-DD")
    parser.add_argument("--rainfall", type=float, default=None, help="当前降雨量(mm)")
    parser.add_argument("--limit", type=int, default=5, help="返回事件数")
    args = parser.parse_args()

    result = query_historical_events(args)
    json.dump({"success": True, "data": result}, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
