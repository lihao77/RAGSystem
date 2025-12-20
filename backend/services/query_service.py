# -*- coding: utf-8 -*-
"""
查询服务 - Cypher查询执行和结果处理
"""

import logging
from db import neo4j_conn
from utils.neo4j_helpers import parse_neo4j_record

logger = logging.getLogger(__name__)


class QueryService:
    """查询服务类"""
    
    def __init__(self):
        pass
    
    def execute_cypher(self, cypher):
        """
        执行Cypher查询
        
        Args:
            cypher: Cypher查询语句
            
        Returns:
            dict: {
                'records': 查询记录列表,
                'graph': {
                    'nodes': 节点列表,
                    'relationships': 关系列表
                }
            }
        """
        try:
            with neo4j_conn.get_session() as session:
                result = session.run(cypher)
                
                records = []
                nodes_dict = {}
                relationships = []
                node_attributes = {}
                
                for record in result:
                    record_dict, record_nodes, record_rels = parse_neo4j_record(record)
                    records.append(record_dict)
                    nodes_dict.update(record_nodes)
                    relationships.extend(record_rels)
                    
                    # 提取节点属性信息
                    self._extract_node_attributes(record_dict, node_attributes)
                
                # 为节点附加属性信息
                for node_id, attrs in node_attributes.items():
                    if node_id in nodes_dict:
                        nodes_dict[node_id]['attributes'] = attrs
                
                # 整合自定义nodes和relationships字段
                self._integrate_custom_graph_data(records, nodes_dict, relationships)
                
                return {
                    'records': records,
                    'graph': {
                        'nodes': list(nodes_dict.values()),
                        'relationships': relationships
                    }
                }
        except Exception as e:
            logger.error(f'执行Cypher查询失败: {e}')
            raise
    
    def get_graph_schema(self):
        """
        获取图谱结构信息
        
        Returns:
            dict: {
                'labels': 节点标签列表,
                'relationships': 关系类型列表,
                'node_properties': 节点属性示例,
                'relationship_patterns': 关系模式列表
            }
        """
        try:
            with neo4j_conn.get_session() as session:
                # 获取所有节点标签
                labels_result = session.run("""
                    CALL db.labels() YIELD label
                    RETURN collect(label) as labels
                """)
                labels = labels_result.single()['labels']
                
                # 获取所有关系类型
                relationships_result = session.run("""
                    CALL db.relationshipTypes() YIELD relationshipType
                    RETURN collect(relationshipType) as relationships
                """)
                relationships = relationships_result.single()['relationships']
                
                # 获取节点属性示例（前5个标签）
                node_properties = {}
                for label in labels[:5]:
                    props_result = session.run(f"""
                        MATCH (n:`{label}`)
                        WITH n LIMIT 1
                        RETURN keys(n) as properties
                    """)
                    record = props_result.single()
                    if record:
                        node_properties[label] = record['properties']
                
                # 获取关系模式
                relationship_patterns = []
                pattern_result = session.run("""
                    MATCH (a)-[r]->(b)
                    WITH labels(a)[0] as from_label, type(r) as rel_type, labels(b)[0] as to_label
                    RETURN DISTINCT from_label, rel_type, to_label
                    LIMIT 20
                """)
                for record in pattern_result:
                    relationship_patterns.append({
                        'from': record['from_label'],
                        'relationship': record['rel_type'],
                        'to': record['to_label']
                    })
                
                return {
                    'labels': labels,
                    'relationships': relationships,
                    'node_properties': node_properties,
                    'relationship_patterns': relationship_patterns
                }
        except Exception as e:
            logger.error(f'获取图谱结构失败: {e}')
            return None
    
    def _extract_node_attributes(self, record_dict, node_attributes):
        """从记录中提取节点属性信息"""
        for key, value in record_dict.items():
            if isinstance(value, list):
                for item in value:
                    if isinstance(item, dict) and 'id' in item and 'attributes' in item:
                        node_id = str(item['id'])
                        if node_id not in node_attributes:
                            node_attributes[node_id] = []
                        node_attributes[node_id] = item['attributes']
    
    def _integrate_custom_graph_data(self, records, nodes_dict, relationships):
        """整合查询返回的自定义nodes和relationships字段"""
        for record in records:
            # 整合自定义nodes字段
            if 'nodes' in record and isinstance(record['nodes'], list):
                for node_info in record['nodes']:
                    if isinstance(node_info, dict) and 'id' in node_info:
                        node_id = str(node_info['id'])
                        
                        if node_id in nodes_dict and 'attributes' in node_info:
                            nodes_dict[node_id]['attributes'] = node_info.get('attributes', [])
                        elif node_id not in nodes_dict:
                            nodes_dict[node_id] = {
                                'id': node_info['id'],
                                'labels': node_info.get('label', node_info.get('labels', [])),
                                'properties': node_info.get('props', {}),
                                'attributes': node_info.get('attributes', [])
                            }
            
            # 整合自定义relationships字段
            if 'relationships' in record and isinstance(record['relationships'], list):
                for rel_info in record['relationships']:
                    if isinstance(rel_info, dict) and 'start' in rel_info and 'end' in rel_info:
                        rel_exists = any(
                            r['source'] == str(rel_info['start']) and 
                            r['target'] == str(rel_info['end']) and 
                            r['type'] == rel_info.get('type')
                            for r in relationships
                        )
                        if not rel_exists:
                            relationships.append({
                                'id': rel_info.get('id', f"{rel_info['start']}_{rel_info['end']}"),
                                'type': rel_info.get('type', 'RELATED'),
                                'source': str(rel_info['start']),
                                'target': str(rel_info['end']),
                                'properties': rel_info.get('props', {})
                            })


# 全局单例
_query_service = None


def get_query_service():
    """获取查询服务单例"""
    global _query_service
    if _query_service is None:
        _query_service = QueryService()
    return _query_service
