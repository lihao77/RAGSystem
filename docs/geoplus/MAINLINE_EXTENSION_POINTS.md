# 主线需先补齐的扩展点清单

本文列出 GeoPLUS 启动前，主线仓库应优先补齐的扩展点。目标不是提前把 Geo 功能做进主线，而是让主线具备稳定承载 GeoPLUS 的能力。

## 1. 目标

主线需要做到两件事：

- 对 GeoPLUS 暴露稳定扩展面
- 在不引入 Geo 专属负担的前提下容纳新型地图与多模态结果

换句话说，主线要支持“GeoPLUS 能接得上”，而不是“主线自己变成 Geo 系统”。

## 2. 扩展点分组

建议优先补齐以下 6 组扩展点：

1. 可视化结果扩展点
2. 事件流与执行观测扩展点
3. 工具注册与工具结果扩展点
4. 多模态输入与结构化输出扩展点
5. 前端工作台容器扩展点
6. 测试与兼容性扩展点

## 3. 可视化结果扩展点

### 3.1 现状

当前系统已经有图表和地图展示能力，但两者仍然偏“工具输出结果”，没有形成统一的场景对象协议。

相关现状文件：

- `backend-fastapi/tools/presentation_store.py`
- `backend-fastapi/tools/tool_executor_modules/visualization_tools.py`
- `frontend-client/src/components/MapRenderer.vue`
- `frontend-client/src/components/ChartRenderer.vue`

### 3.2 主线应补内容

主线应抽象统一的“可视化资产”协议，至少包含：

- `presentation_type`
- `presentation_id`
- `source_tool`
- `source_call_id`
- `title`
- `summary`
- `payload`
- `metadata`

其中 `presentation_type` 不应只限于 `chart`，而应允许未来扩展：

- `chart`
- `map`
- `geo_layer`
- `geo_scene`
- `timeline`

### 3.3 价值

- GeoPLUS 可以直接在统一协议上挂 `geo_layer` / `geo_scene`
- 主线无需提前知道全部 Geo 细节
- 前后端展示链路复用现有机制

## 4. 事件流与执行观测扩展点

### 4.1 现状

当前事件系统已经较完整，适合承载 GeoPLUS 的实时图层更新与时序播放。

相关文件：

- `backend-fastapi/agents/events/bus.py`
- `backend-fastapi/agents/events/publisher.py`
- `backend-fastapi/agents/events/sse_adapter.py`
- `backend-fastapi/services/execution_service.py`

### 4.2 主线应补内容

新增一套稳定的可视化事件语义，而不是让 GeoPLUS 自定义散乱 payload。

建议新增事件类型或标准 payload 字段：

- `presentation.created`
- `presentation.updated`
- `presentation.published`
- `presentation.removed`

事件 payload 最少包含：

- `presentation_id`
- `presentation_type`
- `session_id`
- `run_id`
- `revision`
- `metadata`

### 4.3 价值

- GeoPLUS 可实时增量更新地图图层
- 图表、地图、时序对象未来可共享一套流式发布协议
- 执行回放、审计与调试更统一

## 5. 工具注册与工具结果扩展点

### 5.1 现状

主线已有较完整的工具定义、权限和执行器体系。

相关文件：

- `backend-fastapi/tools/catalog/`
- `backend-fastapi/tools/tool_definition_builder.py`
- `backend-fastapi/tools/result_schema.py`
- `backend-fastapi/tools/result_normalizer.py`
- `backend-fastapi/tools/permissions.py`

### 5.2 主线应补内容

主线应明确支持“新工具源”和“新结果类型”的非侵入式接入：

- 允许增加新的 tool source 分类而不修改主逻辑
- 允许结果标注 `output_type`
- 允许结果直接引用 `presentation_id`

建议工具结果统一补充这些字段：

- `output_type`
- `structured_content`
- `presentations`
- `references`
- `artifacts`

### 5.3 价值

- Geo 工具可以自然返回 GeoJSON、图层定义、场景定义
- 不需要在执行器里写大量 Geo 特判
- 主线协议对未来其他 Plus 版本也有价值

## 6. 多模态输入与结构化输出扩展点

### 6.1 现状

当前系统有文档读取、结构化抽取、地图/图表展示的基础，但“多模态输入到统一结构化对象”的主线接口还不够明确。

相关文件：

- `backend-fastapi/tools/catalog/document_tools.py`
- `frontend-client/src/components/MultimodalContent.vue`
- `frontend-client/src/components/MapRenderer.vue`

### 6.2 主线应补内容

主线需要定义“多模态观察结果”的统一结构，而不是让各工具自由返回。

建议新增统一输出模型概念：

- `ObservationRecord`
- `EntityRecord`
- `FeatureRecord`
- `EvidenceRecord`

至少统一这些字段：

- `type`
- `modality`
- `source`
- `timestamp`
- `confidence`
- `attributes`

GeoPLUS 之后可以在其上扩展：

- 地理坐标
- geometry
- 行政区
- 时空范围

### 6.3 价值

- 文本抽取、图片抽取、地图落图走同一条结果转换链
- GeoPLUS 只需要追加地理字段
- 主线不会被 Geo 语义污染

## 7. 前端工作台容器扩展点

### 7.1 现状

前端已有聊天、监控、向量库管理等页面，但缺少“统一场景工作台容器”。

相关文件：

- `frontend-client/src/views/ChatViewV2.vue`
- `frontend-client/src/views/AgentMonitor.vue`
- `frontend-client/src/components/ContextSnapshotDrawer.vue`
- `frontend-client/src/components/ExecutionDiagnosticsDrawer.vue`

### 7.2 主线应补内容

主线建议抽一个通用工作台容器能力，而不是让 GeoPLUS 直接复制聊天页。

建议补齐：

- 可插拔右侧场景面板区域
- 可插拔底部时序/证据/诊断面板区域
- 可订阅统一 presentation 事件的数据层
- 场景对象状态管理

GeoPLUS 才能在其上叠加：

- 地图主画布
- 图层管理
- 时序播放
- 证据联动

### 7.3 价值

- 避免 GeoPLUS fork 整个聊天页
- 主线未来也能复用此容器支持别的增强工作台

## 8. 测试与兼容性扩展点

### 8.1 主线应补内容

主线在开始支持 Plus 仓库前，应先把兼容性测试面补齐：

- 工具定义快照测试
- 工具结果 schema 测试
- SSE 事件 payload 快照测试
- presentation 协议快照测试
- API 合同测试

### 8.2 价值

- GeoPLUS 在同步主线后能快速发现断裂点
- 避免“主线小改动，GeoPLUS 大面积失效”

## 9. 优先级排序

建议按以下顺序推进：

### P0：先做

- 统一 presentation 协议
- 统一 presentation 事件协议
- 工具结果增加 `output_type` / `presentations`
- SSE 事件 contract 固化

### P1：随后做

- 多模态结构化输出统一模型
- 前端工作台容器扩展
- presentation 状态管理抽象

### P2：再做

- 更细的 API 合同测试
- 更细的扩展插件化加载机制

## 10. 对当前仓库的直接建议

结合当前代码结构，建议主线先从以下位置开始补：

后端：

- `backend-fastapi/tools/presentation_store.py`
- `backend-fastapi/tools/result_schema.py`
- `backend-fastapi/tools/result_normalizer.py`
- `backend-fastapi/agents/events/bus.py`
- `backend-fastapi/agents/events/publisher.py`
- `backend-fastapi/agents/events/sse_adapter.py`

前端：

- `frontend-client/src/views/ChatViewV2.vue`
- `frontend-client/src/components/MapRenderer.vue`
- `frontend-client/src/components/ChartRenderer.vue`
- 新增统一的 presentation store 或 composable

## 11. 不应提前做进主线的内容

以下内容不建议提前放入主线：

- 具体 Geo API
- 具体 Geo Tools
- 具体 Geo Scene 数据模型细节
- 地图工作台页面
- 时空分析逻辑
- 遥感/无人机专属流程

这些应保留在 GeoPLUS 中，主线只提供承载它们的接口面。

## 12. 一句话原则

主线先补“扩展点”，GeoPLUS 再补“能力”。

主线不预埋业务负担，但必须预埋承载能力。
