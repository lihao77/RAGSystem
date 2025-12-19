# -*- coding: utf-8 -*-
"""
工具执行器 - 执行Function Calling调用的工具
"""

import logging
from flask import jsonify
from db import get_session
from routes.graphrag import (
    get_graph_schema,
    generate_cypher_with_llm,
    execute_cypher,
    generate_answer_with_llm,
    convert_neo4j_types
)

logger = logging.getLogger(__name__)


def execute_tool(tool_name, arguments):
    """
    执行指定的工具
    
    Args:
        tool_name: 工具名称
        arguments: 工具参数（字典）
    
    Returns:
        工具执行结果
    """
    try:
        if tool_name == "search_knowledge_graph":
            return search_knowledge_graph(**arguments)
        elif tool_name == "query_knowledge_graph_with_nl":
            return query_knowledge_graph_with_nl(**arguments)
        elif tool_name == "get_entity_relations":
            return get_entity_relations(**arguments)
        elif tool_name == "execute_cypher_query":
            return execute_cypher_query(**arguments)
        elif tool_name == "get_graph_schema":
            return get_graph_schema_tool()
        elif tool_name == "analyze_temporal_pattern":
            return analyze_temporal_pattern(**arguments)
        elif tool_name == "find_causal_chain":
            return find_causal_chain(**arguments)
        elif tool_name == "compare_entities":
            return compare_entities(**arguments)
        elif tool_name == "aggregate_statistics":
            return aggregate_statistics(**arguments)
        elif tool_name == "get_spatial_neighbors":
            return get_spatial_neighbors(**arguments)
        elif tool_name == "query_emergency_plan":
            return query_emergency_plan(**arguments)
        elif tool_name == "generate_chart":
            return generate_chart(**arguments)
        else:
            return {
                "success": False,
                "error": f"未知的工具: {tool_name}"
            }
    except Exception as e:
        logger.error(f"执行工具 {tool_name} 失败: {e}")
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "error": str(e)
        }


def search_knowledge_graph(keyword="", category="", document_source="", 
                           time_range=None, location=None, advanced_query=""):
    """
    搜索知识图谱中的实体和状态
    
    根据category参数决定查询基础实体(:entity)还是状态节点(:State)
    """
    session = None
    try:
        session = get_session()
        
        # 格式化时间范围
        time_range_new = {'start': '', 'end': ''}
        if time_range and len(time_range) == 2:
            time_range_new['start'] = time_range[0]
            time_range_new['end'] = time_range[1]
        
        params = {}
        entities = []
        
        # 根据category决定查询策略
        if category in ['地点', '设施', '事件']:
            # 查询基础实体节点 (:地点:entity, :设施:entity, :事件:entity)
            cypher = f'MATCH (n:{category}:entity) WHERE 1=1'
            
            # 关键词匹配
            if keyword and keyword.strip():
                cypher += ' AND (n.name CONTAINS $keyword OR n.id CONTAINS $keyword OR n.geo_description CONTAINS $keyword)'
                params['keyword'] = keyword
            
            # 来源
            if document_source and document_source.strip():
                cypher += ' AND n.source = $source'
                params['source'] = document_source
            
            # 地理位置（对地点节点特殊处理）
            if location and len(location) > 0 and location[-1] and location[-1].strip():
                cypher += ' AND n.id CONTAINS $location'
                params['location'] = location[-1]
            
            # 高级查询
            if advanced_query and advanced_query.strip():
                cypher += f' AND ({advanced_query})'
            
            cypher += ' RETURN n.id AS id, n.name AS name, labels(n) AS labels, n.source AS source, properties(n) AS properties LIMIT 100'
            
            result = session.run(cypher, params)
            for record in result:
                entity = {
                    'id': record['id'],
                    'name': record['name'],
                    'category': category,
                    'labels': record['labels'],
                    'source': record['source'],
                    'properties': convert_neo4j_types(record['properties'])
                }
                entities.append(entity)
        
        elif category == 'State' or category == '':
            # 查询状态节点 (:State)
            cypher = 'MATCH (n:State) WHERE 1=1'
            
            # 关键词匹配（通过entity_ids字段）
            if keyword and keyword.strip():
                # 先查基础实体ID
                entity_ids_result = session.run(
                    'MATCH (e) WHERE e:entity AND e.name CONTAINS $keyword RETURN e.id AS id LIMIT 100',
                    {'keyword': keyword}
                )
                entity_ids = [record['id'] for record in entity_ids_result]
                
                if entity_ids:
                    cypher += ' AND (ANY(eid IN n.entity_ids WHERE eid IN $entityids) OR n.id CONTAINS $keyword)'
                    params['entityids'] = entity_ids
                    params['keyword'] = keyword
                else:
                    cypher += ' AND n.id CONTAINS $keyword'
                    params['keyword'] = keyword
            
            # 来源
            if document_source and document_source.strip():
                cypher += ' AND n.source = $source'
                params['source'] = document_source
            
            # 地理位置
            if location and len(location) > 0 and location[-1] and location[-1].strip():
                cypher += ' AND (ANY(eid IN n.entity_ids WHERE eid CONTAINS $location) OR n.id CONTAINS $location)'
                params['location'] = location[-1]
            
            # 时间范围（修复：使用start_time和end_time字段）
            if time_range_new['start'] and time_range_new['end']:
                cypher += ''' AND (
                    n.start_time >= date($startTime) AND n.start_time <= date($endTime)
                )'''
                params['startTime'] = time_range_new['start']
                params['endTime'] = time_range_new['end']
            
            # 高级查询
            if advanced_query and advanced_query.strip():
                cypher += f' AND ({advanced_query})'
            
            cypher += ' RETURN n.id AS id, n.state_type AS state_type, n.time AS time, n.source AS source, n.entity_ids AS entity_ids, properties(n) AS properties LIMIT 100'
            
            result = session.run(cypher, params)
            for record in result:
                entity = {
                    'id': record['id'],
                    'name': record['state_type'] or 'State',
                    'category': 'State',
                    'time': record['time'],
                    'source': record['source'],
                    'entity_ids': record['entity_ids'],
                    'properties': convert_neo4j_types(record['properties'])
                }
                entities.append(entity)
        
        else:
            # 不支持的category
            return {
                "success": False,
                "error": f"不支持的category: {category}，可选值：'地点'、'设施'、'事件'、'State'"
            }
        
        return {
            "success": True,
            "data": {
                "entities": entities,
                "count": len(entities),
                "query_type": "基础实体" if category in ['地点', '设施', '事件'] else "状态节点"
            }
        }
        
    except Exception as e:
        logger.error(f'搜索知识图谱失败: {e}')
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "error": str(e)
        }
    finally:
        if session:
            session.close()


def query_knowledge_graph_with_nl(question, history=None):
    """
    使用自然语言查询知识图谱
    
    这是对原有 /api/graphrag/query 接口的封装
    """
    try:
        if not question or not question.strip():
            return {
                "success": False,
                "error": "问题不能为空"
            }
        
        # 1. 获取图谱结构
        logger.info(f'获取图谱结构...')
        graph_schema = get_graph_schema()
        if not graph_schema:
            return {
                "success": False,
                "error": "获取图谱结构失败"
            }
        
        # 2. 生成Cypher查询
        logger.info(f'生成Cypher查询: {question}')
        cypher = generate_cypher_with_llm(question, graph_schema, history)
        if not cypher:
            return {
                "success": False,
                "error": "生成查询语句失败"
            }
        
        logger.info(f'生成的Cypher: {cypher}')
        
        # 3. 执行查询（带自动重试机制）
        max_retries = 2
        retry_count = 0
        query_records = []
        graph_data = {}
        last_error = None
        
        while retry_count <= max_retries:
            try:
                logger.info(f'执行Cypher查询 (尝试 {retry_count + 1}/{max_retries + 1})...')
                query_result = execute_cypher(cypher)
                query_records = query_result.get('records', [])
                graph_data = query_result.get('graph', {})
                logger.info(f'查询结果数量: {len(query_records)}')
                
                # 如果查到结果，直接返回
                if len(query_records) > 0:
                    break
                    
                # 如果没查到结果，尝试生成更宽泛的查询
                if retry_count < max_retries:
                    logger.warning(f'查询返回0条结果，尝试生成更宽泛的查询...')
                    broader_question = f"{question}（提示：上次查询返回0条结果，请生成更宽泛的查询，去掉State类型前缀限制，使用CONTAINS代替STARTS WITH，扩大时间范围）"
                    cypher = generate_cypher_with_llm(broader_question, graph_schema, history)
                    if not cypher:
                        break
                    logger.info(f'重试Cypher: {cypher}')
                    retry_count += 1
                else:
                    logger.warning(f'达到最大重试次数，返回空结果')
                    break
                    
            except Exception as e:
                last_error = str(e)
                logger.error(f'执行查询失败: {e}')
                
                # 如果是语法错误，尝试让LLM修正
                if retry_count < max_retries and ('Syntax' in str(e) or 'syntax' in str(e)):
                    logger.warning(f'Cypher语法错误，尝试重新生成...')
                    error_hint = f"{question}（提示：上次查询语法错误：{str(e)}，请修正Cypher语句）"
                    cypher = generate_cypher_with_llm(error_hint, graph_schema, history)
                    if not cypher:
                        break
                    logger.info(f'修正后的Cypher: {cypher}')
                    retry_count += 1
                else:
                    return {
                        "success": False,
                        "error": f"执行查询失败: {str(e)}",
                        "cypher": cypher
                    }
        
        # 4. 生成回答
        logger.info(f'生成回答...')
        if len(query_records) == 0:
            answer = f"未查询到相关数据。可能原因：\n1. 该时间段或实体没有相关记录\n2. 数据可能使用了不同的命名或时间格式\n\n执行的查询：\n{cypher}"
        else:
            answer = generate_answer_with_llm(question, query_records, cypher, history)
        
        return {
            "success": True,
            "data": {
                "answer": answer,
                "cypher": cypher,
                "query_results": query_records[:20],
                "total_results": len(query_records),
                "graph_data": graph_data
            }
        }
        
    except Exception as e:
        logger.error(f'自然语言查询失败: {e}')
        return {
            "success": False,
            "error": str(e)
        }


def get_entity_relations(entity_id):
    """
    获取实体的关系信息
    
    这是对原有 /api/search/relations/<entity_id> 接口的封装
    """
    session = None
    try:
        session = get_session()
        
        # 查询实体的所有关系
        cypher = """
        MATCH (n)
        WHERE n.id = $entity_id OR n.id CONTAINS $entity_id
        OPTIONAL MATCH (n)-[r]-(m)
        RETURN n, r, m
        LIMIT 100
        """
        
        result = session.run(cypher, {'entity_id': entity_id})
        
        nodes = {}
        relationships = []
        
        for record in result:
            # 处理中心节点
            if record['n']:
                node = record['n']
                node_id = str(node.id)
                if node_id not in nodes:
                    nodes[node_id] = {
                        'id': node.id,
                        'labels': list(node.labels),
                        'properties': convert_neo4j_types(dict(node))
                    }
            
            # 处理关联节点
            if record['m']:
                node = record['m']
                node_id = str(node.id)
                if node_id not in nodes:
                    nodes[node_id] = {
                        'id': node.id,
                        'labels': list(node.labels),
                        'properties': convert_neo4j_types(dict(node))
                    }
            
            # 处理关系
            if record['r']:
                rel = record['r']
                relationships.append({
                    'id': rel.id,
                    'type': rel.type,
                    'source': str(rel.start_node.id),
                    'target': str(rel.end_node.id),
                    'properties': convert_neo4j_types(dict(rel))
                })
        
        return {
            "success": True,
            "data": {
                "nodes": list(nodes.values()),
                "relationships": relationships,
                "count": len(relationships)
            }
        }
        
    except Exception as e:
        logger.error(f'获取实体关系失败: {e}')
        return {
            "success": False,
            "error": str(e)
        }
    finally:
        if session:
            session.close()


def execute_cypher_query(cypher):
    """
    执行Cypher查询
    
    这是对原有 /api/graphrag/cypher/execute 接口的封装
    """
    try:
        if not cypher or not cypher.strip():
            return {
                "success": False,
                "error": "Cypher语句不能为空"
            }
        
        # 安全检查
        cypher_upper = cypher.upper()
        dangerous_keywords = ['CREATE', 'DELETE', 'SET', 'REMOVE', 'MERGE', 'DROP']
        for keyword in dangerous_keywords:
            if keyword in cypher_upper:
                return {
                    "success": False,
                    "error": f"不允许执行包含{keyword}操作的查询"
                }
        
        query_result = execute_cypher(cypher)
        
        return {
            "success": True,
            "data": {
                "results": query_result.get('records', []),
                "count": len(query_result.get('records', [])),
                "graph_data": query_result.get('graph', {})
            }
        }
        
    except Exception as e:
        logger.error(f'执行Cypher查询失败: {e}')
        return {
            "success": False,
            "error": str(e)
        }


def get_graph_schema_tool():
    """
    获取图谱结构信息
    
    这是对原有 /api/graphrag/schema 接口的封装
    """
    try:
        schema = get_graph_schema()
        if schema:
            return {
                "success": True,
                "data": schema
            }
        else:
            return {
                "success": False,
                "error": "获取图谱结构失败"
            }
    except Exception as e:
        logger.error(f'获取图谱结构失败: {e}')
        return {
            "success": False,
            "error": str(e)
        }


def analyze_temporal_pattern(entity_name, start_date, end_date, metric=None):
    """分析时序模式"""
    session = None
    try:
        session = get_session()
        
        # 构建查询
        cypher = """
        MATCH (s:State)
        WHERE s.id CONTAINS $entity_name
          AND s.start_time >= date($start_date)
          AND s.end_time <= date($end_date)
        """
        
        if metric:
            cypher += """
            OPTIONAL MATCH (s)-[ha:hasAttribute]->(attr:Attribute)
            WHERE ha.type = $metric
            RETURN s.time AS time, s.start_time AS start, s.end_time AS end, 
                   attr.value AS value, s.type AS state_type
            ORDER BY s.start_time
            """
        else:
            cypher += """
            RETURN s.time AS time, s.start_time AS start, s.end_time AS end, 
                   s.type AS state_type, count(s) AS count
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
        
        # 简单的趋势分析
        if records and metric:
            values = [float(r.get('value', 0)) for r in records if r.get('value')]
            if values:
                trend_analysis = {
                    'count': len(values),
                    'min': min(values),
                    'max': max(values),
                    'avg': sum(values) / len(values),
                    'trend': 'increasing' if len(values) > 1 and values[-1] > values[0] else 'decreasing'
                }
            else:
                trend_analysis = None
        else:
            trend_analysis = {'count': len(records)}
        
        return {
            "success": True,
            "data": {
                "records": records,
                "analysis": trend_analysis,
                "time_range": f"{start_date} 至 {end_date}"
            }
        }
        
    except Exception as e:
        logger.error(f'时序分析失败: {e}')
        return {
            "success": False,
            "error": str(e)
        }
    finally:
        if session:
            session.close()


def find_causal_chain(start_event, end_event=None, max_depth=3, direction="forward"):
    """查找因果链路"""
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
            cypher = f"""
            MATCH (start:State)
            WHERE start.id CONTAINS $start_event
            MATCH (end:State)
            WHERE end.id CONTAINS $end_event
            MATCH path = (start){rel_pattern.replace('{max_depth}', str(max_depth))}(end)
            WITH path, nodes(path) AS ns, relationships(path) AS rs
            RETURN [n IN ns | {{id: n.id, type: n.type, time: n.time}}] AS nodes,
                   [r IN rs | {{type: type(r), relation_type: r.type}}] AS relationships
            LIMIT 10
            """
            params = {'start_event': start_event, 'end_event': end_event}
        else:
            cypher = f"""
            MATCH (start:State)
            WHERE start.id CONTAINS $start_event
            MATCH path = (start){rel_pattern.replace('{max_depth}', str(max_depth))}(target:State)
            WITH path, nodes(path) AS ns, relationships(path) AS rs
            WHERE length(path) > 0
            RETURN [n IN ns | {{id: n.id, type: n.type, time: n.time}}] AS nodes,
                   [r IN rs | {{type: type(r), relation_type: r.type}}] AS relationships
            ORDER BY length(path) DESC
            LIMIT 20
            """
            params = {'start_event': start_event}
        
        result = session.run(cypher, params)
        chains = [convert_neo4j_types(dict(record)) for record in result]
        
        return {
            "success": True,
            "data": {
                "chains": chains,
                "count": len(chains),
                "direction": direction
            }
        }
        
    except Exception as e:
        logger.error(f'因果链查找失败: {e}')
        return {
            "success": False,
            "error": str(e)
        }
    finally:
        if session:
            session.close()


def compare_entities(entity_names, time_range=None, compare_attributes=None):
    """比较多个实体"""
    session = None
    try:
        session = get_session()
        
        comparisons = {}
        
        for entity_name in entity_names:
            cypher = """
            MATCH (s:State)
            WHERE s.id CONTAINS $entity_name
            """
            
            params = {'entity_name': entity_name}
            
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
                RETURN s.id AS state_id, s.time AS time, 
                       collect({attr: ha.type, value: attr.value}) AS attributes
                LIMIT 50
                """
                params['attributes'] = compare_attributes
            else:
                cypher += """
                RETURN s.id AS state_id, s.time AS time, s.type AS state_type,
                       properties(s) AS properties
                LIMIT 50
                """
            
            result = session.run(cypher, params)
            records = [convert_neo4j_types(dict(record)) for record in result]
            comparisons[entity_name] = records
        
        return {
            "success": True,
            "data": {
                "comparisons": comparisons,
                "entity_count": len(entity_names)
            }
        }
        
    except Exception as e:
        logger.error(f'实体比较失败: {e}')
        return {
            "success": False,
            "error": str(e)
        }
    finally:
        if session:
            session.close()


def aggregate_statistics(attribute, aggregation, entity_type=None, time_range=None, group_by=None):
    """聚合统计"""
    session = None
    try:
        session = get_session()
        
        # 构建查询
        cypher = """
        MATCH (s:State)-[ha:hasAttribute]->(attr:Attribute)
        WHERE ha.type = $attribute
        """
        
        params = {'attribute': attribute}
        
        if entity_type:
            cypher += " AND s.id CONTAINS $entity_type"
            params['entity_type'] = entity_type
        
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
        
        return {
            "success": True,
            "data": {
                "records": records,
                "aggregation": aggregation,
                "attribute": attribute
            }
        }
        
    except Exception as e:
        logger.error(f'聚合统计失败: {e}')
        return {
            "success": False,
            "error": str(e)
        }
    finally:
        if session:
            session.close()


def get_spatial_neighbors(entity_name, radius=1, neighbor_type=None):
    """获取空间邻近实体"""
    session = None
    try:
        session = get_session()
        
        # 构建查询
        cypher = f"""
        MATCH (center)
        WHERE center.id CONTAINS $entity_name OR center.name CONTAINS $entity_name
        MATCH path = (center)-[:locatedIn|occurredAt*1..{radius}]-(neighbor)
        """
        
        params = {'entity_name': entity_name}
        
        if neighbor_type:
            cypher += f" WHERE $neighbor_type IN labels(neighbor)"
            params['neighbor_type'] = neighbor_type
        
        cypher += """
        RETURN DISTINCT neighbor.id AS id, neighbor.name AS name, 
               labels(neighbor) AS labels, length(path) AS distance
        ORDER BY distance
        LIMIT 50
        """
        
        result = session.run(cypher, params)
        neighbors = [convert_neo4j_types(dict(record)) for record in result]
        
        return {
            "success": True,
            "data": {
                "neighbors": neighbors,
                "count": len(neighbors),
                "center": entity_name,
                "radius": radius
            }
        }
        
    except Exception as e:
        logger.error(f'空间邻近查询失败: {e}')
        return {
            "success": False,
            "error": str(e)
        }
    finally:
        if session:
            session.close()


def query_emergency_plan(query, top_k=5, min_similarity=0.3, document_filter=None):
    """
    查询应急预案文档
    
    使用向量语义搜索从应急预案知识库中检索相关内容
    
    Args:
        query: 查询问题或关键词
        top_k: 返回结果数量，默认5
        min_similarity: 最小相似度阈值（0-1），默认0.3
        document_filter: 文档来源过滤（可选）
    
    Returns:
        检索结果，包含文档片段、相似度、元数据
    """
    try:
        from vector_store import VectorRetriever, get_vector_client
        
        # 智能选择集合：优先使用专用集合，如果为空则使用 documents
        client = get_vector_client()
        try:
            emergency_collection = client.get_collection("emergency_plans")
            collection_name = "emergency_plans" if emergency_collection.count() > 0 else "documents"
        except:
            collection_name = "documents"  # 集合不存在，使用默认集合
        
        logger.info(f"使用集合: {collection_name}")
        
        # 初始化检索器
        retriever = VectorRetriever(collection_name=collection_name)
        
        # 构建过滤条件
        filters = {}
        if document_filter:
            filters["document_id"] = document_filter
        
        # 执行向量检索
        results = retriever.search(
            query=query,
            top_k=top_k * 2,  # 多取一些，然后过滤
            filters=filters if filters else None,
            include_distances=True
        )
        
        # 日志：显示检索到的相似度
        if results:
            similarities = [r.get('similarity', 0) for r in results[:5]]
            logger.info(f"检索到 {len(results)} 条结果，前5条相似度: {similarities}")
        
        # 过滤低相似度结果
        filtered_results = [
            r for r in results 
            if r.get('similarity', 0) >= min_similarity
        ][:top_k]
        
        logger.info(f"相似度过滤后: {len(filtered_results)} 条结果（阈值={min_similarity}）")
        
        # 格式化返回结果
        formatted_results = []
        for idx, result in enumerate(filtered_results):
            formatted_results.append({
                "rank": idx + 1,
                "content": result['text'],
                "similarity": round(result.get('similarity', 0), 4),
                "source": result['metadata'].get('document_id', 'unknown'),
                "chunk_index": result['metadata'].get('chunk_index', 0),
                "metadata": result['metadata']
            })
        
        return {
            "success": True,
            "data": {
                "results": formatted_results,
                "count": len(formatted_results),
                "query": query,
                "total_searched": len(results),
                "min_similarity": min_similarity
            },
            "message": f"检索到 {len(formatted_results)} 条相关预案内容"
        }
        
    except Exception as e:
        logger.error(f'应急预案检索失败: {e}')
        import traceback
        traceback.print_exc()
        
        return {
            "success": False,
            "error": str(e),
            "message": "向量检索功能可能尚未初始化，请先索引应急预案文档"
        }


def generate_chart(data, question="", chart_type=None, title="", 
                   x_field="", y_field="", series_field=""):
    """
    生成图表配置
    
    使用 ChartAgent 根据数据和问题生成 ECharts 配置
    
    Args:
        data: 数据列表，每个元素是字典
        question: 原始问题（用于智能选择图表类型）
        chart_type: 指定图表类型（可选）
        title: 图表标题（可选）
        x_field: X轴字段名
        y_field: Y轴字段名
        series_field: 系列字段名
    
    Returns:
        {
            "success": True/False,
            "chart_type": "折线图/柱状图/...",
            "echarts_config": {...},
            "data_summary": {...},
            "message": "..."
        }
    """
    try:
        from agents import ChartAgent
        
        # 数据验证
        if not data or not isinstance(data, list):
            return {
                "success": False,
                "error": "数据格式错误：需要列表类型"
            }
        
        if len(data) == 0:
            return {
                "success": False,
                "error": "数据为空，无法生成图表"
            }
        
        if len(data) < 3:
            return {
                "success": False,
                "error": f"数据量过少（{len(data)}条），建议至少3条数据才能生成有意义的图表",
                "suggestion": "可以尝试扩大时间范围或查询更多实体"
            }
        
        # 创建 ChartAgent 实例
        agent = ChartAgent()
        
        # 生成图表
        result = agent.generate_chart(
            data=data,
            question=question,
            chart_type=chart_type,
            title=title,
            x_field=x_field,
            y_field=y_field,
            series_field=series_field
        )
        
        return result
    
    except Exception as e:
        logger.error(f"生成图表失败: {e}")
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "error": f"生成图表失败: {str(e)}"
        }
