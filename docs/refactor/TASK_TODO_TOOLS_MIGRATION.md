# 移植方案：Claude Code Task/Todo 工具到 RAGSystem

## Context

RAGSystem 已完成工具 runtime 重构（对标度 ~90%），当前缺少任务追踪类工具。
Claude Code 的 TaskCreate/Get/Update/List + TodoWrite 是 Agent 自我管理执行进度的核心能力，
移植后 Agent 可在多步骤任务中追踪进度、建立依赖关系、向用户展示执行状态。

存储方式对齐 Claude Code：JSON 文件，按 session 隔离。

---

## 移植目标

| 工具名 | Claude Code 对应 | 说明 |
|--------|-----------------|------|
| `task_create` | `TaskCreate` | 创建任务，返回 task_id |
| `task_get` | `TaskGet` | 获取单个任务详情 |
| `task_update` | `TaskUpdate` | 更新状态/字段/阻塞关系 |
| `task_list` | `TaskList` | 列出所有任务（过滤已解决阻塞） |
| `todo_write` | `TodoWrite` | 内存 Todo 列表，会话内追踪 |

全部放入两个新文件：
- `backend-fastapi/tools/local/task_store.py` — 存储层（无副作用纯函数）
- `backend-fastapi/tools/local/task_tools.py` — 4 个 Task 工具
- `backend-fastapi/tools/local/todo_tools.py` — 1 个 Todo 工具

---

## 数据模型

### Task（JSON 文件存储）

存储路径：`DATA_ROOT/tasks/{session_id}/{task_id}.json`
复用 `tools/paths/path_resolution.py` 的 `DATA_ROOT` 常量。

```json
{
  "id": "1",
  "subject": "Fix authentication bug",
  "description": "详细描述与验收标准",
  "active_form": "Fixing authentication bug",
  "owner": "react_agent",
  "status": "pending",
  "blocks": ["2", "3"],
  "blocked_by": [],
  "metadata": {}
}
```

**状态流转**：`pending` → `in_progress` → `completed`，`deleted` 触发文件删除。

**task_id 生成**：读写 `{session_id}/counter.json`，原子自增整数字符串 "1","2",...

### TodoItem（内存存储）

进程内字典 `_TODO_STORE: dict[str, list[dict]]`，key 为 session_id，重启丢失。

```python
{
  "content": "任务描述",
  "status": "pending",       # pending / in_progress / completed
  "active_form": "Running..."
}
```

---

## 实现步骤

### Step 1：task_store.py（存储层）

新建 `tools/local/task_store.py`：

```python
from pathlib import Path
from tools.paths.path_resolution import DATA_ROOT
import json, threading

_lock = threading.Lock()

def get_task_dir(session_id: str) -> Path:
    p = Path(DATA_ROOT) / "tasks" / session_id
    p.mkdir(parents=True, exist_ok=True)
    return p

def _next_task_id(session_id: str) -> str:
    # 读写 counter.json，线程锁保护
    ...

def create_task(session_id, subject, description, active_form=None, metadata=None) -> dict: ...
def get_task(session_id, task_id) -> dict | None: ...
def list_tasks(session_id) -> list[dict]: ...
def update_task(session_id, task_id, **updates) -> dict: ...
def delete_task(session_id, task_id) -> bool: ...
```

文件并发用 `threading.Lock()` 保护（单进程 FastAPI 场景足够）。

---

### Step 2：task_tools.py（4 个工具）

新建 `tools/local/task_tools.py`，每个工具用 `@tool()` 装饰器注册：

#### task_create
- 参数：`subject`（必填）、`description`（必填）、`active_form`（可选）、`metadata`（可选）
- 上下文：需 `session_id` 参数（executor 自动注入）
- 返回：`{"task": {"id": "1", "subject": "..."}}`

#### task_get
- 参数：`task_id`（必填）
- 返回：`{"task": {...}}` 或 `{"task": null}`（不存在时）

#### task_update
- 参数：`task_id`（必填）+ 以下全部可选：
  - `subject` / `description` / `active_form` / `owner`
  - `status`：`pending` / `in_progress` / `completed` / `deleted`
  - `add_blocks`：追加到 blocks 列表（去重）
  - `add_blocked_by`：追加到 blocked_by 列表（去重），同时更新对方的 blocks
  - `metadata`：merge 合并，value=null 则删除该 key
- `status="deleted"` 触发 `delete_task()`
- 返回：`{"success": true, "task_id": "1", "updated_fields": [...], "status_change": {"from": "pending", "to": "in_progress"}}`

#### task_list
- 无参数
- 过滤：`metadata._internal=true` 的任务不返回
- `blocked_by` 字段：只保留状态不是 `completed` 的阻塞任务 ID
- 返回：`{"tasks": [{"id", "subject", "status", "owner", "blocked_by"}]}`

---

### Step 3：todo_tools.py（1 个工具）

新建 `tools/local/todo_tools.py`：

#### todo_write
- 参数：`todos`（必填，TodoItem 数组）
  - 每个 TodoItem：`content`（必填）、`status`（必填，枚举）、`active_form`（必填）
- 逻辑：
  - 所有 item 都是 `completed` → 清空列表（对齐 Claude Code 行为）
  - 否则直接替换当前 session 的 todo 列表
- 返回：`{"old_todos": [...], "new_todos": [...]}`

---

### Step 4：自动注册

`tools/local/` 包由 `tools/runtime/discovery.py` 的 `discover_decorated_tools()` 自动扫描，
新文件放入该目录后无需手动注册，`bootstrap_tool_system()` 启动时自动发现。

确认 `tools/local/__init__.py` 为空文件，无需修改。

---

### Step 5：更新 MEMORY.md

更新 `С:/Users/admin/.claude/projects/Е--Python-RAGSystem/memory/MEMORY.md`：
- 本地工具实现新增 3 行（task_store / task_tools / todo_tools）
- 工具总数：19 → 24

---

## 关键文件

| 文件 | 操作 |
|------|------|
| `tools/local/task_store.py` | **新建**（Task 存储层） |
| `tools/local/task_tools.py` | **新建**（task_create/get/update/list） |
| `tools/local/todo_tools.py` | **新建**（todo_write） |
| `tools/paths/path_resolution.py` | 只读，复用 DATA_ROOT |
| `tools/local/__init__.py` | 确认无需修改 |
| `С:/Users/admin/.claude/projects/Е--Python-RAGSystem/memory/MEMORY.md` | 更新工具清单 |

---

## 验证方式

1. 启动后端，确认 bootstrap 日志中出现 5 个新工具
2. 调用完整生命周期：`task_create` → `task_list` → `task_update(status=in_progress)` → `task_update(status=completed)` → `task_list`
3. 确认 `DATA_ROOT/tasks/{session_id}/` 下 JSON 文件正确创建和删除
4. 调用 `task_update(add_blocks=["2"])` 验证双向阻塞关系维护
5. 调用 `todo_write` 验证内存隔离和全完成自动清空
