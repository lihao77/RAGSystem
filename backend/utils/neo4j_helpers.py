# -*- coding: utf-8 -*-
"""
Neo4j工具函数 - 类型转换、数据处理
"""

import json
import logging
from datetime import datetime, date, time

logger = logging.getLogger(__name__)


def convert_neo4j_types(obj):
    """将Neo4j特殊类型转换为JSON可序列化的类型"""
    if obj is None:
        return None
    
    type_name = type(obj).__name__
    
    # 处理Neo4j时间类型
    if type_name in ('DateTime', 'Date', 'Time'):
        return obj.isoformat() if hasattr(obj, 'isoformat') else str(obj)
    
    elif type_name == 'Duration':
        return str(obj)
    
    # 处理Python内置日期时间类型
    elif isinstance(obj, (datetime, date, time)):
        return obj.isoformat()
    
    # 处理字典
    elif isinstance(obj, dict):
        return {k: convert_neo4j_types(v) for k, v in obj.items()}
    
    # 处理列表
    elif isinstance(obj, list):
        return [convert_neo4j_types(item) for item in obj]
    
    # 处理元组
    elif isinstance(obj, tuple):
        return [convert_neo4j_types(item) for item in obj]
    
    # 处理集合
    elif isinstance(obj, set):
        return [convert_neo4j_types(item) for item in obj]
    
    else:
        try:
            json.dumps(obj)
            return obj
        except (TypeError, ValueError):
            return str(obj)


def parse_neo4j_record(record):
    """解析Neo4j记录，提取节点和关系"""
    record_dict = {}
    nodes_dict = {}
    relationships = []
    
    for key in record.keys():
        value = record[key]
        
        # 处理路径类型
        if hasattr(value, 'nodes') and hasattr(value, 'relationships'):
            path_data = _parse_path(value, nodes_dict, relationships)
            record_dict[key] = path_data
        
        # 处理Neo4j节点
        elif hasattr(value, 'labels'):
            node_data = _parse_node(value)
            record_dict[key] = node_data
            node_id = str(value.id)
            if node_id not in nodes_dict:
                nodes_dict[node_id] = node_data
        
        # 处理Neo4j关系
        elif hasattr(value, 'type') and hasattr(value, 'start_node') and hasattr(value, 'end_node'):
            rel_data = _parse_relationship(value, nodes_dict)
            record_dict[key] = rel_data
            relationships.append(rel_data)
        
        # 处理列表
        elif isinstance(value, list):
            parsed_list = []
            for item in value:
                if hasattr(item, 'labels'):
                    node_data = _parse_node(item)
                    parsed_list.append(node_data)
                    node_id = str(item.id)
                    if node_id not in nodes_dict:
                        nodes_dict[node_id] = node_data
                else:
                    parsed_list.append(convert_neo4j_types(item))
            record_dict[key] = parsed_list
        
        else:
            record_dict[key] = convert_neo4j_types(value)
    
    return record_dict, nodes_dict, relationships


def _parse_node(node):
    """解析Neo4j节点"""
    return {
        'id': node.id,
        'labels': list(node.labels),
        'properties': convert_neo4j_types(dict(node))
    }


def _parse_relationship(rel, nodes_dict):
    """解析Neo4j关系"""
    start_id = str(rel.start_node.id)
    end_id = str(rel.end_node.id)
    
    # 确保起点和终点节点被收集
    if start_id not in nodes_dict:
        nodes_dict[start_id] = _parse_node(rel.start_node)
    
    if end_id not in nodes_dict:
        nodes_dict[end_id] = _parse_node(rel.end_node)
    
    return {
        'id': rel.id,
        'type': rel.type,
        'source': start_id,
        'target': end_id,
        'properties': convert_neo4j_types(dict(rel))
    }


def _parse_path(path, nodes_dict, relationships):
    """解析Neo4j路径"""
    path_nodes = []
    path_rels = []
    
    for node in path.nodes:
        node_id = str(node.id)
        node_data = _parse_node(node)
        if node_id not in nodes_dict:
            nodes_dict[node_id] = node_data
        path_nodes.append(node_data)
    
    for rel in path.relationships:
        rel_data = {
            'id': rel.id,
            'type': rel.type,
            'source': str(rel.start_node.id),
            'target': str(rel.end_node.id),
            'properties': convert_neo4j_types(dict(rel))
        }
        relationships.append(rel_data)
        path_rels.append(rel_data)
    
    return {
        'nodes': path_nodes,
        'relationships': path_rels
    }
