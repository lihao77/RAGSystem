from flask import Blueprint, request, jsonify
import logging
import re
from db import get_session

logger = logging.getLogger(__name__)

# 创建蓝图
visualization_bp = Blueprint('visualization', __name__)

_POINT_PATTERN = re.compile(
    r"^\s*(?:SRID=\d+;\s*)?POINT(?:\s+[A-Z]+)?\s*\(\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)",
    re.IGNORECASE,
)


def extract_coordinates_from_geometry(geometry_value):
    """Derive longitude/latitude from common WKT or coordinate structures."""
    if not geometry_value:
        return None, None

    if isinstance(geometry_value, str):
        text = geometry_value.strip()
        match = _POINT_PATTERN.match(text)
        if match:
            try:
                return float(match.group(1)), float(match.group(2))
            except ValueError:
                return None, None

        # Support simple "lon,lat" strings if present.
        if text.count(',') == 1:
            left, right = text.split(',', 1)
            try:
                return float(left.strip()), float(right.strip())
            except ValueError:
                return None, None

    if isinstance(geometry_value, dict):
        coords = geometry_value.get('coordinates')
        if isinstance(coords, (list, tuple)) and len(coords) >= 2:
            try:
                return float(coords[0]), float(coords[1])
            except (TypeError, ValueError):
                return None, None

    if isinstance(geometry_value, (list, tuple)) and len(geometry_value) >= 2:
        try:
            return float(geometry_value[0]), float(geometry_value[1])
        except (TypeError, ValueError):
            return None, None

    return None, None


def add_coordinates_from_geometry(entity, geometry_value):
    lon, lat = extract_coordinates_from_geometry(geometry_value)
    if lon is not None and lat is not None:
        entity['longitude'] = lon
        entity['latitude'] = lat

@visualization_bp.route('/base-entities', methods=['GET'])
def get_base_entities():
    """获取所有基础实体（地点和设施）"""
    session = None
    try:
        session = get_session()
        
        # 查询地点和设施实体，包含经纬度信息
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
                add_coordinates_from_geometry(entity, geo_value)

            entities.append(entity)
        
        return jsonify(entities)
        
    except Exception as e:
        logger.error(f'获取基础实体失败: {e}')
        return jsonify({'success': False, 'message': '获取基础实体失败'}), 500
    finally:
        if session:
            session.close()

@visualization_bp.route('/entity-relationships', methods=['GET'])
def get_entity_relationships():
    """获取地点和设施实体及其关系"""
    session = None
    try:
        session = get_session()
        
        # 查询地点和设施实体
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
                add_coordinates_from_geometry(entity, geo_value)

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
        
        print(entities, relationships)
        return jsonify({
            'entities': entities,
            'relationships': relationships
        })
        
    except Exception as e:
        logger.error(f'获取实体关系失败: {e}')
        return jsonify({'success': False, 'message': '获取实体关系失败'}), 500
    finally:
        if session:
            session.close()

@visualization_bp.route('/entity-states/<entity_id>', methods=['GET'])
def get_entity_states(entity_id):
    """获取实体的状态链"""
    session = None
    try:
        session = get_session()
        
        # 查询实体的状态链，包括nextState和contain关系
        query = """
        MATCH (e)-[:hasState]->(first_state:State)
        WHERE e.id = $entityId
        
        // 使用路径模式收集所有通过nextState和contain关联的状态
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
        
        // 获取每个状态的直接nextState关系
        OPTIONAL MATCH (state)-[next_rel:nextState]->(next_state)
        WHERE $entityId IN next_rel.entity
        
        // 获取每个状态的直接contain关系
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
        
        # 首先构建所有状态节点
        for record in result:
            state_id = record['id']
            if not state_id:
                continue
                
            next_state_ids = [id for id in record['nextStateIds'] if id]  # 过滤空值
            child_state_ids = [id for id in record['childStateIds'] if id]  # 过滤空值
            
            geo_value = record['geo']

            states_map[state_id] = {
                'id': state_id,
                'type': record['type'],
                'time': record['time'],
                'geo': geo_value,
                'entityIds': record['entityIds'],
                'nextStateIds': next_state_ids,
                'childStateIds': child_state_ids,
                'children': [],  # 用于构建树形结构
                'next': []  # 用于构建链式结构
            }

            if geo_value:
                add_coordinates_from_geometry(states_map[state_id], geo_value)
        
        # 构建树形结构关系
        for state in states_map.values():
            # 添加子状态
            for child_id in state['childStateIds']:
                if child_id in states_map:
                    state['children'].append(states_map[child_id])
            
            # 添加下一个状态
            for next_id in state['nextStateIds']:
                if next_id in states_map:
                    state['next'].append(states_map[next_id])
        
        # 找到根状态（没有父状态的状态）
        root_states = []
        for state in states_map.values():
            is_root = True
            for s in states_map.values():
                if state['id'] in s['childStateIds'] or state['id'] in s['nextStateIds']:
                    is_root = False
                    break
            if is_root:
                root_states.append(state)
        
        # 按时间排序函数
        def sort_by_time(states):
            def time_key(state):
                if not state.get('time'):
                    return float('inf')  # 没有时间的排在最后
                try:
                    from datetime import datetime
                    return datetime.fromisoformat(state['time'].replace('Z', '+00:00'))
                except:
                    return float('inf')
            return sorted(states, key=time_key)
        
        # 按时间排序根状态
        sorted_root_states = sort_by_time(root_states)
        
        # 递归排序所有子节点
        def sort_all_children(state):
            if state['children']:
                state['children'] = sort_by_time(state['children'])
                for child in state['children']:
                    sort_all_children(child)
            if state['next']:
                state['next'] = sort_by_time(state['next'])
                for next_state in state['next']:
                    sort_all_children(next_state)
        
        for root_state in sorted_root_states:
            sort_all_children(root_state)
        
        # 返回完整的状态树结构
        return jsonify({
            'states': list(states_map.values()),
            'rootStates': sorted_root_states
        })
        
    except Exception as e:
        logger.error(f'查询实体{entity_id}的状态链失败: {e}')
        return jsonify({'success': False, 'message': f'查询实体{entity_id}的状态链失败'}), 500
    finally:
        if session:
            session.close()

@visualization_bp.route('/entity-events/<entity_id>', methods=['GET'])
def get_entity_events(entity_id):
    """获取与实体相关的事件"""
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
        
        return jsonify(events)
        
    except Exception as e:
        logger.error(f'查询实体{entity_id}相关事件失败: {e}')
        return jsonify({'success': False, 'message': f'查询实体{entity_id}相关事件失败'}), 500
    finally:
        if session:
            session.close()

@visualization_bp.route('/event-locations/<event_id>', methods=['GET'])
def get_event_locations(event_id):
    """获取与事件相关的地理位置"""
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
                add_coordinates_from_geometry(entity, record['geo'])
            
            entities.append(entity)
            
            relationships.append({
                'source': record['source'],
                'target': record['target'],
                'type': record['rtype'],
                'entities': record['entities']
            })
        
        return jsonify({
            'entities': entities,
            'relationships': relationships
        })
        
    except Exception as e:
        logger.error(f'查询知识图谱数据失败: {e}')
        return jsonify({'success': False, 'message': '查询知识图谱数据失败'}), 500
    finally:
        if session:
            session.close()

@visualization_bp.route('/entity-facilities/<entity_id>', methods=['GET'])
def get_entity_facilities(entity_id):
    """获取与实体相关的设施"""
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
                add_coordinates_from_geometry(facility, record['geo'])
            
            facilities.append(facility)
        
        return jsonify(facilities)
        
    except Exception as e:
        logger.error(f'获取实体设施失败: {e}')
        return jsonify({'success': False, 'message': f'获取实体{entity_id}相关设施失败'}), 500
    finally:
        if session:
            session.close()

@visualization_bp.route('/state-relationships', methods=['GET'])
def get_state_relationships():
    """获取状态之间的关系"""
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
        
        return jsonify(relationships)
        
    except Exception as e:
        logger.error(f'获取状态关系失败: {e}')
        return jsonify({'success': False, 'message': '获取状态关系失败'}), 500
    finally:
        if session:
            session.close()

@visualization_bp.route('/knowledge-graph', methods=['GET'])
def get_knowledge_graph():
    """获取完整的知识图谱数据（包括实体和关系）"""
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
                add_coordinates_from_geometry(entity, record['geo'])
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
        
        return jsonify({
            'entities': entities,
            'relationships': relationships
        })
        
    except Exception as e:
        logger.error(f'获取知识图谱数据失败: {e}')
        return jsonify({'success': False, 'message': '获取知识图谱数据失败'}), 500
    finally:
        if session:
            session.close()

@visualization_bp.route('/entities/<entity_id>', methods=['GET'])
def get_entity_details(entity_id):
    """获取实体详情"""
    session = None
    try:
        session = get_session()
        
        # 查询实体详情
        query = """
        MATCH (e)
        WHERE e.id = $entityId
        RETURN e, labels(e)[-1] AS type
        """
        
        result = session.run(query, {'entityId': entity_id})
        
        if not result.peek():
            return jsonify({'success': False, 'message': '未找到该实体'}), 404
        
        record = result.single()
        entity_node = dict(record['e'])
        entity_type = record['type']
        
        # 构建实体对象
        entity = {
            'id': entity_node.get('id'),
            'type': entity_type,
        }
        
        # 添加不同类型实体的特定属性
        if entity_node.get('name'):
            entity['name'] = entity_node['name']
        if entity_node.get('time'):
            entity['time'] = entity_node['time']
        geometry_value = entity_node.get('geometry') or entity_node.get('geo')
        if geometry_value:
            entity['geo'] = geometry_value
            add_coordinates_from_geometry(entity, geometry_value)
        if entity_node.get('value'):
            entity['value'] = entity_node['value']
        
        return jsonify(entity)
        
    except Exception as e:
        logger.error(f'获取实体详情失败: {e}')
        return jsonify({'success': False, 'message': f'获取实体{entity_id}详情失败'}), 500
    finally:
        if session:
            session.close()

@visualization_bp.route('/state-details/<state_id>', methods=['GET'])
def get_state_details(state_id):
    """获取状态详情及其所属实体"""
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
            return
        
        rel_attrs = []
        for record in result:
            rel_attr = {
                'type': record['rtype'],
                'value': record['value']
            }
            rel_attrs.append(rel_attr)
        
        return jsonify(rel_attrs)
        
    except Exception as e:
        logger.error(f'获取状态详情失败: {e}')
        return jsonify({'success': False, 'message': f'获取状态{state_id}详情失败'}), 500
    finally:
        if session:
            session.close()

@visualization_bp.route('/location-hierarchy/<location_id>', methods=['GET'])
def get_location_hierarchy(location_id):
    """获取地点的层级结构"""
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
                add_coordinates_from_geometry(entity, record['geo'])
            
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
                add_coordinates_from_geometry(entity, record['geo'])
            
            entities2.append(entity)
            
            relationship = {
                'source': record['source'],
                'target': record['target'],
                'type': record['rtype']
            }
            relationships2.append(relationship)
        
        entities = entities1 + entities2
        relationships = relationships1 + relationships2
        
        return jsonify({
            'entities': entities,
            'relationships': relationships
        })
        
    except Exception as e:
        logger.error(f'获取地点层级结构失败: {e}')
        return jsonify({'success': False, 'message': f'获取地点{location_id}的层级结构失败'}), 500
    finally:
        if session:
            session.close()