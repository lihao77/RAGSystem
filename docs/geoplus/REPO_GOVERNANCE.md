# GeoPLUS 仓库与分支治理规范

本文定义 `RAGSystem` 与 `RAGSystem-GeoPLUS` 的协作边界，目标是让 GeoPLUS 像 `CLI-PROXY-API-PLUS` 一样与主线锁步演进，而不是发展成长期漂移的产品分叉。

## 1. 仓库定位

### 1.1 主线仓库：`RAGSystem`

职责：

- 维护通用平台内核
- 对外提供稳定扩展点
- 承载所有非 Geo 专属能力
- 作为 GeoPLUS 的上游来源

主线包含但不限于：

- Agent Runtime、Execution、Event Bus、SSE
- Tool Registry、Tool Executor、权限审批
- Model Adapter、MCP、Skills
- Files、Vector、Conversation Store
- 通用多模态输入协议
- 通用可视化结果协议

### 1.2 增强仓库：`RAGSystem-GeoPLUS`

职责：

- 锁步跟随主线版本
- 只维护 Geo / 地图 / 时空分析 / Geo 工作台增强
- 对主线新能力做 Geo 侧适配
- 不承载主线通用能力的长期私有分叉

GeoPLUS 包含但不限于：

- Geo API、Geo Service、Geo Capability
- Geo Tools、时空分析工具、地理多模态工具
- Geo Schema、GeoScene、GeoLayer 协议实现
- GeoWorkspace、图层面板、时序播放、证据抽屉

## 2. 代码归属规则

所有改动先做一次分类判断：`通用能力` 还是 `Geo 专属能力`。

### 2.1 必须进主线的改动

满足以下任一条件，必须先进入主线：

- 对所有垂类都通用
- 属于现有核心链路的扩展点补强
- 会影响工具协议、事件协议、可视化协议、审批协议
- 会被 GeoPLUS 之外的版本复用
- 实际上是内核 Bug 修复或架构收敛

典型例子：

- 扩展 `tools/catalog` 的统一注册方式
- 扩展 SSE 事件格式以支持新可视化类型
- 在执行层暴露新的 observability 字段
- 给前端增加统一的场景面板容器协议

### 2.2 只进 GeoPLUS 的改动

满足以下条件，进入 GeoPLUS：

- 明确只服务地图或地理分析
- 不应扩大主线默认认知负担
- 即使移除 GeoPLUS，主线仍然完整成立

典型例子：

- `route_analysis`
- `buffer_zone`
- `spatial_join`
- `GeoWorkspace.vue`
- `GeoTimeline.vue`
- 面向遥感/图片的地理实体落图工具

### 2.3 禁止事项

- 禁止在 GeoPLUS 长期修改主线核心文件后不回流
- 禁止把 GeoPLUS 变成“主线功能先行试验场”
- 禁止在主线大量散落 `if geo_mode`
- 禁止复制一套聊天、执行、监控页面做 Geo 版平行维护

## 3. 分支策略

推荐分支：

- 主线仓库：
  - `main`
  - `feature/*`
  - `fix/*`
- GeoPLUS 仓库：
  - `main`
  - `feature/geo-*`
  - `sync/mainline-*`

规则：

- `RAGSystem-GeoPLUS/main` 必须定期同步 `RAGSystem/main`
- GeoPLUS 功能开发从 GeoPLUS 自己的 `main` 拉分支
- 主线兼容性修复优先回主线，再回灌 GeoPLUS

## 4. 锁步同步机制

GeoPLUS 的目标不是“偶尔追一次主线”，而是“持续锁步”。

建议流程：

1. 主线 `main` 合并新特性或发布版本。
2. GeoPLUS 拉取上游主线并合并到 GeoPLUS `main`。
3. 运行主线回归测试。
4. 运行 GeoPLUS 扩展回归测试。
5. 若失败，只允许在 Geo 扩展层或适配层修复。
6. 若发现主线扩展点不足，回主线补接口后再次同步。

建议版本命名：

- 主线：`vX.Y.Z`
- GeoPLUS：`vX.Y.Z-geoplus.N`

这意味着 GeoPLUS 与主线共享主版本号，只在 Geo 扩展增量上追加后缀。

## 5. PR 归属规范

### 5.1 主线 PR

以下 PR 必须提到 `RAGSystem`：

- 平台内核增强
- 非 Geo 垂类功能
- 工具协议、事件协议、可视化协议更新
- 通用多模态接入
- Bug 修复、性能优化、测试补全

### 5.2 GeoPLUS PR

以下 PR 可以只提到 `RAGSystem-GeoPLUS`：

- 地图工作台功能
- Geo 图层编排
- 时空分析能力
- 地理多模态能力
- Geo 对主线新接口的适配

### 5.3 PR 检查清单

每个 PR 都要回答以下问题：

- 这是通用能力还是 Geo 专属能力？
- 是否新增或修改了主线扩展契约？
- 如果修改契约，主线是否已先合入？
- 是否引入了跨仓库同步风险？
- 是否新增了对应测试？

## 6. 目录约束

### 6.1 主线仓库目录原则

主线只保留平台能力，不新增 Geo 专属目录树。

允许的主线扩展点示例：

- `backend-fastapi/capabilities/`
- `backend-fastapi/services/`
- `backend-fastapi/tools/catalog/`
- `backend-fastapi/tools/tool_executor_modules/`
- `backend-fastapi/schemas/`
- `frontend-client/src/components/`
- `frontend-client/src/api/`

### 6.2 GeoPLUS 仓库目录原则

GeoPLUS 新增代码尽量集中，降低同步冲突：

```text
backend-fastapi/
  capabilities/
    geo_scene.py
    geo_analysis.py
  services/
    geo_service.py
  api/v1/
    geo.py
  schemas/
    geo.py
  tools/catalog/
    geo_tools.py
  tools/tool_executor_modules/
    geo_tools.py

frontend-client/src/
  views/
    GeoWorkspace.vue
  components/geo/
    GeoLayerPanel.vue
    GeoTimeline.vue
    GeoEvidenceDrawer.vue
  api/
    geo.js
```

原则：

- Geo 代码集中
- 与主线共享已有容器和协议
- 减少对主线现有页面的大范围侵入

## 7. CI 与发布要求

建议最少建立两层检查：

### 7.1 主线 CI

- 后端测试
- 前端构建
- 工具协议与事件协议回归
- API 基础烟测

### 7.2 GeoPLUS CI

- 先同步主线最新 `main`
- 跑主线 CI 子集，确认基础平台未破
- 跑 Geo 专属测试：
  - Geo API
  - Geo tools
  - Geo schema
  - GeoWorkspace 构建
  - 地图结果协议兼容性检查

## 8. 角色分工

建议至少分出两类维护职责：

- 平台维护者：
  - 负责主线内核、扩展点、协议稳定性
- GeoPLUS 维护者：
  - 负责 Geo 垂类能力与主线伴随适配

职责边界：

- 平台维护者不为 Geo 专属页面背负长期维护成本
- GeoPLUS 维护者不绕过主线直接重写内核

## 9. 落地执行清单

第一阶段先完成治理落地：

1. 建立 `RAGSystem-GeoPLUS` 仓库，明确其为主线 fork。
2. 在主线和 GeoPLUS README 中写清仓库边界。
3. 制定 PR 模板，新增“改动归属”检查项。
4. 建立 GeoPLUS 同步主线的标准流程。
5. 为 GeoPLUS 建立独立 CI。

第二阶段再开始 Geo 能力开发：

1. 先补主线扩展点。
2. 再在 GeoPLUS 新增 Geo 模块。
3. 每次主线升级后执行 GeoPLUS 兼容适配。

## 10. 一句话原则

`RAGSystem` 是平台主线，`RAGSystem-GeoPLUS` 是锁步跟随主线的 Geo 增强仓库。

GeoPLUS 可以扩展主线，但不能演化成长期漂移的第二主线。
