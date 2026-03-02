# -*- coding: utf-8 -*-
"""
工具执行器 - 执行Function Calling调用的工具
"""

import logging
from flask import jsonify
from db import get_session
from routes.graphrag import (
    get_graph_schema,
    execute_cypher,
    convert_neo4j_types
)
from services.cypher_generator import (
    get_cypher_generator,
    generate_answer_from_query_results  # 使用新的答案生成函数
)
from tools.response_builder import success_response, error_response

logger = logging.getLogger(__name__)


# ==================== 工具执行函数 ====================

def execute_tool(tool_name, arguments, agent_config=None, event_bus=None, user_role=None, caller="direct"):
    """
    执行指定的工具

    Args:
        tool_name: 工具名称
        arguments: 工具参数（字典）
        agent_config: 智能体配置（可选，用于权限检查）
        event_bus: 事件总线（可选，用于用户审批）
        user_role: 用户角色（可选，用于权限检查）
        caller: 调用来源（"direct" 或 "code_execution"）

    Returns:
        工具执行结果
    """
    try:
        # 1. 权限检查
        from tools.permissions import check_tool_permission, get_tool_permission

        allowed, error_msg = check_tool_permission(
            tool_name=tool_name,
            agent_config=agent_config,
            user_role=user_role,
            caller=caller  # 传递调用来源
        )

        if not allowed:
            logger.warning(f"工具权限检查失败: {error_msg}")
            return error_response(error_msg)

        # 2. 检查是否需要用户审批
        permission = get_tool_permission(tool_name)
        if permission and permission.requires_approval:
            logger.info(f"工具 {tool_name} 需要用户审批")

            # 如果提供了事件总线，请求用户审批
            if event_bus:
                try:
                    from agents.events import EventType
                    # 发布审批请求事件
                    event_bus.publish(
                        EventType.USER_APPROVAL_REQUIRED,
                        {
                            "tool_name": tool_name,
                            "arguments": arguments,
                            "risk_level": permission.risk_level.value,
                            "description": permission.description
                        }
                    )
                    # 注意：实际审批逻辑需要在前端实现，这里只是发布事件
                    # 在生产环境中，应该等待审批结果后再继续执行
                    logger.info(f"已发布工具 {tool_name} 的审批请求事件")
                except Exception as e:
                    logger.error(f"发布审批请求事件失败: {e}")

        # 3. 执行工具
        if tool_name == "execute_code":
            # PTC 代码执行
            from tools.code_sandbox import execute_code_sandbox
            return execute_code_sandbox(
                code=arguments.get('code'),
                description=arguments.get('description', ''),
                timeout=arguments.get('timeout', 30),
                agent_config=agent_config,
                event_bus=event_bus,
                user_role=user_role
            )
        elif tool_name == "search_knowledge_graph":
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
        elif tool_name == "generate_map":
            return generate_map(**arguments)
        elif tool_name == "get_entity_geometry":
            return get_entity_geometry(**arguments)
        elif tool_name == "transform_data":
            return transform_data(**arguments)
        elif tool_name == "process_data_file":
            return process_data_file(**arguments)
        elif tool_name == "activate_skill":
            return activate_skill(**arguments)
        elif tool_name == "load_skill_resource":
            return load_skill_resource(**arguments)
        elif tool_name == "execute_skill_script":
            return execute_skill_script(**arguments)
        # 文档处理工具
        elif tool_name == "read_document":
            from tools.document_executor import read_document as read_doc
            return read_doc(**arguments)
        elif tool_name == "chunk_document":
            from tools.document_executor import chunk_document as chunk_doc
            return chunk_doc(**arguments)
        elif tool_name == "extract_structured_data":
            from tools.document_executor import extract_structured_data as extract_data
            return extract_data(**arguments)
        elif tool_name == "merge_extracted_data":
            from tools.document_executor import merge_extracted_data as merge_data
            return merge_data(**arguments)
        elif tool_name == "save_json_file":
            from tools.document_executor import save_json_file as save_json
            return save_json(**arguments)
        else:
            return error_response(f"未知的工具: {tool_name}")
    except Exception as e:
        logger.error(f"执行工具 {tool_name} 失败: {e}")
        import traceback
        traceback.print_exc()
        return error_response(str(e))


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


def generate_chart(data, chart_type=None, title="",
                   x_field="", y_field="", series_field=""):
    """
    生成图表配置 (纯代码逻辑版)

    直接根据 Agent 传入的参数生成 ECharts 配置，不进行复杂的推断。
    Agent 负责指定 chart_type, x_field, y_field。

    返回格式（标准化）:
    {
        "success": True,
        "data": {
            "results": {"echarts_config": {...}},  # 图表配置
            "metadata": {...},                      # 自动生成
            "summary": "..."                        # 自动生成
        }
    }

    Args:
        data: 数据列表（List[Dict]）或数据文件路径（str）
        chart_type: 指定图表类型 ('line', 'bar', 'pie', 'scatter') - 必填
        title: 图表标题
        x_field: X轴字段名 - 必填
        y_field: Y轴字段名 - 必填
        series_field: 系列分组字段名
    """
    import pandas as pd
    import json
    import os

    try:
        logger.info(f"生成图表: chart_type={chart_type}, x_field={x_field}, y_field={y_field}")

        # 1. 快速检查必填参数 (Fail Fast)
        missing_params = []
        if not x_field: missing_params.append("x_field")
        if not y_field: missing_params.append("y_field")
        if not chart_type: chart_type = 'bar'

        if missing_params:
            return error_response(
                f"缺少必填参数: {', '.join(missing_params)}。请根据数据元数据，明确指定 X 轴和 Y 轴的字段名。"
            )

        # 2. 数据加载
        df = None
        if isinstance(data, str):
            # 首先尝试解析为 JSON 字符串
            try:
                content = json.loads(data)
                if isinstance(content, list):
                    df = pd.DataFrame(content)
                elif isinstance(content, dict) and 'results' in content:
                    df = pd.DataFrame(content['results'])
                else:
                    return error_response("JSON 数据格式错误：需要列表或包含 results 字段的字典")
            except json.JSONDecodeError:
                # 如果不是 JSON 字符串，尝试作为文件路径处理
                if os.path.exists(data):
                    try:
                        if data.endswith('.csv'):
                            df = pd.read_csv(data)
                        else:
                            df = pd.read_json(data)
                    except Exception:
                         # 兜底：尝试标准 JSON 读取
                        try:
                            with open(data, 'r', encoding='utf-8') as f:
                                content = json.load(f)
                                if isinstance(content, list):
                                    df = pd.DataFrame(content)
                                elif isinstance(content, dict) and 'results' in content:
                                    df = pd.DataFrame(content['results'])
                                else:
                                    return error_response("文件内容无法解析为表格")
                        except Exception as e:
                            return error_response(f"无法读取数据文件: {str(e)}")
                else:
                    return error_response(f"数据既不是有效的 JSON 字符串，也不是存在的文件路径: {data[:100]}...")
        elif isinstance(data, list):
            df = pd.DataFrame(data)
        else:
            return error_response("数据格式错误：需要列表或文件路径")

        if df is None or df.empty:
            return error_response("数据为空")

        logger.info(f"[generate_chart] 数据加载成功，形状: {df.shape}, 列: {df.columns.tolist()}")

        # 3. 验证字段存在性
        columns = df.columns.tolist()
        if x_field not in columns:
            return error_response(f"X轴字段 '{x_field}' 在数据中不存在。可用字段: {columns}")
        if y_field not in columns:
            return error_response(f"Y轴字段 '{y_field}' 在数据中不存在。可用字段: {columns}")
        if series_field and series_field not in columns:
            return error_response(f"系列字段 '{series_field}' 在数据中不存在。可用字段: {columns}")

        # 4. 构建 ECharts Option
        # 转换数据 (处理 NaN) - 使用 replace 替换 NaN 为 None
        import numpy as np
        import math
        dataset_source = df.replace({np.nan: None}).to_dict(orient='records')

        # 智能生成标题
        final_title = title
        if not final_title:
            final_title = f"{y_field} 随 {x_field} 变化"

        option = {
            "title": {
                "text": final_title,
                "left": "center"
            },
            "tooltip": {
                "trigger": "axis" if chart_type != 'pie' else 'item'
            },
            "legend": {
                "top": "bottom"
            },
            "dataset": {
                "source": dataset_source
            },
            "xAxis": {
                "type": "category", # 默认 X 轴为类目轴
                "name": x_field
            } if chart_type != 'pie' else None,
            "yAxis": {
                "type": "value",
                "name": y_field
            } if chart_type != 'pie' else None,
            "series": []
        }

        # 处理多系列 (Pivot)
        if series_field:
            try:
                # 尝试透视表转换，以便 ECharts 更容易处理多系列
                pivot_df = df.pivot(index=x_field, columns=series_field, values=y_field)
                # 重置索引，第一列是 X，后面是各系列
                pivot_df = pivot_df.reset_index()

                # 更新 dataset source (清理 NaN)
                option['dataset']['source'] = pivot_df.replace({np.nan: None}).to_dict(orient='records')

                # 动态添加 series
                series_names = [c for c in pivot_df.columns if c != x_field]
                for s_name in series_names:
                    option['series'].append({
                        "type": chart_type,
                        "name": str(s_name),
                        "encode": {"x": x_field, "y": s_name}
                    })
            except Exception as e:
                return error_response(f"数据透视失败（可能存在重复的 X+Series 组合）: {str(e)}")
        else:
            # 单系列
            series_cfg = {
                "type": chart_type,
                "encode": {"x": x_field, "y": y_field},
                "name": y_field
            }
            if chart_type == 'pie':
                series_cfg['encode'] = {"itemName": x_field, "value": y_field}
                series_cfg['radius'] = '50%'

            option['series'].append(series_cfg)

        logger.info(f"图表配置生成成功: {chart_type}, 数据点数: {len(dataset_source)}")

        # 使用标准化响应
        return success_response(
            results={"echarts_config": option, "chart_type": chart_type},
            summary=f"图表配置已生成 ({chart_type})"
        )

    except Exception as e:
        return error_response(f"生成图表失败: {str(e)}")


def generate_map(data, map_type="heatmap", title="", name_field="", value_field="", geometry_field="geometry"):
    """
    生成地图可视化配置（Leaflet 地图）

    支持多种地图类型，从知识图谱数据中提取 WKT geometry 并转换为 Leaflet 格式

    返回格式（标准化）:
    {
        "success": True,
        "data": {
            "results": {
                "map_type": "heatmap/marker/circle",
                "heat_data": [[lat, lng, intensity], ...],  # 热力图数据（heatmap）
                "markers": [{"name": "...", "lat": ..., "lng": ..., "value": ...}],  # 标记点数据（marker/circle）
                "bounds": [[minLat, minLng], [maxLat, maxLng]],  # 地图边界
                "center": [lat, lng],  # 地图中心
                "title": "...",
                "value_field": "...",
                "total_points": int
            },
            "metadata": {...},
            "summary": "..."
        }
    }

    Args:
        data: 数据列表（List[Dict]）或数据文件路径（str）
              每条记录必须包含 geometry 字段（WKT格式：POINT (lng lat)）
        map_type: 地图类型
                  - 'heatmap': 热力图（展示数值密度分布）
                  - 'marker': 标记点（展示精确位置和数值）
                  - 'circle': 圆圈标记（圆的大小代表数值大小）
        title: 地图标题
        name_field: 地名字段（如 "city", "区域"）- 可选（marker/circle 时建议提供）
        value_field: 数值字段（如 "受灾人口", "经济损失"）- 必填
        geometry_field: 几何字段名（默认 "geometry"）
    """
    import pandas as pd
    import json
    import os
    import re

    try:
        # 1. 参数验证
        if not value_field:
            return error_response("缺少必填参数: value_field。请指定数值字段。")

        # 验证地图类型
        supported_types = ['heatmap', 'marker', 'circle']
        if map_type not in supported_types:
            return error_response(
                f"不支持的地图类型: {map_type}。支持的类型: {', '.join(supported_types)}"
            )

        # 2. 数据加载
        df = None
        if isinstance(data, str):
            # 首先尝试解析为 JSON 字符串
            try:
                content = json.loads(data)
                if isinstance(content, list):
                    df = pd.DataFrame(content)
                elif isinstance(content, dict) and 'results' in content:
                    df = pd.DataFrame(content['results'])
                else:
                    return error_response("JSON 数据格式错误：需要列表或包含 results 字段的字典")
            except json.JSONDecodeError:
                # 如果不是 JSON 字符串，尝试作为文件路径处理
                if os.path.exists(data):
                    try:
                        if data.endswith('.csv'):
                            df = pd.read_csv(data)
                        else:
                            df = pd.read_json(data)
                    except Exception:
                        try:
                            with open(data, 'r', encoding='utf-8') as f:
                                content = json.load(f)
                                if isinstance(content, list):
                                    df = pd.DataFrame(content)
                                elif isinstance(content, dict) and 'results' in content:
                                    df = pd.DataFrame(content['results'])
                                else:
                                    return error_response("文件内容无法解析为表格")
                        except Exception as e:
                            return error_response(f"无法读取数据文件: {str(e)}")
                else:
                    return error_response(f"数据既不是有效的 JSON 字符串，也不是存在的文件路径: {data[:100]}...")
        elif isinstance(data, list):
            df = pd.DataFrame(data)
        else:
            return error_response("数据格式错误：需要列表或文件路径")

        if df is None or df.empty:
            return error_response("数据为空")

        # 3. 验证字段存在性
        columns = df.columns.tolist()
        if value_field not in columns:
            return error_response(f"数值字段 '{value_field}' 在数据中不存在。可用字段: {columns}")
        if geometry_field not in columns:
            return error_response(
                f"几何字段 '{geometry_field}' 在数据中不存在。可用字段: {columns}\n"
                "请确保数据包含 geometry 字段（WKT格式，如 'POINT (lng lat)'）"
            )

        # 4. 解析 WKT geometry 并提取坐标
        def parse_wkt_point(wkt_str):
            """
            解析 WKT POINT 格式: "POINT (lng lat)"
            返回 (lat, lng) 或 None
            """
            if pd.isna(wkt_str) or not isinstance(wkt_str, str):
                return None

            # 正则提取坐标：POINT (lng lat)
            match = re.search(r'POINT\s*\(\s*([\d.+-]+)\s+([\d.+-]+)\s*\)', wkt_str, re.IGNORECASE)
            if match:
                lng = float(match.group(1))
                lat = float(match.group(2))
                return (lat, lng)  # Leaflet 使用 [lat, lng] 顺序
            return None

        # 5. 构建地图数据
        heat_data = []
        markers = []
        valid_count = 0

        # 计算数值范围（用于标准化）
        values = df[value_field].dropna().astype(float)
        if len(values) == 0:
            return error_response(f"{value_field} 字段没有有效的数值数据")

        min_value = float(values.min())
        max_value = float(values.max())

        for idx, row in df.iterrows():
            # 解析坐标
            coords = parse_wkt_point(row[geometry_field])
            if coords is None:
                continue

            lat, lng = coords
            value = float(row[value_field]) if pd.notnull(row[value_field]) else 0

            # 热力图数据: [lat, lng, normalized_intensity]
            # 归一化到 0.1-1.0 范围（避免完全为0的点不显示）
            if max_value > min_value:
                normalized_intensity = 0.1 + 0.9 * (value - min_value) / (max_value - min_value)
            else:
                normalized_intensity = 0.5

            heat_data.append([lat, lng, normalized_intensity])

            # 标记点数据（保留原始值用于显示）
            marker_data = {
                "lat": lat,
                "lng": lng,
                "value": value
            }

            # 添加地名（如果有）
            if name_field and name_field in columns and pd.notnull(row[name_field]):
                marker_data["name"] = str(row[name_field])
            else:
                marker_data["name"] = f"点 {valid_count + 1}"

            # Circle 类型需要半径
            if map_type == 'circle':
                # 根据数值大小计算半径（归一化到 500-5000 米）
                if max_value > min_value:
                    normalized = (value - min_value) / (max_value - min_value)
                    marker_data["radius"] = int(500 + normalized * 4500)
                else:
                    marker_data["radius"] = 2000

            markers.append(marker_data)
            valid_count += 1

        if valid_count == 0:
            return error_response(
                f"没有有效的地理坐标数据。请检查 {geometry_field} 字段是否包含有效的 WKT POINT 格式。"
            )

        # 6. 计算地图边界（用于自动定位）
        lats = [point[0] for point in heat_data]
        lngs = [point[1] for point in heat_data]
        bounds = [
            [min(lats), min(lngs)],  # 西南角
            [max(lats), max(lngs)]   # 东北角
        ]

        # 7. 计算中心点
        center = [
            (min(lats) + max(lats)) / 2,
            (min(lngs) + max(lngs)) / 2
        ]

        # 8. 智能生成标题
        if not title:
            map_type_name = {
                'heatmap': '热力图',
                'marker': '标记点地图',
                'circle': '圆圈标记地图'
            }.get(map_type, '地图')
            title = f"{value_field}分布{map_type_name}"

        # 9. 构建返回数据
        result_data = {
            "map_type": map_type,
            "heat_data": heat_data if map_type == 'heatmap' else [],      # [[lat, lng, intensity], ...]
            "markers": markers if map_type in ['marker', 'circle'] else [],  # [{"name": "...", "lat": ..., "lng": ..., "value": ...}, ...]
            "bounds": bounds,             # [[minLat, minLng], [maxLat, maxLng]]
            "center": center,             # [lat, lng]
            "title": title,
            "value_field": value_field,
            "total_points": valid_count,
            "value_range": {"min": min_value, "max": max_value}
        }

        # 使用标准化响应
        return success_response(
            results=result_data,
            summary=f"地图配置已生成 ({map_type})，共 {valid_count} 个有效数据点"
        )

    except Exception as e:
        logger.error(f"生成地图失败: {str(e)}")
        import traceback
        logger.error(traceback.format_exc())
        return error_response(f"生成地图失败: {str(e)}")


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


def transform_data(python_code, description=""):
    """
    执行 Python 代码进行数据转换（纯内存操作）

    适用于 LLM 已经从前一个工具获得数据，需要快速转换的场景。
    LLM 直接在代码中硬编码数据，无需传递 data 参数。

    Args:
        python_code: Python 转换代码，必须设置 result 变量作为输出
        description: 操作描述（可选）

    Returns:
        标准化响应:
        {
            "success": True,
            "data": {
                "results": [...],  # 转换后的数据（从 result 变量获取）
                "metadata": {...},  # 自动生成
                "summary": "数据转换成功"
            }
        }

    Example:
        python_code = '''
# 直接在代码中定义数据
raw_data = [
    {"name": "南宁", "lng": 108.37, "lat": 22.82, "value": 1500},
    {"name": "柳州", "lng": 109.42, "lat": 24.33, "value": 800}
]

# 转换数据
result = []
for item in raw_data:
    result.append({
        'name': item['name'],
        'value': item['value'],
        'geometry': f"POINT ({item['lng']} {item['lat']})"
    })
'''
        transform_data(python_code, "添加 geometry 字段")
    """
    import pandas as pd
    import json

    try:
        logger.info(f"执行数据转换: {description}")

        # 参数验证
        if not python_code or not python_code.strip():
            return error_response("参数 python_code 不能为空")

        # 准备执行环境
        local_vars = {
            'pd': pd,
            'json': json,
            'result': None,    # 输出结果（用户必须设置）
            '__builtins__': __builtins__
        }

        # 安全限制：禁止导入敏感模块
        forbidden_modules = ['os', 'sys', 'subprocess', 'shutil']
        for mod in forbidden_modules:
            if f"import {mod}" in python_code or f"from {mod}" in python_code:
                return error_response(f"安全警告: 禁止在代码中使用 {mod} 模块")

        # 执行代码
        logger.info("开始执行转换代码...")
        exec(python_code, local_vars, local_vars)

        # 获取结果
        result_data = local_vars.get('result')
        if result_data is None:
            return error_response(
                "代码执行成功，但未设置 result 变量。\n"
                "请在代码末尾添加：result = <转换后的数据>"
            )

        # 使用标准化响应（自动生成元数据）
        return success_response(
            results=result_data,
            summary=f"数据转换成功：{description}" if description else "数据转换成功"
        )

    except Exception as e:
        logger.error(f"数据转换失败: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return error_response(f"数据转换失败: {str(e)}")


def process_data_file(source_path, python_code, description=""):
    """
    执行数据处理工具

    Args:
        source_path: 源文件路径
        python_code: Python 处理代码
        description: 操作描述

    Returns:
        标准化响应（自动生成元数据和摘要）:
        {
            "success": True,
            "data": {
                "results": list,         # 处理后的数据列表
                "metadata": {            # 自动生成
                    "total_count": int,
                    "fields": list,
                    "sample": dict
                },
                "summary": str,          # 自动生成
                "debug": {
                    "result_path": str,
                    "source_path": str,
                    "file_size": str
                }
            }
        }
    """
    import pandas as pd
    import json
    import os
    import uuid

    try:
        logger.info(f"执行数据处理: {description}")
        logger.info(f"源文件: {source_path}")

        # 1. 验证源文件存在
        if not os.path.exists(source_path):
            return error_response(f"源文件不存在: {source_path}")

        # 2. 生成结果文件路径
        result_dir = os.path.dirname(source_path)
        result_filename = f"processed_{uuid.uuid4().hex}.json"
        result_path = os.path.join(result_dir, result_filename)

        # 3. 准备执行环境
        local_vars = {
            'pd': pd,
            'json': json,
            'source_path': source_path,
            'result_path': result_path,
            '__builtins__': __builtins__
        }

        # 4. 安全限制：禁止导入敏感模块
        forbidden_modules = ['os', 'sys', 'subprocess', 'shutil']
        for mod in forbidden_modules:
            if f"import {mod}" in python_code or f"from {mod}" in python_code:
                return error_response(f"安全警告: 禁止在代码中使用 {mod} 模块")

        # 5. 执行代码
        logger.info("开始执行 Python 代码...")
        exec(python_code, local_vars, local_vars)

        # 6. 验证结果文件是否生成
        if not os.path.exists(result_path):
            return error_response("代码执行成功，但未生成结果文件。请检查代码是否正确写入 result_path。")

        # 7. 读取处理后的完整数据
        file_size = os.path.getsize(result_path)

        # 尝试读取结果文件，支持 JSON 和 CSV 格式
        try:
            with open(result_path, 'r', encoding='utf-8') as f:
                processed_data = json.load(f)
        except json.JSONDecodeError:
            # 如果不是 JSON，尝试作为 CSV 读取
            try:
                df = pd.read_csv(result_path)
                processed_data = df.to_dict('records')
                logger.info(f"结果文件是 CSV 格式，已转换为 {len(processed_data)} 条记录")
            except Exception as csv_error:
                # 如果也不是 CSV，尝试作为文本读取
                with open(result_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                    logger.warning(f"结果文件既不是 JSON 也不是 CSV，返回原始文本（前500字符）")
                    return error_response(f"结果文件格式不支持。请确保代码将数据保存为 JSON 格式（使用 json.dump）。\n文件内容预览：{content[:500]}")

        # 8. 使用标准化响应，自动生成元数据和摘要
        # 直接传递处理后的数据，让 success_response 自动分析
        debug_info = {
            "result_path": result_path,
            "source_path": source_path,
            "file_size": f"{file_size / 1024:.2f} KB"
        }

        return success_response(
            results=processed_data,
            debug=debug_info
        )

    except Exception as e:
        logger.error(f"数据处理失败: {e}")
        import traceback
        traceback.print_exc()
        return error_response(f"代码执行错误: {str(e)}")


# ==================== Skills 工具 ====================

def activate_skill(skill_name):
    """
    激活一个 Skill 并加载其主文件内容（SKILL.md）

    这是使用 Skill 的第一步。激活后，AI 将获得该 Skill 的完整指导流程。

    Args:
        skill_name: 要激活的 Skill 名称

    Returns:
        Skill 的主文件内容和元数据

    功能：
    1. 加载 SKILL.md 主文件内容
    2. 记录 Skill 激活状态（未来用于上下文管理）
    3. 返回可用的引用文件和脚本列表
    """
    try:
        from agents.skills.skill_loader import get_skill_loader

        # 获取 Skill
        skill_loader = get_skill_loader()
        all_skills = skill_loader.load_all_skills()
        skill = next((s for s in all_skills if s.name == skill_name), None)

        if not skill:
            available_skills = [s.name for s in all_skills]
            return error_response(
                f"Skill '{skill_name}' 不存在。可用的 Skills: {available_skills}"
            )

        # 加载主文件内容（SKILL.md）
        main_content = skill.content

        logger.info(f"✅ 激活 Skill: {skill_name}")

        # 返回激活信息（无需提前列出资源和脚本）
        return success_response(
            results={
                "skill_name": skill_name,
                "description": skill.description,
                "main_content": main_content  # SKILL.md 的完整内容
            },
            metadata={
                "content_length": len(main_content),
                "activation_time": "now",  # 未来可以记录时间戳
                "status": "activated"
            },
            summary=f"✅ Skill '{skill_name}' 已激活，加载主文件 {len(main_content)} 字符"
        )

    except Exception as e:
        logger.error(f"激活 Skill 失败: {e}")
        import traceback
        traceback.print_exc()
        return error_response(f"激活失败: {str(e)}")


def load_skill_resource(skill_name, resource_file):
    """
    加载 Skill 的引用文件内容（Additional Resources）

    实现渐进式披露：主 SKILL.md 保持简洁，详细内容按需加载

    Args:
        skill_name: Skill 名称
        resource_file: 要加载的文件名（相对于 Skill 目录）

    Returns:
        文件内容
    """
    try:
        from agents.skills.skill_loader import get_skill_loader

        # 获取 Skill
        skill_loader = get_skill_loader()
        all_skills = skill_loader.load_all_skills()
        skill = next((s for s in all_skills if s.name == skill_name), None)

        if not skill:
            return error_response(f"Skill '{skill_name}' 不存在")

        # 加载文件内容
        content = skill.get_resource_file_content(resource_file)

        if content is None:
            return error_response(
                f"文件 '{resource_file}' 不存在或无法读取"
            )

        logger.info(f"加载 Skill 资源: {skill_name}/{resource_file} ({len(content)} 字符)")

        return success_response(
            results={
                "file_name": resource_file,
                "content": content,
                "skill": skill_name
            },
            metadata={
                "length": len(content)
            },
            summary=f"成功加载 {resource_file} ({len(content)} 字符)"
        )

    except Exception as e:
        logger.error(f"加载 Skill 资源失败: {e}")
        import traceback
        traceback.print_exc()
        return error_response(f"加载失败: {str(e)}")


def execute_skill_script(skill_name, script_name, arguments=None):
    """
    执行 Skill 的实用脚本（Utility Scripts）

    零上下文执行：脚本内容不加载到上下文，只返回执行结果

    ✨ 新特性：支持依赖隔离
    - 每个 Skill 可以有独立的虚拟环境
    - 自动安装 requirements.txt 中的依赖
    - 避免污染后端系统环境

    Args:
        skill_name: Skill 名称
        script_name: 脚本文件名
        arguments: 传递给脚本的命令行参数列表

    Returns:
        脚本执行结果（stdout, stderr, return_code）
    """
    try:
        from agents.skills.skill_loader import get_skill_loader

        # 获取 Skill
        skill_loader = get_skill_loader()
        all_skills = skill_loader.load_all_skills()
        skill = next((s for s in all_skills if s.name == skill_name), None)

        if not skill:
            return error_response(f"Skill '{skill_name}' 不存在")

        # 检查是否有 scripts 目录
        if not skill.has_scripts():
            return error_response(
                f"Skill '{skill_name}' 没有 scripts 目录"
            )

        # 🔧 使用 Skill 的 execute_script 方法（支持环境隔离）
        script_args = arguments if arguments else []
        logger.info(f"执行 Skill 脚本: {skill_name}/{script_name} {script_args}")

        result = skill.execute_script(
            script_name=script_name,
            arguments=script_args,
            timeout=30
        )

        logger.info(f"脚本执行完成，返回码: {result['return_code']}")

        return success_response(
            results={
                "script_name": script_name,
                "stdout": result['stdout'],
                "stderr": result['stderr'],
                "return_code": result['return_code'],
                "skill": skill_name
            },
            summary=f"脚本 {script_name} 执行完成（返回码: {result['return_code']}）",
            metadata={
                "success": result['return_code'] == 0
            }
        )

    except Exception as e:
        logger.error(f"执行 Skill 脚本失败: {e}")
        import traceback
        traceback.print_exc()
        return error_response(f"执行失败: {str(e)}")
