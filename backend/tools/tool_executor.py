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


# ==================== 辅助函数：结果压缩 ====================

def _compress_query_results(records, max_records=10):
    """
    压缩查询结果，只保留关键字段，移除冗余数据

    策略：
    1. 限制返回条数
    2. 移除过长的嵌套对象
    3. 截断超长字符串
    """
    if not records:
        return []

    compressed = []
    for record in records[:max_records]:
        compressed_record = {}
        for key, value in record.items():
            compressed_record[key] = _compress_value(value)
        compressed.append(compressed_record)

    return compressed


def _compress_value(value, max_str_length=200, max_list_items=5):
    """
    递归压缩单个值

    Args:
        value: 要压缩的值
        max_str_length: 字符串最大长度
        max_list_items: 列表最大元素数
    """
    # 字符串：截断
    if isinstance(value, str):
        if len(value) > max_str_length:
            return value[:max_str_length] + f"... (截断，总长{len(value)})"
        return value

    # 列表：限制元素数量，递归压缩每个元素
    elif isinstance(value, list):
        if len(value) > max_list_items:
            compressed_list = [_compress_value(item) for item in value[:max_list_items]]
            return compressed_list + [f"... (还有{len(value) - max_list_items}项)"]
        return [_compress_value(item) for item in value]

    # 字典：递归压缩每个值，但移除明显冗余的键
    elif isinstance(value, dict):
        # 移除已知的冗余字段
        redundant_keys = {'_raw', 'metadata', 'internal_id'}
        compressed_dict = {}
        for k, v in value.items():
            if k not in redundant_keys:
                compressed_dict[k] = _compress_value(v)
        return compressed_dict

    # 其他类型（数字、布尔等）：直接返回
    else:
        return value


def _generate_result_summary(records):
    """
    生成结果摘要，用于 Agent 快速理解数据结构

    Returns:
        str: 简洁的摘要信息
    """
    if not records:
        return "无查询结果"

    record_count = len(records)

    # 分析第一条记录的字段
    if record_count > 0:
        first_record = records[0]
        field_info = []

        for key, value in first_record.items():
            # 识别字段类型
            if isinstance(value, list):
                field_type = f"列表({len(value)}项)"
            elif isinstance(value, dict):
                field_type = f"对象({len(value)}个字段)"
            elif isinstance(value, str):
                field_type = "文本"
            elif isinstance(value, (int, float)):
                field_type = "数值"
            else:
                field_type = str(type(value).__name__)

            field_info.append(f"  - {key}: {field_type}")

        summary = f"查询返回 {record_count} 条记录\n"
        summary += "字段结构:\n"
        summary += "\n".join(field_info[:8])  # 最多显示8个字段

        if len(field_info) > 8:
            summary += f"\n  ... (还有{len(field_info) - 8}个字段)"

        return summary

    return f"查询返回 {record_count} 条记录"


# ==================== 工具执行函数 ====================

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
        elif tool_name == "process_data_file":
            return process_data_file(**arguments)
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

    这是对原有 /api/search/relations/<entity_id> 接口的封装
    优化：区分基础实体和状态节点，使用标签过滤提高效率
    优化：压缩节点属性数据，减少 Agent 上下文占用
    """
    session = None
    try:
        session = get_session()

        # 优化：根据ID格式判断是基础实体还是状态节点
        # 基础实体ID: L-*, F-*, E-*
        # 状态节点ID: LS-*, FS-*, ES-*, JS-*
        is_state = entity_id.startswith(('LS-', 'FS-', 'ES-', 'JS-'))

        if is_state:
            # 查询状态节点及其关系
            cypher = """
            MATCH (n:State)
            WHERE n.id = $entity_id OR n.id CONTAINS $entity_id
            OPTIONAL MATCH (n)-[r]-(m)
            RETURN n, r, m
            LIMIT 50
            """
        else:
            # 查询基础实体节点及其关系（更高效）
            cypher = """
            MATCH (n:entity)
            WHERE n.id = $entity_id
            OPTIONAL MATCH (n)-[r]-(m)
            RETURN n, r, m
            LIMIT 50
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
                    # 优化：只保留关键属性，压缩完整属性
                    props = convert_neo4j_types(dict(node))
                    key_props = {
                        'id': props.get('id'),
                        'name': props.get('name'),
                        'state_type': props.get('state_type'),
                        'time': props.get('time')
                    }
                    # 过滤掉 None 值
                    key_props = {k: v for k, v in key_props.items() if v is not None}

                    nodes[node_id] = {
                        'id': node.id,
                        'labels': list(node.labels),
                        'key_properties': key_props,  # ✅ 只保留关键属性
                        'full_properties_compressed': _compress_value(props)  # ✅ 压缩完整属性
                    }

            # 处理关联节点
            if record['m']:
                node = record['m']
                node_id = str(node.id)
                if node_id not in nodes:
                    props = convert_neo4j_types(dict(node))
                    key_props = {
                        'id': props.get('id'),
                        'name': props.get('name'),
                        'state_type': props.get('state_type'),
                        'time': props.get('time')
                    }
                    key_props = {k: v for k, v in key_props.items() if v is not None}

                    nodes[node_id] = {
                        'id': node.id,
                        'labels': list(node.labels),
                        'key_properties': key_props,
                        'full_properties_compressed': _compress_value(props)
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
                    'properties': _compress_value(rel_props)  # ✅ 压缩关系属性
                })

        # 优化：限制关系数量，避免过多数据
        MAX_RELATIONS = 30
        truncated = len(relationships) > MAX_RELATIONS
        relationships = relationships[:MAX_RELATIONS]

        return {
            "success": True,
            "data": {
                "nodes": list(nodes.values()),
                "relationships": relationships,
                "count": len(relationships),
                "node_type": "State" if is_state else "Entity",
                "truncated": truncated  # ✅ 标记是否截断
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
    优化：压缩返回数据，减少 Agent 上下文占用
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
        records = query_result.get('records', [])

        # 优化：压缩返回数据
        # 1. 限制返回结果数量（Agent 通常不需要所有结果）
        # 2. 压缩每条记录的数据
        # 3. 移除 graph_data（Agent 不需要图可视化）
        compressed_results = _compress_query_results(records, max_records=15)
        result_summary = _generate_result_summary(records)

        return {
            "success": True,
            "data": {
                "results": compressed_results,  # ✅ 压缩后的结果
                "result_summary": result_summary,  # ✅ 结果摘要
                "count": len(records),  # ✅ 总数量
                "truncated": len(records) > 15  # ✅ 是否被截断
                # ❌ 移除 graph_data
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
    """
    分析时序模式
    优化：压缩返回记录数，只保留关键时序数据
    """
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
                   attr.value AS value, s.state_type AS state_type
            ORDER BY s.start_time
            """
        else:
            cypher += """
            RETURN s.time AS time, s.start_time AS start, s.end_time AS end,
                   s.state_type AS state_type, count(s) AS count
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

        # 优化：限制返回的时序记录数量
        # 策略：如果记录太多，采样关键时间点（开始、中间、结束）
        MAX_RECORDS = 20
        if len(records) > MAX_RECORDS:
            # 保留开始、结束和均匀间隔的中间点
            step = len(records) // (MAX_RECORDS - 2)
            sampled_records = [records[0]]  # 开始
            sampled_records.extend(records[step::step][:MAX_RECORDS-2])  # 中间点
            sampled_records.append(records[-1])  # 结束
            compressed_records = sampled_records
            truncated = True
        else:
            compressed_records = records
            truncated = False

        return {
            "success": True,
            "data": {
                "records": compressed_records,  # ✅ 压缩后的记录
                "analysis": trend_analysis,  # ✅ 趋势分析（基于完整数据）
                "time_range": f"{start_date} 至 {end_date}",
                "total_records": len(records),  # ✅ 原始记录总数
                "truncated": truncated  # ✅ 是否被采样
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
            RETURN [n IN ns | {{id: n.id, state_type: n.state_type, time: n.time}}] AS nodes,
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
            RETURN [n IN ns | {{id: n.id, state_type: n.state_type, time: n.time}}] AS nodes,
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
                RETURN s.id AS state_id, s.time AS time, s.state_type AS state_type,
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
    """
    聚合统计

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

        # 修复：正确处理 entity_type 过滤
        if entity_type:
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

    修复：添加完整的空间关系类型，包括 :hasState
    优化：限制返回数量，只保留关键字段
    """
    session = None
    try:
        session = get_session()

        # 构建查询（添加 :hasState 关系）
        cypher = f"""
        MATCH (center)
        WHERE center.id CONTAINS $entity_name OR center.name CONTAINS $entity_name
        MATCH path = (center)-[:locatedIn|occurredAt|hasState*1..{radius}]-(neighbor)
        """

        params = {'entity_name': entity_name}

        if neighbor_type:
            cypher += f" WHERE $neighbor_type IN labels(neighbor)"
            params['neighbor_type'] = neighbor_type

        # 优化：限制返回数量，减少从30到25
        cypher += """
        RETURN DISTINCT neighbor.id AS id, neighbor.name AS name,
               labels(neighbor) AS labels, length(path) AS distance
        ORDER BY distance
        LIMIT 25
        """

        result = session.run(cypher, params)
        neighbors = [convert_neo4j_types(dict(record)) for record in result]

        # 优化：按距离分组统计，提供摘要信息
        distance_summary = {}
        for n in neighbors:
            dist = n.get('distance', 0)
            if dist not in distance_summary:
                distance_summary[dist] = 0
            distance_summary[dist] += 1

        return {
            "success": True,
            "data": {
                "neighbors": neighbors,  # ✅ 已压缩到25个
                "count": len(neighbors),
                "center": entity_name,
                "radius": radius,
                "distance_summary": distance_summary,  # ✅ 距离分布摘要
                "truncated": len(neighbors) >= 25  # ✅ 可能被截断
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
                return error_response(f"数据文件不存在: {data}")
        elif isinstance(data, list):
            df = pd.DataFrame(data)
        else:
            return error_response("数据格式错误：需要列表或文件路径")

        if df is None or df.empty:
            return error_response("数据为空")

        # 3. 验证字段存在性
        columns = df.columns.tolist()
        if x_field not in columns:
            return error_response(f"X轴字段 '{x_field}' 在数据中不存在。可用字段: {columns}")
        if y_field not in columns:
            return error_response(f"Y轴字段 '{y_field}' 在数据中不存在。可用字段: {columns}")
        if series_field and series_field not in columns:
            return error_response(f"系列字段 '{series_field}' 在数据中不存在。可用字段: {columns}")

        # 4. 构建 ECharts Option
        # 转换数据 (处理 NaN)
        dataset_source = df.where(pd.notnull(df), None).to_dict(orient='records')

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

                # 更新 dataset source
                option['dataset']['source'] = pivot_df.where(pd.notnull(pivot_df), None).to_dict(orient='records')

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

        # 使用标准化响应
        return success_response(
            results={"echarts_config": option, "chart_type": chart_type},
            summary=f"图表配置已生成 ({chart_type})"
        )

    except Exception as e:
        return error_response(f"生成图表失败: {str(e)}")


def process_data_file(source_path, python_code, description=""):
    """
    执行数据处理工具

    Args:
        source_path: 源文件路径
        python_code: Python 处理代码
        description: 操作描述
    """
    import pandas as pd
    import json
    import os
    import uuid
    import tempfile

    try:
        logger.info(f"执行数据处理: {description}")
        logger.info(f"源文件: {source_path}")

        # 1. 验证源文件存在
        if not os.path.exists(source_path):
            return {
                "success": False,
                "error": f"源文件不存在: {source_path}"
            }

        # 2. 生成结果文件路径
        result_dir = os.path.dirname(source_path)
        result_filename = f"processed_{uuid.uuid4().hex}.json"
        result_path = os.path.join(result_dir, result_filename)

        # 3. 准备执行环境
        # 注意：local_vars 必须同时作为 globals 和 locals 传入 exec()
        # 否则在 lambda、列表推导式等嵌套作用域中无法访问这些变量
        local_vars = {
            'pd': pd,
            'json': json,
            'source_path': source_path,
            'result_path': result_path,
            # 添加内置函数，确保代码可以正常执行
            '__builtins__': __builtins__
        }

        # 4. 安全限制（简单版）：禁止导入敏感模块
        forbidden_modules = ['os', 'sys', 'subprocess', 'shutil']
        for mod in forbidden_modules:
            if f"import {mod}" in python_code or f"from {mod}" in python_code:
                return {
                    "success": False,
                    "error": f"安全警告: 禁止在代码中使用 {mod} 模块"
                }

        # 5. 执行代码
        # 关键修复：使用 local_vars 同时作为 globals 和 locals
        # 这样在 lambda、apply 等嵌套作用域中也能访问 pd、json 等变量
        logger.info("开始执行 Python 代码...")
        exec(python_code, local_vars, local_vars)

        # 6. 验证结果文件是否生成
        if not os.path.exists(result_path):
            return {
                "success": False,
                "error": "代码执行成功，但未生成结果文件。请检查代码是否正确写入 result_path。"
            }

        # 7. 读取结果文件的元数据（不读取全文）
        file_size = os.path.getsize(result_path)

        # 尝试读取前几行作为预览
        preview_data = None
        try:
            with open(result_path, 'r', encoding='utf-8') as f:
                # 只读取前 1000 字符用于预览
                content_preview = f.read(1000)
                try:
                    # 尝试解析为 JSON
                    json_data = json.loads(content_preview)
                    preview_data = json_data
                except:
                    # 如果截断导致解析失败，或者不是 JSON，则保留字符串
                    preview_data = content_preview + "..."
        except Exception as e:
            preview_data = f"无法预览: {str(e)}"

        return {
            "success": True,
            "data": {
                "message": "数据处理成功",
                "result_path": result_path,
                "source_path": source_path,
                "file_size": f"{file_size / 1024:.2f} KB",
                "preview": preview_data
            }
        }

    except Exception as e:
        logger.error(f"数据处理失败: {e}")
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "error": f"代码执行错误: {str(e)}"
        }
