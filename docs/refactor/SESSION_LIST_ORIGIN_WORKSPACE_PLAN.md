# 会话列表来源、时间排序与 Workspace 升级方案（Clean Break）

> **落地核对注记**（2026-08-17）：本方案主体已实施——`workspaces` 表、`session_list_projection` 读模型、cursor 分页 API（`routes/agent/sessions.ts`）均按方案落地。**一处未完全符合 Clean Break**：`backend-core/src/services/agent/delegation/helpers.ts:27` 仍读取 `child.metadata.workspace_root` 作为 workspace 解析回退，与第 1 节"不解析旧 metadata.workspace_root"的原则相悖，属待清理残留。

## 1. 实施原则

系统仍处于开发阶段，本方案采用一次性 clean break：

- 不迁移旧 session 数据。
- 不解析旧 `metadata.widget`、旧 Bot `user_id` 语义或旧 `metadata.workspace_root`。
- 不双写新旧字段。
- 不保留兼容 DTO、fallback resolver 或 lazy backfill。
- 不保留 offset 分页。
- Local SQLite 与开发环境 PostgreSQL 在切换新结构时直接重建或清空。
- 新模型必须成为唯一事实来源，前端不根据 metadata 推断业务语义。

目标不是在现有列表上补几个标签，而是一次性建立清晰的 session 所有权、来源、Workspace 和列表读模型。

## 2. 产品形态

默认使用统一的最近会话时间流：

```text
[全部来源 ▾] [全部 Workspace ▾]

退款流程咨询                         12 分钟前
售后助手 · 飞书                      ragsystem

套餐价格问题                         2 小时前
官网客服 · Widget                    —
```

- `direct/bot/widget` 是来源类型。
- “售后助手”“官网客服”是具体来源实例。
- 飞书、Widget Embed、API、Cron 是通道。
- Workspace 是独立维度，不属于来源。
- Bot、Widget 不默认拆区块，用户通过来源筛选切换。

## 3. 核心领域模型

### 3.1 Session 不再复用 user_id 表达来源

当前 `user_id` 同时承担直接用户、Bot 身份和 Widget 伪用户，导致所有权和来源耦合。新结构拆成四个独立概念：

```ts
type SessionOriginType = "direct" | "bot" | "widget";
type SessionVisibility = "private" | "tenant";

interface SessionRecord {
  session_id: string;
  tenant_id: string;

  // 访问所有权
  owner_user_id: string | null;
  visibility: SessionVisibility;

  // 会话从哪里产生
  origin_type: SessionOriginType;
  origin_id: string | null;
  origin_channel: string;

  // 工作上下文
  workspace_id: string | null;

  // 非核心扩展配置，例如 team、entry_agent
  metadata: Record<string, unknown>;

  created_at: string;
  updated_at: string;
}
```

数据库约束：

- `direct`：`origin_id IS NULL`，`owner_user_id IS NOT NULL`，默认 `private`。
- `bot`：`origin_id IS NOT NULL`，`owner_user_id IS NOT NULL`，默认 `private`。
- `widget`：`origin_id IS NOT NULL`，默认 `tenant`；未来若支持分配负责人，可以改为 `private + owner_user_id`。
- `visibility='private'` 时必须有 `owner_user_id`。
- `workspace_id` 必须属于同一 tenant。

`origin_id` 的含义由 `origin_type` 决定：

- Bot：Bot ID。
- Widget：Widget app key。
- Direct：`null`。

这是明确的 typed reference，不再从 metadata 或 session ID 命名规则反推。

### 3.2 来源通道

通道使用统一 schema，而不是任意字符串散落在调用链：

```ts
const SessionOriginChannelSchema = z.enum([
  "web",
  "api",
  "feishu",
  "cron",
  "widget_embed",
  "widget_api",
]);
```

新增通道时同时修改 contract、创建入口和展示映射。运行时的 `source` 字符串仍可用于执行追踪，但不能替代 session 的 `origin_channel`。

### 3.3 来源名称不写入 Session

Session 只保存稳定 `origin_id`，不保存名称快照，避免改名后出现两套名称。

- Bot 名称来自 bot repository。
- Widget 名称来自 widget credential repository。
- 列表应用层批量加载来源记录后组装 DTO，禁止逐 session N+1 查询。
- Bot 和 Widget 改为软删除/停用；被 session 引用的来源实体不得物理删除，从而保证历史会话始终可以解析名称。

## 4. Workspace 一等实体

Workspace 不再保存在 `metadata.workspace_root` 中，建立正式实体：

```ts
interface WorkspaceRecord {
  workspace_id: string;
  tenant_id: string;
  kind: "local";
  display_name: string;
  root_path: string;
  canonical_key: string;
  created_at: string;
  updated_at: string;
}
```

约束：

- `(tenant_id, canonical_key)` 唯一。
- `canonical_key` 由规范化绝对路径生成，Windows 处理盘符、分隔符和大小写规则。
- `workspace_id` 是稳定 UUID，不直接使用路径 hash 作为业务 ID。
- `display_name` 可以修改，不影响绑定关系。
- `root_path` 修改通过 Workspace service 完成，并重新校验唯一性。
- session 只保存 `workspace_id`。

新增 Workspace application/repository，所有现有运行时消费者通过 `workspace_id` 解析 root path。删除 `metadata.workspace_root` 的读写路径，包括会话创建、Agent runtime、memory scope、skill discovery、资源定位和 UI 上下文显示。

Local 新会话流程：

1. 用户输入或选择 root path。
2. `WorkspaceApplication.resolveLocalWorkspace(rootPath)` 规范化并 upsert Workspace。
3. 创建 session 时写入 `workspace_id`。
4. runtime 按 `workspace_id` 解析 `root_path`。

## 5. 列表读模型

### 5.1 不按 sessions.updated_at 排序

`updated_at` 表示 session 记录被修改，不代表有新聊天。修改权限、Team 或标题都不能改变列表顺序。

建立专用列表投影：

```ts
interface SessionListProjection {
  session_id: string;
  tenant_id: string;
  owner_user_id: string | null;
  visibility: "private" | "tenant";
  origin_type: "direct" | "bot" | "widget";
  origin_id: string | null;
  workspace_id: string | null;
  title: string;
  first_message: string;
  last_message: string;
  activity_at: string;
  unread_count: number;
}
```

数据库表建议命名：

- SQLite：`session_list_projection`
- PostgreSQL：`conversation_session_list_projection`

投影是明确的 read model，不是兼容缓存：

- 新 session 创建时同步创建空投影，`activity_at = session.created_at`。
- 新增可见 root 消息时，在同一事务中刷新 title、last message 和 activity time。
- 编辑、删除、rollback 消息时，在同一事务中调用统一的 `rebuildSessionListProjection(sessionId)`。
- session 的 owner、visibility、origin 或 workspace 改变时，在同一事务中同步投影过滤字段。
- tool、child thread、intermediate、不可见消息不改变投影。
- 投影异常时操作失败并回滚，禁止静默吞错。

为列表建立索引：

```text
(tenant_id, owner_user_id, activity_at DESC, session_id DESC)
(tenant_id, visibility, activity_at DESC, session_id DESC)
(tenant_id, origin_type, origin_id, activity_at DESC, session_id DESC)
(tenant_id, workspace_id, activity_at DESC, session_id DESC)
```

projection 有意复制列表过滤维度，这是正式 read model，而不是临时缓存。所有写入集中经过 projector 并与 session mutation 保持同一事务；列表查询不再 join session 表。来源名称仍在应用层批量解析，不写入投影。

### 5.2 可见消息口径

将“会影响会话列表的消息”定义为领域函数：

```ts
isSessionListVisibleMessage(message): boolean
```

规则：

- `thread_key === "root"`
- role 为 `user | assistant | system`
- 非 intermediate
- `visible_to_user !== false`
- 非 child conversation
- 非 intent/observation

SQLite、PostgreSQL、消息 mutation 和 projection rebuild 必须共享同一组测试向量，禁止两套口径各自演化。

## 6. 创建入口写入规则

### Direct

```ts
{
  owner_user_id: currentUser.id,
  visibility: "private",
  origin_type: "direct",
  origin_id: null,
  origin_channel: "web",
  workspace_id,
}
```

### Bot

Bot runtime 创建 session 前加载 Bot，直接写入其 owner：

```ts
{
  owner_user_id: bot.owner_id,
  visibility: "private",
  origin_type: "bot",
  origin_id: bot.id,
  origin_channel: "feishu" | "cron" | "api",
  workspace_id,
}
```

不再以 Bot ID 填入 session owner，也不再依靠 `bot-...` session ID 识别来源。

### Widget

```ts
{
  owner_user_id: null,
  visibility: "tenant",
  origin_type: "widget",
  origin_id: widgetApp.app_key,
  origin_channel: "widget_embed" | "widget_api",
  workspace_id: null,
}
```

Widget WebSocket 和 HTTP session 校验直接读取 `origin_type/origin_id`，删除 `metadata.widget.app_key` 依赖和 widget 伪用户 ID。

## 7. 权限模型

列表可见性只使用 session 自身字段，不再先查询 owned Bot IDs 后拼 `userIds`：

```text
private session: owner_user_id = current user
tenant session: current user 具有允许读取 tenant 会话的角色
Local: local identity 允许读取当前 tenant 的 private/tenant session
```

Widget app 当前没有成员分配关系，因此：

- SaaS 普通成员默认看不到 tenant Widget 会话。
- tenant admin/owner 可以查看。
- Local 可以查看。

若未来要把 Widget 会话分配给客服，直接更新 `owner_user_id + visibility`，无需改变来源模型。

`assertSessionOwner` 应重构为 `assertSessionReadable`，详情、消息、文件、WebSocket、删除和导出全部复用同一授权策略，避免列表可见但无法打开。

## 8. API 契约

### 8.1 SessionListItem

直接替换现有 contract，不保留旧字段别名：

```ts
interface SessionListItem {
  session_id: string;
  title: string;
  first_message: string;
  last_message: string;
  activity_at: string;
  unread_count: number;

  origin: {
    type: "direct" | "bot" | "widget";
    id: string | null;
    display_name: string;
    channel: "web" | "api" | "feishu" | "cron" | "widget_embed" | "widget_api";
  };

  workspace: {
    workspace_id: string;
    display_name: string;
    root_path: string | null;
  } | null;
}
```

删除列表 DTO 中不需要的 `user_id`、`metadata`、`updated_at` 和 `last_message_at`。详情接口可以返回领域 session DTO，但同样不得让前端依赖 metadata 推断来源或 Workspace。

### 8.2 Cursor 分页

时间流从一开始就使用稳定 cursor，不保留 offset：

```http
GET /api/agent/sessions
  ?limit=20
  &cursor=<opaque>
  &origin_type=bot
  &origin_id=bot_xxx
  &workspace_id=workspace_xxx
```

cursor 内部包含：

```ts
{ activity_at: string; session_id: string }
```

排序固定为：

```text
activity_at DESC, session_id DESC
```

响应：

```ts
interface SessionListPage {
  items: SessionListItem[];
  next_cursor: string | null;
}
```

cursor 必须签名或至少使用不透明 base64url 编码并严格校验 schema。前端只透传，不解析。

### 8.3 Facets

新增：

```http
GET /api/agent/sessions/facets
```

返回当前用户可见范围内的完整筛选项：

```ts
interface SessionListFacets {
  type_counts: Record<"direct" | "bot" | "widget", number>;
  origins: Array<{
    type: "bot" | "widget";
    id: string;
    display_name: string;
    count: number;
  }>;
  workspaces: Array<{
    workspace_id: string;
    display_name: string;
    root_path: string | null;
    count: number;
  }>;
}
```

Facets 由数据库聚合 origin/workspace ID，再由应用层批量解析名称。

## 9. 前端实现

### 9.1 组件结构

```text
layouts/MainLayout.vue
components/session-list/SessionList.vue
components/session-list/SessionListToolbar.vue
components/session-list/SessionListItem.vue
composables/useSessionListTime.js
stores/session-list.js
```

`MainLayout.vue` 只负责布局和导航，不继续承载时间格式、筛选和 item 渲染细节。

使用项目现有 shadcn-vue 组件：

- `DropdownMenu`：来源和 Workspace 筛选。
- `Badge`：Bot/Widget 来源实例。
- `Button`：筛选和删除操作。
- `Tooltip`：截断名称和路径。
- 已有 skeleton 先替换成项目的 `Skeleton` 后再提交，避免继续扩散自定义 loading markup。

遵循现有技能约束：菜单项放在 `DropdownMenuGroup` 中，使用语义色、`gap-*`、`truncate` 和 `cn()`，不手写 Badge 样式。

### 9.2 Store

`session-list.js` 重写为 cursor store：

```ts
items
nextCursor
filters
facets
loadingInitial
loadingMore
error
```

行为：

- filter 变化后取消旧请求、清空 items 和 cursor，再加载第一页。
- 追加页按 `session_id` 去重。
- 实时 upsert 后统一按 `(activity_at, session_id)` 排序。
- item 不匹配当前筛选时不插入；已存在但不再匹配时移除。
- 刷新后 facets 不包含当前筛选值时回到“全部”。
- 快捷键和命令面板只消费当前 store items。

### 9.3 时间展示

抽出纯函数 `formatSessionTime(time, now)`：

1. 今天不足一分钟：`刚刚`
2. 今天不足一小时：`N 分钟前`
3. 今天其余：`N 小时前`
4. 前一自然日：`昨天`
5. 同年两天及以上：`M月D日`
6. 跨年：`YYYY-MM-DD`

由一个共享分钟 tick 驱动所有 item 更新，禁止每个 item 各自创建 timer。

## 10. 实施顺序

### Phase 1：领域结构与存储重建

1. 修改 session、workspace、list projection contracts。
2. 新建 Workspace repository/application。
3. 重建 SQLite 和 PostgreSQL conversation schema。
4. 拆分 owner、visibility、origin、workspace 字段。
5. 新建 session list projection 和索引。
6. 修改 direct、Bot、Widget 创建入口。
7. 删除 widget 伪用户 ID 作为 session owner 的用法，以及 `metadata.widget` 会话鉴权。
8. 删除 `metadata.workspace_root` 的所有读写。

完成后清空 Local 与开发 PostgreSQL 数据验证新 schema；不编写历史数据转换脚本。

### Phase 2：投影与权限

1. 所有消息写入和 mutation 维护列表投影。
2. 统一 visible-message 领域判断与跨存储测试。
3. 重构 `assertSessionReadable`。
4. 保证列表、详情、WS、文件、删除和导出权限一致。
5. Bot/Widget 来源实体改为软删除或禁止删除被引用记录。

### Phase 3：列表 API

1. 新 SessionListItem contract。
2. Cursor 编解码与稳定分页。
3. 来源、Workspace 服务端过滤。
4. Facets 聚合和批量来源解析。
5. 删除旧 offset、userIds 和 metadata 推断代码。

### Phase 4：前端

1. 重写 session list store。
2. 拆分 SessionList、Toolbar、Item。
3. 增加具体来源和 Workspace 展示。
4. 增加来源/Workspace 筛选。
5. 增加分钟、小时、昨天和日期展示。
6. 更新快捷键、命令面板、移动端、空状态和 loading。

## 11. 测试门槛

### Backend

- 每种创建入口写入唯一正确的 owner、visibility、origin 和 channel。
- metadata 不包含 origin、widget app key 或 workspace root。
- 修改 session metadata/权限不会改变 activity order。
- 消息新增、编辑、删除、rollback 后 projection 正确。
- invisible、tool、child message 不更新 projection。
- private/tenant 权限在列表、详情、WS、文件和删除上一致。
- 静态数据集下 cursor 翻页无重复、无跳项；activity 相同时按 session ID 稳定排序。
- origin/workspace 筛选和 facets count 一致。
- SQLite/PostgreSQL 使用同一测试向量。

### Frontend

- 时间格式覆盖午夜、昨天、两天、跨年、非法时间和未来时间。
- cursor reset、append、dedupe、live upsert 和筛选失效。
- 来源实例、channel、Workspace 正确展示并截断。
- 筛选菜单使用完整 facets，不从当前页推断。
- 快捷键和命令面板遵循当前过滤后的顺序。

### Required checks

```text
npm run check:packages
npm run check:backend
npm run check:frontend
```

## 12. 完成定义

以下条件全部满足才算完成：

1. 代码库中不存在旧 session 列表 offset API。
2. 不存在根据 `user_id`、session ID 或 metadata 推断 Bot/Widget 来源的代码。
3. 不存在 session `metadata.workspace_root` 读写。
4. 不存在新旧字段双写或兼容 resolver。
5. Widget session 所有权与读取鉴权不再依赖 metadata 或伪用户 ID。
6. 排序只依赖 session list projection 的 `activity_at`。
7. 所有读取入口复用统一权限策略。
8. Local 与 PostgreSQL schema、contract 和测试语义一致。
9. 开发数据库使用新 schema 重新初始化，无历史迁移脚本。
10. 全量 package、backend、frontend checks 通过。
