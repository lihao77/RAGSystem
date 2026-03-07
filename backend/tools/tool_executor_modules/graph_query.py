# -*- coding: utf-8 -*-
"""
graph_query 工具模块。
"""

import logging
from .shared import convert_neo4j_types, error_response, execute_cypher, generate_answer_from_query_results, get_cypher_generator, get_graph_schema, get_session, success_response

logger = logging.getLogger(__name__)

def search_knowledge_graph(keyword="", category="", document_source="",
                           time_range=None, location=None, advanced_query=""):
    """
    搜索知识图谱中的实体和状态

    优化策略：
    - 基础实体查询：直接查询 :entity 节点（当需要基础属性时）
    - 状态查询：直接在状态ID上过滤，无需先查基础实体（符合"状态ID优先"原则）
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
            # 查询状态节点 (:State) - 使用"状态ID优先"原则
            cypher = 'MATCH (n:State) WHERE 1=1'

            # 关键词匹配 - 直接在状态ID上过滤（无需先查基础实体）
            # 状态ID格式: LS-L-450100-..., FS-F-450381-潘厂水库-..., ES-E-450000-..., JS-...
            if keyword and keyword.strip():
                # 同时搜索状态ID和entity_ids字段
                cypher += ' AND (n.id CONTAINS $keyword OR ANY(eid IN n.entity_ids WHERE eid CONTAINS $keyword))'
                params['keyword'] = keyword

            # 来源
            if document_source and document_source.strip():
                cypher += ' AND n.source = $source'
                params['source'] = document_source

            # 地理位置 - 直接在状态ID上过滤
            if location and len(location) > 0 and location[-1] and location[-1].strip():
                cypher += ' AND (n.id CONTAINS $location OR ANY(eid IN n.entity_ids WHERE eid CONTAINS $location))'
                params['location'] = location[-1]

            # 时间范围（修复：包含跨越时间段的状态）
            if time_range_new['start'] and time_range_new['end']:
                cypher += ''' AND (
                    (n.start_time >= date($startTime) AND n.start_time <= date($endTime))
                    OR (n.end_time >= date($startTime) AND n.end_time <= date($endTime))
                    OR (n.start_time <= date($startTime) AND n.end_time >= date($endTime))
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
            return error_response(f"不支持的category: {category}，可选值：'地点'、'设施'、'事件'、'State'")

        return success_response(
            results=entities,
            metadata={
                "count": len(entities),
                "query_type": "基础实体" if category in ['地点', '设施', '事件'] else "状态节点"
            }
        )

    except Exception as e:
        logger.error(f'搜索知识图谱失败: {e}')
        import traceback
        traceback.print_exc()
        return error_response(str(e))
    finally:
        if session:
            session.close()

def query_knowledge_graph_with_nl(question, history=None):
    """
    使用自然语言查询知识图谱

    这是对原有 /api/graphrag/query 接口的封装

    返回格式（标准化）:
    {
        "success": True,
        "data": {
            "results": [...],      # 纯净的查询记录
            "metadata": {...},     # 自动生成的元数据
            "summary": "...",      # 自动生成的摘要
            "answer": "...",       # 完整的文本答案
            "debug": {
                "cypher": "...",
                "execution_time": 0.5
            }
        }
    }
    """
    import time
    start_time = time.time()

    try:
        if not question or not question.strip():
            return error_response("问题不能为空")

        # 1. 获取图谱结构
        logger.info(f'获取图谱结构...')
        graph_schema = get_graph_schema()
        if not graph_schema:
            return error_response("获取图谱结构失败")

        # 2. 生成Cypher查询
        logger.info(f'生成Cypher查询: {question}')
        generator = get_cypher_generator()
        cypher = generator.generate(question, graph_schema, history)
        if not cypher:
            return error_response("生成查询语句失败")

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
                    retry_hint = "上次查询返回0条结果，请生成更宽泛的查询，去掉State类型前缀限制，使用CONTAINS代替STARTS WITH，扩大时间范围"
                    cypher = generator.generate(question, graph_schema, history, retry_hint=retry_hint)
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
                    retry_hint = f"上次查询语法错误：{str(e)}，请修正Cypher语句"
                    cypher = generator.generate(question, graph_schema, history, retry_hint=retry_hint)
                    if not cypher:
                        break
                    logger.info(f'修正后的Cypher: {cypher}')
                    retry_count += 1
                else:
                    return error_response(
                        f"执行查询失败: {str(e)}",
                        debug={"cypher": cypher}
                    )

        # 4. 生成回答
        logger.info(f'生成回答...')
        if len(query_records) == 0:
            answer = f"未查询到相关数据。可能原因：\n1. 该时间段或实体没有相关记录\n2. 数据可能使用了不同的命名或时间格式\n\n执行的查询：\n{cypher}"
        else:
            answer = generate_answer_from_query_results(question, query_records, cypher, history)

        # 5. 使用标准化响应构造器返回结果
        execution_time = time.time() - start_time

        return success_response(
            results=query_records,  # 纯净的查询记录（不压缩，让 _format_observation 处理）
            answer=answer,          # 完整的文本答案
            debug={
                "cypher": cypher[:500] + "..." if len(cypher) > 500 else cypher,
                "execution_time": round(execution_time, 2),
                "retry_count": retry_count
            }
            # metadata 和 summary 会自动生成
        )

    except Exception as e:
        logger.error(f'自然语言查询失败: {e}')
        return error_response(str(e))

def get_entity_relations(entity_id):
    """
    获取实体的关系信息

    优化策略：
    - 基础实体（L-*, F-*, E-*）：查询实体节点及其直接关系（包括hasState关系）
    - 状态节点（LS-*, FS-*, ES-*, JS-*）：查询状态节点及其关系（hasAttribute, hasRelation, nextState等）

    返回标准格式的关系数据，智能体系统会自动处理长返回数据的summary和存储
    """
    session = None
    try:
        session = get_session()

        # 根据ID格式判断是基础实体还是状态节点
        # 基础实体ID: L-*, F-*, E-*
        # 状态节点ID: LS-*, FS-*, ES-*, JS-*
        is_state = entity_id.startswith(('LS-', 'FS-', 'ES-', 'JS-'))

        if is_state:
            # 查询状态节点及其关系
            # 状态节点的关系类型: hasAttribute（属性）, hasRelation（因果）, nextState（时序）, contain（包含）
            cypher = """
            MATCH (n:State)
            WHERE n.id = $entity_id OR n.id CONTAINS $entity_id
            OPTIONAL MATCH (n)-[r]-(m)
            RETURN n, r, m
            """
        else:
            # 查询基础实体节点及其关系
            # 基础实体的关系类型: locatedIn（空间层级）, occurredAt（事件发生地）, hasState（状态链）
            cypher = """
            MATCH (n:entity)
            WHERE n.id = $entity_id OR n.id CONTAINS $entity_id
            OPTIONAL MATCH (n)-[r]-(m)
            RETURN n, r, m
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
                    props = convert_neo4j_types(dict(node))
                    nodes[node_id] = {
                        'id': node.id,
                        'labels': list(node.labels),
                        'properties': props
                    }

            # 处理关联节点
            if record['m']:
                node = record['m']
                node_id = str(node.id)
                if node_id not in nodes:
                    props = convert_neo4j_types(dict(node))
                    nodes[node_id] = {
                        'id': node.id,
                        'labels': list(node.labels),
                        'properties': props
                    }

            # 处理关系
            if record['r']:
                rel = record['r']
                rel_props = convert_neo4j_types(dict(rel))
                relationships.append({
                    'id': rel.id,
                    'type': rel.type,
                    'source': str(rel.start_node.id),
                    'target': str(rel.end_node.id),
                    'properties': rel_props
                })

        # 构造结果数据
        result_data = {
            "nodes": list(nodes.values()),
            "relationships": relationships
        }

        # 使用标准响应构造器
        return success_response(
            results=result_data,
            metadata={
                "node_count": len(nodes),
                "relationship_count": len(relationships),
                "node_type": "State" if is_state else "Entity"
            },
            debug={"cypher": cypher, "entity_id": entity_id}
        )

    except Exception as e:
        logger.error(f'获取实体关系失败: {e}')
        return error_response(str(e), debug={"entity_id": entity_id})
    finally:
        if session:
            session.close()

def execute_cypher_query(cypher):
    """
    执行Cypher查询

    这是对原有 /api/graphrag/cypher/execute 接口的封装
    返回标准格式的查询结果，智能体系统会自动处理长返回数据的summary和存储
    """
    try:
        if not cypher or not cypher.strip():
            return error_response("Cypher语句不能为空")

        # 安全检查
        cypher_upper = cypher.upper()
        dangerous_keywords = ['CREATE', 'DELETE', 'SET', 'REMOVE', 'MERGE', 'DROP']
        for keyword in dangerous_keywords:
            if keyword in cypher_upper:
                return error_response(f"不允许执行包含{keyword}操作的查询")

        query_result = execute_cypher(cypher)
        records = query_result.get('records', [])

        # 使用标准响应构造器
        return success_response(
            results=records,
            debug={"cypher": cypher}  # 可选：包含执行的Cypher语句用于调试
        )

    except Exception as e:
        logger.error(f'执行Cypher查询失败: {e}')
        return error_response(str(e), debug={"cypher": cypher})

def get_graph_schema_tool():
    """
    获取图谱结构信息

    这是对原有 /api/graphrag/schema 接口的封装
    """
    try:
        schema = get_graph_schema()
        if schema:
            return success_response(
                results=schema,
                summary="成功获取图谱结构信息"
            )
        else:
            return error_response("获取图谱结构失败")
    except Exception as e:
        logger.error(f'获取图谱结构失败: {e}')
        return error_response(str(e))
