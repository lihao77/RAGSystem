# 前端文档入口 / Frontend Docs

本目录是 `frontend-client/` 的正式文档入口，集中索引前端架构与前端实现约定。

## 当前文档

- [architecture.md](architecture.md) — 前端架构总览，包含路由、SSE 流式通信、执行树投影、消息结构与可视化渲染说明
- [workbench-redesign-plan.md](workbench-redesign-plan.md) — Agent 工作台改造计划，包含阶段目标、任务清单、验收标准与回滚点

## 推荐阅读顺序

1. [architecture.md](architecture.md)
2. [workbench-redesign-plan.md](workbench-redesign-plan.md)

## 维护约定

- 本 README 只负责前端文档导航与阅读顺序。
- 详细设计、交互链路与实现说明写在具体 docs 文档中，不写回子项目 README。
- 修改前端系统行为后，必须同步更新对应文档：
  - 页面结构、流式通信、状态投影、可视化渲染等行为变更 → 更新 [architecture.md](architecture.md)
  - 工作台布局、聊天页拆分、导航结构、管理页统一等演进任务 → 更新 [workbench-redesign-plan.md](workbench-redesign-plan.md)
- 新增前端专题文档时，先放在本目录并补充本 README 索引；若是仓库级专题，则放入 `../../docs/` 下对应专题目录。

## 返回上层

- [../../docs/README.md](../../docs/README.md) — 仓库文档中心
- [../README.md](../README.md) — 前端子项目入口
