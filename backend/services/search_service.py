# -*- coding: utf-8 -*-
"""
搜索服务 - 实体和状态搜索业务逻辑
"""

import logging
from runtime.dependencies import get_runtime_dependency
from datetime import datetime
from db import get_session
from utils.neo4j_helpers import convert_neo4j_types

logger = logging.getLogger(__name__)


class SearchService:
    """搜索服务类"""
    
    def search_entities(self, search_params):
        """
        搜索实体和状态节点
        
        Args:
            search_params: dict，包含以下字段：
                - queryMode: 'entity' 或 'state'
                - keyword: 关键词
                - category: 类别（地点/设施/事件）
                - stateType: 状态类型
                - attributeType: 属性类型
                - relationType: 关系类型
                - documentSource: 文档来源
                - timeRange: 时间范围 [start, end]
                - location: 地理位置 [province, city, district]
                - advancedQuery: 高级查询语句
                
        Returns:
            list: 搜索结果列表
        """
        session = None
        try:
            session = get_session()
            
            # 提取参数
            query_mode = search_params.get('queryMode', 'state')
            keyword = search_params.get('keyword', '') or ''
            category = search_params.get('category', '') or ''
            state_type = search_params.get('stateType', '') or ''
            attribute_type = search_params.get('attributeType', '') or ''
            relation_type = search_params.get('relationType', '') or ''
            document_source = search_params.get('documentSource', '') or ''
            time_range = search_params.get('timeRange') or []
            location = search_params.get('location') or []
            advanced_query = search_params.get('advancedQuery', '') or ''
            
            # 格式化时间范围
            time_range_formatted = self._format_time_range(time_range)
            
            params = {}
            entities = []
            
            if query_mode == 'entity':
                entities = self._search_base_entities(
                    session, keyword, category, document_source, 
                    location, advanced_query, params
                )
            else:
                entities = self._search_state_nodes(
                    session, keyword, state_type, attribute_type, 
                    relation_type, document_source, location, 
                    time_range_formatted, advanced_query, params
                )
            
            logger.info(f'搜索完成: 查询模式={query_mode}, 返回{len(entities)}条结果')
            return entities
            
        except Exception as e:
            logger.error(f'搜索实体失败: {e}')
            raise
        finally:
            if session:
                session.close()
    
    def _format_time_range(self, time_range):
        """格式化时间范围"""
        def format_date(date_str):
            date = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
            return date.strftime('%Y-%m-%d')
        
        time_range_new = {'start': '', 'end': ''}
        if time_range and len(time_range) == 2:
            time_range_new['start'] = format_date(time_range[0])
            time_range_new['end'] = format_date(time_range[1])
        
        return time_range_new
    
    def _search_base_entities(self, session, keyword, category, document_source, 
                             location, advanced_query, params):
        """搜索基础实体节点（地点/设施/事件）"""
        # 构建查询
        if category and category in ['地点', '设施', '事件']:
            cypher = f'MATCH (n:{category}) WHERE 1=1'
        else:
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
        entities = []
        
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
        return entities
    
    def _search_state_nodes(self, session, keyword, state_type, attribute_type, 
                           relation_type, document_source, location, 
                           time_range, advanced_query, params):
        """搜索状态节点（包含属性）"""
        cypher = 'MATCH (n:State) WHERE 1=1'
        
        # 状态类型筛选
        if state_type and state_type.strip():
            cypher += ' AND n.state_type = $stateType'
            params['stateType'] = state_type
        
        # 关键词匹配
        if keyword and keyword.strip():
            cypher += ' AND n.id CONTAINS $keyword'
            params['keyword'] = keyword
        
        # 属性筛选
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
        
        # 地理位置筛选
        if location and len(location) > 0 and location[-1] and location[-1].strip():
            cypher += ' AND (n.id CONTAINS $location OR ANY(eid IN n.entity_ids WHERE eid CONTAINS $location))'
            params['location'] = location[-1]
        
        # 时间范围筛选
        if time_range['start'] and time_range['end']:
            cypher += ''' AND (
                (n.start_time >= date($startTime) AND n.start_time <= date($endTime))
                OR (n.end_time >= date($startTime) AND n.end_time <= date($endTime))
                OR (n.start_time <= date($startTime) AND n.end_time >= date($endTime))
            )'''
            params['startTime'] = time_range['start']
            params['endTime'] = time_range['end']
        
        # 高级查询
        if advanced_query and advanced_query.strip():
            cypher += f' AND ({advanced_query})'
        
        # 返回状态节点及其属性
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
        entities = []
        
        # 状态类型映射
        state_type_map = {
            'event': '事件状态',
            'location': '地点状态',
            'facility': '设施状态',
            'joint': '联合状态'
        }
        
        for record in result:
            # 过滤掉空属性
            attributes = [attr for attr in record['attributes'] if attr.get('type') and attr.get('value')]
            
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
                'attributes': attributes,
                'properties': convert_neo4j_types(record['properties'])
            }
            entities.append(entity)
        
        return entities
    
    def search_relations(self, entity_id):
        """
        搜索实体的关系
        
        Args:
            entity_id: 实体ID
            
        Returns:
            dict: {
                'nodes': [...],          # 节点列表
                'relationships': [...]   # 关系列表
            }
        """
        session = None
        try:
            session = get_session()
            
            # 查询实体的所有关系（与原始版本保持一致）
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
            
            return {
                'nodes': list(nodes.values()),
                'relationships': relationships
            }
            
        except Exception as e:
            logger.error(f'搜索关系失败: {e}')
            raise
        finally:
            if session:
                session.close()
    
    def export_search_results(self, entity_ids, export_format='json'):
        """
        导出搜索结果
        
        Args:
            entity_ids: 实体ID列表
            export_format: 导出格式 ('json' 或 'csv')
            
        Returns:
            str: 导出的文件路径
        """
        session = None
        try:
            session = get_session()
            
            # 根据ID列表查询实体详情
            query = """
            MATCH (n)
            WHERE n.id IN $entityIds
            RETURN n.id AS id, n.name AS name, labels(n) AS labels, properties(n) AS properties
            """
            
            result = session.run(query, {'entityIds': entity_ids})
            entities = []
            
            for record in result:
                entities.append({
                    'id': record['id'],
                    'name': record['name'],
                    'labels': record['labels'],
                    'properties': convert_neo4j_types(record['properties'])
                })
            
            # 生成导出文件（这里简化处理，实际应该生成文件）
            import json
            import os
            
            export_dir = 'exports'
            os.makedirs(export_dir, exist_ok=True)
            
            filename = f'search_results_{datetime.now().strftime("%Y%m%d_%H%M%S")}.{export_format}'
            filepath = os.path.join(export_dir, filename)
            
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(entities, f, ensure_ascii=False, indent=2)
            
            logger.info(f'导出成功: {filepath}')
            return filepath
            
        except Exception as e:
            logger.error(f'导出失败: {e}')
            raise
        finally:
            if session:
                session.close()
    
    def get_location_options(self):
        """
        获取地理位置选项（级联）
        
        Returns:
            list: 地理位置树形结构
        """
        # 这里返回固定的选项，也可以从数据库动态查询
        return [
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
    
    def get_document_sources(self):
        """
        获取文档来源列表
        
        Returns:
            list: 文档来源列表
        """
        return [
            '2016年广西水旱灾害公报',
            '2017年广西水旱灾害公报',
            '2018年广西水旱灾害公报',
            '2019年广西水旱灾害公报',
            '2020年广西水旱灾害公报',
            '2021年广西水旱灾害公报',
            '2022年广西水旱灾害公报',
            '2023年广西水旱灾害公报'
        ]
    
    def get_node_stats(self):
        """
        获取节点统计信息
        
        Returns:
            dict: 节点统计数据
        """
        session = None
        try:
            session = get_session()
            
            # 统计各类型节点数量
            query = """
            MATCH (n)
            WITH labels(n) AS nodeLabels
            UNWIND nodeLabels AS label
            RETURN label, count(*) AS count
            ORDER BY count DESC
            """
            
            result = session.run(query)
            stats = {}
            
            for record in result:
                stats[record['label']] = record['count']
            
            return stats
            
        except Exception as e:
            logger.error(f'获取节点统计失败: {e}')
            raise
        finally:
            if session:
                session.close()


# 全局单例
_search_service = None


def get_search_service():
    """获取搜索服务单例"""
    global _search_service
    return get_runtime_dependency(
        container_getter='get_search_service',
        fallback_name='search_service',
        fallback_factory=SearchService,
        require_container=True,
        legacy_getter=lambda: _search_service,
        legacy_setter=lambda instance: globals().__setitem__('_search_service', instance),
    )
