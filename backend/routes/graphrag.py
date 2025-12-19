# -*- coding: utf-8 -*-
"""
GraphRAG路由 - 基于知识图谱的问答系统
"""

from flask import Blueprint, request, jsonify
import logging
import json
import requests
from datetime import datetime, date, time
from db import neo4j_conn
from config import get_config

logger = logging.getLogger(__name__)

graphrag_bp = Blueprint('graphrag', __name__)


def convert_neo4j_types(obj):
    """将Neo4j特殊类型转换为JSON可序列化的类型"""
    # 处理None
    if obj is None:
        return None
    
    # 获取对象类型名称
    type_name = type(obj).__name__
    
    # 处理Neo4j时间类型（通过类型名称判断）
    if type_name in ('DateTime', 'Date', 'Time'):
        return obj.isoformat() if hasattr(obj, 'isoformat') else str(obj)
    
    # 处理Duration
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
    
    # 其他类型尝试直接返回
    else:
        try:
            json.dumps(obj)  # 测试是否可序列化
            return obj
        except (TypeError, ValueError):
            # 不可序列化，转换为字符串
            return str(obj)


def get_graph_schema():
    """获取图谱结构信息"""
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
            
            # 获取节点属性示例
            node_properties = {}
            for label in labels[:5]:  # 限制查询前5个标签
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


def generate_cypher_with_llm(user_question, graph_schema, conversation_history=None):
    """使用LLM生成Cypher查询语句"""
    try:
        # 读取配置
        config = get_config()
        api_endpoint = config.llm.api_endpoint
        api_key = config.llm.api_key
        model_name = config.llm.model_name
        
        # 构建详细的图谱结构说明
        schema_desc = """
## 知识图谱结构说明

### 一、节点类型与ID规范

#### 1. 基础实体节点（标签带 :entity）
   - **事件节点** (:事件:entity)
     - ID格式: `E-<行政区划码>-<日期>-<事件类型>`
     - 示例: `E-450000-20231001-TYPHOON`
     - 属性: id, name, geo_description, source
   
   - **地点节点** (:地点:entity)
     - ID格式: `L-<行政区划码>[>子区域]` 或 `L-RIVER-<名称>`
     - 示例: `L-450100`（南宁市）, `L-450103>新竹街道`, `L-RIVER-长江`
     - 属性: id, name, geo_description, admin_level
   
   - **设施节点** (:设施:entity)
     - ID格式: `F-<行政区划码>-<设施名称>`
     - 示例: `F-420500-三峡大坝`, `F-450381-潘厂水库`
     - 属性: id, name, geo_description, facility_type

#### 2. 状态节点 (:State) - **状态ID包含实体ID信息**
   - **事件状态** (ES-*)
     - ID格式: `ES-E-<事件ID>-<开始日期YYYYMMDD>_<结束日期YYYYMMDD>`
     - 示例: `ES-E-450000-20231001-TYPHOON-20231001_20231010`
     - **注意**: 状态ID中包含完整的事件ID (`E-450000-20231001-TYPHOON`)
   
   - **地点状态** (LS-*)
     - ID格式: `LS-L-<地点ID>-<开始日期>_<结束日期>`
     - 示例: `LS-L-450100-20231001_20231001`
     - **注意**: 状态ID中包含地点ID (`L-450100`)
   
   - **设施状态** (FS-*)
     - ID格式: `FS-F-<设施ID>-<开始日期>_<结束日期>`
     - 示例: `FS-F-450381-潘厂水库-20200607_20200607`
     - **注意**: 状态ID中包含设施ID (`F-450381-潘厂水库`)
   
   - **联合状态** (JS-*)
     - ID格式: `JS-<实体ID1>-<实体ID2>-...-<日期>`
     - 示例: `JS-L-450100-L-450500-20231001_20231010`
   
   - **关键属性**: id, state_type, time, start_time, end_time, entity_ids

#### 3. 属性节点 (:Attribute)
   - 存储状态的具体属性值
   - 属性: id, value

### 二、关系类型
1. **空间关系**
   - :locatedIn - 地点之间的层级关系，设施到地点的归属关系
   - :occurredAt - 事件发生在某地点

2. **状态链关系**
   - :hasState - 基础实体到其首个状态
   - :nextState - 同一实体的时间序列状态（关系属性entity记录实体ID列表）
   - :contain - 状态之间的时间包含关系

3. **因果关系**
   - :hasRelation - 状态之间的因果关系（关系属性type值为：导致、间接导致、隐含导致、触发）

4. **属性关系**
   - :hasAttribute - 状态到属性节点（关系属性type记录属性名称，如"降雨量"、"受灾人口"）

### 三、查询优化策略 - **利用ID进行高效过滤**

**核心原则：状态ID包含实体信息，可直接过滤，无需从基础实体查起！**

#### ID过滤优化规则：
1. **已知实体名称时**：优先使用状态ID的CONTAINS过滤，避免先查基础实体
   - ❌ 低效: `MATCH (e:entity {name:'潘厂水库'})-[:hasState]->(s)`
   - ✅ 高效: `MATCH (s:State) WHERE s.id CONTAINS '潘厂水库'`
   
2. **已知行政区划时**：直接用区划码过滤状态ID
   - ✅ `MATCH (s:State) WHERE s.id CONTAINS 'L-450100'` (南宁市的所有状态)
   - ✅ `MATCH (s:State) WHERE s.id STARTS WITH 'LS-L-4501'` (南宁市地点状态)

3. **已知时间范围时**：结合ID前缀和时间属性双重过滤
   - ✅ `MATCH (s:State) WHERE s.id STARTS WITH 'FS-F-450381-潘厂水库' AND s.start_time >= date('2020-01-01')`

4. **多实体查询时**：使用entity_ids数组过滤
   - ✅ `MATCH (s:State) WHERE ANY(id IN s.entity_ids WHERE id CONTAINS '潘厂水库')`

#### 何时需要从基础实体开始：
- 需要基础实体的属性（如geo_description, admin_level）
- 需要利用空间层级关系（locatedIn, occurredAt）
- 实体名称模糊，需要先确定实体ID

**重要规则：**
1. 状态节点通过hasAttribute关系连接到Attribute节点，属性名在关系的type字段，属性值在Attribute节点的value字段
2. 基础实体通过hasState关系连接到首个状态，后续状态通过nextState链接
3. 状态之间的因果关系只在State节点之间通过hasRelation建立，type属性记录关系类型
4. **优先使用状态ID过滤，只有必要时才从基础实体查起**

**查询模板（按优先级排序）：**

1. **直接通过状态ID过滤**（最高效）：
```cypher
// 查询潘厂水库2020年的状态
MATCH (s:State)
WHERE s.id CONTAINS '潘厂水库' 
  AND s.start_time >= date('2020-01-01') 
  AND s.end_time <= date('2020-12-31')
OPTIONAL MATCH (s)-[ha:hasAttribute]->(attr:Attribute)
RETURN s.id, s.time, ha.type AS attr_name, attr.value
LIMIT 50
```

2. **通过状态ID前缀+实体名过滤**：
```cypher
// 查询南宁市2023年10月的地点状态
MATCH (s:State)
WHERE s.id STARTS WITH 'LS-L-450100'  // 南宁市区划码
  AND s.time CONTAINS '2023-10'
OPTIONAL MATCH (s)-[ha:hasAttribute]->(attr:Attribute)
WHERE ha.type IN ['降雨量', '受灾人口']
RETURN s.id, s.time, ha.type, attr.value
LIMIT 50
```

3. **通过entity_ids数组过滤**：
```cypher
// 查询涉及多个实体的状态
MATCH (s:State)
WHERE ANY(eid IN s.entity_ids WHERE eid CONTAINS '潘厂水库' OR eid CONTAINS 'L-450100')
  AND s.start_time >= date('2020-01-01')
OPTIONAL MATCH (s)-[ha:hasAttribute]->(attr:Attribute)
RETURN s.id, s.entity_ids, ha.type, attr.value
LIMIT 50
```

4. **因果链查询（直接从状态开始）**：
```cypher
// 查询某设施状态导致的下游影响
MATCH (targetState:State)
WHERE targetState.id CONTAINS '潘厂水库'
  AND targetState.start_time >= date('2020-01-01')
MATCH p = (startState:State)-[:hasRelation*0..3]->(targetState)
WHERE startState.id CONTAINS 'ES-'
WITH p, nodes(p) AS ns, relationships(p) AS rs
CALL (ns) {
  WITH ns
  UNWIND ns AS n
  OPTIONAL MATCH (n)-[ha:hasAttribute]->(a:Attribute)
  WITH n, collect({{type: ha.type, value: a.value}}) AS attrs
  RETURN collect({{id: n.id, attrs: attrs}}) AS node_infos
}
RETURN node_infos, [r IN rs | {{start: startNode(r).id, end: endNode(r).id, type: type(r)}}] AS rels
LIMIT 20
```

5. **需要基础实体信息时才从实体查起**：
```cypher
// 需要实体的geo_description或admin_level等属性时
MATCH (entity:entity {name: '南宁市'})-[:hasState]->(s0:State)
OPTIONAL MATCH (s0)-[:nextState*0..]->(s:State)
WHERE s.start_time >= date('2023-10-01')
OPTIONAL MATCH (s)-[ha:hasAttribute]->(attr:Attribute)
RETURN entity.name, entity.admin_level, s.id, s.time, ha.type, attr.value
LIMIT 50
```

4. 提取完整子图（包含属性）：
**注意：Neo4j 5.x使用新的CALL语法，必须指定变量作用域**
```cypher
MATCH p = (...)...
WITH p, nodes(p) AS ns, relationships(p) AS rs
CALL (ns) {{
  WITH ns
  UNWIND ns AS n
  OPTIONAL MATCH (n)-[ha:hasAttribute]->(a:Attribute)
  WITH n, collect(DISTINCT {{type: ha.type, value: a.value}}) AS attrs
  RETURN collect({{
    id: n.id,
    label: labels(n),
    props: properties(n),
    attributes: attrs
  }}) AS node_infos
}}
WITH p, node_infos,
     [r IN rs | {{start: startNode(r).id, end: endNode(r).id, type: type(r), props: properties(r)}}] AS rel_infos
RETURN node_infos AS nodes, rel_infos AS relationships
```
"""
        
        system_prompt = """你是一个Neo4j Cypher查询专家，专门处理广西洪涝灾害知识图谱查询。

""" + schema_desc + """

## 🎯 核心原则：自适应查询策略（从宽到精）

**查询失败的根本原因：过早地限制了搜索范围！**

### ⚠️ 查询范围控制原则

**初次查询：尽可能宽泛**
- ❌ 不要过早限定State类型前缀（ES-、LS-、JS-）
- ❌ 不要过早限定具体实体ID
- ❌ 不要在WHERE中堆砌太多AND条件
- ✅ 优先用宽泛条件，通过OPTIONAL MATCH扩展数据
- ✅ 让数据库返回更多结果，由LLM后续筛选

**渐进式缩小策略（仅在初次查询结果过多时）：**
1. 第一次：只用时间范围 + 属性值模糊匹配
2. 第二次：如果结果>100条，添加地域限制
3. 第三次：如果仍>100条，限定State类型

### 📝 查询模板（按优先级）

#### 模板1：查询某时间段的统计数据（如损失、受灾人口）
```cypher
// ✅ 正确：宽泛查询所有相关State
MATCH (s:State)
WHERE s.start_time >= date('2017-07-01') 
  AND s.start_time <= date('2017-07-31')
OPTIONAL MATCH (s)-[:hasAttribute]->(attr:Attribute)
WHERE attr.value CONTAINS '亿元' 
   OR attr.value CONTAINS '万人'
   OR attr.value CONTAINS '损失'
RETURN s.id, s.state_type, s.start_time, 
       collect({attr: attr.value}) as attributes
LIMIT 100

// ❌ 错误：过早限定范围
WHERE s.id STARTS WITH 'ES-E-45'  // 只查事件状态，遗漏地点/联合状态
WHERE s.id CONTAINS 'E-450000'     // 过于具体，遗漏其他地区
```

#### 模板2：查询特定实体的情况
```cypher
// ✅ 正确：用CONTAINS宽泛匹配
MATCH (s:State)
WHERE s.id CONTAINS '潘厂水库'
  AND s.start_time >= date('2020-01-01')
OPTIONAL MATCH (s)-[:hasAttribute]->(attr:Attribute)
RETURN s, collect(attr) as attributes
LIMIT 50

// ❌ 错误：限定前缀
WHERE s.id STARTS WITH 'FS-F-450381-潘厂水库'  // 太具体
```

#### 模板3：属性值模糊搜索
```cypher
// ✅ 当不确定数据在哪里时，直接从属性反向查
MATCH (attr:Attribute)
WHERE attr.value CONTAINS '2017' 
  AND (attr.value CONTAINS '亿元' OR attr.value CONTAINS '损失')
MATCH (s:State)-[:hasAttribute]->(attr)
WHERE s.start_time >= date('2017-07-01')
  AND s.start_time <= date('2017-07-31')
RETURN s.id, s.state_type, collect(attr.value) as losses
LIMIT 100
```

## 生成要求：
1. **只返回Cypher查询语句**，不要任何解释或markdown标记
2. **第一次查询必须宽泛**，不限定State类型前缀（ES-/LS-/JS-）
3. 优先使用CONTAINS而非STARTS WITH或精确匹配
4. 时间过滤使用date()函数：`date('2020-01-01')`
5. 使用OPTIONAL MATCH扩展属性，避免漏数据
6. **CALL子查询必须使用Neo4j 5.x新语法**：`CALL (变量) {{ WITH 变量 ... }}`
7. LIMIT设为100（宽查询）或50（精确查询）
8. ⚠️ **禁止在初次查询时同时使用多个严格限制条件**
"""
        
        # 构建消息
        messages = [
            {"role": "system", "content": system_prompt}
        ]
        
        # 添加对话历史（如果有）
        if conversation_history:
            for msg in conversation_history[-4:]:
                messages.append({
                    "role": msg.get('role', 'user'),
                    "content": msg.get('content', '')
                })
        
        messages.append({
            "role": "user",
            "content": f"用户问题：{user_question}\n\n请生成对应的Cypher查询语句："
        })
        
        # 调用LLM API
        response = requests.post(
            f"{api_endpoint}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            },
            json={
                "model": model_name,
                "messages": messages,
                "temperature": 0.1,
                "max_tokens": 1500
            },
            timeout=60
        )
        
        if response.status_code == 200:
            result = response.json()
            cypher = result['choices'][0]['message']['content'].strip()
            
            # 清理Cypher语句（移除markdown代码块标记）
            if '```' in cypher:
                # 提取代码块中的内容
                lines = cypher.split('\n')
                in_code_block = False
                code_lines = []
                for line in lines:
                    if line.strip().startswith('```'):
                        in_code_block = not in_code_block
                        continue
                    if in_code_block or not any(line.strip().startswith(x) for x in ['```', '#', '//']):
                        if line.strip():
                            code_lines.append(line)
                cypher = '\n'.join(code_lines).strip()
            
            # 移除可能的cypher关键字前缀
            if cypher.lower().startswith('cypher'):
                cypher = cypher[6:].strip()
                if cypher.startswith(':'):
                    cypher = cypher[1:].strip()
            
            logger.info(f'LLM生成的Cypher: {cypher}')
            return cypher
        else:
            logger.error(f'LLM API调用失败: {response.status_code} - {response.text}')
            return None
            
    except Exception as e:
        logger.error(f'生成Cypher语句失败: {e}')
        return None


def execute_cypher(cypher):
    """执行Cypher查询"""
    try:
        with neo4j_conn.get_session() as session:
            result = session.run(cypher)
            
            # 将结果转换为JSON可序列化的格式
            records = []
            nodes_dict = {}  # 用于去重节点
            relationships = []  # 存储关系
            node_attributes = {}  # 存储节点的属性信息
            
            for record in result:
                record_dict = {}
                
                for key in record.keys():
                    value = record[key]
                    
                    # 处理路径类型
                    if hasattr(value, 'nodes') and hasattr(value, 'relationships'):
                        # 这是一个路径对象
                        path_nodes = []
                        path_rels = []
                        
                        for node in value.nodes:
                            node_id = str(node.id)
                            node_data = {
                                'id': node.id,
                                'labels': list(node.labels),
                                'properties': convert_neo4j_types(dict(node))
                            }
                            if node_id not in nodes_dict:
                                nodes_dict[node_id] = node_data
                            path_nodes.append(node_data)
                        
                        for rel in value.relationships:
                            rel_data = {
                                'id': rel.id,
                                'type': rel.type,
                                'source': str(rel.start_node.id),
                                'target': str(rel.end_node.id),
                                'properties': convert_neo4j_types(dict(rel))
                            }
                            relationships.append(rel_data)
                            path_rels.append(rel_data)
                        
                        record_dict[key] = {
                            'nodes': path_nodes,
                            'relationships': path_rels
                        }
                    
                    # 处理Neo4j节点
                    elif hasattr(value, 'labels'):
                        node_data = {
                            'id': value.id,
                            'labels': list(value.labels),
                            'properties': convert_neo4j_types(dict(value))
                        }
                        record_dict[key] = node_data
                        
                        # 收集节点用于图谱可视化
                        node_id = str(value.id)
                        if node_id not in nodes_dict:
                            nodes_dict[node_id] = node_data
                        
                    # 处理Neo4j关系
                    elif hasattr(value, 'type') and hasattr(value, 'start_node') and hasattr(value, 'end_node'):
                        # 确保起点和终点节点也被收集
                        start_id = str(value.start_node.id)
                        end_id = str(value.end_node.id)
                        
                        if start_id not in nodes_dict:
                            nodes_dict[start_id] = {
                                'id': value.start_node.id,
                                'labels': list(value.start_node.labels),
                                'properties': convert_neo4j_types(dict(value.start_node))
                            }
                        
                        if end_id not in nodes_dict:
                            nodes_dict[end_id] = {
                                'id': value.end_node.id,
                                'labels': list(value.end_node.labels),
                                'properties': convert_neo4j_types(dict(value.end_node))
                            }
                        
                        rel_data = {
                            'id': value.id,
                            'type': value.type,
                            'source': start_id,
                            'target': end_id,
                            'properties': convert_neo4j_types(dict(value))
                        }
                        record_dict[key] = rel_data
                        relationships.append(rel_data)
                    
                    # 处理列表（可能包含节点、关系或自定义对象）
                    elif isinstance(value, list):
                        converted_list = []
                        for item in value:
                            if hasattr(item, 'labels'):  # 节点
                                node_id = str(item.id)
                                node_data = {
                                    'id': item.id,
                                    'labels': list(item.labels),
                                    'properties': convert_neo4j_types(dict(item))
                                }
                                if node_id not in nodes_dict:
                                    nodes_dict[node_id] = node_data
                                converted_list.append(node_data)
                            elif hasattr(item, 'type') and hasattr(item, 'start_node'):  # 关系
                                start_id = str(item.start_node.id)
                                end_id = str(item.end_node.id)
                                rel_data = {
                                    'id': item.id,
                                    'type': item.type,
                                    'source': start_id,
                                    'target': end_id,
                                    'properties': convert_neo4j_types(dict(item))
                                }
                                relationships.append(rel_data)
                                converted_list.append(rel_data)
                            elif isinstance(item, dict):
                                # 处理自定义字典（可能包含 attributes）
                                converted_item = convert_neo4j_types(item)
                                converted_list.append(converted_item)
                                
                                # 检查是否是节点信息字典（包含 id 和 attributes）
                                if 'id' in converted_item and 'attributes' in converted_item:
                                    node_id = str(converted_item['id'])
                                    if node_id not in node_attributes:
                                        node_attributes[node_id] = []
                                    node_attributes[node_id] = converted_item['attributes']
                            else:
                                converted_list.append(convert_neo4j_types(item))
                        record_dict[key] = converted_list
                        
                    # 处理基本类型和特殊类型
                    else:
                        record_dict[key] = convert_neo4j_types(value)
                
                records.append(record_dict)
            
            # 为收集到的节点附加属性信息
            for node_id, node_data in nodes_dict.items():
                if node_id in node_attributes:
                    node_data['attributes'] = node_attributes[node_id]
            
            # 如果查询返回了自定义的 nodes 字段，也尝试整合到 nodes_dict
            for record in records:
                if 'nodes' in record and isinstance(record['nodes'], list):
                    for node_info in record['nodes']:
                        if isinstance(node_info, dict) and 'id' in node_info:
                            node_id = str(node_info['id'])
                            # 如果已有该节点，添加属性信息
                            if node_id in nodes_dict and 'attributes' in node_info:
                                nodes_dict[node_id]['attributes'] = node_info.get('attributes', [])
                            # 如果没有该节点，添加到字典
                            elif node_id not in nodes_dict:
                                nodes_dict[node_id] = {
                                    'id': node_info['id'],
                                    'labels': node_info.get('label', node_info.get('labels', [])),
                                    'properties': node_info.get('props', {}),
                                    'attributes': node_info.get('attributes', [])
                                }
                
                # 如果返回了 relationships 字段
                if 'relationships' in record and isinstance(record['relationships'], list):
                    for rel_info in record['relationships']:
                        if isinstance(rel_info, dict) and 'start' in rel_info and 'end' in rel_info:
                            # 检查是否已经在 relationships 中
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
            
            # 返回结果和图谱数据
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


def generate_answer_with_llm(user_question, query_results, cypher, conversation_history=None):
    """使用LLM基于查询结果生成回答"""
    try:
        # 读取配置
        config = get_config()
        api_endpoint = config.llm.api_endpoint
        api_key = config.llm.api_key
        model_name = config.llm.model_name
        
        # 构建提示词
        system_prompt = """你是一个知识图谱问答助手。根据用户的问题和从知识图谱中查询到的结果，生成准确、详细的回答。

要求：
1. 回答要基于查询结果，不要编造信息
2. 如果查询结果为空，礼貌地告诉用户没有找到相关信息
3. 组织好回答的结构，使用markdown格式
4. 对于数字统计，要给出具体数值
5. 如果结果很多，可以总结要点
"""
        
        # 限制查询结果大小（避免token过多）
        # 1. 先限制记录数
        limited_results = query_results[:10]
        
        # 2. 简化结果结构，只保留关键信息
        simplified_results = []
        for record in limited_results:
            simplified = {}
            for key, value in record.items():
                # 跳过过大的嵌套结构
                if isinstance(value, (str, int, float, bool)) or value is None:
                    simplified[key] = value
                elif isinstance(value, list) and len(value) < 50:  # 限制列表大小
                    simplified[key] = value[:20]  # 只取前20项
                elif isinstance(value, dict) and len(str(value)) < 500:  # 限制字典大小
                    simplified[key] = value
                else:
                    simplified[key] = f"<数据过大，已省略，类型:{type(value).__name__}>"
            simplified_results.append(simplified)
        
        results_str = json.dumps(simplified_results, ensure_ascii=False)
        
        # 3. 最终长度限制
        if len(results_str) > 4000:
            results_str = results_str[:4000] + '...(结果已截断)'
        
        # 构建消息
        messages = [
            {"role": "system", "content": system_prompt}
        ]
        
        # 添加对话历史（如果有）
        if conversation_history:
            for msg in conversation_history[-4:]:
                if msg.get('role') in ['user', 'assistant']:
                    messages.append({
                        "role": msg['role'],
                        "content": msg['content']
                    })
        
        messages.append({
            "role": "user",
            "content": f"""用户问题：{user_question}

执行的Cypher查询：
```cypher
{cypher}
```

查询结果：
```json
{results_str}
```

请基于以上查询结果，生成对用户问题的回答："""
        })
        
        # 调用LLM API
        response = requests.post(
            f"{api_endpoint}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            },
            json={
                "model": model_name,
                "messages": messages,
                "temperature": 0.7,
                "max_tokens": 8192
            },
            timeout=90  # 增加超时时间到90秒
        )
        
        if response.status_code == 200:
            result = response.json()
            answer = result['choices'][0]['message']['content'].strip()
            return answer
        else:
            logger.error(f'LLM API调用失败: {response.status_code} - {response.text}')
            return "抱歉，生成回答时出现错误。"
            
    except requests.exceptions.Timeout:
        logger.error(f'生成回答超时（90秒）')
        return "抱歉，生成回答时超时。查询已完成，但AI回答生成较慢，请稍后重试或查看原始查询结果。"
    except Exception as e:
        logger.error(f'生成回答失败: {e}')
        return "抱歉，生成回答时出现错误。"


@graphrag_bp.route('/schema', methods=['GET'])
def get_schema():
    """获取图谱结构"""
    try:
        schema = get_graph_schema()
        if schema:
            return jsonify({
                'success': True,
                'data': schema
            })
        else:
            return jsonify({
                'success': False,
                'message': '获取图谱结构失败'
            }), 500
    except Exception as e:
        logger.error(f'获取图谱结构API错误: {e}')
        return jsonify({
            'success': False,
            'message': str(e)
        }), 500


@graphrag_bp.route('/query', methods=['POST'])
def query():
    """
    基于 Function Calling 的 GraphRAG 问答
    LLM 自主选择工具，支持多步推理和工具组合
    """
    try:
        data = request.get_json()
        user_question = data.get('question', '').strip()
        conversation_history = data.get('history', [])
        
        if not user_question:
            return jsonify({
                'success': False,
                'message': '问题不能为空'
            }), 400
        
        # 使用 Function Calling 模块处理
        logger.info(f'使用 Function Calling 处理问题: {user_question}')
        
        # 导入工具模块
        from tools.function_definitions import get_tool_definitions
        from tools.tool_executor import execute_tool
        
        # 读取 LLM 配置
        config = get_config()
        api_endpoint = config.llm.api_endpoint
        api_key = config.llm.api_key
        model_name = config.llm.model_name
        
        # 获取所有可用工具
        tools = get_tool_definitions()
        
        # 构建系统提示词
        system_prompt = """你是一个知识图谱问答助手，专门回答关于广西水旱灾害的问题。

**核心原则：循序渐进、分步推理**

⚠️ **关键图谱知识：损失数据的存储位置**
- 经济损失、受灾人口等数据**不仅仅存储在事件状态(ES-E-)中**！
- 损失数据可能分散在：
  1. **事件状态节点** (ES-E-*) - 灾害事件的整体统计
  2. **地点状态节点** (LS-L-*) - 各市县的受灾情况
  3. **联合状态节点** (JS-*) - 多个地区的汇总统计（如"南宁、北海两市总受灾52.88万人，损失3.90亿元"）
- ⚠️ 查询损失时，必须同时考虑所有State类型，不能只查事件！
- ⚠️ Cypher查询应使用 `MATCH (s:State)` 而非 `MATCH (e:Event)` 或限定ID前缀

你拥有以下工具：

📊 **基础检索工具**
1. query_knowledge_graph_with_nl - 自然语言查询（自动生成Cypher）⭐推荐优先使用
   - 必填参数：question（自然语言问题）
   - 可选参数：history（对话历史，用于上下文理解）
   - 适用场景：复杂关联查询、模糊查询、多条件组合查询

2. search_knowledge_graph - 结构化筛选查询（支持基础实体和状态节点）
   - 可选参数：keyword（关键词）、category（类别：地点/设施/事件/State，默认State）、time_range（时间范围数组，仅对State有效）、location（地理位置层级数组）、document_source（文档来源）、advanced_query（高级WHERE子句）
   - ⚠️重要：category参数决定查询目标！
     * category='地点'/'设施'/'事件' → 查询基础实体(:entity节点)
     * category='State'/'' → 查询状态节点(:State节点，包含时序数据和属性)
   - 适用场景：
     * 查询基础实体信息（名称、位置）：用category='地点'/'设施'/'事件'
     * 查询损失、受灾等数据：必须用category='State'！
     * 按时间范围筛选：只对category='State'有效

3. get_entity_relations - 实体关系网络探索
   - 必填参数：entity_id（基础实体ID，如'L-450100'、'F-450381-潘厂水库'、'E-450000-20231001-TYPHOON'）
   - ⚠️注意：只支持基础实体ID（:entity节点），不支持State节点ID（ES-*/LS-*/FS-*/JS-*）
   - 返回三类关系：
     * 空间关系：locatedIn（层级）、occurredAt（发生地）
     * 状态链：hasState（首个状态）、nextState（时间序列）
     * 因果关系：hasRelation（通过状态节点间接获取）
   - 适用场景：探索实体的空间位置、历史状态链、因果网络

4. execute_cypher_query - 直接执行Cypher（高级用户专用）
   - 必填参数：cypher（Cypher查询语句，仅限只读）
   - 适用场景：需要精确控制查询逻辑

5. get_graph_schema - 获取图谱结构元数据
   - 无参数
   - 适用场景：了解节点类型、关系类型、属性schema

🔍 **高级分析工具**
6. analyze_temporal_pattern - 时序趋势分析
   - 必填参数：entity_name（实体名称）、start_date（开始日期YYYY-MM-DD）、end_date（结束日期YYYY-MM-DD）
   - 可选参数：metric（分析指标，如'降雨量'、'受灾人口'）
   - 适用场景：趋势分析、周期性分析

7. find_causal_chain - 因果链路追踪
   - 必填参数：start_event（起始事件/实体名称或状态ID）
   - 可选参数：end_event（目标事件）、max_depth（最大深度，默认3）、direction（方向：forward/backward/both，默认forward）
   - ⚠️注意：不支持时间过滤！需要精确时间时，start_event应传入完整状态ID（如FS-F-450381-潘厂水库-20200607_20200607）
   - 适用场景：影响传播分析、溯源分析

8. compare_entities - 多实体对比
   - 必填参数：entity_names（实体名称数组，至少2个）
   - 可选参数：time_range（时间范围[开始,结束]）、compare_attributes（要比较的属性数组）
   - 适用场景：对比不同地区/设施的状态差异

9. aggregate_statistics - 聚合统计
   - 必填参数：attribute（属性名称，如'受灾人口'）、aggregation（聚合方式：sum/avg/max/min/count）
   - 可选参数：entity_type（实体类型：地点/设施/事件）、time_range（时间范围）、group_by（分组字段：source/time）
   - 适用场景：数据汇总、总计、平均值计算

10. get_spatial_neighbors - 空间邻近查询
    - 必填参数：entity_name（中心实体名称）
    - 可选参数：radius（邻近层级，默认1）、neighbor_type（邻居类型：地点/设施/事件）
    - 适用场景：查找周边实体、影响范围评估

📚 **文档检索工具**
11. query_emergency_plan - 应急预案语义检索
    - 必填参数：query（自然语言查询）
    - 可选参数：top_k（返回数量，默认5）、min_similarity（最小相似度，默认0.3）、document_filter（文档来源过滤）
    - 适用场景：
      * 应急响应规范查询（Ⅰ/Ⅱ/Ⅲ/Ⅳ级响应启动条件、流程、职责）
      * 操作指南查询（防汛减灾措施、应急处置方案、预警发布）
      * 规范标准查询（灾害等级划分、安全阈值、技术规范）
    - ⚠️重要：当问题涉及"应急响应"、"预案"、"措施"、"标准"、"流程"等关键词时优先使用
    - 返回：文档片段、相似度评分、元数据（来源、章节）

📊 **数据可视化工具**
12. generate_chart - 生成数据图表
    - 必填参数：data（数据列表，每个元素是字典）
    - 可选参数：question（原始问题，用于智能选择图表类型）、chart_type（指定类型：line/bar/pie/scatter）、title（图表标题）、x_field（X轴字段）、y_field（Y轴字段）、series_field（系列分组字段）
    - 支持图表类型：
      * line（折线图）：时序趋势、演化分析
      * bar（柱状图）：类别对比、排名展示
      * pie（饼图）：占比分布、构成分析
      * scatter（散点图）：相关性分析、分布特征
    - ⚠️使用场景：
      * 用户明确要求"图表"、"图形"、"可视化"、"趋势图"时
      * 数据量 >= 3 条，适合可视化展示
      * 包含可对比的数值数据
    - ⚠️不适用：数据量 < 3 条、纯文本数据、单一数值
    - **工作流程**：先调用查询工具获取数据 → 将查询结果传给 generate_chart
    - 返回：ECharts 配置对象 + 数据摘要

**查询示例（按场景分类）**

🔹 **损失统计类问题**
"2017年7月广西因灾害导致的损失有多少？"
→ query_knowledge_graph_with_nl(question="2017年7月广西的灾害损失统计")
  说明：自动生成宽泛查询，覆盖所有State类型（事件/地点/联合状态）

"2020年全广西的经济损失总计"
→ aggregate_statistics(attribute="经济损失", aggregation="sum", time_range=["2020-01-01", "2020-12-31"])

🔹 **因果链追踪问题**
"潘厂水库2020年泄洪造成了什么影响？"
推荐方案（两步法）：
  ① query_knowledge_graph_with_nl(question="潘厂水库2020年6月的泄洪状态")
  ② 从结果提取状态ID（如FS-F-450381-潘厂水库-20200607_20200607）
  ③ find_causal_chain(start_event="FS-F-450381-潘厂水库-20200607_20200607", direction="forward", max_depth=3)

备用方案（如果时间不重要）：
  → find_causal_chain(start_event="潘厂水库", direction="forward", max_depth=3)
  说明：会返回所有时间的因果链，LLM需要人工筛选

🔹 **对比分析问题**
"比较2018和2019年南宁市和柳州市的受灾情况"
→ compare_entities(
    entity_names=["南宁市", "柳州市"], 
    time_range=["2018-01-01", "2019-12-31"], 
    compare_attributes=["受灾人口", "经济损失"]
  )

🔹 **时序趋势问题**
"潘厂水库2019-2021年降雨量变化趋势"
→ analyze_temporal_pattern(
    entity_name="潘厂水库", 
    start_date="2019-01-01", 
    end_date="2021-12-31", 
    metric="降雨量"
  )

🔹 **结构化筛选问题**
"查找2023年来源于水旱灾害公报的所有事件"
→ search_knowledge_graph(
    category="事件",  # 查基础实体
    document_source="2023年广西水旱灾害公报"
  )
  
"查找2023年10月南宁市的所有状态（包含降雨、受灾数据）"
→ search_knowledge_graph(
    keyword="南宁",
    category="State",  # 查状态节点！
    time_range=["2023-10-01", "2023-10-31"]
  )

🔹 **空间关系问题**
"查找南宁市周边的水库设施"
→ get_spatial_neighbors(entity_name="南宁市", radius=2, neighbor_type="设施")

🔹 **应急预案查询问题**
"Ⅰ级应急响应的启动条件是什么"
→ query_emergency_plan(query="Ⅰ级应急响应启动条件", top_k=5)

"降雨量达到多少需要启动应急响应"
→ query_emergency_plan(query="降雨量应急响应标准", top_k=3)

"防汛应急处置流程"
→ query_emergency_plan(query="防汛应急处置流程", top_k=5)

⚠️ **混合检索策略**：结合图谱和预案
"南宁市降雨300mm应启动什么响应？"
推荐方案（两步法）：
  ① query_knowledge_graph_with_nl(question="南宁市降雨300mm的历史情况")
  ② query_emergency_plan(query="降雨量应急响应启动标准")
  说明：图谱提供历史数据，预案提供规范标准，综合给出建议

🔹 **数据可视化问题**
"南宁市2020-2023年受灾人口变化趋势图"
推荐方案（两步法）：
  ① query_knowledge_graph_with_nl(question="南宁市2020-2023年受灾人口数据")
  ② generate_chart(data=<查询结果>, question="南宁市2020-2023年受灾人口趋势", chart_type="line")
  说明：先查数据，再生成图表

"对比南宁和柳州2023年受灾人口，用柱状图"
推荐方案：
  ① compare_entities(entity_names=["南宁市","柳州市"], time_range=["2023-01-01","2023-12-31"], compare_attributes=["受灾人口"])
  ② generate_chart(data=<对比结果>, chart_type="bar")

⚠️ **图表生成注意事项**：
- 必须先有数据（≥3条记录），再生成图表
- ChartAgent 不查询数据，只负责数据→图表配置转换
- 如果查询结果 < 3 条，应告知用户数据量不足，无法生成有意义的图表

🔹 **精确Cypher查询**（高级用户）
"查询所有包含'潘厂水库'的状态节点"
→ execute_cypher_query(cypher="MATCH (s:State) WHERE s.id CONTAINS '潘厂水库' RETURN s LIMIT 10")

**工具选择决策树**

```
问题分析
    ├─ 是否涉及应急预案/规范标准？
    │   ├─ 是（包含"应急响应"、"预案"、"措施"、"标准"、"流程"、"启动条件"等）
    │   │   ├─ 仅查预案 → query_emergency_plan
    │   │   └─ 需结合历史数据 → query_nl + query_emergency_plan（混合检索）
    │   └─ 否 → 继续判断（查图谱）
    │
    ├─ 是否要求数据可视化？
    │   ├─ 是（包含"图表"、"图形"、"可视化"、"趋势图"、"柱状图"等）
    │   │   └─ 查询工具 + generate_chart（两步法）
    │   │       ⚠️ 注意：先查数据（≥3条），再生成图表
    │   └─ 否 → 继续判断
    │
    ├─ 是否涉及时间？
    │   ├─ 是 → 问题是否包含"具体事件+年份"？
    │   │   ├─ 是（如"潘厂水库2020年影响"）→ 先用 query_nl 获取状态ID，再用 find_causal_chain
    │   │   └─ 否（如"2017年广西损失"）→ 直接用 query_nl 或 aggregate_statistics
    │   └─ 否 → 继续判断
    │
    ├─ 是否是对比分析？
    │   ├─ 是（包含"比较"、"对比"、"vs"等）→ compare_entities
    │   │   └─ 如果要求图表 → + generate_chart
    │   └─ 否 → 继续判断
    │
    ├─ 是否是因果关系？
    │   ├─ 是（包含"导致"、"影响"、"原因"等）→ 
    │   │   ├─ 有明确时间 → query_nl + find_causal_chain（两步法）
    │   │   └─ 无时间限制 → 直接 find_causal_chain
    │   └─ 否 → 继续判断
    │
    ├─ 是否是统计聚合？
    │   ├─ 是（包含"总计"、"平均"、"最多"、"统计"等）→ aggregate_statistics
    │   └─ 否 → 继续判断
    │
    ├─ 是否是趋势分析？
    │   ├─ 是（包含"趋势"、"变化"、"增长"等）→ analyze_temporal_pattern
    │   │   └─ 如果要求图表 → + generate_chart
    │   └─ 否 → 继续判断
    │
    ├─ 是否是空间关系？
    │   ├─ 是（包含"周边"、"附近"、"邻近"等）→ get_spatial_neighbors
    │   └─ 否 → 继续判断
    │
    ├─ 是否需要精确控制查询？
    │   ├─ 是（问题复杂，query_nl多次失败）→ execute_cypher_query
    │   └─ 否 → 使用 query_knowledge_graph_with_nl ⭐（万能工具）
    │
    └─ 是否有明确筛选条件？
        ├─ 是（按类别、来源、地点筛选）→ search_knowledge_graph
        │   ├─ 查基础实体（名称、位置）→ category='地点'/'设施'/'事件'
        │   └─ 查时序数据（降雨、损失）→ category='State'
        └─ 否 → 使用 query_knowledge_graph_with_nl ⭐
```

**快速参考表**

| 关键词 | 推荐工具 | 注意事项 |
|--------|---------|---------|
| 应急响应、预案、措施、标准、流程 | query_emergency_plan | 查规范文档，非历史数据 |
| 图表、图形、可视化、趋势图 | 查询工具 → generate_chart | ⚠️两步法！数据≥3条 |
| 损失、受灾、影响（无明确因果） | query_nl 或 aggregate | 自动覆盖所有State类型 |
| 导致、造成、影响（有因果关系） | query_nl → find_causal_chain | ⚠️两步法！先获取状态ID |
| 原因、溯源（反向因果） | find_causal_chain | direction="backward" |
| 比较、对比 | compare_entities | 至少2个实体 |
| 总计、平均、最大、最小 | aggregate_statistics | 明确aggregation类型 |
| 趋势、变化 | analyze_temporal_pattern | 必须提供时间范围 |
| 周边、附近、邻近 | get_spatial_neighbors | radius控制层级 |
| 按来源/类别筛选（基础实体） | search(category='地点/设施/事件') | 查实体本身 |
| 按时间/损失筛选（状态数据） | search(category='State') | ⚠️时间范围只对State有效 |
| 复杂/模糊/多条件 | query_nl ⭐ | 最智能，优先使用 |

**多步推理策略（重要！）**

🎯 **何时需要多步？何时一步就够？**

**一步到位场景**（直接调用一个工具即可）：
- ✅ "2020年广西的洪涝事件" → query_nl
- ✅ "南宁市2023年的受灾人口总数" → aggregate_statistics
- ✅ "比较南宁和柳州" → compare_entities
- ✅ "南宁市周边的设施" → get_spatial_neighbors

**必须多步场景**（工具之间有依赖关系）：
- ⚠️ "潘厂水库2020年泄洪的影响" → 
  ① query_nl获取2020年状态ID → ② find_causal_chain追踪影响
  原因：find_causal_chain不支持时间过滤
  
- ⚠️ "哪些事件导致了大规模受灾" → 
  ① aggregate找到受灾人口最多的状态 → ② find_causal_chain追溯原因
  原因：需要先识别"大规模"是哪些

- ⚠️ "实体ID为L-450100的所有关系及其属性统计" →
  ① get_entity_relations获取关系 → ② 针对关联实体调用aggregate
  原因：需要先知道关联了哪些实体

**可选多步场景**（一步可行，但多步更精确）：
- 🔄 "2017年广西损失详情"
  方案A：query_nl（一步，快速但可能不精确）
  方案B：query_nl → aggregate（两步，更准确的统计）
  建议：先尝试A，如果LLM判断需要精确统计再用B

**禁止无效多步**（浪费资源）：
- ❌ query_nl → query_nl（参数相同或相似）
- ❌ search → query_nl（功能重复）
- ❌ aggregate → aggregate（同一指标重复计算）
- ❌ 连续3次调用同一工具（陷入循环）

**智能决策规则**：
1. ✅ **优先一步解决**：除非工具明确不支持某功能，否则先尝试一个工具
2. ✅ **基于结果判断**：第一个工具返回数据后，判断是否足够回答
3. ✅ **传递状态ID**：如果第一步获得了实体ID/状态ID，第二步要用上
4. ⚠️ **最多2-3步**：超过3步说明策略有问题，应重新思考
5. ⚠️ **空结果处理**：如果工具返回空，不要重复调用，换个角度或直接告知用户
6. ❌ **禁止为了多步而多步**：不是步骤越多越好！

**多步推理模板**：

```
场景1：因果链+时间限制
用户问："潘厂水库2020年6月的泄洪造成了什么影响？"
步骤1: query_nl(question="潘厂水库2020年6月的泄洪状态")
步骤2: 提取state_id（如FS-F-450381-潘厂水库-20200607_20200607）
步骤3: find_causal_chain(start_event="FS-F-450381-潘厂水库-20200607_20200607", direction="forward")

场景2：先筛选再统计
用户问："2019年导致经济损失超过1亿的事件有哪些？"
步骤1: query_nl(question="2019年的灾害事件及经济损失")
步骤2: LLM从结果中筛选损失>1亿的（无需再调工具）

场景3：先定位再分析趋势
用户问："受灾最严重的市在2018-2020年的趋势"
步骤1: aggregate(attribute="受灾人口", aggregation="max", time_range=["2018-01-01","2020-12-31"], group_by="source")
步骤2: 提取受灾最多的市名（如"南宁市"）
步骤3: analyze_temporal_pattern(entity_name="南宁市", start_date="2018-01-01", end_date="2020-12-31")

场景4：混合检索（图谱+预案）
用户问："南宁市降雨300mm应启动什么级别的应急响应？"
步骤1: query_nl(question="南宁市降雨300mm的历史灾害情况")
步骤2: query_emergency_plan(query="降雨量应急响应启动标准")
步骤3: LLM综合两个结果给出建议

场景5：数据查询+可视化
用户问："南宁市2020-2023年受灾人口变化趋势图"
步骤1: query_nl(question="南宁市2020-2023年受灾人口数据")
步骤2: 检查数据量（必须≥3条）
步骤3: generate_chart(data=<查询结果>, question="南宁市2020-2023年受灾人口趋势", chart_type="line")

场景6：对比分析+图表
用户问："对比南宁和柳州2023年受灾情况，用柱状图显示"
步骤1: compare_entities(entity_names=["南宁市","柳州市"], time_range=["2023-01-01","2023-12-31"], compare_attributes=["受灾人口","经济损失"])
步骤2: generate_chart(data=<对比结果>, chart_type="bar")
```

**关键原则：每一步必须有明确的信息增益！不要为了查询而查询！**

⚠️ **特别注意：图表生成工作流**
1. ChartAgent 不查询数据，只负责数据→图表配置的转换
2. 必须先调用查询工具获取数据（≥3条记录）
3. 将查询结果作为 data 参数传给 generate_chart
4. 如果数据量 < 3 条，应告知用户无法生成有意义的图表

现在开始回答用户问题！"""

        # 构建消息
        messages = [{"role": "system", "content": system_prompt}]
        
        # 添加对话历史
        if conversation_history:
            for msg in conversation_history[-4:]:
                if msg.get('role') in ['user', 'assistant']:
                    messages.append({
                        "role": msg['role'],
                        "content": msg['content']
                    })
        
        # 添加当前问题
        messages.append({"role": "user", "content": user_question})
        
        # 记录所有工具调用
        all_tool_calls = []
        max_iterations = 10  # 最多迭代5次，防止无限循环
        iteration = 0
        total_valid_results = 0  # 累积有效结果的工具调用数
        
        while iteration < max_iterations:
            iteration += 1
            logger.info(f'迭代 {iteration}: 调用 LLM')
            
            # 调用 LLM
            response = requests.post(
                f"{api_endpoint}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json"
                },
                json={
                    "model": model_name,
                    "messages": messages,
                    "tools": tools,
                    "tool_choice": "auto",
                    "temperature": 0.3
                },
                timeout=60
            )
            
            if response.status_code != 200:
                logger.error(f'LLM API 调用失败: {response.text}')
                return jsonify({
                    'success': False,
                    'message': f'LLM API 调用失败: {response.text}'
                }), 500
            
            result = response.json()
            assistant_message = result['choices'][0]['message']
            
            # 检查是否有工具调用
            tool_calls = assistant_message.get('tool_calls', [])
            
            if not tool_calls:
                # 没有工具调用，说明 LLM 已经生成了最终答案
                final_answer = assistant_message.get('content', '')
                logger.info(f'LLM 生成最终答案（共使用 {len(all_tool_calls)} 个工具）')
                
                return jsonify({
                    'success': True,
                    'data': {
                        'answer': final_answer,
                        'tool_calls': all_tool_calls,
                        'iterations': iteration
                    }
                })
            
            # 添加助手消息到历史
            messages.append(assistant_message)
            
            # 执行所有工具调用
            logger.info(f'执行 {len(tool_calls)} 个工具调用（累计有效结果: {total_valid_results}）')
            
            current_iteration_has_result = False  # 本次迭代是否有有效结果
            
            for tool_call in tool_calls:
                tool_name = tool_call['function']['name']
                arguments = json.loads(tool_call['function']['arguments'])
                tool_call_id = tool_call['id']
                
                logger.info(f'  - 工具: {tool_name}, 参数: {json.dumps(arguments, ensure_ascii=False)[:100]}...')
                
                # 执行工具
                tool_result = execute_tool(tool_name, arguments)
                
                # 检查工具是否返回了有效数据
                tool_has_data = False
                result_count = 0
                if tool_result.get('success') and tool_result.get('data'):
                    # 检查数据是否非空
                    data = tool_result.get('data', {})
                    if isinstance(data, dict):
                        # 检查是否有实质性内容（支持所有工具的返回字段）
                        if (data.get('entities') or data.get('query_results') or 
                            data.get('nodes') or data.get('records') or 
                            data.get('chains') or data.get('neighbors') or 
                            data.get('comparison') or data.get('result') or
                            data.get('results') or  # 向量检索结果
                            data.get('total_results', 0) > 0 or
                            data.get('count', 0) > 0):
                            tool_has_data = True
                            current_iteration_has_result = True
                            total_valid_results += 1
                            # 计算记录数（优先使用count字段，然后尝试列表长度）
                            result_count = (
                                data.get('total_results') or 
                                data.get('count') or 
                                len(data.get('entities') or data.get('query_results') or 
                                    data.get('nodes') or data.get('records') or 
                                    data.get('results') or  # 向量检索结果
                                    data.get('chains') or data.get('neighbors') or [])
                            )
                    elif isinstance(data, list) and len(data) > 0:
                        tool_has_data = True
                        current_iteration_has_result = True
                        total_valid_results += 1
                        result_count = len(data)
                
                logger.info(f'    结果: {"✅ 有效" if tool_has_data else "❌ 空"} ({result_count}条记录)')
                
                # 记录工具调用
                all_tool_calls.append({
                    'name': tool_name,
                    'arguments': arguments,
                    'result': tool_result
                })
                
                # 将工具结果添加到消息历史（带提示）
                result_content = json.dumps(tool_result, ensure_ascii=False)
                
                # 根据工具执行情况添加不同的提示
                if tool_has_data:
                    # 有数据：提供信息但不限制后续调用
                    result_content += f"\n\n[系统提示] ✅ 成功获取{result_count}条记录。你可以：\n1. 如果数据足够回答问题，直接生成答案\n2. 如果需要进一步分析（如追踪因果链、统计汇总），继续调用相关工具"
                else:
                    # 无数据：根据情况给出建议
                    if total_valid_results > 0:
                        result_content += f"\n\n[系统提示] ⚠️ 此工具未返回数据，但之前已有{total_valid_results}个工具返回了有效结果。建议：\n1. 优先基于已有数据回答\n2. 如果确实需要，可以尝试不同的查询角度（但避免重复相同查询）"
                    else:
                        result_content += "\n\n[系统提示] ❌ 此工具未返回有效数据。建议：\n1. 如果尝试次数已多，直接告知用户数据不存在\n2. 如果还有其他查询角度，可以尝试一次"
                
                messages.append({
                    'role': 'tool',
                    'tool_call_id': tool_call_id,
                    'name': tool_name,
                    'content': result_content
                })
            
            # 智能停止策略：区分"多步推理"和"无效重复"
            should_force_stop = False
            stop_reason = ""
            
            # 情况1: 前3次迭代完全无结果 → 可能数据不存在
            if iteration >= 3 and total_valid_results == 0:
                should_force_stop = True
                stop_reason = "前3次查询均无结果，数据可能不存在"
            
            # 情况2: 已有结果，但LLM连续2次调用相同工具 → 可能陷入循环
            elif len(all_tool_calls) >= 5 and total_valid_results > 0:
                # 检查最近3次工具调用是否重复
                recent_tools = [tc['name'] for tc in all_tool_calls[-3:]]
                if len(set(recent_tools)) <= 1:  # 连续调用同一工具
                    should_force_stop = True
                    stop_reason = f"连续调用{recent_tools[0]}工具，可能陷入循环"
            
            # 情况3: 已经调用了5个以上工具 → 防止过度查询
            elif len(all_tool_calls) >= 6:
                should_force_stop = True
                stop_reason = f"已调用{len(all_tool_calls)}个工具（含{total_valid_results}个有效），应该足够回答"
            
            if should_force_stop:
                logger.warning(f'智能停止触发: {stop_reason}')
                messages.append({
                    'role': 'user',
                    'content': f'[系统] {stop_reason}。请基于已有信息（{total_valid_results}个工具返回了数据）直接回答用户问题。不要再调用工具。'
                })
        
        # 达到最大迭代次数
        logger.warning(f'达到最大迭代次数 {max_iterations}')
        return jsonify({
            'success': False,
            'message': f'处理超时：达到最大迭代次数 {max_iterations}',
            'tool_calls': all_tool_calls
        }), 500
        
    except Exception as e:
        logger.error(f'GraphRAG查询错误: {e}')
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'message': str(e)
        }), 500


@graphrag_bp.route('/cypher/execute', methods=['POST'])
def execute_custom_cypher():
    """执行自定义Cypher查询（供高级用户使用）"""
    try:
        data = request.get_json()
        cypher = data.get('cypher', '').strip()
        
        if not cypher:
            return jsonify({
                'success': False,
                'message': 'Cypher语句不能为空'
            }), 400
        
        # 安全检查：禁止修改操作
        cypher_upper = cypher.upper()
        dangerous_keywords = ['CREATE', 'DELETE', 'SET', 'REMOVE', 'MERGE', 'DROP']
        for keyword in dangerous_keywords:
            if keyword in cypher_upper:
                return jsonify({
                    'success': False,
                    'message': f'不允许执行包含{keyword}操作的查询'
                }), 403
        
        
#         cypher = '''
# MATCH (s:State)
# WHERE s.id = 'FS-F-450381-潘厂水库-20200607_20200607'
# MATCH (s)<-[:hasRelation*0..]-(es)
# WHERE es.id contains 'ES-'
# MATCH (e:`事件`) WHERE e.id in es.entity_ids
# RETURN e.name as name, e.geo_description as geo_description
#         '''
        query_result = execute_cypher(cypher)
        
        return jsonify({
            'success': True,
            'data': {
                'results': query_result.get('records', []),
                'count': len(query_result.get('records', [])),
                'graph_data': query_result.get('graph', {})
            }
        })
        
    except Exception as e:
        logger.error(f'执行自定义Cypher错误: {e}')
        return jsonify({
            'success': False,
            'message': str(e)
        }), 500
