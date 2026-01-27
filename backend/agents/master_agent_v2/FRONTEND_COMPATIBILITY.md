# Master V2 前端兼容性更新

## 问题

Master V2 最初使用了新的事件类型（`agent_call_start`、`agent_call_end`），前端不支持这些事件，导致无法正常显示。

## 解决方案

**将 Master V2 的 Agent 调用包装成前端已支持的 subtask 事件**

### 关键修改

#### 1. 使用 `subtask_start` 代替 `agent_call_start`

```python
# ❌ 旧方式（前端不支持）
yield {
    "type": "agent_call_start",
    "agent_name": agent_name,
    "task": agent_task
}

# ✅ 新方式（前端已支持）
yield {
    "type": "subtask_start",
    "task_id": f"v2_agent_{rounds}_{idx}",  # 唯一 ID
    "order": idx,
    "agent_name": agent_name,
    "agent_display_name": agent_display_name,
    "description": agent_task
}
```

#### 2. 使用 `subtask_end` 代替 `agent_call_end`

```python
# ❌ 旧方式（前端不支持）
yield {
    "type": "agent_call_end",
    "agent_name": agent_name,
    "result": result
}

# ✅ 新方式（前端已支持）
yield {
    "type": "subtask_end",
    "task_id": task_id,
    "order": idx,
    "result_summary": result_summary,  # 格式化后的摘要
    "success": result.get('success', False)
}
```

#### 3. 在 `thought_structured` 中添加 `task_id`

```python
yield {
    "type": "thought_structured",
    "task_id": task_id,  # 🆕 关联到当前 Agent 调用
    "subtask_order": idx,
    "thought": thought,
    "round": rounds
}
```

### 新增辅助方法

#### `_get_agent_display_name(agent_name)`
从 Agent 配置中获取友好显示名称，用于前端展示。

#### `_format_agent_result_summary(result)`
将 Agent 执行结果格式化为简短摘要，适合在前端列表中显示。

## 前端展示效果

现在 Master V2 的 Agent 调用会像 Master V1 的子任务一样展示：

```
📋 Master V2 执行计划
└─ 🔄 知识图谱问答智能体
   └─ 💭 思考: 用户需要查询数据...
   └─ ✅ 完成: 查询成功，返回了 10 条记录
```

## 兼容性

✅ **完全兼容现有前端**
- 使用前端已支持的 `subtask_start`/`subtask_end` 事件
- 使用前端已支持的 `thought_structured` 事件
- 无需修改前端代码

## 测试

运行测试脚本验证：
```bash
cd backend
python test_master_v2.py
```

前端测试：
1. 启动后端：`python app.py`
2. 前端发送请求，指定 `preferred_agent: "master_agent_v2"`
3. 观察前端是否正常展示 Agent 调用过程

---

**更新时间**: 2026-01-27
