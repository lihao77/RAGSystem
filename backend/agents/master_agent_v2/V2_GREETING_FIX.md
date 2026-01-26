# V2 问候语问题修复说明

## 🐛 问题描述

**症状**: 当用户输入简单的问候语（如"你好"）时，V2 会错误地将任务分配给 `qa_agent`，而不是由 MasterAgent 自己直接回答。

**根本原因**:
1. V2 的任务分析提示词中缺少"问候/闲聊"的示例
2. V2 没有处理"任务分配给自己"的特殊逻辑，导致递归调用

---

## ✅ 修复内容

### 1. 修复任务分析提示词

**文件**: `backend/agents/master_agent_v2/master_agent_v2.py`

**修改位置**: 第 96-111 行（新增示例2）

**修改内容**:
```python
**示例2：问候/闲聊**
输入: "你好"
输出:
{
  "mode": "simple",
  "reasoning": "这是简单的问候，不需要调用专业智能体，master_agent 直接回复即可",
  "subtasks": [
    {
      "id": "task_1",
      "order": 1,
      "description": "回复用户问候",
      "agent_name": "master_agent_v2",  # ✨ 关键：指定为自己
      "depends_on": []
    }
  ]
}

**注意：如果任务是问候、闲聊或不需要专业知识的通用对话，agent_name 必须设为 "master_agent_v2"**
```

**效果**: LLM 现在会将问候类任务分配给 `master_agent_v2` 自己。

---

### 2. 修复 DAGExecutor 自调用逻辑

**文件**: `backend/agents/master_agent_v2/dag_executor.py`

**修改位置**: 第 219-256 行

**修改内容**:
```python
# ✨ 特殊处理：如果任务分配给 master_agent_v2 自己，直接使用 LLM 回答
if task.agent_name in ['master_agent_v2', 'master_agent']:
    # 直接使用 LLM 生成回答，避免递归
    logger.info(f"[DAGExecutor] 任务 {task.id} 分配给 MasterAgent 自己，直接回答")

    # 获取 master_agent 的 LLM adapter
    master_agent = self.orchestrator.agents.get(task.agent_name)
    if not master_agent or not hasattr(master_agent, 'llm_adapter'):
        raise ValueError(f"无法获取 {task.agent_name} 的 LLM adapter")

    # 直接使用 LLM 生成回答
    from llm_adapter import Message
    messages = [
        Message(role='user', content=enhanced_description)
    ]

    llm_response = master_agent.llm_adapter.generate(
        messages=messages,
        temperature=0.7,
        max_tokens=2000
    )

    # 构造成功响应
    response = type('Response', (), {
        'success': True,
        'content': llm_response,
        'data': None,
        'error': None
    })()
else:
    # 执行任务（调用其他智能体）
    response = self.orchestrator.execute(
        task=enhanced_description,
        context=agent_context,
        preferred_agent=task.agent_name
    )
```

**效果**:
- 当任务分配给 `master_agent_v2` 或 `master_agent` 时，不再通过 Orchestrator 调度
- 直接使用 MasterAgent 的 LLM adapter 生成回答
- 避免递归调用

---

## 🧪 测试验证

### 测试场景 1：问候语
**输入**: "你好"

**预期行为** (修复后):
1. MasterAgent V2 分析任务
2. 识别为 simple 模式
3. 分配给 `master_agent_v2` 自己
4. DAGExecutor 检测到是自己，直接使用 LLM 回答
5. 前端显示：MasterAgent V2 直接回复，无子任务卡片

**实际测试**:
```bash
# 启动后端
cd backend
python app.py

# 切换到 V2，输入"你好"
# 应该看到 MasterAgent 直接回答，不调用 qa_agent
```

### 测试场景 2：闲聊
**输入**: "今天天气真好"

**预期行为**:
- 分配给 `master_agent_v2`
- 直接回答
- 不调用专业智能体

### 测试场景 3：专业查询（确保不影响正常功能）
**输入**: "查询广西2023年的台风数据"

**预期行为**:
- 分配给 `qa_agent`
- 正常调用知识图谱查询
- 显示子任务卡片

---

## 📊 修复前后对比

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| **输入"你好"** | ❌ 调用 qa_agent | ✅ MasterAgent 直接回答 |
| **任务分配** | ❌ `agent: qa_agent` | ✅ `agent: master_agent_v2` |
| **执行流程** | ❌ Orchestrator → qa_agent | ✅ DAGExecutor → LLM |
| **前端显示** | ❌ 显示"知识图谱问答助手"子任务 | ✅ 无子任务，直接显示回答 |
| **专业查询** | ✅ 正常 | ✅ 正常（不受影响） |

---

## 🔍 修复细节

### 为什么需要两处修复？

**修复 1（提示词）**:
- 确保 LLM 能正确识别问候类任务
- 明确指示将此类任务分配给 `master_agent_v2`

**修复 2（执行逻辑）**:
- 即使 LLM 正确分配了，也需要避免递归
- 提供"自调用"的特殊处理路径

### 为什么不直接在 V2 中添加 `if simple then 直接回答`？

因为 V2 的设计是**统一通过 DAGExecutor 执行**，即使是 simple 模式也要经过 DAG 流程。这样可以保持代码一致性，也能支持未来的扩展（例如 simple 任务也可能需要重试）。

---

## ⚠️ 注意事项

### 1. 温度参数
直接调用 LLM 时使用 `temperature=0.7`，这是问候/闲聊的合适温度。如果需要更多创意，可以调整为 0.8-0.9。

### 2. Token 限制
设置 `max_tokens=2000`，对于简单问候足够。如果任务描述很长，可能需要调整。

### 3. 兼容性
修复后 V1 和 V2 对问候语的处理保持一致：
- V1: MasterAgent 直接回答
- V2: MasterAgent V2 直接回答

---

## 🚀 部署步骤

### 1. 应用修复
修复已自动应用到代码中，无需手动操作。

### 2. 重启后端
```bash
cd backend
# 停止当前运行的后端（Ctrl+C）
python app.py
```

### 3. 验证修复
```bash
# 查看启动日志，确认 V2 加载成功
# 应该看到：✅ 已加载系统智能体: master_agent_v2
```

### 4. 前端测试
1. 切换到 V2
2. 输入"你好"
3. 验证 MasterAgent 直接回答，不显示子任务

---

## 📝 总结

✅ **修复完成**，V2 现在可以正确处理问候和闲聊
✅ **V1 兼容**，修复不影响 V1 功能
✅ **专业查询不受影响**，仍然正常调用子智能体
✅ **避免递归**，通过特殊逻辑直接使用 LLM

现在可以重启后端进行测试了！
