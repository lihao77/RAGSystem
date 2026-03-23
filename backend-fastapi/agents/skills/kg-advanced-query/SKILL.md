---
name: kg-advanced-query
description: 知识图谱高级查询技能，通过执行自定义 Cypher 语句实现多跳推理、时序聚合、因果路径发现、空间关系分析与空间数据导出等复杂查询场景。当基础查询工具无法满足需求，或需要从知识图谱获取空间分析结果、边界/河流等几何数据时使用此 Skill。
---

## 知识图谱结构说明

### 一、节点类型与ID规范

#### 1. 基础实体节点（标签带 :entity）
   - **事件节点** (:事件:entity)
     - ID格式: `E-<行政区划码>-<日期>-<事件类型>`
     - 示例: `E-450000-20231001-TYPHOON`
     - 属性: id, name, geo_description, source, geometry(wkt)
   
   - **地点节点** (:地点:entity)
     - ID格式: `L-<行政区划码>[>子区域]` 或 `L-RIVER-<名称>`
     - 示例: `L-450100`（南宁市）, `L-450103>新竹街道`, `L-RIVER-长江`
     - 属性: id, name, geo_description, geometry(wkt), admin_level（查询请勿使用此属性）
   
   - **设施节点** (:设施:entity)
     - ID格式: `F-<行政区划码>-<设施名称>`
     - 示例: `F-420500-三峡大坝`, `F-450381-潘厂水库`
     - 属性: id, name, geo_description, facility_type, geometry(wkt)

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

## 可用脚本

## 空间数据获取说明

- 该 Skill 不仅能回答事实性和关系性问题，还可以从知识图谱中获得空间数据。
- 需要查询区域内事件、设施、下级区域及其空间影响时，优先使用 `spatial_impact.py`。
- 需要导出行政区边界、河流线、或可直接用于地图渲染的 GeoJSON / `bindmap_ready` 图层时，使用 `geo_export.py`。
- 如果用户目标是“拿到空间数据用于后续制图、叠加分析或地图展示”，应优先想到这两个脚本，而不是只返回文本答案。

### entity_detail.py
**功能**：实体详情查询，获取实体的完整属性、标签、状态统计及因果关联数量

**参数**：
- `--entity`（必填）：实体名称或 ID 关键词，如 `"潘厂水库"` 或 `"F-450381-潘厂水库"`
- `--include-states`（可选）：同时返回最近的状态列表
- `--state-limit`（可选）：返回的最近状态数，默认 20

**调用示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "entity_detail.py",
    "arguments": ["--entity", "潘厂水库", "--include-states"]
  }
}
```

---

### temporal_extract.py
**功能**：时序数据提取，获取指定实体某属性在时间范围内的完整时间序列及基本统计。
支持**属性名模糊匹配**（`--fuzzy`）和**含单位数值解析**（如 `"199.70米"` → `199.70`）。
精确匹配失败时自动返回 `attr_suggestion` 字段，列出可用属性名。

**参数**：
- `--entity`（必填）：实体名称或 ID 关键词
- `--attr`（必填）：属性名称，如 `"水位"`、`"降雨量"`
- `--start`（可选）：开始日期 `YYYY-MM-DD`
- `--end`（可选）：结束日期 `YYYY-MM-DD`
- `--limit`（可选）：最大记录数，默认 500
- `--fuzzy`（可选）：精确属性名不存在时自动扩展为 CONTAINS 匹配

**调用示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "temporal_extract.py",
    "arguments": ["--entity", "潘厂水库", "--attr", "水位",
                  "--start", "2020-01-01", "--end", "2020-12-31"]
  }
}
```

---

### causal_trace.py
**功能**：因果链追踪，从事件状态出发沿因果关系链（hasRelation）溯源或追踪后果。

**三层锚点解析策略**（逐层尝试，找到即停止）：
- **Layer 1**：State ID / entity_ids / state_type 直接包含关键词（最快）
- **Layer 2**：通过事件实体 `hasState + nextState*` 展开全部 State（处理实体 ID 与 State ID 不一致的情况）
- **Layer 3**：通过 `contain` 关系找到的父级 State

**关键词选择建议**（按效果排序）：
1. 英文事件类型（推荐）：`FLOOD`、`HEAVY_RAIN`、`TYPHOON` → Layer 1 直接命中，链路最多
2. 中文事件名称：`"洪水"` → 通过 Layer 2 展开，可找到因果链
3. 完整实体 ID：`"E-450000-20200529-FLOOD"` → Layer 1 精确命中，结果精准

**诊断机制**：
- 锚点未找到时：返回候选事件列表和已有因果关系的状态
- 锚点找到但无链时：返回锚点的直接邻居关系，提示正确方向

返回结果包含 `anchor_layer` 字段，说明实际使用了哪层解析策略。

**参数**：
- `--event`（必填）：事件名称、实体 ID 或 state_type 关键词（推荐英文类型如 `FLOOD`）
- `--direction`（可选）：`upstream`（追溯原因）/ `downstream`（追踪后果）/ `both`，默认 `upstream`
- `--depth`（可选）：最大追踪深度，默认 3（因果链通常 1-2 层）
- `--limit`（可选）：每个锚点返回的最大路径数，默认 50

**调用示例 1 - 分析强降雨的后果（推荐写法）**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "causal_trace.py",
    "arguments": ["--event", "HEAVY_RAIN", "--direction", "downstream", "--depth", "2"]
  }
}
```

**调用示例 2 - 用事件 ID 精确查询双向因果**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "causal_trace.py",
    "arguments": ["--event", "E-450000-20200529-FLOOD", "--direction", "both", "--depth", "2"]
  }
}
```

**调用示例 3 - 分析洪水成因**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "causal_trace.py",
    "arguments": ["--event", "洪水", "--direction", "upstream", "--depth", "3"]
  }
}
```

---

### region_aggregate.py
**功能**：区域聚合统计，按行政区域下各子实体聚合某属性的统计指标。
支持**属性名模糊匹配**（`--fuzzy`）和**含单位数值解析**（在 Python 侧处理，绕过 Cypher toFloat 限制）。
**结果为空时**自动返回 `diagnosis` 字段，包含该区域可用属性列表和全局属性变体。

**参数**：
- `--region`（必填）：区域名称或 ID 前缀，如 `"广西"` 或 `"L-45"`
- `--attr`（必填）：属性名称，如 `"降雨量"`、`"受灾人口"`
- `--start`（可选）：开始日期 `YYYY-MM-DD`
- `--end`（可选）：结束日期 `YYYY-MM-DD`
- `--agg`（可选）：聚合方式 `sum/avg/max/min/count`，默认 `sum`
- `--limit`（可选）：最大返回实体数，默认 100
- `--fuzzy`（可选）：精确属性名不存在时自动扩展为 CONTAINS 匹配

**调用示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "region_aggregate.py",
    "arguments": ["--region", "L-45", "--attr", "降雨量",
                  "--start", "2023-06-01", "--end", "2023-09-30", "--agg", "sum"]
  }
}
```

---

### time_aggregate.py
**功能**：时间聚合统计，按时间粒度（日/周/月/年）分桶聚合实体属性，揭示变化趋势。
支持**属性名模糊匹配**（`--fuzzy`）和**含单位数值解析**（在 Python 侧聚合，绕过 Cypher toFloat 限制）。

**参数**：
- `--entity`（必填）：实体名称或 ID 关键词
- `--attr`（必填）：属性名称
- `--start`（可选）：开始日期 `YYYY-MM-DD`
- `--end`（可选）：结束日期 `YYYY-MM-DD`
- `--interval`（可选）：时间粒度 `day/week/month/year`，默认 `month`
- `--agg`（可选）：聚合方式 `sum/avg/max/min/count`，默认 `avg`
- `--limit`（可选）：最大原始记录数，默认 200
- `--fuzzy`（可选）：精确属性名不存在时自动扩展为 CONTAINS 匹配

**调用示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "time_aggregate.py",
    "arguments": ["--entity", "潘厂水库", "--attr", "水位",
                  "--start", "2020-01-01", "--end", "2020-12-31",
                  "--interval", "month", "--agg", "avg"]
  }
}
```

---

### spatial_impact.py
**功能**：空间影响分析，给定一个地点，查找其空间关联的子区域、设施、事件及其状态属性。
走 `locatedIn`（行政层级）和 `occurredAt`（事件发生地）关系，填补现有脚本不能遍历空间关系图的空白。

**四种模式**：
- `subregions`：查找该地点的直接下级行政区及其状态（`locatedIn` 反向）
- `facilities`：查找位于该区域内的所有设施及其状态（`locatedIn` 1-3跳）
- `events`：查找发生在该区域（含子区域）的所有事件及其状态（`occurredAt`）
- `all`：三者合并（默认）

**参数**：
- `--location`（必填）：地点名称或 ID，如 `"南宁市"` 或 `"L-450100"`
- `--mode`（可选）：`subregions/facilities/events/all`，默认 `all`
- `--start`（可选）：开始日期 `YYYY-MM-DD`
- `--end`（可选）：结束日期 `YYYY-MM-DD`
- `--attr`（可选）：属性关键词过滤，如 `"受灾人口"`（CONTAINS 匹配）
- `--limit`（可选）：每种模式最大返回数，默认 100

**调用示例 1 - 查询南宁市范围内的所有设施及受灾情况**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "spatial_impact.py",
    "arguments": ["--location", "南宁市", "--mode", "facilities",
                  "--start", "2023-06-01", "--end", "2023-09-30",
                  "--attr", "受灾"]
  }
}
```

**调用示例 2 - 查询广西范围内发生的所有洪涝事件**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "spatial_impact.py",
    "arguments": ["--location", "L-45", "--mode", "events",
                  "--start", "2020-01-01", "--end", "2020-12-31"]
  }
}
```

---

### event_summary.py
**功能**：事件影响汇总，一次调用完成"因果链遍历 + 属性收集 + 结构化聚合"。
替代原来需要先 `causal_trace.py` 拿 state ID 再手写 Cypher 查属性的两步工作流。

**执行流程**：
1. 三层锚点解析（与 causal_trace.py 相同策略）
2. 沿 `hasRelation` 下游遍历受影响 State
3. 拉取每个受影响 State 的属性
4. 按实体类型（地点/设施/事件）和属性名汇总
5. 返回汇总表 + 月度分布 + 各实体详情

**返回结构**：
- `summary.affected_state_count`：受影响状态总数
- `summary.by_entity_type`：按实体类型分布（地点/设施/事件各多少）
- `summary.key_attributes`：各属性的统计（总量、最大值、影响实体数）
- `summary.monthly_distribution`：按月统计的受影响数量
- `affected_entities`：每个受影响实体的详细状态和属性

**参数**：
- `--event`（必填）：事件关键词、实体 ID 或 state_type（推荐英文如 `FLOOD`、`HEAVY_RAIN`）
- `--depth`（可选）：下游因果链深度，默认 2
- `--start`（可选）：开始日期 `YYYY-MM-DD`
- `--end`（可选）：结束日期 `YYYY-MM-DD`
- `--attrs`（可选）：逗号分隔的属性关键词，如 `"受灾人口,直接经济损失"`（空=全部属性）
- `--limit`（可选）：最大受影响状态数，默认 200

**调用示例 1 - 2020年广西洪水影响汇总（关注人口和经济损失）**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "event_summary.py",
    "arguments": ["--event", "FLOOD",
                  "--start", "2020-01-01", "--end", "2020-12-31",
                  "--attrs", "受灾人口,直接经济损失,紧急转移人口",
                  "--depth", "2"]
  }
}
```

**调用示例 2 - 精确事件 ID 的完整影响分析**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "event_summary.py",
    "arguments": ["--event", "E-450000-20200529-FLOOD", "--depth", "2"]
  }
}
```

---

### explore.py
**功能**：查询前数据探索，了解实体/区域的可用属性名称、时间范围、样本值。
**建议在不确定属性名时优先调用此脚本**，而不是猜测属性名。

**参数（四种模式，选其一）**：
- `--entity <关键词>`：查看指定实体的所有可用属性及时间覆盖
  - `--attr <关键词>`：配合 `--entity` 过滤属性名（CONTAINS 匹配）
- `--region <关键词> --time-range`：查看区域内各属性的时间覆盖范围
- `--list-events`：列出图谱中所有事件实体（辅助 causal_trace.py 找关键词）
- `--global-attrs`：列出全图所有属性类型及记录数（快速了解数据全貌）

**调用示例 1 - 查看实体可用属性**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "explore.py",
    "arguments": ["--entity", "潘厂水库"]
  }
}
```

**调用示例 2 - 过滤属性关键词**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "explore.py",
    "arguments": ["--entity", "潘厂水库", "--attr", "水位"]
  }
}
```

**调用示例 3 - 查看全图属性列表**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "explore.py",
    "arguments": ["--global-attrs"]
  }
}
```

**调用示例 4 - 列出所有事件实体**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "explore.py",
    "arguments": ["--list-events"]
  }
}
```

---

### query.py
**功能**：执行任意 Cypher 查询语句，返回 JSON 格式结果

**参数**：
- `--cypher`（必填）：Cypher 查询语句
- `--params`（可选）：查询参数，JSON 字符串，默认 `{}`
- `--limit`（可选）：最大返回行数，默认 100（查询中已有 LIMIT 时自动跳过）

**执行示例 1 - 直接通过状态ID过滤**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "query.py",
    "arguments": [
      "--cypher",
      "MATCH (s:State) WHERE s.id CONTAINS $state_keyword AND s.start_time >= date($start_date) AND s.end_time <= date($end_date) OPTIONAL MATCH (s)-[ha:hasAttribute]->(attr:Attribute) RETURN s.id, s.time, ha.type AS attr_name, attr.value LIMIT 50",
      "--params",
      "{\"state_keyword\": \"潘厂水库\", \"start_date\": \"2020-01-01\", \"end_date\": \"2020-12-31\"}"
    ]
  }
}
```

**执行示例 2 - 通过状态ID前缀+实体名过滤**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "query.py",
    "arguments": [
      "--cypher",
      "MATCH (s:State) WHERE s.id STARTS WITH $state_prefix AND s.time CONTAINS $time_contains OPTIONAL MATCH (s)-[ha:hasAttribute]->(attr:Attribute) WHERE ha.type IN $attr_types RETURN s.id, s.time, ha.type, attr.value LIMIT 50",
      "--params",
      "{\"state_prefix\": \"LS-L-450100\", \"time_contains\": \"2023-10\", \"attr_types\": [\"降雨量\", \"受灾人口\"]}"
    ]
  }
}
```

**执行示例 3 - 通过entity_ids数组过滤**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "query.py",
    "arguments": [
      "--cypher",
      "MATCH (s:State) WHERE ANY(eid IN s.entity_ids WHERE eid CONTAINS $entity_keyword1 OR eid CONTAINS $entity_keyword2) AND s.start_time >= date($start_date) OPTIONAL MATCH (s)-[ha:hasAttribute]->(attr:Attribute) RETURN s.id, s.entity_ids, ha.type, attr.value LIMIT 50",
      "--params",
      "{\"entity_keyword1\": \"潘厂水库\", \"entity_keyword2\": \"L-450100\", \"start_date\": \"2020-01-01\"}"
    ]
  }
}
```

**执行示例 4 - 因果链查询（直接从状态开始）**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "query.py",
    "arguments": [
      "--cypher",
      "MATCH (targetState:State) WHERE targetState.id CONTAINS $target_state_keyword AND targetState.start_time >= date($start_date) MATCH p = (startState:State)-[:hasRelation*0..3]->(targetState) WHERE startState.id CONTAINS $start_state_prefix WITH p, nodes(p) AS ns, relationships(p) AS rs CALL (ns) { WITH ns UNWIND ns AS n OPTIONAL MATCH (n)-[ha:hasAttribute]->(a:Attribute) WITH n, collect({type: ha.type, value: a.value}) AS attrs RETURN collect({id: n.id, attrs: attrs}) AS node_infos } RETURN node_infos, [r IN rs | {start: startNode(r).id, end: endNode(r).id, type: type(r)}] AS rels LIMIT 20",
      "--params",
      "{\"target_state_keyword\": \"潘厂水库\", \"start_date\": \"2020-01-01\", \"start_state_prefix\": \"ES-\"}"
    ]
  }
}
```

**执行示例 5 - 需要基础实体信息时才从实体查起**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "query.py",
    "arguments": [
      "--cypher",
      "MATCH (entity:entity {name: $entity_name})-[:hasState]->(s0:State) OPTIONAL MATCH (s0)-[:nextState*0..]->(s:State) WHERE s.start_time >= date($start_date) OPTIONAL MATCH (s)-[ha:hasAttribute]->(attr:Attribute) RETURN entity.name, entity.admin_level, s.id, s.time, ha.type, attr.value LIMIT 50",
      "--params",
      "{\"entity_name\": \"南宁市\", \"start_date\": \"2023-10-01\"}"
    ]
  }
}
```

**执行示例 6 - 提取完整子图（包含属性）**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "query.py",
    "arguments": [
      "--cypher",
      "MATCH p = (...)... WITH p, nodes(p) AS ns, relationships(p) AS rs CALL (ns) { WITH ns UNWIND ns AS n OPTIONAL MATCH (n)-[ha:hasAttribute]->(a:Attribute) WITH n, collect(DISTINCT {type: ha.type, value: a.value}) AS attrs RETURN collect({id: n.id, label: labels(n), props: properties(n), attributes: attrs}) AS node_infos } WITH p, node_infos, [r IN rs | {start: startNode(r).id, end: endNode(r).id, type: type(r), props: properties(r)}] AS rel_infos RETURN node_infos AS nodes, rel_infos AS relationships",
      "--params",
      "{}"
    ]
  }
}
```

**执行示例 7 - 2019年广西受灾人口统计详情**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "query.py",
    "arguments": [
      "--cypher",
      "MATCH (s:State) WHERE s.start_time >= date($start_date) AND s.start_time <= date($end_date) AND s.id STARTS WITH $state_prefix MATCH (s)-[ha:hasAttribute]->(attr:Attribute) WHERE ha.type CONTAINS $attr_keyword AND attr.value IS NOT NULL WITH s, ha, attr MATCH (city:地点:entity) WHERE city.id IN s.entity_ids AND city.name IS NOT NULL RETURN city.name AS city_name, collect({type: ha.type, value: attr.value}) AS population_data LIMIT 100",
      "--params",
      "{\"start_date\": \"2019-01-01\", \"end_date\": \"2019-12-31\", \"state_prefix\": \"LS-L-45\", \"attr_keyword\": \"人口\"}"
    ]
  }
}
```

## 返回格式

```json
{
  "success": true,
  "data": {
    "records": [...],
    "count": 12
  }
}
```

如果失败：
```json
{
  "success": false,
  "error": "错误信息"
}
```

---

### geo_export.py
**功能**：从知识图谱导出地点/河流的几何数据（WKT → GeoJSON），输出 `bindmap_ready` 格式可直接传 `create_bindmap`。

**三种模式**：
- `boundary`：查询行政区划边界（POLYGON/POINT），可选包含子区域
- `river`：查询河流线型（LINESTRING），支持单条或全部
- `bindmap-layers`：组合查询，输出多图层底图

**参数**：
- `--type`（必填）：`boundary` / `river` / `bindmap-layers`
- `--name`（boundary/bindmap-layers 必填）：地点或河流名称
- `--include-children`（可选）：包含子区域（boundary 模式）
- `--all`（可选）：查询所有河流（river 模式）
- `--include`（可选）：逗号分隔的图层类型 `boundary,rivers,children`（bindmap-layers 模式，默认 `boundary,rivers`）

**调用示例 1 - 查询行政区划边界**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "geo_export.py",
    "arguments": ["--type", "boundary", "--name", "南宁市"]
  }
}
```

**调用示例 2 - 含子区域的边界**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "geo_export.py",
    "arguments": ["--type", "boundary", "--name", "南宁市", "--include-children"]
  }
}
```

**调用示例 3 - 查询河流走向**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "geo_export.py",
    "arguments": ["--type", "river", "--name", "柳江"]
  }
}
```

**调用示例 4 - 查询所有河流**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "geo_export.py",
    "arguments": ["--type", "river", "--all"]
  }
}
```

**调用示例 5 - 组合底图（行政边界+河流）**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "kg-advanced-query",
    "script_name": "geo_export.py",
    "arguments": ["--type", "bindmap-layers", "--name", "南宁市", "--include", "boundary,rivers"]
  }
}
```

**输出说明**：
- `data.features`：GeoJSON Feature 数组
- `data.bindmap_ready.layers`：可直接传 `create_bindmap` 的图层数组
- POLYGON/MULTIPOLYGON → `map_type: "choropleth"`
- LINESTRING/MULTILINESTRING → `map_type: "geojson"`
- POINT → `map_type: "marker"`
- 输出数据量可能较大（POLYGON 坐标），系统会自动落盘为 artifact
