# -*- coding: utf-8 -*-
"""
可视化服务 - 图谱可视化数据处理
"""

import logging
from runtime.dependencies import get_runtime_dependency
from db import get_session
from utils.geo_helpers import add_coordinates_to_entity

logger = logging.getLogger(__name__)


class VisualizationService:
    """可视化服务类"""
    
    def __init__(self):
        pass
    
    def get_base_entities(self):
        """
        获取所有基础实体（地点和设施）
        
        Returns:
            list: 实体列表
        """
        session = None
        try:
            session = get_session()
            
            query = """
            MATCH (n)
            WHERE (n:地点 OR n:设施) 
            RETURN 
                n.id as id,
                n.name as name,
                labels(n)[-1] as type,
                n.geometry as geo
            ORDER BY n.name
            """
            
            result = session.run(query)
            
            entities = []
            for record in result:
                entity = {
                    'id': record['id'],
                    'type': record['type']
                }
                
                if record['name']:
                    entity['name'] = record['name']
                
                geo_value = record['geo']
                if geo_value:
                    entity['geo'] = geo_value
                    add_coordinates_to_entity(entity, geo_value)
                
                entities.append(entity)
            
            return entities
            
        except Exception as e:
            logger.error(f'获取基础实体失败: {e}')
            raise
        finally:
            if session:
                session.close()
    
    def get_entity_relationships(self):
        """
        获取地点和设施实体及其关系
        
        Returns:
            dict: {'entities': [...], 'relationships': [...]}
        """
        session = None
        try:
            session = get_session()
            
            # 查询实体
            entities_query = """
            MATCH (n)
            WHERE n:地点 OR n:设施
            RETURN 
                n.id as id,
                n.name as name,
                labels(n)[-1] as type,
                n.geometry as geo
            """
            
            entities_result = session.run(entities_query)
            entities = []
            for record in entities_result:
                entity = {
                    'id': record['id'],
                    'type': record['type']
                }
                
                if record['name']:
                    entity['name'] = record['name']
                
                geo_value = record['geo']
                if geo_value:
                    entity['geo'] = geo_value
                    add_coordinates_to_entity(entity, geo_value)
                
                entities.append(entity)
            
            # 查询关系
            relationships_query = """
            MATCH (a)-[r]->(b)
            WHERE (a:地点 OR a:设施) AND (b:地点 OR b:设施)
            RETURN 
                a.id as source,
                b.id as target,
                type(r) as type
            """
            
            relationships_result = session.run(relationships_query)
            relationships = []
            for record in relationships_result:
                relationship = {
                    'source': record['source'],
                    'target': record['target'],
                    'type': record['type']
                }
                relationships.append(relationship)
            
            return {
                'entities': entities,
                'relationships': relationships
            }
            
        except Exception as e:
            logger.error(f'获取实体关系失败: {e}')
            raise
        finally:
            if session:
                session.close()
    
    def get_entity_states(self, entity_id):
        """
        获取实体的状态链
        
        Args:
            entity_id: 实体ID
            
        Returns:
            dict: {'states': [...], 'rootStates': [...]}
        """
        session = None
        try:
            session = get_session()
            
            query = """
            MATCH (e)-[:hasState]->(first_state:State)
            WHERE e.id = $entityId
            
            CALL apoc.path.expandConfig(first_state, {
                relationshipFilter: "nextState>|contain>",
                minLevel: 0
            }) YIELD path
            
            WHERE ALL(r IN relationships(path) WHERE $entityId IN r.entity) 
            AND ALL(n IN nodes(path) WHERE n:State AND $entityId IN n.entity_ids)
            
            WITH COLLECT(DISTINCT nodes(path)[-1]) AS all_states
            
            UNWIND all_states AS state
            WITH state
            WHERE state IS NOT NULL
            
            OPTIONAL MATCH (state)-[next_rel:nextState]->(next_state)
            WHERE $entityId IN next_rel.entity
            
            OPTIONAL MATCH (state)-[contain_rel:contain]->(child_state)
            WHERE $entityId IN contain_rel.entity
            
            RETURN DISTINCT 
                state.id AS id, 
                state.type AS type, 
                state.time AS time, 
                state.geo AS geo, 
                state.entity_ids AS entityIds,
                COLLECT(DISTINCT next_state.id) AS nextStateIds,
                COLLECT(DISTINCT child_state.id) AS childStateIds
            ORDER BY state.time
            """
            
            result = session.run(query, {'entityId': entity_id})
            
            states_map = {}
            
            for record in result:
                state_id = record['id']
                if not state_id:
                    continue
                
                next_state_ids = [id for id in record['nextStateIds'] if id]
                child_state_ids = [id for id in record['childStateIds'] if id]
                
                geo_value = record['geo']
                
                state = {
                    'id': state_id,
                    'type': record['type'],
                    'time': record['time'],
                    'geo': geo_value,
                    'entityIds': record['entityIds'],
                    'nextStateIds': next_state_ids,
                    'childStateIds': child_state_ids,
                    'children': [],
                    'next': []
                }
                
                if geo_value:
                    from utils.geo_helpers import add_coordinates_to_entity
                    add_coordinates_to_entity(state, geo_value)
                
                states_map[state_id] = state
            
            # 构建树形结构关系
            for state in states_map.values():
                for child_id in state['childStateIds']:
                    if child_id in states_map:
                        state['children'].append(states_map[child_id])
                
                for next_id in state['nextStateIds']:
                    if next_id in states_map:
                        state['next'].append(states_map[next_id])
            
            # 找到根状态
            root_states = []
            for state in states_map.values():
                is_root = True
                for s in states_map.values():
                    if state['id'] in s['childStateIds'] or state['id'] in s['nextStateIds']:
                        is_root = False
                        break
                if is_root:
                    root_states.append(state)
            
            # 按时间排序
            def time_key(state):
                if not state.get('time'):
                    return float('inf')
                try:
                    from datetime import datetime
                    return datetime.fromisoformat(state['time'].replace('Z', '+00:00'))
                except:
                    return float('inf')
            
            sorted_root_states = sorted(root_states, key=time_key)
            
            return {
                'states': list(states_map.values()),
                'rootStates': sorted_root_states
            }
            
        except Exception as e:
            logger.error(f'获取实体状态失败: {e}')
            raise
        finally:
            if session:
                session.close()
    
    def get_entity_events(self, entity_id):
        """
        获取与实体相关的事件
        
        Args:
            entity_id: 实体ID
            
        Returns:
            list: 事件列表
        """
        session = None
        try:
            session = get_session()
            
            # 查询与实体相关的事件
            query = """
            MATCH (e)<-[:occurredAt]-(event:事件)
            WHERE e.id = $entityId
            RETURN DISTINCT event.id AS id, event.name AS name
            """
            
            result = session.run(query, {'entityId': entity_id})
            
            events = []
            for record in result:
                event = {
                    'id': record['id'],
                    'name': record['name'],
                    'type': '事件'
                }
                
                events.append(event)
            
            return events
            
        except Exception as e:
            logger.error(f'获取实体事件失败: {e}')
            raise
        finally:
            if session:
                session.close()
    
    def get_event_locations(self, event_id):
        """
        获取事件发生的地点
        
        Args:
            event_id: 事件ID
            
        Returns:
            dict: {'entities': [...], 'relationships': [...]}
        """
        session = None
        try:
            session = get_session()
            
            # 查询与事件相连的所有实体（基础实体和状态实体）
            query = """
            MATCH (e:事件 {id: $eventId})-[r:occurredAt]->(loc)
            WHERE loc:地点 OR loc:设施
            RETURN loc.id AS id, loc.name AS name, labels(loc)[-1] AS type,
                loc.geometry AS geo,
                e.id AS source, loc.id AS target, type(r) AS rtype, r.entity AS entities
            """
            
            result = session.run(query, {'eventId': event_id})
            
            entities = []
            relationships = []
            
            for record in result:
                entity = {
                    'id': record['id'],
                    'type': record['type']
                }
                
                # 添加不同类型实体的特定属性
                if record['name']:
                    entity['name'] = record['name']
                if record['geo']:
                    entity['geo'] = record['geo']
                    add_coordinates_to_entity(entity, record['geo'])
                
                entities.append(entity)
                
                relationships.append({
                    'source': record['source'],
                    'target': record['target'],
                    'type': record['rtype'],
                    'entities': record['entities']
                })
        
            return {
                'entities': entities,
                'relationships': relationships
            }
            
        except Exception as e:
            logger.error(f'获取事件地点失败: {e}')
            raise
        finally:
            if session:
                session.close()
    
    def get_entity_facilities(self, entity_id):
        """
        获取地点下的设施
        
        Args:
            entity_id: 地点实体ID
            
        Returns:
            list: 设施列表
        """
        session = None
        try:
            session = get_session()
            
            # 查询与实体相关的设施
            query = """
            MATCH (e)-[:locatedIn]-(facility:设施)
            WHERE e.id = $entityId
            RETURN DISTINCT facility.id AS id, facility.name AS name, facility.type AS type,
            facility.geometry AS geo
            """
            
            result = session.run(query, {'entityId': entity_id})
            
            facilities = []
            for record in result:
                facility = {
                    'id': record['id'],
                    'name': record['name'],
                    'type': '设施'
                }
                
                if record['geo']:
                    facility['geo'] = record['geo']
                    add_coordinates_to_entity(facility, record['geo'])
                
                facilities.append(facility)
            
            return facilities
            
        except Exception as e:
            logger.error(f'获取实体设施失败: {e}')
            raise
        finally:
            if session:
                session.close()
    
    def get_state_relationships(self):
        """
        获取状态节点之间的关系
        
        Returns:
            list: 关系列表（直接返回数组，不是对象）
        """
        session = None
        try:
            session = get_session()
            
            query = """
            MATCH (s1:State)-[r:nextState|contain]->(s2:State)
            RETURN s1.id AS source, s2.id AS target, type(r) AS type, r.entity AS entities
            """
            
            result = session.run(query)
            
            relationships = []
            for record in result:
                relationship = {
                    'source': record['source'],
                    'target': record['target'],
                    'type': record['type'],
                    'entities': record['entities']
                }
                relationships.append(relationship)
            
            
            return relationships
            
        except Exception as e:
            logger.error(f'获取状态关系失败: {e}')
            raise
        finally:
            if session:
                session.close()
    
    def get_knowledge_graph(self, limit=100):
        session = None
        try:
            session = get_session()
            
            # 优化：使用WITH和集合操作，性能更好
            query = """
            // 获取限定数量的实体
            MATCH (n)
            WHERE n:地点 OR n:设施 OR n:事件 OR n:State
            WITH n LIMIT $limit
            
            // 收集实体ID用于关系过滤
            WITH collect(n.id) AS entityIds, collect(n) AS nodes
            
            // 查询实体信息
            UNWIND nodes AS n
            WITH entityIds, {
                id: n.id,
                name: n.name,
                type: labels(n)[-1],
                time: n.time,
                geo: n.geometry,
                value: n.value,
                entityIds: n.entity_ids,
                Sname: n.type
            } AS entity
            
            WITH collect(entity) AS entities, entityIds
            
            // 批量查询关系（只查询实体集合内的关系）
            MATCH (n1)-[r]->(n2)
            WHERE n1.id IN entityIds AND n2.id IN entityIds
            
            RETURN entities,
                collect({
                    source: n1.id,
                    target: n2.id,
                    type: type(r),
                    entities: r.entity,
                    name: r.type
                }) AS relationships
            """
            
            result = session.run(query, limit=limit)
            record = result.single()
            
            if not record:
                return {'entities': [], 'relationships': []}
            
            # 处理实体
            entities = []
            for entity_data in record['entities']:
                entity = {'type': entity_data['type']}
                
                # 添加非空字段
                for key in ['id', 'value', 'name', 'time', 'geo', 'entityIds']:
                    if entity_data[key] is not None:
                        entity[key] = entity_data[key]
                
                # State类型特殊处理
                if entity_data['type'] == 'State' and entity_data['Sname']:
                    entity['name'] = entity_data['Sname']
                
                # 处理地理坐标
                if entity.get('geo'):
                    add_coordinates_to_entity(entity, entity['geo'])
                
                entities.append(entity)
            
            return {
                'entities': entities,
                'relationships': record['relationships']
            }
                
        except Exception as e:
            logger.error(f'获取知识图谱失败: {e}')
            raise
    
    def get_knowledge_graph1(self, limit=100):
        session = None
        try:
            session = get_session()
            
            # 查询所有实体（基础实体和状态实体）
            entities_query = """
            MATCH (n)
            WHERE n:地点 OR n:设施 OR n:State OR n:事件 OR n:Attribute
            RETURN n.id AS id, n.name AS name, labels(n)[-1] AS type,
            n.time AS time, n.geometry AS geo, n.value AS value, 
                n.entity_ids AS entityIds, n.type AS Sname
            """
            
            entities_result = session.run(entities_query)
            entities = []
            for record in entities_result:
                entity = {
                    'type': record['type']
                }
                
                if record['id']:
                    entity['id'] = record['id']
                if record['value']:
                    entity['value'] = record['value']
                if record['name']:
                    entity['name'] = record['name']
                if record['time']:
                    entity['time'] = record['time']
                if record['geo']:
                    entity['geo'] = record['geo']
                    add_coordinates_to_entity(entity, record['geo'])
                if record['entityIds']:
                    entity['entityIds'] = record['entityIds']
                if record['type'] == 'State':
                    entity['name'] = record['Sname']
                
                entities.append(entity)
            
            # 查询所有关系
            relationships_query = """
            MATCH (n1)-[r]->(n2)
            RETURN n1.id AS source, n2.id AS target, type(r) AS type, r.entity AS entities, r.type AS name
            """
            
            relationships_result = session.run(relationships_query)
            relationships = []
            for record in relationships_result:
                relationship = {
                    'source': record['source'],
                    'target': record['target'],
                    'type': record['type'],
                    'entities': record['entities'],
                    'name': record['name']
                }
                relationships.append(relationship)
            
            # 返回格式改为与原API一致：entities和relationships
            return {
                'entities': entities,
                'relationships': relationships
            }
            
        except Exception as e:
            logger.error(f'获取知识图谱失败: {e}')
            raise
        finally:
            if session:
                session.close()
        
    def get_entity_details(self, entity_id):
        """
        获取实体详细信息
        
        Args:
            entity_id: 实体ID
            
        Returns:
            dict: 实体详细信息
        """
        session = None
        try:
            session = get_session()
            
            query = """
            MATCH (n)
            WHERE n.id = $entityId
            RETURN n, labels(n) as labels
            """
            
            result = session.run(query, {'entityId': entity_id})
            record = result.single()
            
            if not record:
                return None
            
            node = record['n']
            entity = dict(node)
            entity['labels'] = record['labels']
            
            return entity
            
        except Exception as e:
            logger.error(f'获取实体详情失败: {e}')
            raise
        finally:
            if session:
                session.close()
    
    def get_state_details(self, state_id):
        """
        获取状态详细信息
        
        Args:
            state_id: 状态ID
            
        Returns:
            list: 属性列表 [{type: '', value: ''}]
        """
        session = None
        try:
            session = get_session()
            
            # 查询状态详情和所属实体
            query = """
            MATCH (state:State)-[r:hasAttribute]->(attribute:Attribute)
            WHERE state.id = $stateId
            RETURN r.type AS rtype, attribute.value AS value
            """
            
            result = session.run(query, {'stateId': state_id})
            
            if not result.peek():
                return jsonify({'success': False, 'message': '未找到该状态'}), 404
            
            rel_attrs = []
            for record in result:
                rel_attr = {
                    'type': record['rtype'],
                    'value': record['value']
                }
                rel_attrs.append(rel_attr)
            
            return rel_attrs
            
        except Exception as e:
            logger.error(f'获取状态详情失败: {e}')
            raise
        finally:
            if session:
                session.close()
    
    def get_location_hierarchy(self, location_id):
        """
        获取地点的层级结构
        
        Args:
            location_id: 地点ID
            
        Returns:
            dict: {'entities': [...], 'relationships': [...]}
            注意：返回格式与前端期望一致（entities和relationships）
        """
        session = None
        try:
            session = get_session()
            
            # 查询地点的层级结构
            query1 = """
            MATCH (loc {id: $locationId})-[:locatedIn*0..]->(parent)
            WHERE (loc:地点 OR loc:设施) AND (parent:地点 OR parent:设施)
            RETURN parent.id AS id, parent.name AS name, labels(parent)[-1] AS type,
                    parent.geometry AS geo
            """
            
            result1 = session.run(query1, {'locationId': location_id})
            
            entities1 = []
            for record in result1:
                entity = {
                    'id': record['id'],
                    'type': record['type']
                }
                
                if record['name']:
                    entity['name'] = record['name']
                if record['geo']:
                    entity['geo'] = record['geo']
                    add_coordinates_to_entity(entity, record['geo'])
                
                entities1.append(entity)
            
            relationships1 = []
            for i in range(len(entities1) - 1):
                relationship = {
                    'source': entities1[i]['id'],
                    'target': entities1[i + 1]['id'],
                    'type': 'locatedIn'
                }
                relationships1.append(relationship)
            
            # 查询子地点
            query2 = """
            MATCH (loc {id: $locationId})<-[:locatedIn*1..]-(son)
            WHERE (loc:地点 OR loc:设施) AND (son:地点 OR son:设施)
            WITH son
            MATCH (son)-[r:locatedIn]->(parent)
            WHERE parent:地点 OR parent:设施
            RETURN 
                son.id AS id, son.name AS name, labels(son)[-1] AS type,
                son.geometry AS geo, type(r) AS rtype,
                son.id AS source, parent.id AS target
            """
            
            result2 = session.run(query2, {'locationId': location_id})
            
            entities2 = []
            relationships2 = []
            for record in result2:
                entity = {
                    'id': record['id'],
                    'type': record['type']
                }
                
                if record['name']:
                    entity['name'] = record['name']
                if record['geo']:
                    entity['geo'] = record['geo']
                    add_coordinates_to_entity(entity, record['geo'])
                
                entities2.append(entity)
                
                relationship = {
                    'source': record['source'],
                    'target': record['target'],
                    'type': record['rtype']
                }
                relationships2.append(relationship)
            
            entities = entities1 + entities2
            relationships = relationships1 + relationships2
            
            return {
                'entities': entities,
                'relationships': relationships
            }
            
        except Exception as e:
            logger.error(f'获取地点层级失败: {e}')
            raise
        finally:
            if session:
                session.close()


# 全局单例
_visualization_service = None


def get_visualization_service():
    """获取可视化服务单例"""
    global _visualization_service
    return get_runtime_dependency(
        container_getter='get_visualization_service',
        fallback_name='visualization_service',
        fallback_factory=VisualizationService,
        require_container=True,
        legacy_getter=lambda: _visualization_service,
        legacy_setter=lambda instance: globals().__setitem__('_visualization_service', instance),
    )
