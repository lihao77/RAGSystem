# -*- coding: utf-8 -*-
"""
GraphRAG服务 - 知识图谱问答核心业务逻辑
"""

import logging
import json
from model_adapter import get_default_adapter
from services.query_service import get_query_service
from config import get_config

logger = logging.getLogger(__name__)


# 图谱Schema描述（完整版本，从原文件提取）
GRAPH_SCHEMA_DESCRIPTION = """
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

6. **提取完整子图（包含属性）**：
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


CYPHER_GENERATION_PROMPT = """你是一个Neo4j Cypher查询专家，专门处理广西洪涝灾害知识图谱查询。

{schema_description}

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
       collect({{attr: attr.value}}) as attributes
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


ANSWER_GENERATION_PROMPT = """你是一个知识图谱问答助手。根据用户的问题和从知识图谱中查询到的结果，生成准确、详细的回答。

要求：
1. 回答要基于查询结果，不要编造信息
2. 如果查询结果为空，礼貌地告诉用户没有找到相关信息
3. 组织好回答的结构，使用markdown格式
4. 对于数字统计，要给出具体数值
5. 如果结果很多，可以总结要点
"""


class GraphRAGService:
    """GraphRAG服务类"""

    def __init__(self):
        self.adapter = get_default_adapter()
        self.query_service = get_query_service()
        self.config = get_config()
    
    def generate_cypher(self, user_question, conversation_history=None):
        """
        使用LLM生成Cypher查询语句
        
        Args:
            user_question: 用户问题
            conversation_history: 对话历史
            
        Returns:
            str: Cypher查询语句，失败返回None
        """
        try:
            # 构建系统提示词
            system_prompt = CYPHER_GENERATION_PROMPT.format(
                schema_description=GRAPH_SCHEMA_DESCRIPTION
            )
            
            # 构建消息
            messages = [{"role": "system", "content": system_prompt}]
            
            # 添加对话历史
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
            
            # 调用LLM
            result = self.adapter.chat_completion(
                messages=messages,
                provider=self.config.llm.provider,
                model=self.config.llm.model_name,
                temperature=0.1,
                max_tokens=1500
            )

            if result.error:
                logger.error(f'LLM调用失败: {result.error}')
                return None

            cypher = result.content.strip()
            
            # 清理Cypher语句
            cypher = self._clean_cypher(cypher)
            
            logger.info(f'LLM生成的Cypher: {cypher}')
            return cypher
            
        except Exception as e:
            logger.error(f'生成Cypher语句失败: {e}')
            return None
    
    def generate_answer(self, user_question, query_results, cypher, conversation_history=None):
        """
        使用LLM基于查询结果生成回答
        
        Args:
            user_question: 用户问题
            query_results: 查询结果
            cypher: 执行的Cypher语句
            conversation_history: 对话历史
            
        Returns:
            str: 生成的回答
        """
        try:
            # 简化查询结果
            simplified_results = self._simplify_results(query_results)
            results_str = json.dumps(simplified_results, ensure_ascii=False)
            
            # 限制结果长度
            if len(results_str) > 4000:
                results_str = results_str[:4000] + '...(结果已截断)'
            
            # 构建消息
            messages = [{"role": "system", "content": ANSWER_GENERATION_PROMPT}]
            
            # 添加对话历史
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
            
            # 调用LLM
            result = self.adapter.chat_completion(
                messages=messages,
                provider=self.config.llm.provider,
                model=self.config.llm.model_name,
                temperature=0.7,
                max_tokens=1500
            )

            if result.error:
                logger.error(f'LLM调用失败: {result.error}')
                raise Exception(f'LLM服务调用失败: {result.error}')

            answer = result.content
            logger.info(f'LLM生成的回答: {answer[:100]}...')
            return answer
            
        except Exception as e:
            logger.error(f'生成回答失败: {e}')
            raise
    
    def _clean_cypher(self, cypher):
        """清理Cypher语句，移除markdown标记等"""
        if '```' in cypher:
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
        
        return cypher
    
    def _simplify_results(self, query_results, max_records=10):
        """简化查询结果，避免token过多"""
        limited_results = query_results[:max_records]
        
        simplified_results = []
        for record in limited_results:
            simplified = {}
            for key, value in record.items():
                if isinstance(value, (str, int, float, bool)) or value is None:
                    simplified[key] = value
                elif isinstance(value, list) and len(value) < 50:
                    simplified[key] = value[:20]
                elif isinstance(value, dict) and len(str(value)) < 500:
                    simplified[key] = value
                else:
                    simplified[key] = f"<数据过大，已省略，类型:{type(value).__name__}>"
            simplified_results.append(simplified)
        
        return simplified_results


# 全局单例
_graphrag_service = None


def get_graphrag_service():
    """获取GraphRAG服务单例"""
    global _graphrag_service
    if _graphrag_service is None:
        _graphrag_service = GraphRAGService()
    return _graphrag_service
