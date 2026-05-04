# 系统缺陷修复计划（2026-05-05）

## 背景

本计划来自本轮只读代码审查，目标是把已确认的系统 bug 和代码 bug 按优先级落盘，便于后续分批修复与验证。

用户已确认：审批等待无超时是当前故意设计，目的是等待用户真实审批。后期可通过系统配置加入“超时自动拒绝”，但本轮不修改审批无限等待语义。

## 总体优先级

### P0：立即修复

1. 前端消息与可视化 XSS / HTML 注入
   - `frontend-client/src/views/ChatViewV2.vue`
   - `frontend-client/src/utils/markdown.js`
   - `frontend-client/src/components/FloatingChatPanel.vue`
   - `frontend-client/src/components/MapRenderer.vue`
   - 目标：关闭原始 HTML 或统一净化，所有后端/模型/artifact 字段进入 HTML 前必须转义或白名单校验。

2. 工具 runtime 阻塞与异常处理
   - `backend-fastapi/tools/runtime/executor.py`
   - 目标：修复工具超时后仍等待线程结束的问题；修复 `approval_outcome` 在异常路径未初始化导致二次异常的问题。
   - 明确不做：不为审批等待加入超时。

### P1：下一批修复

1. 路径治理一致性
   - 数据库默认路径统一到 `DATA_ROOT/db/ragsystem.db`。
   - 向量化器运行时配置统一到 `CONFIG_ROOT/vector_store/vectorizers.yaml`。
   - daemon 配置路径直接复用 `CONFIG_ROOT/daemon/daemon.yaml`。

2. 前端流式恢复一致性
   - WebSocket 瞬断不应直接 finalize 当前 run。
   - 发现 seq gap 后触发 replay、补拉或刷新消息。
   - `output.final_answer` 应按事件契约合并 `content`。
   - WebSocket 审批提交应增加 ack/失败恢复，不改变后端审批等待语义。

3. 权限与配置旧字段
   - `allowed_roles` 非空但 `user_role` 缺失时默认拒绝。
   - 删除旧 embedding 配置字段访问路径。

### P2：后续收敛

1. daemon 状态与平台能力
   - adapter 连接失败不应仍标记 running。
   - 未实现平台应在配置校验或启动阶段明确拒绝/降级。
   - Cron 任务增加按 `task_id` 防重入。

2. 前端 artifact 健壮性
   - `VisualizationLoader` 校验响应结构。
   - `image_url` 做类型检查。
   - `MapRenderer.formatNumber` 支持字符串数字和异常值。

3. Skill 与测试覆盖
   - `skill_environment.py` 使用 Pydantic 属性访问配置。
   - 补充路径、配置、XSS、runtime 超时和异常路径测试。

## 本轮执行范围

本轮只执行 P0：

1. 修复主聊天 Markdown 渲染 XSS。
2. 修复浮动聊天面板 HTML 注入。
3. 修复地图 popup 与 SVG marker 样式注入。
4. 修复工具 runtime 超时返回语义。
5. 修复 `execute_tool()` 异常路径中的 `approval_outcome` 未初始化问题。
6. 同步必要测试和架构文档。

## 验证计划

1. 前端：运行相关单元测试或构建检查。
2. 后端：运行工具 runtime 相关测试。
3. 如测试范围过大，则至少运行受影响模块的最小测试集，并记录无法运行的原因。
