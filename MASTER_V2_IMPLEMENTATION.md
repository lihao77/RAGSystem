# Master Agent V2 实施完成报告

## ✅ 已完成的工作

### 1. 核心文件创建

已在 `backend/agents/master_agent_v2/` 目录下创建了以下文件：

```
master_agent_v2/
├── __init__.py                       # 包初始化
├── master_v2.py                      # Master V2 核心实现（17KB）
├── agent_function_definitions.py     # Agent 工具定义生成器（6KB）
├── agent_executor.py                 # Agent 执行器（5KB）
└── README.md                         # 完整设计文档（11KB）
```

### 2. 集成到系统

#### 2.1 修改了 `agent_loader.py`

✅ 更新了 `_load_system_master_agent_v2()` 方法：
- 导入路径：`.master_agent_v2.master_v2` → `MasterAgentV2`
- 配置更新：使用新的 ReAct 模式配置
- 参数顺序：`orchestrator` 作为第一个参数

关键代码：
```python
from .master_agent_v2.master_v2 import MasterAgentV2
master_agent_v2 = MasterAgentV2(
    orchestrator=self.orchestrator,
    llm_adapter=self.llm_adapter,
    agent_config=master_v2_config,
    system_config=self.system_config
)
```

#### 2.2 保持了 `orchestrator.py` 不变

✅ 没有修改路由优先级，V1/V2 切换由前端控制
- Master V1 仍然是默认入口
- 前端可以通过 `preferred_agent` 参数选择 `master_agent_v2`

### 3. 测试脚本

✅ 创建了 `backend/test_master_v2.py`
- 验证 Master V2 是否正确加载
- 测试简单查询任务
- 展示 ReAct 循环的执行过程

## 🏗️ 架构说明

### 核心设计理念

**将 Agent 当作工具，通过 ReAct 模式动态调用**

```
用户任务
  ↓
Master V2 (ReAct 循环)
  ├─ Round 1: Thought → 决定调用 qa_agent
  │           Action → invoke_agent_qa_agent(task="查询数据")
  │           Observation → 获得查询结果
  │
  ├─ Round 2: Thought → 决定生成图表
  │           Action → invoke_agent_qa_agent(task="生成图表")
  │           Observation → 图表已生成
  │
  └─ Round 3: Thought → 有足够信息
              Final Answer → "这是完整的分析报告..."
```

### 与 Master V1 的对比

| 维度 | Master V1 | Master V2 |
|------|----------|----------|
| 决策方式 | 预先分析所有子任务 | 每轮动态决策 |
| 执行模式 | 静态 DAG 计划执行 | ReAct 循环 |
| 灵活性 | 固定流程 | 根据中间结果调整 |
| Agent 调用 | 预设的子任务列表 | 动态决定调用哪个 Agent |
| 可观察性 | 子任务粗粒度 | 每次 Agent 调用都可观察 |

## 📝 使用方式

### 方式 1: 通过 API 端点（前端）

前端在调用 `/api/agent/execute-stream` 时，指定使用 Master V2：

```javascript
const response = await fetch('/api/agent/execute-stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    task: "查询南宁市2023年的洪涝灾害数据",
    preferred_agent: "master_agent_v2"  // 指定使用 V2
  })
});
```

### 方式 2: 直接调用（后端测试）

```python
from agents.orchestrator import get_orchestrator
from agents.base import AgentContext

orchestrator = get_orchestrator(llm_adapter)
master_v2 = orchestrator.agents.get('master_agent_v2')

context = AgentContext(session_id="test")
for event in master_v2.execute_stream(task, context):
    if event['type'] == 'thought_structured':
        print(f"思考: {event['thought']}")
    elif event['type'] == 'agent_call_start':
        print(f"调用: {event['agent_name']}")
    elif event['type'] == 'final_answer':
        print(f"答案: {event['content']}")
```

## 🧪 如何测试

### 测试 1: 验证加载

```bash
cd backend
python test_master_v2.py
```

**预期输出**:
```
[1] 初始化系统组件...
[2] 加载智能体...
   ✓ qa_agent
   ✓ master_agent
   ✓ master_agent_v2
[3] 检查 Master V2...
   ✓ Master V2 已加载: MasterAgentV2
   ✓ 可用 Agent 工具数: 2
[4] 可用的 Agent 工具:
   - invoke_agent_qa_agent
   - invoke_agent_workflow_agent
```

### 测试 2: 完整执行（需要启动服务）

1. 启动后端：`python app.py`
2. 在前端发送请求，指定 `preferred_agent: "master_agent_v2"`
3. 观察 Master V2 的 ReAct 循环执行

## 🔍 调试技巧

### 1. 查看可用的 Agent 工具

```python
master_v2 = orchestrator.agents.get('master_agent_v2')
for tool in master_v2.available_agent_tools:
    print(tool['function']['name'])
```

### 2. 查看 System Prompt

```python
print(master_v2._build_system_prompt())
```

### 3. 启用详细日志

```python
import logging
logging.basicConfig(level=logging.DEBUG)
```

## 📊 前端集成建议

### 新增事件类型

Master V2 会发送以下新的 SSE 事件：

1. **`agent_call_start`**
   ```json
   {
     "type": "agent_call_start",
     "agent_name": "qa_agent",
     "task": "查询数据",
     "index": 1,
     "total": 2
   }
   ```

2. **`agent_call_end`**
   ```json
   {
     "type": "agent_call_end",
     "agent_name": "qa_agent",
     "result": { "success": true, "data": {...} },
     "elapsed_time": 3.5,
     "index": 1,
     "total": 2
   }
   ```

### 前端处理示例

```javascript
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);

  switch (data.type) {
    case 'agent_call_start':
      // 显示 "正在调用 xxx Agent..."
      addAgentCallIndicator(data.agent_name);
      break;

    case 'agent_call_end':
      // 显示 "Agent 执行完成"
      updateAgentCallResult(data.agent_name, data.result);
      break;

    // ... 其他事件类型
  }
};
```

## 🚀 后续优化方向

### 1. 混合调用工具和 Agent

Master V2 可以同时调用工具（如 `query_knowledge_graph_with_nl`）和 Agent：

```json
{
  "thought": "先直接查询数据，然后调用 Agent 分析",
  "actions": [
    {
      "tool": "query_knowledge_graph_with_nl",
      "arguments": {"question": "查询数据"}
    },
    {
      "tool": "invoke_agent_qa_agent",
      "arguments": {"task": "分析数据 {result_1}"}
    }
  ]
}
```

### 2. 自适应策略

根据任务复杂度自动选择 V1 或 V2：
- 简单任务 → Master V1（更快）
- 复杂任务 → Master V2（更灵活）

### 3. 决策质量评估

Master V2 评估自己的决策并优化：
```python
def _evaluate_decision_quality(self, thought, actions):
    # 评估决策是否合理
    # 如果质量低，尝试重新思考
    pass
```

## 📚 关键文件索引

- **核心实现**: `backend/agents/master_agent_v2/master_v2.py`
- **工具定义**: `backend/agents/master_agent_v2/agent_function_definitions.py`
- **Agent 执行器**: `backend/agents/master_agent_v2/agent_executor.py`
- **加载器集成**: `backend/agents/agent_loader.py` (第 192-247 行)
- **设计文档**: `backend/agents/master_agent_v2/README.md`
- **测试脚本**: `backend/test_master_v2.py`

## ⚠️ 注意事项

1. **不要删除 Master V1**
   V1 仍然是默认入口，V2 作为可选的高级模式

2. **LLM 配置**
   Master V2 需要较好的 LLM（推荐 deepseek-chat）
   - Temperature: 0.3（需要一定灵活性）
   - Max tokens: 4096（需要更大上下文）

3. **性能考虑**
   Master V2 需要多轮 LLM 调用，比 V1 慢但更灵活

4. **前端兼容性**
   现有前端无需修改即可使用，只需在请求中指定 `preferred_agent`

## ✅ 验收清单

- [x] 核心文件创建完成
- [x] 集成到 agent_loader
- [x] 保持 orchestrator 路由兼容
- [x] 创建测试脚本
- [x] 编写完整文档
- [x] 清理旧文件
- [x] 前端事件兼容性适配（使用现有 subtask 事件）
- [x] 添加 stream_execute 方法（API 兼容性）
- [ ] 运行完整流程测试（需要启动后端服务 + 前端测试）
- [ ] 生产环境部署测试

## 📞 问题排查

### 问题 1: Master V2 未加载

**检查**:
```python
from agents.orchestrator import get_orchestrator
orchestrator = get_orchestrator(llm_adapter)
print('master_agent_v2' in orchestrator.agents)
```

**可能原因**:
- `agent_loader.py` 中的导入路径错误
- 初始化参数顺序错误

### 问题 2: Agent 调用失败

**检查**:
```python
master_v2 = orchestrator.agents.get('master_agent_v2')
print(len(master_v2.available_agent_tools))
```

**可能原因**:
- 其他 Agent 未正确注册
- Agent 工具定义生成失败

### 问题 3: LLM 返回无效 JSON

**解决**:
- 降低 temperature
- 增加重试次数
- 在 system_prompt 中强调 JSON 格式

---

**实施完成时间**: 2026-01-27
**实施人**: Claude (claude-sonnet-4.5)
