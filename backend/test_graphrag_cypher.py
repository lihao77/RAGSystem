#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
测试GraphRAG Cypher生成功能
"""

import sys
import json
import logging
import requests

from config import get_config

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# 模拟图谱schema
mock_schema = {
    'labels': ['事件', '地点', '设施', 'entity', 'State', 'Attribute'],
    'relationships': ['hasState', 'nextState', 'contain', 'hasRelation', 'hasAttribute', 'locatedIn', 'occurredAt'],
    'node_properties': {
        '事件': ['id', 'name', 'geo_description', 'source'],
        '地点': ['id', 'name', 'geo_description', 'admin_level'],
        '设施': ['id', 'name', 'geo_description', 'facility_type'],
        'State': ['id', 'state_type', 'time', 'start_time', 'end_time', 'entity_ids'],
        'Attribute': ['id', 'value']
    },
    'relationship_patterns': [
        {'from': '事件', 'relationship': 'hasState', 'to': 'State'},
        {'from': '地点', 'relationship': 'hasState', 'to': 'State'},
        {'from': '设施', 'relationship': 'hasState', 'to': 'State'},
        {'from': 'State', 'relationship': 'nextState', 'to': 'State'},
        {'from': 'State', 'relationship': 'hasRelation', 'to': 'State'},
        {'from': 'State', 'relationship': 'hasAttribute', 'to': 'Attribute'}
    ]
}

# 测试问题集
test_questions = [
    "查询潘厂水库在2020年的应急响应情况",
    "查找南宁市在2023年10月的降雨量和受灾人口",
    "三峡大坝的泄洪对下游造成了什么影响",
    "查找台风事件导致的地点受灾情况",
    "广西2020年的洪涝灾害有哪些",
]

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

### 一、节点类型
1. **基础实体节点**（标签带 :entity）
   - 事件节点 (:事件:entity): 台风、洪水等灾害事件
     - 属性: id, name, geo_description, source
   - 地点节点 (:地点:entity): 行政区域、河流等
     - 属性: id, name, geo_description, admin_level, has_spatial_hierarchy
   - 设施节点 (:设施:entity): 水库、大坝、水文站等
     - 属性: id, name, geo_description, facility_type

2. **状态节点** (:State)
   - 事件状态 (ES-*): 事件在特定时间的演化状态
   - 地点状态 (LS-*): 地点在特定时间的灾情状态
   - 设施状态 (FS-*): 设施在特定时间的运行状态
   - 联合状态 (JS-*): 多个实体的联合统计状态
   - 关键属性: id, state_type, time, start_time, end_time, entity_ids

3. **属性节点** (:Attribute)
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

### 三、查询模式规范

**重要规则：**
1. 状态节点通过hasAttribute关系连接到Attribute节点，属性名在关系的type字段，属性值在Attribute节点的value字段
2. 基础实体通过hasState关系连接到首个状态，后续状态通过nextState链接
3. 状态之间的因果关系只在State节点之间通过hasRelation建立，type属性记录关系类型
4. 查询时优先从基础实体入口，再展开状态链，最后提取属性

**查询模板：**
1. 查询实体的所有状态及属性：
```cypher
MATCH (entity {name: $name})-[:hasState]->(s0:State)
OPTIONAL MATCH (s0)-[:nextState*0..]->(s:State)
OPTIONAL MATCH (s)-[ha:hasAttribute]->(attr:Attribute)
RETURN s.id AS state_id, s.time, ha.type AS attr_name, attr.value AS attr_value
```

2. 查询因果链（从原因到结果）：
```cypher
MATCH (target)-[:hasState]->(ts0:State)
OPTIONAL MATCH (ts0)-[:nextState*0..]->(targetState:State)
WHERE targetState.start_time >= date($startDate) AND targetState.end_time <= date($endDate)
MATCH p = (startState:State)-[:hasRelation*1..3]->(targetState)
WHERE startState.id CONTAINS 'ES'
WITH p, nodes(p) AS pathNodes, relationships(p) AS pathRels
UNWIND pathNodes AS n
OPTIONAL MATCH (n)-[ha:hasAttribute]->(a:Attribute)
RETURN n.id AS node_id, labels(n) AS labels, properties(n) AS props,
       collect({type: ha.type, value: a.value}) AS attributes
```

3. 模糊查询（地名或属性包含关键字）：
```cypher
MATCH (loc:地点)
WHERE toLower(loc.name) CONTAINS toLower($keyword)
MATCH (loc)-[:hasState]->(ls0:State)
OPTIONAL MATCH (ls0)-[:nextState*0..]->(ls:State)
OPTIONAL MATCH (ls)-[ha:hasAttribute]->(attr:Attribute)
WHERE toLower(ha.type) CONTAINS toLower($metricKeyword)
RETURN loc.name, ls.time, ha.type, attr.value
```

4. 提取完整子图（包含属性）：
必须使用子查询收集节点属性，格式如下：
```cypher
MATCH p = (...)...
WITH p, nodes(p) AS ns, relationships(p) AS rs
CALL {
  WITH ns
  UNWIND ns AS n
  OPTIONAL MATCH (n)-[ha:hasAttribute]->(a:Attribute)
  WITH n, collect(DISTINCT {type: ha.type, value: a.value}) AS attrs
  RETURN collect({
    id: n.id,
    label: labels(n),
    props: properties(n),
    attributes: attrs
  }) AS node_infos
}
WITH p, node_infos,
     [r IN rs | {start: startNode(r).id, end: endNode(r).id, type: type(r), props: properties(r)}] AS rel_infos
RETURN node_infos AS nodes, rel_infos AS relationships
```
"""
        
        system_prompt = """你是一个Neo4j Cypher查询专家，专门处理广西洪涝灾害知识图谱查询。

""" + schema_desc + """

## 生成要求：
1. **只返回Cypher查询语句**，不要任何解释或markdown标记
2. **必须遵循上述查询模板**，尤其是属性提取方式
3. 对于时间过滤，使用date()函数：date('2020-01-01')
4. 对于模糊匹配，使用CONTAINS或正则表达式=~
5. 如需提取属性，必须通过hasAttribute关系到Attribute节点
6. 返回完整子图时，必须使用CALL子查询收集属性
7. 限制返回数量，避免过大结果集（LIMIT 50以内）

## 常见问题类型识别：
- "查找XX的状态/情况" → 从实体入口展开状态链，提取属性
- "XX导致了什么" → 使用hasRelation {{type:"导致"}}追踪因果
- "XX到YY的影响路径" → 使用hasRelation*1..N查找状态间路径
- "XX时间段的XX指标" → 过滤start_time/end_time，匹配hasAttribute的type
- "包含XX关键字" → 使用CONTAINS或=~进行模糊匹配
"""
        
        # 构建消息
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"用户问题：{user_question}\n\n请生成对应的Cypher查询语句："}
        ]
        
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

def test_cypher_generation():
    """测试Cypher生成"""
    print("=" * 80)
    print("开始测试GraphRAG Cypher生成功能")
    print("=" * 80)
    
    success_count = 0
    fail_count = 0
    
    for i, question in enumerate(test_questions, 1):
        print(f"\n测试 {i}/{len(test_questions)}")
        print(f"问题: {question}")
        print("-" * 80)
        
        try:
            cypher = generate_cypher_with_llm(question, mock_schema)
            
            if cypher:
                print("✓ 生成成功")
                print(f"生成的Cypher:\n{cypher}")
                success_count += 1
                
                # 基本验证
                cypher_upper = cypher.upper()
                if 'MATCH' in cypher_upper:
                    print("✓ 包含MATCH语句")
                if 'RETURN' in cypher_upper:
                    print("✓ 包含RETURN语句")
                if ':State' in cypher or ':Attribute' in cypher:
                    print("✓ 使用了状态或属性节点")
                if 'hasAttribute' in cypher or 'hasRelation' in cypher:
                    print("✓ 使用了正确的关系类型")
            else:
                print("✗ 生成失败 - 返回None")
                fail_count += 1
                
        except Exception as e:
            print(f"✗ 生成失败 - 异常: {e}")
            fail_count += 1
        
        print("-" * 80)
    
    print("\n" + "=" * 80)
    print(f"测试完成: 成功 {success_count}/{len(test_questions)}, 失败 {fail_count}/{len(test_questions)}")
    print("=" * 80)
    
    return success_count == len(test_questions)

if __name__ == '__main__':
    try:
        success = test_cypher_generation()
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        print("\n测试被用户中断")
        sys.exit(1)
    except Exception as e:
        logger.error(f"测试过程出错: {e}", exc_info=True)
        sys.exit(1)
