# -*- coding: utf-8 -*-
"""
graph_analysis 工具模块。
"""

import logging
from .shared import convert_neo4j_types, error_response, get_session, success_response

logger = logging.getLogger(__name__)

def analyze_temporal_pattern(entity_name, start_date, end_date, metric=None):
    """
    分析时序模式

    优化策略：
    - 使用状态ID过滤（符合"状态ID优先"原则）
    - 当指定 metric 时，同时返回属性值和趋势分析
    - 返回完整的时序数据，智能体系统会自动处理长返回数据
    """
    session = None
    try:
        session = get_session()

        # 构建查询 - 直接在状态ID上过滤
        cypher = """
        MATCH (s:State)
        WHERE s.id CONTAINS $entity_name
          AND s.start_time >= date($start_date)
          AND s.end_time <= date($end_date)
        """

        if metric:
            # 当指定 metric 时，获取对应的属性值
            cypher += """
            OPTIONAL MATCH (s)-[ha:hasAttribute]->(attr:Attribute)
            WHERE ha.type = $metric
            RETURN s.id AS state_id, s.time AS time, s.start_time AS start, s.end_time AS end,
                   s.state_type AS state_type, ha.type AS attr_name, attr.value AS value
            ORDER BY s.start_time
            """
        else:
            # 不指定 metric 时，只返回状态信息
            cypher += """
            RETURN s.id AS state_id, s.time AS time, s.start_time AS start, s.end_time AS end,
                   s.state_type AS state_type
            ORDER BY s.start_time
            """

        params = {
            'entity_name': entity_name,
            'start_date': start_date,
            'end_date': end_date
        }

        if metric:
            params['metric'] = metric

        result = session.run(cypher, params)
        records = [convert_neo4j_types(dict(record)) for record in result]

        # 增强的趋势分析
        trend_analysis = {'count': len(records)}

        if records and metric:
            # 提取数值类型的属性值进行分析
            values = []
            for r in records:
                val_str = r.get('value', '')
                if val_str:
                    # 尝试提取数字（支持 "100万人"、"1.5亿元" 等格式）
                    import re
                    match = re.search(r'([\d.]+)', str(val_str))
                    if match:
                        values.append(float(match.group(1)))

            if values:
                trend_analysis.update({
                    'min': min(values),
                    'max': max(values),
                    'avg': round(sum(values) / len(values), 2),
                    'trend': 'increasing' if len(values) > 1 and values[-1] > values[0] else 'decreasing',
                    'valid_values': len(values)
                })

        # 使用标准响应构造器
        return success_response(
            results=records,
            metadata={
                "analysis": trend_analysis,
                "time_range": f"{start_date} 至 {end_date}",
                "metric": metric,
                "entity_name": entity_name
            },
            debug={"cypher": cypher}
        )

    except Exception as e:
        logger.error(f'时序分析失败: {e}')
        return error_response(str(e))
    finally:
        if session:
            session.close()

def find_causal_chain(start_event, end_event=None, max_depth=3, direction="forward"):
    """
    查找因果链路

    优化策略：
    - 使用状态ID过滤（符合"状态ID优先"原则）
    - 返回完整的节点属性信息（包括关键 hasAttribute 数据）
    - 返回完整的因果链数据，智能体系统会自动处理长返回数据
    """
    session = None
    try:
        session = get_session()

        if direction == "forward":
            rel_pattern = "-[:hasRelation*1..{max_depth}]->"
        elif direction == "backward":
            rel_pattern = "<-[:hasRelation*1..{max_depth}]-"
        else:  # both
            rel_pattern = "-[:hasRelation*1..{max_depth}]-"

        if end_event:
            # 查询从 start_event 到 end_event 的因果路径
            cypher = f"""
            MATCH (start:State)
            WHERE start.id CONTAINS $start_event
            MATCH (end:State)
            WHERE end.id CONTAINS $end_event
            MATCH path = (start){rel_pattern.replace('{max_depth}', str(max_depth))}(end)
            WITH path, nodes(path) AS ns, relationships(path) AS rs
            UNWIND ns AS n
            OPTIONAL MATCH (n)-[ha:hasAttribute]->(a:Attribute)
            WITH path, ns, rs, n, collect({{type: ha.type, value: a.value}}) AS attrs
            WITH path, rs, collect({{
                id: n.id,
                state_type: n.state_type,
                time: n.time,
                entity_ids: n.entity_ids,
                attributes: attrs
            }}) AS node_infos
            RETURN node_infos AS nodes,
                   [r IN rs | {{type: type(r), relation_type: r.type, properties: properties(r)}}] AS relationships
            """
            params = {'start_event': start_event, 'end_event': end_event}
        else:
            # 查询从 start_event 出发的所有因果路径
            cypher = f"""
            MATCH (start:State)
            WHERE start.id CONTAINS $start_event
            MATCH path = (start){rel_pattern.replace('{max_depth}', str(max_depth))}(target:State)
            WHERE length(path) > 0
            WITH path, nodes(path) AS ns, relationships(path) AS rs
            UNWIND ns AS n
            OPTIONAL MATCH (n)-[ha:hasAttribute]->(a:Attribute)
            WITH path, ns, rs, n, collect({{type: ha.type, value: a.value}}) AS attrs
            WITH path, rs, collect({{
                id: n.id,
                state_type: n.state_type,
                time: n.time,
                entity_ids: n.entity_ids,
                attributes: attrs
            }}) AS node_infos
            RETURN node_infos AS nodes,
                   [r IN rs | {{type: type(r), relation_type: r.type, properties: properties(r)}}] AS relationships
            ORDER BY size(rs) DESC
            """
            params = {'start_event': start_event}

        result = session.run(cypher, params)
        chains = [convert_neo4j_types(dict(record)) for record in result]

        return success_response(
            results=chains,
            metadata={
                "direction": direction,
                "max_depth": max_depth,
                "has_end_event": end_event is not None,
                "chain_count": len(chains)
            },
            debug={"cypher": cypher}
        )

    except Exception as e:
        logger.error(f'因果链查找失败: {e}')
        return error_response(str(e))
    finally:
        if session:
            session.close()

def compare_entities(entity_names, time_range=None, compare_attributes=None):
    """
    比较多个实体

    优化策略：
    - 使用批量查询代替多次单独查询（提高效率）
    - 使用状态ID过滤（符合"状态ID优先"原则）
    - 返回完整的对比数据，智能体系统会自动处理长返回数据
    """
    session = None
    try:
        session = get_session()

        # 使用批量查询代替多次单独查询
        cypher = """
        MATCH (s:State)
        WHERE ANY(entity IN $entity_names WHERE s.id CONTAINS entity)
        """

        params = {'entity_names': entity_names}

        if time_range and len(time_range) == 2:
            cypher += """
            AND s.start_time >= date($start_date)
            AND s.end_time <= date($end_date)
            """
            params['start_date'] = time_range[0]
            params['end_date'] = time_range[1]

        if compare_attributes:
            cypher += """
            OPTIONAL MATCH (s)-[ha:hasAttribute]->(attr:Attribute)
            WHERE ha.type IN $attributes
            RETURN s.id AS state_id, s.time AS time, s.entity_ids AS entity_ids,
                   collect({attr: ha.type, value: attr.value}) AS attributes
            """
            params['attributes'] = compare_attributes
        else:
            cypher += """
            RETURN s.id AS state_id, s.time AS time, s.state_type AS state_type,
                   s.entity_ids AS entity_ids, properties(s) AS properties
            """

        result = session.run(cypher, params)
        records = [convert_neo4j_types(dict(record)) for record in result]

        # 按实体分组（通过 entity_ids 字段）
        comparisons = {name: [] for name in entity_names}

        for record in records:
            entity_ids = record.get('entity_ids', [])
            # 将记录分配到匹配的实体
            for name in entity_names:
                if any(name in eid for eid in entity_ids):
                    comparisons[name].append(record)

        return success_response(
            results=comparisons,
            metadata={
                "entity_count": len(entity_names),
                "time_range": time_range,
                "compare_attributes": compare_attributes,
                "total_records": len(records)
            },
            debug={"cypher": cypher}
        )

    except Exception as e:
        logger.error(f'实体比较失败: {e}')
        return error_response(str(e))
    finally:
        if session:
            session.close()

def aggregate_statistics(attribute, aggregation, entity_type=None, time_range=None, group_by=None):
    """
    聚合统计

    优化策略：
    - 使用状态ID前缀进行高效过滤（LS-L-*, FS-F-*, ES-E-*）
    - 无需先查询基础实体再过滤

    返回格式（标准化）:
    {
        "success": True,
        "data": {
            "results": [...],      # 聚合统计结果
            "metadata": {...},     # 自动生成
            "summary": "..."       # 自动生成
        }
    }
    """
    session = None
    try:
        session = get_session()

        # 构建查询
        cypher = """
        MATCH (s:State)-[ha:hasAttribute]->(attr:Attribute)
        WHERE ha.type = $attribute
        """

        params = {'attribute': attribute}

        # 优化：使用状态ID前缀过滤，无需先查基础实体
        # 状态ID格式: LS-L-*, FS-F-*, ES-E-*
        if entity_type:
            if entity_type == '地点':
                # 地点状态: LS-L-*
                cypher += " AND s.id STARTS WITH 'LS-L-'"
            elif entity_type == '设施':
                # 设施状态: FS-F-*
                cypher += " AND s.id STARTS WITH 'FS-F-'"
            elif entity_type == '事件':
                # 事件状态: ES-E-*
                cypher += " AND s.id STARTS WITH 'ES-E-'"
            else:
                # 如果是其他类型，尝试通过entity_ids过滤
                # 先查找该类型的所有基础实体ID
                entity_lookup_cypher = f"""
                MATCH (e:{entity_type}:entity)
                RETURN e.id AS entity_id
                """
                entity_result = session.run(entity_lookup_cypher)
                entity_ids = [record['entity_id'] for record in entity_result]

                if entity_ids:
                    # 通过 entity_ids 字段过滤状态节点
                    cypher += " AND ANY(eid IN s.entity_ids WHERE eid IN $entity_ids)"
                    params['entity_ids'] = entity_ids
                else:
                    # 如果没有找到该类型的实体，返回空结果
                    logger.warning(f"未找到类型为 {entity_type} 的实体")
                    return success_response(
                        results=[],
                        summary=f"未找到类型为 '{entity_type}' 的实体"
                    )

        if time_range and len(time_range) == 2:
            cypher += """
            AND s.start_time >= date($start_date)
            AND s.end_time <= date($end_date)
            """
            params['start_date'] = time_range[0]
            params['end_date'] = time_range[1]

        # 聚合函数
        agg_func = {
            'sum': 'sum(toFloat(attr.value))',
            'avg': 'avg(toFloat(attr.value))',
            'max': 'max(toFloat(attr.value))',
            'min': 'min(toFloat(attr.value))',
            'count': 'count(attr.value)'
        }.get(aggregation, 'count(*)')

        if group_by:
            cypher += f"""
            RETURN s.{group_by} AS group_key, {agg_func} AS result
            ORDER BY result DESC
            """
        else:
            cypher += f"""
            RETURN {agg_func} AS result
            """

        result = session.run(cypher, params)
        records = [convert_neo4j_types(dict(record)) for record in result]

        return success_response(
            results=records,
            summary=f"聚合统计完成：{aggregation}({attribute})" + (f"，按 {group_by} 分组" if group_by else "")
        )

    except Exception as e:
        logger.error(f'聚合统计失败: {e}')
        return error_response(str(e))
    finally:
        if session:
            session.close()

def get_spatial_neighbors(entity_name, radius=1, neighbor_type=None):
    """
    获取空间邻近实体

    优化策略：
    - 明确使用 :entity 标签查询基础实体（空间关系在基础实体层级）
    - 空间关系类型：locatedIn（层级关系）、occurredAt（事件发生地）

    返回完整的空间邻近数据，智能体系统会自动处理长返回数据
    """
    session = None
    try:
        session = get_session()

        # 构建查询（明确标签，提高效率）
        # 空间关系主要在基础实体层级，所以查询 :entity 节点
        cypher = f"""
        MATCH (center:entity)
        WHERE center.id CONTAINS $entity_name OR center.name CONTAINS $entity_name
        MATCH path = (center)-[:locatedIn|occurredAt*1..{radius}]-(neighbor:entity)
        """

        params = {'entity_name': entity_name}

        if neighbor_type:
            # 过滤邻居类型（地点、设施、事件）
            cypher += f" WHERE $neighbor_type IN labels(neighbor)"
            params['neighbor_type'] = neighbor_type

        cypher += """
        RETURN DISTINCT neighbor.id AS id, neighbor.name AS name,
               labels(neighbor) AS labels, length(path) AS distance
        ORDER BY distance
        """

        result = session.run(cypher, params)
        neighbors = [convert_neo4j_types(dict(record)) for record in result]

        # 按距离分组统计
        distance_summary = {}
        for n in neighbors:
            dist = n.get('distance', 0)
            if dist not in distance_summary:
                distance_summary[dist] = 0
            distance_summary[dist] += 1

        return success_response(
            results=neighbors,
            metadata={
                "center": entity_name,
                "radius": radius,
                "neighbor_type": neighbor_type,
                "distance_summary": distance_summary
            },
            debug={"cypher": cypher}
        )

    except Exception as e:
        logger.error(f'空间邻近查询失败: {e}')
        return error_response(str(e))
    finally:
        if session:
            session.close()

def query_emergency_plan(query, top_k=5, min_similarity=0.3, document_filter=None):
    """
    查询应急预案文档

    使用向量语义搜索从应急预案知识库中检索相关内容。
    兼容当前向量库架构（SQLite + sqlite-vec，按当前激活向量化器检索）。

    Args:
        query: 查询问题或关键词
        top_k: 返回结果数量，默认5
        min_similarity: 最小相似度阈值（0-1），默认0.3
        document_filter: 文档来源过滤（可选，按 metadata.document_id 过滤）

    Returns:
        检索结果，包含文档片段、相似度、元数据
    """
    try:
        from vector_store import VectorRetriever, get_vector_client

        # 确保向量客户端已初始化（含当前激活向量化器）
        client = get_vector_client()
        client.ensure_initialized()

        # 智能选择集合：优先使用专用集合，若不存在或为空则使用 documents
        try:
            collections = client.list_collections()
            if "emergency_plans" in collections:
                count = client.count_documents("emergency_plans")
                collection_name = "emergency_plans" if count > 0 else "documents"
            else:
                collection_name = "documents"
        except Exception as coll_e:
            logger.debug(f"选择集合时出错，使用默认: {coll_e}")
            collection_name = "documents"

        logger.info(f"使用集合: {collection_name}")

        retriever = VectorRetriever(collection_name=collection_name)

        filters = None
        if document_filter:
            filters = {"document_id": document_filter}

        results = retriever.search(
            query=query,
            top_k=top_k * 2,
            filters=filters,
            include_distances=True
        )

        if results:
            similarities = [r.get('similarity', 0) for r in results[:5]]
            logger.info(f"检索到 {len(results)} 条结果，前5条相似度: {similarities}")

        filtered_results = [
            r for r in results
            if r.get('similarity', 0) >= min_similarity
        ][:top_k]

        logger.info(f"相似度过滤后: {len(filtered_results)} 条结果（阈值={min_similarity}）")

        meta_default = {}
        formatted_results = []
        for idx, result in enumerate(filtered_results):
            m = result.get('metadata') or meta_default
            formatted_results.append({
                "rank": idx + 1,
                "content": result.get('text', ''),
                "similarity": round(result.get('similarity', 0), 4),
                "source": m.get('document_id', 'unknown'),
                "chunk_index": m.get('chunk_index', 0),
                "metadata": m
            })

        resp_meta = {
            "query": query,
            "total_searched": len(results),
            "min_similarity": min_similarity,
            "collection_name": collection_name
        }
        if not formatted_results and collection_name == "emergency_plans":
            resp_meta["hint"] = "若最近更换过向量化器，请用当前向量化器在「向量知识库」中重新索引应急预案集合。"

        return success_response(
            results=formatted_results,
            metadata=resp_meta,
            summary=f"检索到 {len(formatted_results)} 条相关预案内容"
        )

    except RuntimeError as e:
        msg = str(e)
        if "没有激活" in msg or "未初始化" in msg or "embedding" in msg.lower():
            logger.error(f'应急预案检索失败（向量化器未就绪）: {e}')
            return error_response(
                "未配置或未激活向量化器。请在「向量知识库」→「向量化器」中添加并激活一个向量化器，然后重新索引应急预案文档。"
            )
        logger.error(f'应急预案检索失败: {e}')
        return error_response(f"{msg} - 请检查向量库配置与索引。")
    except Exception as e:
        logger.error(f'应急预案检索失败: {e}')
        import traceback
        traceback.print_exc()
        return error_response(
            f"{str(e)} - 请确认已在「向量知识库」中索引应急预案文档，且当前已激活向量化器。"
        )

def get_entity_geometry(entity_ids):
    """
    根据实体 ID 获取几何信息（WKT 格式）

    优化策略：
    - 同时支持基础实体（L-*, F-*, E-*）和状态节点（LS-*, FS-*, ES-*, JS-*）
    - 基础实体节点有 geometry 属性
    - 状态节点也可能有 geometry 属性（从基础实体继承）

    Args:
        entity_ids: 实体 ID 列表，如 ["L-450100", "L-450200", "E-450000-20211012-FLOOD"]

    Returns:
        标准化响应:
        {
            "success": True,
            "data": {
                "results": [
                    {"id": "L-450100", "geometry": "POINT (108.55 25.18)", "type": "entity"},
                    {"id": "LS-L-450100-...", "geometry": "POINT (108.55 25.18)", "type": "state"}
                ],
                "metadata": {...},
                "summary": "获取到 X 个实体的几何信息"
            }
        }
    """
    session = None
    try:
        session = get_session()

        # 参数验证
        if not entity_ids or not isinstance(entity_ids, list):
            return error_response("参数 entity_ids 必须是非空列表")

        # 分离基础实体ID和状态节点ID
        base_entity_ids = []
        state_entity_ids = []

        for eid in entity_ids:
            if eid.startswith(('LS-', 'FS-', 'ES-', 'JS-')):
                state_entity_ids.append(eid)
            else:
                base_entity_ids.append(eid)

        all_records = []

        # 查询基础实体的 geometry
        if base_entity_ids:
            cypher_base = """
            MATCH (e:entity)
            WHERE e.id IN $entity_ids AND e.geometry IS NOT NULL
            RETURN e.id AS id, e.geometry AS geometry, 'entity' AS type
            """
            result = session.run(cypher_base, {"entity_ids": base_entity_ids})
            all_records.extend([convert_neo4j_types(dict(record)) for record in result])

        # 查询状态节点的 geometry（如果有）
        if state_entity_ids:
            cypher_state = """
            MATCH (s:State)
            WHERE s.id IN $entity_ids AND s.geometry IS NOT NULL
            RETURN s.id AS id, s.geometry AS geometry, 'state' AS type
            """
            result = session.run(cypher_state, {"entity_ids": state_entity_ids})
            all_records.extend([convert_neo4j_types(dict(record)) for record in result])

        # 使用标准化响应
        return success_response(
            results=all_records,
            summary=f"获取到 {len(all_records)} 个实体的几何信息（共查询 {len(entity_ids)} 个 ID）"
        )

    except Exception as e:
        logger.error(f'获取实体几何信息失败: {e}')
        import traceback
        logger.error(traceback.format_exc())
        return error_response(f"获取实体几何信息失败: {str(e)}")
    finally:
        if session:
            session.close()
