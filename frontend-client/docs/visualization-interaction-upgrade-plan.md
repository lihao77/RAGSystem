# 前端可视化与交互升级计划

状态: 计划中  
更新时间: 2026-05-19  
范围: `frontend-client/` 为主，少量后端 artifact / execution 协议协同  
目标版本: 分阶段落地，不绑定一次性大版本

本文档定义 RAGSystem 前端在可视化产物、地图/图表交互、运行过程可观测和长流式交互体验上的升级路线。计划基于当前 Vue 3 + ECharts + Leaflet + WebSocket 执行流架构推进，避免重写聊天页和 Agent 运行时。

## 背景

当前前端已经具备以下基础能力:

- `VisualizationLoader.vue` 支持按 artifact id 异步加载 `chart` / `map` / `image`。
- `ChartRenderer.vue` 使用 ECharts 渲染图表，支持全屏和 PNG 导出。
- `MapRenderer.vue` 使用 Leaflet 渲染 heatmap / marker / circle / choropleth / geojson / bindmap / risk 等地图类型。
- `ArtifactPanel.vue` 能从 assistant 消息正文中的 `[viz:artifact_id]` 提取可视化产物入口。
- `WorkPanel.vue` 承载运行状态、执行树、审批、用户输入和 artifact 面板。
- `useSessionRunStream.js` 统一消费 WebSocket 事件，驱动消息流、执行步骤和运行状态。
- `executionProjector.js` 已经将 canonical `execution.step` 投影为执行树视图。

主要短板不在基础组件缺失，而在可视化数据协议、交互闭环、可观测维度和大数据/长输出场景的稳定性。

## 总目标

1. 让可视化产物从“正文占位符解析”升级为“结构化 artifact 模型”。
2. 让图表和地图从“静态展示”升级为“可筛选、可钻取、可追问”的分析界面。
3. 让执行过程从“树形调试信息”升级为“可定位瓶颈、耗时、失败和等待原因”的运行观察面板。
4. 降低长回答、密集事件和大地图数据对前端渲染的压力。
5. 保持现有聊天、WebSocket、执行 projector 和 artifact API 的兼容迁移路径。

## 非目标

- 不重写后端 Agent 编排器。
- 不替换 Vue / ECharts / Leaflet 技术栈。
- 不引入重型 UI 框架。
- 不一次性改造所有历史 artifact 数据。
- 不把所有可视化渲染逻辑塞回 `ChatViewV2.vue`。

## 设计原则

- 消息正文展示最终回答，artifact 元数据独立承载结构化产物信息。
- 图表、地图、图片、表格和未来产物都走统一 registry，而不是在 loader 中持续堆 `if/else`。
- 前端交互产生的筛选、框选、点击追问应形成明确事件，不直接拼接自然语言散落在组件内部。
- 运行可观测面板优先解释“现在发生了什么”和“为什么卡住”，再提供完整原始日志。
- 对长流式输出做批量刷新，对大数据图层做分层加载，避免靠用户设备性能硬撑。

## 阶段 0: 基线梳理与 Smoke 场景

状态: 已完成

目标:
- 明确当前可视化与交互链路的实际表现。
- 建立升级前的性能和可用性基线。

范围:
- `src/components/VisualizationLoader.vue`
- `src/components/ChartRenderer.vue`
- `src/components/MapRenderer.vue`
- `src/components/chat/ArtifactPanel.vue`
- `src/components/workpanel/WorkPanel.vue`
- `src/composables/useSessionRunStream.js`
- `src/utils/executionProjector.js`

任务:
- [x] 列出当前 artifact 数据结构样例: chart / map / image / risk map / bindmap。
- [x] 记录当前流式消息、地图和执行树的性能风险基线。
- [x] 为 smoke 截图增加聊天页 artifact 场景。
- [x] 在 smoke 场景中覆盖内联图表、右侧 artifact 面板和 WorkPanel 执行过程。
- [x] 保持 smoke 场景不依赖真实后端 artifact API。

当前 artifact 基线:

| 类型 | 当前入口 | 当前数据形态 | 主要风险 |
|------|----------|--------------|----------|
| chart | `VisualizationLoader.vue` → `ChartRenderer.vue` | `{ viz_type: 'chart', sub_type, title, config }`，`config` 是 ECharts option | 产物元数据与渲染配置混在一起；缺少 source step、缩略图、能力声明和结构化 artifact 列表 |
| map | `VisualizationLoader.vue` → `MapRenderer.vue` | `{ viz_type: 'map', title, config }`，`config.map_type` 支持 heatmap / marker / circle / choropleth / geojson / bindmap / risk | `downloadMap()` 仍是占位；大量 marker / GeoJSON 没有聚合或分块策略 |
| image | `VisualizationLoader.vue` 图片 fallback | `{ viz_type: 'image', title, image_url }` | 缺少统一 frame、下载、错误恢复和元数据展示 |
| risk map | `MapRenderer.vue` 的 `map_type='risk'` | markers + risk_legend + assessment_summary | 可进入态势大屏，但风险统计、追问和图层控制仍分散 |
| bindmap | `MapRenderer.vue` 的 `map_type='bindmap'` | `layers[]` + Leaflet layer control | 图层控制依赖 Leaflet 默认控件，缺少透明度、顺序和移动端收敛 |

当前性能与交互基线:

- artifact 发现仍以正文 `[viz:artifact_id]` 正则为主，`ArtifactPanel.vue` 与 `parseMessageParts()` 各自解析，后续需要结构化 artifact 模型统一来源。
- `output.chunk` 当前逐 chunk 追加并触发滚动；长输出时存在高频 Vue 更新和 markdown 重渲染风险。
- `execution.step` 当前即时投影执行树；step 数超过数百时 WorkPanel 刷新和列表渲染需要节流或虚拟化。
- `ChartRenderer.vue` 已注册 `DataZoomComponent`，但默认交互仍主要是全屏和 PNG 导出。
- `MapRenderer.vue` 支持多地图类型和图例，但地图截图下载未实现，大数据点位缺少聚合/分块策略。
- smoke 截图已经具备横向溢出检测，新增 `chat-artifact-narrow` 覆盖聊天页内联 artifact、右侧产物面板和执行过程。

验收:
- 已形成当前数据结构清单。
- 已明确后续阶段的对比指标。
- `npm run screenshot:smoke` 新增 artifact 场景并通过。
- 不改变生产用户可见行为，smoke fixture 仅在 Vite dev 模式且 URL 带 `?__smoke=artifact` 时启用。

回滚点:
- 删除 `src/utils/smokeFixtures.js`、`ChatViewV2.vue` 中的 dev-only fixture 分支，以及 `screenshot-smoke.mjs` 中的 `chat-artifact-narrow` 场景即可回滚。

## 阶段 1: 结构化 Artifact 模型

状态: 待开始

目标:
- 用结构化 artifact 列表替代仅从消息正文解析 `[viz:...]` 的方式。
- 保持旧消息正文占位符兼容。

建议数据模型:

```javascript
{
  id: 'viz_xxx',
  type: 'visualization',
  visualization_type: 'chart' | 'map' | 'image' | 'table' | 'report',
  title: 'xxx',
  subtitle: 'xxx',
  thumbnail_url: '/api/artifacts/...',
  source_message_id: 'msg_xxx',
  source_step_id: 'step_xxx',
  source_tool_name: 'create_chart',
  created_at: '2026-05-19T00:00:00Z',
  status: 'ready' | 'loading' | 'error',
  version: 1,
  capabilities: {
    fullscreen: true,
    download: true,
    drilldown: true,
    ask_agent: true
  }
}
```

前端任务:
- [ ] 新增 `src/utils/artifacts.js`，统一 normalize artifact 元数据。
- [ ] `ArtifactPanel.vue` 优先读取 `message.artifacts`，缺失时再回退解析 `[viz:...]`。
- [ ] `VisualizationLoader.vue` 接收 artifact 对象，兼容只传 `artifactId` 的旧用法。
- [ ] 在 artifact 面板展示 title、type、状态、来源工具和缩略图占位。
- [ ] 增加 artifact 加载失败、已删除、权限不足的统一错误态。

后端协同:
- [ ] assistant message 返回 `artifacts: []` 或 `metadata.artifacts: []`。
- [ ] `/api/artifacts/visualizations/{id}` 返回 `metadata` 与 `config` 分层。
- [ ] 历史消息接口补充 artifact sidecar，或提供按 message id 查询 artifacts 的接口。

验收:
- 新 artifact 消息不依赖正文正则也能展示产物面板。
- 旧 `[viz:viz_xxx]` 消息仍能渲染。
- 点击 artifact 面板项能定位到消息内联可视化。
- `npm run build`、`npm test` 通过。

回滚点:
- 保留 `[viz:...]` 解析路径；若结构化字段异常，前端自动回退旧逻辑。

## 阶段 2: Artifact Registry 与通用产物容器

状态: 待开始

目标:
- 将 `VisualizationLoader.vue` 中对 `chart/map/image` 的硬编码分发升级为 registry。
- 为未来 table / report / file preview / GeoJSON preview 留扩展位。

前端任务:
- [ ] 新增 `src/artifacts/registry.js`，按 artifact type 注册 renderer。
- [ ] 抽出 `ArtifactFrame.vue`，统一标题、工具栏、全屏、下载、错误、加载骨架。
- [ ] `ChartRenderer.vue` 和 `MapRenderer.vue` 只负责主体渲染，不再重复实现通用 frame 行为。
- [ ] 新增 `TableRenderer.vue` 的最小版本: 表头、分页、CSV 下载。
- [ ] 统一下载动作: PNG、CSV、JSON、GeoJSON 按类型分流。

验收:
- 新增一种 artifact 类型不需要修改 `VisualizationLoader.vue` 主分发逻辑。
- chart / map / image 旧功能不回退。
- frame 工具栏在移动端不溢出。

回滚点:
- registry 只包一层分发；可快速回退到原 loader 条件渲染。

## 阶段 3: 图表分析交互升级

状态: 待开始

目标:
- 让 ECharts 图表支持常用分析动作，而不是只看图和导出。

前端任务:
- [ ] 为 `ChartRenderer.vue` 增加内置 dataZoom 工具栏开关。
- [ ] 支持系列显示/隐藏、图例搜索和指标切换。
- [ ] 支持 chart type 切换: line / bar / scatter / pie 的安全子集。
- [ ] 支持选中数据点后打开上下文菜单: 复制值、查看原始行、让 Agent 分析该点。
- [ ] 增加“数据表”面板，展示当前图表使用的数据源。
- [ ] 增加 CSV / JSON 导出。
- [ ] 对异常值、峰值、低值提供可选标注层。

交互事件建议:

```javascript
{
  type: 'artifact.ask_agent',
  artifact_id: 'viz_xxx',
  selection: {
    kind: 'chart_point',
    series: '水位',
    x: '2026-05-19 08:00',
    y: 12.4,
    raw: {}
  },
  prompt_template: '请分析该数据点异常原因'
}
```

验收:
- 用户能在单个图表中完成缩放、查看明细、导出和追问。
- 大部分交互不需要重新请求后端。
- 图表全屏后交互状态保持。

回滚点:
- 图表工具栏功能按配置开关启用；默认可先只开放下载和全屏。

## 阶段 4: 地图交互与导出补齐

状态: 待开始

目标:
- 补齐地图真实下载能力。
- 增强图层、空间选择和位置追问。

前端任务:
- [ ] 实现 `MapRenderer.vue` 的真实地图截图导出，替换当前占位 alert。
- [ ] 增加底图切换: 明亮 / 深色 / 卫星或无底图。
- [ ] bindmap 图层增加可见性、透明度和顺序控制。
- [ ] marker 大量点位时启用聚合或抽样展示。
- [ ] GeoJSON 大 feature 集合增加简化或分块渲染策略。
- [ ] 增加框选/圈选工具，生成选区内点位列表。
- [ ] 点击 marker / region 后支持“让 Agent 分析该地点”。
- [ ] 图例支持折叠，移动端默认收敛。

后端协同:
- [ ] 对大 GeoJSON artifact 提供 bbox / simplify 参数。
- [ ] 对点位类 artifact 提供分页或瓦片化接口。

验收:
- 地图截图下载可用，不再弹占位提示。
- 大于 1000 个 marker 时页面仍可操作。
- 用户能从地图位置直接发起追问。
- 态势大屏中的地图交互不遮挡浮动对话面板。

回滚点:
- 聚合、框选、底图切换均作为可选控件逐步启用。

## 阶段 5: 运行过程可观测面板升级

状态: 待开始

目标:
- 将 WorkPanel 中的执行树升级为更适合诊断的运行观察面板。

前端任务:
- [ ] 在 `WorkPanelExecution.vue` 增加视图切换: 时间轴 / 树 / 原始事件。
- [ ] 基于 `executionProjector.rawSteps` 生成 step 时间轴。
- [ ] 显示每个 Agent、tool、subtask 的开始时间、结束时间和耗时。
- [ ] 突出等待状态: LLM 首 token、工具执行、后台任务、审批等待、用户输入等待。
- [ ] 汇总失败、重试、取消和超时节点。
- [ ] 支持按 agent / tool / status 筛选。
- [ ] 点击 timeline 节点时定位到对应执行树节点和结果 preview。

后端协同:
- [ ] canonical `execution.step` 确保携带稳定 `step_id`、`parent_step_id`、`call_id`、`timestamp`、`elapsed_time`。
- [ ] retry / approval / waiting 事件尽量带 `run_id` 与关联 step id。

验收:
- 用户能在 10 秒内判断任务卡在模型、工具、审批还是后台等待。
- 历史消息和实时运行都能使用同一套观察面板。
- 执行节点超过 200 个时仍可操作。

回滚点:
- 保留当前树视图作为默认视图；时间轴作为新 tab 渐进开放。

## 阶段 6: 长流式输出与密集事件性能优化

状态: 待开始

目标:
- 降低 WebSocket 高频事件导致的 Vue 重渲染和滚动抖动。

前端任务:
- [ ] 在 `useSessionRunStream.js` 对 `output.chunk` 做 buffer 合并。
- [ ] 使用 `requestAnimationFrame` 或短时间窗口批量更新 assistant 内容。
- [ ] 用户不在底部时暂停自动滚动，只显示“有新内容”提示。
- [ ] execution.step 密集到达时，对 WorkPanel 投影刷新做节流。
- [ ] 长消息列表启用或补齐虚拟滚动策略。
- [ ] 为 markdown 渲染增加按消息级缓存，避免流式阶段频繁全量解析。

验收:
- 长回答场景输入和滚动不明显卡顿。
- 事件顺序不被 buffer 破坏。
- `run.end` 后最终答案与服务端 `output.final_answer` 对齐。

回滚点:
- buffer 只影响 UI 刷新节奏，不改变 activeRun 状态机；可用 feature flag 关闭。

## 阶段 7: 态势大屏产品化

状态: 待开始

目标:
- 将当前 `SituationScreen.vue` 从地图全屏入口升级为可持续使用的态势工作台。

前端任务:
- [ ] 顶部展示风险等级、受影响区域、关键指标和更新时间。
- [ ] 左侧增加图层/指标控制。
- [ ] 右侧保留浮动对话面板，并支持引用当前地图选区。
- [ ] 底部增加事件时间轴或监测点趋势图。
- [ ] 支持从态势大屏一键生成研判摘要。
- [ ] 移动端提供只读优先布局，避免复杂多栏挤压。

验收:
- risk / bindmap artifact 可稳定进入态势大屏。
- 用户能在态势大屏里完成查看、筛选、追问、生成摘要。
- 关闭大屏后主聊天状态不丢失。

回滚点:
- 保留现有大屏入口和 MapRenderer 主体；新面板按区域逐步添加。

## 阶段 8: 测试与回归体系

状态: 持续

每个阶段至少执行:
- `npm run build`
- `npm test`
- `git diff --check`

关键 UI 阶段额外执行:
- `npm run screenshot:smoke`
- 手工检查暗色/亮色主题
- 手工检查 375px、768px、1440px 三类视口

建议新增测试:
- [ ] `ArtifactPanel` 结构化 artifacts 优先、`[viz:...]` 回退。
- [ ] `VisualizationLoader` registry 分发与错误态。
- [ ] `ChartRenderer` 导出、全屏、dataZoom 配置合并。
- [ ] `MapRenderer` 图层控制和下载入口。
- [ ] `useSessionRunStream` chunk buffer 顺序与 final answer 覆盖。
- [ ] `executionProjector` 时间轴派生数据。

手工回归清单:
- 新聊天发送普通问题。
- 生成 chart artifact 并查看、全屏、下载。
- 生成 map artifact 并查看、全屏、图层切换、下载。
- risk / bindmap 自动进入或手动进入态势大屏。
- 运行中切换历史会话再切回。
- 审批队列连续处理。
- 用户输入等待态提交。
- 长回答滚动和“滚动到底部”按钮。
- 暗色/亮色主题切换。

## 推荐实施顺序

1. 阶段 0: 基线梳理与 smoke 场景补齐。已完成
2. 阶段 1: 结构化 artifact 模型。
3. 阶段 2: Artifact registry 与通用产物容器。
4. 阶段 4: 地图真实导出与基础图层交互。
5. 阶段 3: 图表分析交互。
6. 阶段 5: 运行过程时间轴和诊断面板。
7. 阶段 6: 长流式输出性能优化。
8. 阶段 7: 态势大屏产品化。
9. 阶段 8: 持续测试与回归。

说明: 阶段 3 和阶段 4 可并行推进，但阶段 1 的结构化 artifact 模型应优先完成，否则后续交互事件很难稳定关联到消息、step 和 artifact。

## 风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| 新旧 artifact 数据并存 | 历史消息无法展示或重复展示 | `message.artifacts` 优先，`[viz:...]` 回退，按 id 去重 |
| 大 GeoJSON 或大量 marker 卡顿 | 地图不可操作 | 聚合、简化、bbox 加载和图层懒渲染 |
| chunk buffer 改变流式观感 | 用户感觉响应变慢 | buffer 窗口控制在 16ms-80ms，并在首 token 阶段立即显示 |
| 图表配置来源复杂 | 内置交互覆盖用户配置 | 只补默认配置，不强行覆盖用户显式配置 |
| WorkPanel 信息过载 | 用户找不到关键信息 | 默认显示摘要和异常，详细事件放入 raw tab |
| 后端协议改动排期不一致 | 前端无法等待结构化字段 | 所有新逻辑都提供旧协议兼容路径 |

## 完成定义

本计划完成时，前端应达到以下状态:

- artifact 面板不依赖消息正文正则作为唯一事实来源。
- 图表支持缩放、明细、导出和数据点追问。
- 地图支持真实下载、基础图层控制和地点/选区追问。
- WorkPanel 可以用时间轴解释运行瓶颈和等待原因。
- 长输出和密集执行事件不会明显拖慢聊天页。
- risk / bindmap 态势大屏具备可持续使用的分析工作台雏形。

## 执行记录

- 2026-05-19: 新增本升级计划文档，作为前端可视化与交互升级路线。
- 2026-05-19: 完成阶段 0。新增 dev-only `smokeFixtures.js` 与 `chat-artifact-narrow` 截图场景，覆盖内联 ECharts artifact、右侧 artifact 面板和 WorkPanel 执行过程；`npm run build`、`npm test`、`npm run screenshot:smoke` 通过。
