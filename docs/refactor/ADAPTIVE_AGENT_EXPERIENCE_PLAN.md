# AutoDream 记忆治理方案

> 创建时间：2026-05-26
> 修订时间：2026-05-26
> 状态：方案文档，未进入代码实施（2026-08-17 核对：AutoDream/Dream 在代码中仍不存在，状态声明准确）
> 范围：聚焦 Dream 记忆治理（Memory candidate + AutoDream + Dream 工厂页面）

> **时效性注记**：本文"当前系统基础"章节基于已移除的 Python 后端（`services/memory_store.py`、`backend-fastapi/`、`daemon/scheduler/engine.py` 等路径均已不存在），仅作历史背景；当前记忆系统实现位于 `plugins/backend-plugin-memory/`。方案部分（三态 status、AutoDream 闭环、Dream 工厂）仍为有效设计参考。

## 目标

本方案聚焦 RAGSystem 的记忆治理能力：让系统记忆越来越短、越来越准、越来越可执行，后台能自我维护。

核心闭环：

```text
记忆写入 → 后台扫描 → 健康报告 → 用户确认 → 索引优化 → 更精准的下一次注入
```

最终体验：

- 后台定期扫描记忆健康度，发现过期、重复、臃肿问题。
- Dream 报告可读、可审计，建议操作明确。
- 用户通过 Dream 工厂页面查看报告、浏览记忆、手动触发扫描。
- 索引长度稳定在注入限制内，不持续膨胀。
- candidate 状态的记忆不影响 Agent 行为，直到用户确认。

## 非目标

- 不把所有历史对话无差别塞入长期记忆。
- 不让后台任务未经确认修改 team/workspace 级记忆。
- 不把 AutoDream 设计成普通聊天总结功能。
- 不在本阶段实现 Skill 化、执行语义展示、评测集、权限调优等能力（见"后续演进方向"）。

## 当前系统基础

### Memory 系统

- **MemoryStore**（`services/memory_store.py`）：支持 team/session/agent/workspace scope，active/archived 状态，MEMORY.md 索引重建。
- **frontmatter 字段**（12 个）：name, description, `type`（实际存储 scope 值）, memory_type, status, agent, session_id, team_name, created_at, updated_at, source_run_id, source_message_id。
  - **注意**：代码中 scope 语义的字段名为 `type`（`memory_store.py` 第 188 行），本方案中"scope"均指代码中的 `type` 字段。
- **Memory Prefix**（`services/memory_prefix_service.py`）：记忆索引注入 Agent 上下文，fingerprint 缓存失效，按 scope 控制读写权限。
- **Memory 工具**（`tools/local/memory_tools.py`）：list_memory_index / read_memory_entry / write_memory / archive_memory，运行时自动注入 session_id / team_name / agent_name。
- **自动提取**（`execution/persistence/message_handler.py`）：root agent final_answer 时触发，当前仅 3 条硬编码 regex 模式。

### Daemon 系统

- **CronScheduler**（`daemon/scheduler/engine.py`）：接收 `List[CronTask]`，每分钟检查触发，调用 `DaemonService.execute_cron_task(task)` 执行，超时 300s。
- **DaemonService**（`daemon/service.py`）：创建 session 并启动 Agent 执行 CronTask。
- **配置**：`config/yaml/daemon.yaml`，支持 `agents[*].cron_tasks` 列表。

### 事件体系

- **EventBus**（`agents/events/bus.py`）：统一 `publish(Event(...))` 模型。代码中**无独立 EventPublisher 类**，事件由各模块直接构造 Event 对象并通过 EventBus 发布。
- **工具事件**：由 `tools/runtime/executor.py` 构造 `Event(type=EventType.CALL_TOOL_START, data={...})` 发布。
- **StepProjector**（`execution/step_projector.py`）：CALL_TOOL_START/END 投影为 EXECUTION_STEP 规范化事件。

### 前端管理界面

已有 TeamBuilder、AgentConfig、DaemonManager、SystemConfig 等 8 个管理页面，可扩展出 Dream 工厂页面。

## 方案一：Memory 候选状态扩展

### 问题

当前 MemoryStore 只有 `active` / `archived` 两个 status，无法表示"后台建议但尚未确认"的记忆。AutoDream 需要一个安全的暂存机制来存放扫描发现和治理建议。

### 三态 status 模型

| 状态 | 含义 | 行为 |
|------|------|------|
| `active` | 已确认的有效记忆 | 正常注入上下文、参与搜索 |
| `candidate` | 后台提议的候选记忆 | 不注入上下文，等待用户确认 |
| `archived` | 已归档的历史记忆 | 不注入上下文，保留审计 |

### candidate 适用场景

candidate 是**后台系统发起的记忆变更暂存机制**，不是用户反馈的中间态。

用户主动行为不需要 candidate：

| 场景 | 处理方式 | 理由 |
|------|----------|------|
| 用户说"以后都这样做" | 直接写 `active` | 用户本人就是确认源 |
| Agent 在对话中推断偏好 | 对话中询问用户，确认后写 `active` | 对话本身就是确认通道 |

candidate 有价值的场景：

| 场景 | 处理方式 | 理由 |
|------|----------|------|
| AutoDream 建议合并记忆 | 合并结果写 `candidate` | 后台无对话通道，直接写 active 不安全 |
| AutoDream 建议归档过期记忆 | 标记为待归档 `candidate` | 不确定是否真的过期 |
| session 记忆自动提升到 workspace | 新记忆写 `candidate` | 跨 scope 提升是高影响操作 |

### 落地变更

- `services/memory_store.py`：status 字段接受 `candidate` 值。
- `list_entries()`：默认只返回 `active`，新增 `include_candidates=False` 参数。
- `_rebuild_index()`：索引只包含 `active` 记忆（现有逻辑已满足，增加测试覆盖）。

frontmatter 新增可选字段（**随 Phase 3 Dream 工厂页面一起引入**，Phase 1 不提前添加死字段）：

- `proposal_source`：产出该 candidate 的来源（如 `autodream_run_20260526`）。
- `proposal_action`：建议的操作类型（`merge` / `archive` / `promote` / `refine`）。
- `confirmed_by`：确认来源（`user` / `dream` / `auto`）。
- `confirmed_at`：确认时间。

### 从 candidate 到 active 的转换

- Dream 工厂页面确认 → 更新 status 为 active。
- 对话中通过 Agent 确认（`confirm_candidate_memory` 工具，随 Dream 工厂一起实现）。
- 可配置策略：session scope 低风险 candidate 可自动转 active。

### 验收标准

- candidate 记忆不注入上下文、不出现在 MEMORY.md 索引中。
- 现有 active/archived 记忆行为不受影响。
- `list_entries(include_candidates=True)` 能返回 candidate 记忆。

## 方案二：AutoDream 后台记忆整理

### 定位

AutoDream 是系统空闲时运行的"记忆睡眠整理"能力，是长期记忆治理器，不是聊天总结器。

### 扫描单位

按 **team** 为单位扫描。每个 team 注册自己的 AutoDream CronTask，各扫各的，报告隔离。当前只有 default team，后续多 team 时自然扩展。

### 扫描输入：三层数据

纯分析记忆文件不够——很多治理判断需要对话记录做支撑：

| 治理操作 | 只看记忆文件 | 需要对话/session 数据 |
|----------|------------|----------------------|
| 统计数量、索引大小 | 够了 | — |
| 判断 session 记忆是否过期 | 只能看 created_at | 需要 session 状态（open/closed）和最后活跃时间 |
| 判断记忆是否仍在使用 | 不知道 | 需要近期对话是否命中该记忆 |
| 去重/合并相似记忆 | 文本相似度初筛 | 需要看原始对话确认语义是否真的重复 |
| 精炼改写 | 可以改写文本 | 需要原始对话上下文避免语义偏差 |

因此 AutoDream 扫描依赖三层输入：

1. **记忆文件**（现有）：frontmatter（name / description / `type` / memory_type / status / source_run_id / source_message_id 等）+ body 正文。
2. **session 元数据**：状态（open/closed）、created_at、last_activity_at、关联 agent_name。来源：数据库 session 表。
3. **来源对话采样**：通过记忆的 `source_run_id` / `source_message_id` 反查产出该记忆的那段对话。**按需读取，不全量拉取**——仅对需要判断语义的记忆（如去重候选、精炼候选）才查原始对话。

MVP 阶段只用第 1、2 层（记忆文件 + session 元数据）。第 3 层（来源对话采样）在后续全量能力（去重、精炼）时引入。

### MVP 范围

MVP 只实现 3 项只读/低风险能力：

#### 1. 扫描统计

遍历该 team 下各 scope 记忆，收集：

- 各 scope 的 active / archived / candidate 数量。
- 重复候选：description 或 body 相似度 > 阈值的记忆对（基于简单字符串相似度，不使用 embedding）。
- 过期候选：session scope 中关联的 session 已关闭超过 N 天的记忆（需查询 session 元数据）。
- 索引长度：各 scope 的 MEMORY.md 行数和大小。

扫描使用 `fast` tier（纯统计，不需要深度推理）。

#### 2. Dream 报告

每次扫描后生成双格式报告：

Markdown 报告示例：

```text
# Dream 报告 - 2026-05-26

## 统计
- 活跃记忆：42 条
- 归档记忆：15 条
- 候选记忆：3 条
- 重复候选：2 组
- 过期候选：5 条
- 索引总行数：128 行

## 发现
- session scope 有 5 条关联已结束会话的记忆，建议归档。
- team scope 存在 2 组描述相似的记忆，建议合并。
- workspace scope 的 MEMORY.md 索引已达 85 行，接近注入限制。

## 建议操作
- [待确认] 归档 session 过期记忆（5 条）
- [待确认] 合并 team 重复记忆（2 组）
- [自动] 已重建 workspace 索引
```

JSON 报告（机器可读）：存放在 `DATA_ROOT/dream/reports/` 下，包含完整结构化数据。

#### 3. 索引重建

调用现有 `MemoryStore._rebuild_index()`，优化各 scope 的 MEMORY.md 索引：

- 移除指向已归档记忆的索引条目。
- 确保索引与实际文件一致。
- 控制索引长度在注入限制（200 行 / 25KB）内。

### 与 Daemon CronTask 集成

AutoDream 注册为标准 CronTask：

```yaml
# config/yaml/daemon.yaml
agents:
  - team_name: default
    cron_tasks:
      - task_id: autodream_scan
        name: AutoDream 记忆扫描
        cron: "0 3 * * *"
        task: "执行 AutoDream 记忆扫描：统计各 scope 记忆健康度，生成 Dream 报告，重建过长索引。只读扫描，不自动修改 team/workspace 记忆。"
        enabled: true
```

执行链路：

1. `CronScheduler._check_and_execute()` 每天 3:00 触发。
2. `DaemonService.execute_cron_task(task)` 创建 session 并启动 Agent。
3. Agent 执行扫描、生成报告、重建索引。
4. 结果存入 `DATA_ROOT/dream/reports/`。
5. 如配置了推送，发送报告摘要到飞书等平台。

### 后续全量能力（暂不实现）

以下能力在 MVP 验证后、Dream 工厂页面就绪后再启用：

- **过期检测与自动归档**：session scope 可自动归档，team/workspace 只生成建议（写 candidate）。依赖第 2 层（session 元数据）。
- **冲突检测**：发现互相矛盾的记忆，建议保留最近确认的版本。依赖第 1 层即可。
- **去重合并**：合并表达相近的记忆，生成候选，归档旧记忆。**依赖第 3 层（来源对话采样）**——需要看原始对话确认语义是否真的重复。
- **精炼表达**：LLM 改写为简短规则，使用 `default` tier，只生成建议不自动替换。**依赖第 3 层**——需要原始上下文避免语义偏差。
- **Scope 调整建议**：session → workspace 提升、team → agent 降级。依赖第 2 层（跨 session 使用频次）。

### 自动化边界

| 操作 | 是否自动执行 | 阶段 |
|------|--------------|------|
| 扫描记忆 | 是 | MVP |
| 生成 Dream 报告 | 是 | MVP |
| 重建索引 | 是 | MVP |
| 归档 session 临时记忆 | 可配置 | 后续 |
| 合并 team/workspace 记忆 | 需要确认 | 后续 |
| 删除记忆 | 不自动 | — |
| 修改 pinned 记忆 | 不自动 | — |

### 验收标准

- 后台能产出可读的 Dream 报告（Markdown + JSON）。
- 索引长度能被控制在注入限制内。
- MVP 阶段不修改 team/workspace 级记忆。
- Dream 报告关联 CronTask 执行的 run_id。

## 方案三：Dream 工厂页面

### 定位

Dream 工厂是 AutoDream 的前端治理入口，围绕报告查看、记忆浏览和手动触发构建。

### API 清单

| API | 方法 | 说明 |
|-----|------|------|
| `/api/v1/dream/status` | GET | 记忆健康度统计（各 scope 数量、索引大小） |
| `/api/v1/dream/reports` | GET | Dream 报告列表（分页、按时间排序） |
| `/api/v1/dream/reports/{id}` | GET | 单份报告详情（Markdown + JSON） |
| `/api/v1/dream/trigger` | POST | 手动触发 AutoDream 扫描 |
| `/api/v1/dream/config` | GET/PUT | AutoDream 运行策略配置 |
| `/api/v1/memory/browse` | GET | 按 scope 浏览记忆（分页、过滤 status） |
| `/api/v1/memory/{scope}/{file}` | GET | 单条记忆详情（frontmatter + body） |

后续扩展（随全量能力引入）：

| API | 方法 | 说明 |
|-----|------|------|
| `/api/v1/dream/pending` | GET | 待确认变更列表 |
| `/api/v1/dream/pending/{id}/action` | POST | 确认/拒绝/编辑变更 |

### 页面模块

#### 1. 总览

记忆健康度：active / archived / candidate 数量、重复候选数、过期候选数、MEMORY.md 注入长度占比、最近一次 Dream 时间和结果。

#### 2. Dream 报告

展示每次整理结果：统计数据、发现列表、建议操作、索引压缩效果、执行时间和 run_id。

#### 3. 记忆浏览器

按 scope 浏览（team / workspace / agent / session）。每条记忆显示：名称、memory_type、状态、scope、更新时间、来源 run_id。

#### 4. 整理配置

AutoDream 运行方式：手动触发 / Cron 自动 / 只扫描不修改（MVP 默认）。

### 验收标准

- 用户能查看记忆健康度和 Dream 报告。
- 用户能手动触发 AutoDream 扫描。
- 用户能浏览各 scope 记忆。
- 页面复用现有管理界面布局和组件库。

## 分阶段落地路线

### Phase 1：Memory candidate 状态

目标：为 AutoDream 建立数据基础。

工作：

- 扩展 MemoryStore status 为三态（active / candidate / archived）。
- `list_entries()` 增加 `include_candidates` 参数。
- 确认 `_rebuild_index()` 只包含 active（现有逻辑已满足，增加测试覆盖）。

验收：candidate 不注入上下文，现有记忆行为不受影响。

### Phase 2：AutoDream MVP

目标：后台能扫描记忆并产出治理报告。

工作：

- 实现 AutoDream 扫描逻辑（统计各 scope 记忆健康度）。
- 实现 Dream 报告生成（Markdown + JSON）。
- 索引重建优化。
- 注册 AutoDream CronTask 到 Daemon。
- 实现 `GET /api/v1/dream/status` 和 `GET /api/v1/dream/reports` API。

验收：定时扫描产出报告，不修改 team/workspace 记忆。

### Phase 3：Dream 工厂页面

目标：提供可视化记忆治理入口。

工作：

- 实现 Dream 工厂 API 全集。
- 前端实现总览、报告列表、记忆浏览器。
- 前端实现手动触发和策略配置。
- 引入 frontmatter 扩展字段（proposal_source / proposal_action / confirmed_by / confirmed_at）。

验收：用户能在页面上查看健康度、浏览记忆、触发扫描。

## 工程约束

### 成本控制

| 能力 | Tier | 理由 |
|------|------|------|
| AutoDream 扫描 | fast | 纯统计和格式化 |
| Dream 报告生成 | fast | 模板化文本生成 |
| 后续精炼改写 | default | 需要语义理解，不需要最强模型 |

### 数据迁移

所有变更增量式，不需要迁移脚本：

| 变更 | 兼容性 |
|------|--------|
| 新增 `candidate` status | 向后兼容，现有记忆无需修改 |
| frontmatter 新增可选字段 | 向后兼容，旧文件缺失时解析为空 |
| Dream 报告存储 | 新增 `DATA_ROOT/dream/reports/` |

### 并发安全

**MVP 阶段**：AutoDream 扫描为只读操作，不存在写冲突。通过 Daemon 调度在空闲时段执行，Dream 报告写入独立目录。

**后续全量阶段**：AutoDream 引入写操作时需要保护。由于 AutoDream 与前台 Agent 在同一 Node.js 进程内并发运行，文件级 advisory lock **无法互斥进程内并发任务**。正确策略：

- 进程内互斥锁，按 `(scope, file_name)` 建 lock 字典。
- 锁粒度：单个 memory 文件，不锁整个 scope。
- 超时：获取锁超时（5 秒）则跳过该文件，不阻塞扫描。

### 可观测性

| 数据 | 关联字段 |
|------|----------|
| Dream 报告 | run_id（CronTask 产出） |
| Memory 变更 | source_run_id（已有字段） |

## 风险与控制

### 风险一：记忆污染

后台写入错误的长期记忆导致 Agent 行为偏差。

控制：candidate 不注入上下文，MVP 只读不写，高影响 scope 变更需确认。

### 风险二：后台黑盒修改

AutoDream 自动改写重要记忆导致用户信任崩塌。

控制：MVP 只读扫描，后续高影响变更只生成建议，所有变更有 diff 和 source_run_id，支持 pinned 保护。

### 风险三：Dream 工厂概念化

页面只做展示没有治理操作。

控制：API 清单已定义，页面围绕报告、浏览、触发构建，不做概念展示。

## 成功指标

- Memory 索引长度稳定在注入限制（200 行 / 25KB）内。
- AutoDream 每周发现的重复/过期记忆数量趋于收敛。
- Dream 报告能指出需要关注的记忆健康问题。
- candidate 记忆不影响 Agent 行为，直到用户确认。

## 后续演进方向

以下方向在 Dream 功能验证后按需推进，不在本方案范围内。

### 用户反馈到 Memory 的完整闭环

- 前端消息气泡"记住这个"按钮。
- 可配置 regex 模式库替代硬编码（`config/yaml/memory_patterns.yaml`）。
- 记忆反馈存储（建议采用 JSONL 追加模式而非多文件 Markdown，更适合结构化、高频、短生命周期的反馈数据）。
- `submit_memory_feedback` 工具。

### 高频任务 Skill 化

- 工具调用频次统计（`DATA_ROOT/stats/tool_usage.json`）。
- Skill 发现 API（`GET /api/v1/skills`）。
- Skill manifest 增加 triggers 字段，Orchestrator prompt 注入摘要。
- 注意：当 Skill 数量超过 ~20 个时，prompt 注入 triggers 会显著增加 token 消耗，需考虑轻量嵌入匹配预筛选。

### 执行语义展示优化

- `@tool()` 装饰器新增 `display_name` 参数。
- `tools/runtime/executor.py` 构造 CALL_TOOL_START/END 事件时在 data 中附加 display_name / semantic_tool_name（代码中无独立 EventPublisher，直接在 executor.py 构造 Event）。
- StepProjector 透传新字段到 EXECUTION_STEP。

### 真实任务回归评测集

- Eval Runner + 基线对比（`backend-fastapi/evals/`）。
- 初始 25 条样本（每类 5 条）。
- 建议增加 smoke test subset（每类 1 条共 5 条），日常改动跑 smoke，Phase 合并前跑全量，控制评测成本。

### 权限与审批调优

- Run 级审批缓存（`approvals.py`，缓存 `(tool_name, risk_level)` 对）。
- `write_memory` 写 workspace/team scope 默认需确认。

### 专用 Team

待使用数据支撑后推进。前置条件：Orchestrator 自动路由、频次统计、Team 热切换、评测集覆盖。

## 总结

本方案聚焦 Dream 记忆治理，分三步落地：

1. **Phase 1**：Memory candidate 状态（数据基础）。
2. **Phase 2**：AutoDream MVP（只读扫描 + Dream 报告 + 索引重建 + CronTask 集成）。
3. **Phase 3**：Dream 工厂页面（治理入口 + 记忆浏览 + 报告查看 + frontmatter 扩展）。

MVP 阶段只做只读扫描，不修改高影响 scope 记忆。全量能力（归档、合并、精炼）待 Dream 工厂页面就绪后再启用。
