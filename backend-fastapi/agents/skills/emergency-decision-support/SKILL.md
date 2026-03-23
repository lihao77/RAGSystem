---
name: emergency-decision-support
description: 广西洪涝灾害应急决策支持技能，提供完整的"态势研判→风险评估→预案匹配→行动清单→历史对比"决策工作流。
---

## 应急决策工作流

本 Skill 提供洪涝灾害应急决策的完整流程，包含五个步骤：

### 步骤 1：态势研判（situation_assess.py）
聚合当前气象、水文、预警数据，形成态势概览。

### 步骤 2a：快速风险评估（assess_flood_risk.py）⭐
直接按广西防汛四级响应阈值评估风险等级，同时返回完整应急响应措施。
支持 --batch 批量评估多地点，输出可直接用于构造 create_risk_map 数据。

### 步骤 2b：风险矩阵计算（risk_matrix.py）
基于态势数据和广西防汛四级响应标准，计算综合风险等级（多维度加权）。

### 步骤 3：预案推荐（plan_recommend.py）
根据风险等级和灾害类型，检索并推荐最相关的预案条款。

### 步骤 4：行动清单生成（action_checklist.py）
将匹配到的应急响应措施转换为可执行的行动清单（JSON 格式）。

### 步骤 5：历史事件对比（historical_compare.py）
通过知识图谱查找历史上相似的洪涝事件，对比分析提供参考。

## 决策流程说明

典型使用流程：
1. 先调用 `situation_assess.py` 收集当前态势数据
2. 用态势数据调用 `risk_matrix.py` 得到风险等级
3. 用风险等级调用 `plan_recommend.py` 获取预案推荐
4. 调用 `action_checklist.py` 生成结构化行动清单
5. 可选：调用 `historical_compare.py` 对比历史事件

也可以根据已有数据跳过某些步骤，例如已知风险等级时直接从步骤 3 开始。

## 可用脚本

### assess_flood_risk.py ⭐ 推荐首选
**功能**：洪涝风险等级评估 - 内嵌广西防汛四级响应阈值，同时返回对应应急响应措施

**特点**：
- 纯本地计算，无需联网，响应极快
- `--batch` 支持多城市批量评估，输出可直接用于 `create_risk_map`
- 返回结果包含 `risk_level`、`risk_color`、`risk_factors`、完整 `response` 措施

**参数**：
- `--location`（单次必填）：地点名称，如"南宁市"
- `--batch`（批量必填）：JSON 数组，每项含 `location` + 数据字段
- `--rainfall`（可选）：24小时实际降雨量（mm）
- `--forecast-rainfall`（可选）：未来24小时预报降雨量（mm）
- `--water-level`（可选）：当前水位（m）
- `--warning-level`（可选）：警戒水位（m），与 `--water-level` 配合计算超警幅度

**单次调用示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "emergency-decision-support",
    "script_name": "assess_flood_risk.py",
    "arguments": ["--location", "南宁市", "--rainfall", "180", "--water-level", "78.5", "--warning-level", "72.5"]
  }
}
```

**批量调用示例（推荐与 guangxi-flood-data/fetch_weather.py 配合使用）**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "emergency-decision-support",
    "script_name": "assess_flood_risk.py",
    "arguments": [
      "--batch",
      "[{\"location\":\"南宁市\",\"rainfall_24h\":180},{\"location\":\"桂林市\",\"rainfall_24h\":120,\"water_level\":148.5,\"warning_level\":146.0},{\"location\":\"柳州市\",\"rainfall_24h\":95}]"
    ]
  }
}
```

**批量输出结构**：
```json
{
  "total": 3,
  "summary": {"I": 0, "II": 1, "III": 1, "IV": 1, "无": 0},
  "results": [
    {
      "location": "南宁市",
      "risk_level": "II",
      "risk_label": "重大",
      "risk_color": "orange",
      "risk_factors": ["降雨量 180mm ≥ II级阈值 ..."],
      "assessment": "南宁市当前评估为 II 级（重大）洪涝风险...",
      "response": {
        "name": "II级应急响应",
        "command_authority": "...",
        "key_actions": [...],
        "time_requirements": [...],
        "resource_mobilization": [...]
      }
    }
  ]
}
```

**与 create_risk_map.py 配合的完整推理链**：
```
1. guangxi-flood-data/fetch_weather.py --batch "14市" → 获取 rainfall_24h_mm
2. guangxi-geodata/geocode.py --batch "14市" → 获取 wkt 坐标
3. 组装 [{location, geometry, rainfall_24h, ...}] JSON
4. create_risk_map.py --data "[...]" → 自动评估+生成风险地图 artifact
```

---

### query_plan.py
**功能**：应急预案向量检索 - 通过语义搜索返回最相关的预案内容片段

**参数**：
- `--query`（必填）：查询内容，如"三级防汛应急响应启动条件"
- `--plan-type`（可选）：预案类型过滤（防汛/抗旱/台风/地质灾害/综合）
- `--top-k`（可选）：返回结果数量，默认 5，最大 20

**调用示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "emergency-decision-support",
    "script_name": "query_plan.py",
    "arguments": ["--query", "广西三级防汛应急响应启动条件", "--top-k", "3"]
  }
}
```

---

### create_risk_map.py
**功能**：批量风险评估 + 自动生成风险地图（输出 artifact 协议，系统自动持久化）

**参数**：
- `--data`（必填）：JSON 数组，每项含 location/geometry + 气象水文字段
- `--title`（可选）：地图标题
- `--disaster-type`（可选）：灾害类型，默认"洪涝"

**调用示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "emergency-decision-support",
    "script_name": "create_risk_map.py",
    "arguments": ["--data", "[{\"location\":\"南宁市\",\"geometry\":\"POINT (108.32 22.82)\",\"rainfall_24h\":150},{\"location\":\"桂林市\",\"geometry\":\"POINT (110.29 25.27)\",\"rainfall_24h\":80}]", "--title", "广西防汛风险评估"]
  }
}
```

---

### situation_assess.py
**功能**：态势研判 - 聚合气象/水文/预警数据，生成态势概览

**参数**：
- `--location`（必填）：评估地点名称，如"南宁市"
- `--rainfall`（可选）：24小时实际降雨量（mm）
- `--forecast-rainfall`（可选）：未来24小时预报降雨量（mm）
- `--water-level`（可选）：当前水位（m）
- `--warning-level`（可选）：警戒水位（m）
- `--warnings`（可选）：当前生效的预警信息（JSON 字符串）

**调用示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "emergency-decision-support",
    "script_name": "situation_assess.py",
    "arguments": ["--location", "南宁市", "--rainfall", "180", "--water-level", "78.5", "--warning-level", "77.0"]
  }
}
```

---

### risk_matrix.py
**功能**：风险矩阵计算 - 基于多维度数据计算综合风险等级

**参数**：
- `--location`（必填）：地点名称
- `--rainfall`（可选）：24小时降雨量（mm）
- `--forecast-rainfall`（可选）：预报降雨量（mm）
- `--water-level`（可选）：当前水位（m）
- `--warning-level`（可选）：警戒水位（m）
- `--affected-population`（可选）：受影响人口数
- `--dam-risk`（可选）：水库风险等级（none/low/medium/high）

**调用示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "emergency-decision-support",
    "script_name": "risk_matrix.py",
    "arguments": ["--location", "南宁市", "--rainfall", "200", "--water-level", "79.0", "--warning-level", "77.0"]
  }
}
```

---

### plan_recommend.py
**功能**：预案推荐 - 调用向量库检索与风险等级匹配的预案条款

**参数**：
- `--risk-level`（必填）：风险等级（I/II/III/IV）
- `--disaster-type`（可选）：灾害类型，默认"洪涝"
- `--location`（可选）：地点，增加检索精度
- `--top-k`（可选）：返回条目数，默认 5

**调用示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "emergency-decision-support",
    "script_name": "plan_recommend.py",
    "arguments": ["--risk-level", "III", "--disaster-type", "洪涝", "--location", "南宁市"]
  }
}
```

---

### match_response.py
**功能**：响应匹配 - 对原 `match_emergency_response` 工具的 1:1 Skill 化封装，返回推荐预案与可执行行动清单

**参数**：
- `--risk-level`（必填）：风险等级（I/II/III/IV）
- `--disaster-type`（可选）：灾害类型，默认"洪涝"
- `--affected-area`（可选）：受影响区域
- `--top-k`（可选）：预案检索返回条目数，默认 5

**调用示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "emergency-decision-support",
    "script_name": "match_response.py",
    "arguments": ["--risk-level", "III", "--disaster-type", "洪涝", "--affected-area", "南宁市"]
  }
}
```

---

### action_checklist.py
**功能**：行动清单生成 - 将响应措施转换为带优先级和时限的可执行清单

**参数**：
- `--risk-level`（必填）：风险等级（I/II/III/IV）
- `--disaster-type`（可选）：灾害类型，默认"洪涝"
- `--affected-area`（可选）：受影响区域
- `--format`（可选）：输出格式 json/text，默认 json

**调用示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "emergency-decision-support",
    "script_name": "action_checklist.py",
    "arguments": ["--risk-level", "II", "--disaster-type", "洪涝", "--affected-area", "南宁市"]
  }
}
```

---

### historical_compare.py
**功能**：历史事件对比 - 调用知识图谱查找相似历史事件，对比分析

**参数**：
- `--location`（必填）：地点
- `--disaster-type`（可选）：灾害类型关键词，默认"FLOOD"
- `--start`（可选）：历史查询起始日期 YYYY-MM-DD
- `--end`（可选）：历史查询结束日期 YYYY-MM-DD
- `--rainfall`（可选）：当前降雨量（mm），用于对比
- `--limit`（可选）：返回事件数，默认 5

**调用示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "emergency-decision-support",
    "script_name": "historical_compare.py",
    "arguments": ["--location", "南宁市", "--disaster-type", "FLOOD", "--rainfall", "200"]
  }
}
```
