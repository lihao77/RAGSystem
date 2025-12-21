#!/usr/bin/env python3
"""
搜索相关API路由
"""

from flask import Blueprint, request, jsonify
from datetime import datetime, date
import logging
import json
import os
from neo4j.time import Date, DateTime, Time

from db import get_session

logger = logging.getLogger(__name__)

# 创建蓝图
search_bp = Blueprint('search', __name__)

def convert_neo4j_types(obj):
    """将Neo4j特殊类型转换为Python原生类型，以便JSON序列化"""
    if isinstance(obj, (Date, DateTime)):
        return obj.iso_format()
    elif isinstance(obj, Time):
        return str(obj)
    elif isinstance(obj, (date, datetime)):
        return obj.isoformat()
    elif isinstance(obj, dict):
        return {key: convert_neo4j_types(value) for key, value in obj.items()}
    elif isinstance(obj, list):
        return [convert_neo4j_types(item) for item in obj]
    else:
        return obj

# 模拟地理位置选项
location_options = [
    {
        'value': 'guangxi',
        'label': '广西壮族自治区',
        'children': [
            {
                'value': 'nanning',
                'label': '南宁市',
                'children': [
                    {'value': 'xingning', 'label': '兴宁区'},
                    {'value': 'qingxiu', 'label': '青秀区'},
                    {'value': 'jiangnan', 'label': '江南区'},
                ]
            },
            {
                'value': 'liuzhou',
                'label': '柳州市',
                'children': [
                    {'value': 'chengzhong', 'label': '城中区'},
                    {'value': 'yufeng', 'label': '鱼峰区'},
                    {'value': 'liubei', 'label': '柳北区'},
                ]
            },
            {
                'value': 'guilin',
                'label': '桂林市',
                'children': [
                    {'value': 'xiufeng', 'label': '秀峰区'},
                    {'value': 'diecai', 'label': '叠彩区'},
                    {'value': 'xiangshan', 'label': '象山区'},
                ]
            }
        ]
    }
]

# 模拟文档来源
document_sources = [
    '2016年广西水旱灾害公报',
    '2017年广西水旱灾害公报',
    '2018年广西水旱灾害公报',
    '2019年广西水旱灾害公报',
    '2020年广西水旱灾害公报',
    '2021年广西水旱灾害公报',
    '2022年广西水旱灾害公报',
    '2023年广西水旱灾害公报'
]

@search_bp.route('/entities', methods=['POST'])
def search_entities():
    """搜索实体和状态节点（优化版，支持属性展示）"""
    session = None
    try:
        data = request.get_json()
        if not data:
            data = {}
        
        session = get_session()
        
        # 获取搜索参数
        query_mode = data.get('queryMode', 'state')  # 'entity' or 'state'
        keyword = data.get('keyword', '') or ''
        category = data.get('category', '') or ''
        state_type = data.get('stateType', '') or ''
        attribute_type = data.get('attributeType', '') or ''
        relation_type = data.get('relationType', '') or ''
        document_source = data.get('documentSource', '') or ''
        time_range = data.get('timeRange') or []
        location = data.get('location') or []
        advanced_query = data.get('advancedQuery', '') or ''
        
        # 格式化时间范围
        def format_date(date_str):
            date = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
            return date.strftime('%Y-%m-%d')
        
        time_range_new = {'start': '', 'end': ''}
        if time_range and len(time_range) == 2:
            time_range_new['start'] = format_date(time_range[0])
            time_range_new['end'] = format_date(time_range[1])
        
        params = {}
        entities = []
        
        # 根据查询模式构建不同的查询
        if query_mode == 'entity':
            # ===== 查询基础实体节点 =====
            # 注意：基础实体节点标签可能是 (:地点:entity) 或只有 (:地点)
            # 先尝试标准查询，如果没结果再尝试宽松查询
            if category and category in ['地点', '设施', '事件']:
                # 优先匹配带entity标签的，如果没有则匹配只有类型标签的
                cypher = f'MATCH (n:{category}) WHERE 1=1'
            else:
                # 查询所有基础实体类型
                cypher = 'MATCH (n) WHERE (n:地点 OR n:设施 OR n:事件)'
            
            # 关键词匹配
            if keyword and keyword.strip():
                cypher += ' AND (n.name CONTAINS $keyword OR n.id CONTAINS $keyword OR n.geo_description CONTAINS $keyword)'
                params['keyword'] = keyword
            
            # 来源
            if document_source and document_source.strip():
                cypher += ' AND n.source = $source'
                params['source'] = document_source
            
            # 地理位置（通过ID匹配）
            if location and len(location) > 0 and location[-1] and location[-1].strip():
                cypher += ' AND n.id CONTAINS $location'
                params['location'] = location[-1]
            
            # 高级查询
            if advanced_query and advanced_query.strip():
                cypher += f' AND ({advanced_query})'
            
            cypher += ' RETURN n.id AS id, n.name AS name, labels(n) AS labels, n.source AS source, properties(n) AS properties LIMIT 100'
            
            logger.info(f'基础实体查询 Cypher: {cypher}')
            logger.info(f'参数: {params}')
            
            result = session.run(cypher, params)
            for record in result:
                # 提取主要标签（排除entity标签）
                labels = [l for l in record['labels'] if l != 'entity']
                main_label = labels[0] if labels else '未知'
                
                entity = {
                    'id': record['id'],
                    'name': record['name'],
                    'category': category if category else main_label,
                    'labels': record['labels'],
                    'source': record['source'],
                    'properties': convert_neo4j_types(record['properties'])
                }
                entities.append(entity)
            
            logger.info(f'基础实体查询结果: {len(entities)}条')
        
        else:
            # ===== 查询状态节点（包含属性） =====
            cypher = 'MATCH (n:State) WHERE 1=1'
            
            # 状态类型筛选
            if state_type and state_type.strip():
                cypher += ' AND n.state_type = $stateType'
                params['stateType'] = state_type
            
            # 关键词匹配（优先使用ID过滤，这是最高效的方式）
            if keyword and keyword.strip():
                # 直接通过状态ID的CONTAINS匹配（状态ID包含实体名称）
                cypher += ' AND n.id CONTAINS $keyword'
                params['keyword'] = keyword
            
            # 属性筛选（查找包含特定属性的状态）
            if attribute_type and attribute_type.strip():
                cypher += ' AND EXISTS((n)-[:hasAttribute]->(a:Attribute)) AND EXISTS((n)-[ha:hasAttribute]->(a2:Attribute) WHERE ha.type CONTAINS $attrType)'
                params['attrType'] = attribute_type
            
            # 关系类型筛选
            if relation_type and relation_type.strip():
                cypher += ' AND (EXISTS((n)-[r:hasRelation]->() WHERE r.type = $relType) OR EXISTS(()-[r:hasRelation]->(n) WHERE r.type = $relType))'
                params['relType'] = relation_type
            
            # 来源筛选
            if document_source and document_source.strip():
                cypher += ' AND n.source = $source'
                params['source'] = document_source
            
            # 地理位置筛选（通过entity_ids或ID）
            if location and len(location) > 0 and location[-1] and location[-1].strip():
                cypher += ' AND (n.id CONTAINS $location OR ANY(eid IN n.entity_ids WHERE eid CONTAINS $location))'
                params['location'] = location[-1]
            
            # 时间范围筛选（使用start_time和end_time）
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
            
            # 返回状态节点及其属性（关键：一并查询属性）
            cypher += '''
            WITH n
            OPTIONAL MATCH (n)-[ha:hasAttribute]->(attr:Attribute)
            WITH n, 
                 collect(DISTINCT {type: ha.type, value: attr.value}) AS attributes
            RETURN n.id AS id, 
                   n.state_type AS state_type, 
                   n.time AS time, 
                   n.start_time AS start_time,
                   n.end_time AS end_time,
                   n.source AS source, 
                   n.entity_ids AS entity_ids, 
                   properties(n) AS properties,
                   attributes
            ORDER BY n.start_time DESC
            LIMIT 100
            '''
            
            result = session.run(cypher, params)
            for record in result:
                # 过滤掉空属性
                attributes = [attr for attr in record['attributes'] if attr.get('type') and attr.get('value')]
                
                # 构建状态类型显示名称
                state_type_map = {
                    'event': '事件状态',
                    'location': '地点状态',
                    'facility': '设施状态',
                    'joint': '联合状态'
                }
                state_type_display = state_type_map.get(record['state_type'], record['state_type'] or '状态')
                
                entity = {
                    'id': record['id'],
                    'name': state_type_display,
                    'category': record['time'] or '',
                    'state_type': record['state_type'],
                    'time': record['time'],
                    'start_time': convert_neo4j_types(record['start_time']),
                    'end_time': convert_neo4j_types(record['end_time']),
                    'source': record['source'],
                    'entity_ids': record['entity_ids'] or [],
                    'attributes': attributes,  # 属性列表
                    'properties': convert_neo4j_types(record['properties'])
                }
                entities.append(entity)
        
        logger.info(f'搜索完成: 查询模式={query_mode}, 返回{len(entities)}条结果')
        return jsonify(entities)
        
    except Exception as e:
        logger.error(f'搜索实体失败: {e}')
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'message': f'搜索实体失败: {str(e)}'}), 500
    finally:
        if session:
            session.close()

@search_bp.route('/relations/<entity_id>', methods=['GET'])
def get_entity_relations(entity_id):
    """获取实体关系"""
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
                rel_props = convert_neo4j_types(dict(rel))
                relationships.append({
                    'id': rel.id,
                    'type': rel_props.get('type', rel.type),  # 优先使用关系属性中的type
                    'source': str(rel.start_node.id),
                    'target': str(rel.end_node.id),
                    'properties': rel_props
                })
        
        return jsonify({
            'nodes': list(nodes.values()),
            'relationships': relationships
        })
        
    except Exception as e:
        logger.error(f'获取实体关系失败: {e}')
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'message': f'获取实体关系失败: {str(e)}'}), 500
    finally:
        if session:
            session.close()

@search_bp.route('/export', methods=['POST'])
def export_search_results():
    """导出搜索结果"""
    try:
        data = request.get_json()
        results = data.get('results', [])
        
        # 这里应该实现导出逻辑，例如生成CSV或Excel文件
        # 模拟返回数据
        return jsonify({
            'success': True,
            'fileUrl': '/downloads/export_123456.xlsx'
        })
        
    except Exception as e:
        logger.error(f'导出搜索结果失败: {e}')
        return jsonify({'success': False, 'message': '导出搜索结果失败'}), 500

@search_bp.route('/location-options', methods=['GET'])
def get_location_options():
    """获取地理位置选项"""
    try:
        # 这里应该从Neo4j数据库获取所有地理位置实体
        # 模拟返回数据
        locations = [
            {'id': 'l001', 'name': '广西壮族自治区'},
            {'id': 'l002', 'name': '南宁市'},
            {'id': 'l003', 'name': '柳州市'},
            {'id': 'l004', 'name': '桂林市'},
            {'id': 'l005', 'name': '梧州市'}
        ]
        
        return jsonify(locations)
        
    except Exception as e:
        logger.error(f'获取地理位置选项失败: {e}')
        return jsonify({'success': False, 'message': '获取地理位置选项失败'}), 500

@search_bp.route('/document-sources', methods=['GET'])
def get_document_sources():
    """获取文档来源列表"""
    session = None
    try:
        session = get_session()
        
        # neo4j数据库查询语句，neo4j中的节点都包含了source属性，统计所有节点中source属性
        result = session.run(
            """MATCH (n)
               WHERE n.source IS NOT NULL
               RETURN DISTINCT n.source AS name"""
        )
        
        # 先对 result.records 进行排序
        records = list(result)
        records.sort(key=lambda record: record['name'].lower())
        
        sources = [record['name'] for record in records]
        
        return jsonify(sources)
        
    except Exception as e:
        logger.error(f'获取文档来源列表失败: {e}')
        return jsonify({'success': False, 'message': '获取文档来源列表失败'}), 500
    finally:
        if session:
            session.close()


@search_bp.route('/debug/node-stats', methods=['GET'])
def debug_node_stats():
    """调试接口：查看数据库中的节点统计"""
    session = None
    try:
        session = get_session()
        
        stats = {}
        
        # 检查所有标签
        result = session.run("CALL db.labels() YIELD label RETURN label ORDER BY label")
        stats['all_labels'] = [record['label'] for record in result]
        
        # 检查各类节点数量
        queries = {
            'entity标签节点': 'MATCH (n:entity) RETURN count(n) AS count',
            '地点节点': 'MATCH (n:地点) RETURN count(n) AS count',
            '地点:entity节点': 'MATCH (n:地点:entity) RETURN count(n) AS count',
            '设施节点': 'MATCH (n:设施) RETURN count(n) AS count',
            '设施:entity节点': 'MATCH (n:设施:entity) RETURN count(n) AS count',
            '事件节点': 'MATCH (n:事件) RETURN count(n) AS count',
            '事件:entity节点': 'MATCH (n:事件:entity) RETURN count(n) AS count',
            'State节点': 'MATCH (n:State) RETURN count(n) AS count',
            'Attribute节点': 'MATCH (n:Attribute) RETURN count(n) AS count',
        }
        
        for name, query in queries.items():
            result = session.run(query)
            stats[name] = result.single()['count']
        
        # 获取样例节点
        samples = {}
        
        # 地点样例
        result = session.run("MATCH (n:地点) RETURN n.id, n.name, labels(n) LIMIT 3")
        samples['地点样例'] = [{'id': r['n.id'], 'name': r['n.name'], 'labels': r['labels(n)']} for r in result]
        
        # 设施样例
        result = session.run("MATCH (n:设施) RETURN n.id, n.name, labels(n) LIMIT 3")
        samples['设施样例'] = [{'id': r['n.id'], 'name': r['n.name'], 'labels': r['labels(n)']} for r in result]
        
        # 事件样例
        result = session.run("MATCH (n:事件) RETURN n.id, n.name, labels(n) LIMIT 3")
        samples['事件样例'] = [{'id': r['n.id'], 'name': r['n.name'], 'labels': r['labels(n)']} for r in result]
        
        # State样例
        result = session.run("MATCH (n:State) RETURN n.id, n.state_type, labels(n) LIMIT 3")
        samples['State样例'] = [{'id': r['n.id'], 'state_type': r['n.state_type'], 'labels': r['labels(n)']} for r in result]
        
        return jsonify({
            'success': True,
            'stats': stats,
            'samples': samples
        })
        
    except Exception as e:
        logger.error(f'获取节点统计失败: {e}')
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)}), 500
    finally:
        if session:
            session.close()