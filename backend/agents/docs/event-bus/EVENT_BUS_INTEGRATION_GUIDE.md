# 事件总线集成指南

本文档说明如何将事件总线集成到 MasterAgent V2 系统中。

---

## 快速开始

### 1. 基本使用示例

```python
# 在Agent中发布事件
from agents.events import EventPublisher

class MyAgent(BaseAgent):
    def execute(self, task: str, context: AgentContext):
        # 创建事件发布器
        publisher = EventPublisher(
            agent_name=self.name,
            session_id=context.session_id,
            trace_id=context.metadata.get('trace_id')
        )

        # 发布事件
        publisher.agent_start(task)
        publisher.thought("我需要查询知识图谱")
        publisher.tool_start("query_knowledge_graph", {"query": "..."})

        # 执行工具
        result = self.execute_tool(...)

        publisher.tool_end("query_knowledge_graph", result)
        publisher.final_answer("查询完成")

        return AgentResponse(success=True, content=result)
```

### 2. 在Flask路由中使用SSE适配器

```python
# routes/agent.py
from agents.events import get_event_bus, SSEAdapter
from flask import Response, stream_with_context

@agent_bp.route('/stream', methods=['POST'])
def stream_execute():
    data = request.get_json()
    task = data.get('task')
    session_id = data.get('session_id') or str(uuid.uuid4())

    # 获取事件总线
    event_bus = get_event_bus()

    async def generate():
        # 创建SSE适配器
        adapter = SSEAdapter(event_bus=event_bus, session_id=session_id)

        # 在后台执行Agent任务
        async def execute_task():
            orchestrator = _get_orchestrator()
            context = AgentContext(session_id=session_id)
            await orchestrator.execute_async(task, context)

        # 启动任务
        asyncio.create_task(execute_task())

        # 流式输出事件
        async for sse_data in adapter.stream():
            yield sse_data

    # 返回SSE响应
    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no'
        }
    )
```

---

## 修改 MasterAgent V2 使用事件总线

### 修改 1: 在 `__init__` 中初始化事件发布器

```python
# backend/agents/master_agent_v2/master_v2.py

from agents.events import EventPublisher

class MasterAgentV2(BaseAgent):
    def __init__(
        self,
        orchestrator,
        agent_executor,
        llm_adapter,
        agent_name="master_agent_v2",
        # ... 其他参数
    ):
        super().__init__(agent_name, llm_adapter)

        self.orchestrator = orchestrator
        self.agent_executor = agent_executor

        # ✨ 初始化事件发布器（会在execute时更新）
        self._publisher: Optional[EventPublisher] = None

        # ... 其他初始化代码
```

### 修改 2: 在 `execute_stream` 中使用事件发布器

```python
# backend/agents/master_agent_v2/master_v2.py

def execute_stream(self, task: str, context: AgentContext):
    """流式执行任务（使用事件总线）"""

    # ✨ 创建事件发布器
    self._publisher = EventPublisher(
        agent_name=self.name,
        session_id=context.session_id,
        trace_id=context.metadata.get('trace_id')
    )

    # ✨ 发布会话开始事件
    self._publisher.session_start(metadata={"task": task})
    self._publisher.agent_start(task)

    try:
        # 原有的执行逻辑
        rounds = 0
        messages = [
            {"role": "system", "content": self._build_system_prompt()},
            {"role": "user", "content": task}
        ]

        while rounds < self.max_rounds:
            rounds += 1

            # ✨ 发布思考事件（替代原来的yield）
            self._publisher.thought(f"第 {rounds} 轮思考...")

            # 调用LLM
            response = self.llm_adapter.chat_completion(
                messages=messages,
                tools=available_tools,
                ...
            )

            # 解析响应
            if response.finish_reason == 'tool_calls':
                tool_calls = response.tool_calls

                # ✨ 发布结构化思考事件
                self._publisher.thought_structured(
                    thought=f"我需要调用 {len(tool_calls)} 个工具",
                    actions=[tc.function.name for tc in tool_calls]
                )

                # 执行工具
                for tool_call in tool_calls:
                    tool_name = tool_call.function.name
                    arguments = json.loads(tool_call.function.arguments)

                    # ✨ 发布工具开始事件
                    self._publisher.tool_start(tool_name, arguments)

                    # 执行工具
                    result = self._execute_tool(tool_name, arguments, context)

                    # ✨ 发布工具结束事件
                    self._publisher.tool_end(tool_name, result)

                    # 添加到消息历史
                    messages.append(...)

            elif response.finish_reason == 'stop':
                # 有最终答案
                final_content = response.content

                # ✨ 发布最终答案事件
                self._publisher.final_answer(final_content)

                # ✨ 发布Agent结束事件
                self._publisher.agent_end(final_content)

                break

        # ✨ 发布会话结束事件
        self._publisher.session_end(summary="任务完成")

        return AgentResponse(success=True, content=final_content)

    except Exception as e:
        # ✨ 发布错误事件
        self._publisher.agent_error(str(e), error_type=type(e).__name__)
        raise
```

### 修改 3: 在工具执行中发布事件

```python
# backend/agents/master_agent_v2/master_v2.py

def _execute_tool(self, tool_name: str, arguments: Dict, context: AgentContext):
    """执行工具（发布事件）"""

    # 判断是Agent调用还是普通工具
    if tool_name.startswith('invoke_agent_'):
        agent_name = tool_name.replace('invoke_agent_', '')

        # ✨ 发布子任务开始事件
        self._publisher.subtask_start(
            subtask_agent=agent_name,
            subtask_description=arguments.get('task', '')
        )

        # 执行Agent
        result = self.agent_executor.execute_agent_stream(
            agent_name=agent_name,
            task=arguments.get('task'),
            context=context.fork(),
            context_hint=arguments.get('context_hint')
        )

        # 收集结果
        final_result = None
        for event in result:
            # 透传子Agent的事件（由子Agent自己发布）
            if event.get('type') == 'final_answer':
                final_result = event.get('content')

        # ✨ 发布子任务结束事件
        self._publisher.subtask_end(
            subtask_agent=agent_name,
            result=final_result
        )

        return {"success": True, "data": {"results": final_result}}

    else:
        # 普通工具调用（工具内部会发布事件）
        from tools.tool_executor import execute_tool
        return execute_tool(tool_name, arguments)
```

---

## 用户许可机制示例

### 场景：Agent需要用户确认才能执行危险操作

```python
# backend/agents/master_agent_v2/master_v2.py

async def _execute_tool_with_approval(
    self,
    tool_name: str,
    arguments: Dict,
    context: AgentContext
):
    """执行工具（需要用户许可）"""

    # 判断是否需要用户许可
    dangerous_tools = ['execute_cypher_query', 'delete_data']

    if tool_name in dangerous_tools:
        # ✨ 请求用户许可（阻塞等待）
        approved = await self._publisher.request_user_approval(
            action_description=f"执行工具 {tool_name}，参数: {arguments}",
            timeout=60.0
        )

        if not approved:
            # 用户拒绝
            return {
                "success": False,
                "error": "用户拒绝执行该操作"
            }

    # 执行工具
    return self._execute_tool(tool_name, arguments, context)
```

### 前端处理用户许可请求

```javascript
// frontend/src/components/AgentChat.vue

const eventSource = new EventSource('/api/agent/stream');

eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'user.approval_required') {
        // 显示用户许可对话框
        showApprovalDialog({
            approvalId: data.data.approval_id,
            agentName: data.data.agent_name,
            description: data.data.action_description,
            timeout: data.data.timeout
        });
    }

    // 其他事件类型...
};

function handleUserApproval(approvalId, approved) {
    // 发送用户响应到后端
    fetch('/api/agent/approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            approval_id: approvalId,
            approved: approved
        })
    });
}
```

### 后端接收用户许可响应

```python
# routes/agent.py

@agent_bp.route('/approval', methods=['POST'])
def handle_approval():
    """接收用户许可响应"""
    data = request.get_json()
    approval_id = data.get('approval_id')
    approved = data.get('approved', False)

    # 获取事件总线
    event_bus = get_event_bus()

    # 响应许可请求
    event_bus.respond_to_approval(approval_id, approved)

    return success_response(message="已收到用户响应")
```

---

## 事件类型参考

### Agent执行事件
- `agent.start` - Agent开始执行
- `agent.end` - Agent执行完成
- `agent.error` - Agent执行错误

### 思考过程事件
- `agent.thought` - 简单思考（纯文本）
- `agent.thought_structured` - 结构化思考（包含推理和动作）

### 工具调用事件
- `tool.start` - 工具开始执行
- `tool.end` - 工具执行完成
- `tool.error` - 工具执行错误

### 子任务事件
- `subtask.start` - 子任务开始
- `subtask.end` - 子任务完成

### 流式输出事件
- `output.chunk` - 流式输出片段
- `output.final_answer` - 最终答案（标记完成，不含持久化字段）
- `output.message_saved` - 消息持久化完成（携带 `id`/`seq` 供前端补全）

### 可视化事件
- `visualization.chart` - 图表生成
- `visualization.map` - 地图生成

### 用户交互事件
- `user.approval_required` - 需要用户许可
- `user.approval_granted` - 用户同意
- `user.approval_denied` - 用户拒绝
- `user.interrupt` - 用户中断
- `user.feedback` - 用户反馈

### 会话事件
- `session.start` - 会话开始
- `session.end` - 会话结束

---

## 前端集成示例

### Vue 3 组件示例

```vue
<template>
  <div class="agent-chat">
    <!-- 思考过程展示 -->
    <div v-for="event in events" :key="event.event_id" class="event-item">
      <!-- Agent思考 -->
      <div v-if="event.type === 'agent.thought'" class="thought">
        💭 {{ event.data.content }}
      </div>

      <!-- 工具调用 -->
      <div v-if="event.type === 'tool.start'" class="tool-start">
        🔧 调用工具: {{ event.data.tool_name }}
      </div>

      <!-- 最终答案 -->
      <div v-if="event.type === 'output.final_answer'" class="final-answer">
        {{ event.data.content }}
      </div>

      <!-- 用户许可请求 -->
      <div v-if="event.type === 'user.approval_required'" class="approval-request">
        <p>⚠️ {{ event.data.action_description }}</p>
        <button @click="approve(event.data.approval_id)">同意</button>
        <button @click="deny(event.data.approval_id)">拒绝</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';

const events = ref([]);

onMounted(() => {
  const eventSource = new EventSource('/api/agent/stream');

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    events.value.push(data);
  };

  eventSource.onerror = (error) => {
    console.error('SSE连接错误:', error);
    eventSource.close();
  };
});

function approve(approvalId) {
  fetch('/api/agent/approval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approval_id: approvalId, approved: true })
  });
}

function deny(approvalId) {
  fetch('/api/agent/approval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approval_id: approvalId, approved: false })
  });
}
</script>
```

---

## 性能优化建议

### 1. 事件过滤

```python
# 仅订阅关心的事件类型
event_bus.subscribe(
    event_types=[
        EventType.THOUGHT,
        EventType.FINAL_ANSWER,
        EventType.USER_APPROVAL_REQUIRED
    ],
    handler=my_handler
)
```

### 2. 批量发送事件

```python
# 在SSE适配器中批量发送（减少HTTP请求）
class SSEAdapter:
    def __init__(self, batch_size=5, batch_interval=0.1):
        self.batch_size = batch_size
        self.batch_interval = batch_interval

    async def stream(self):
        batch = []
        last_send = time.time()

        while not self._stopped:
            event = await self._event_queue.get()
            batch.append(event)

            # 批量发送条件
            if len(batch) >= self.batch_size or (time.time() - last_send) >= self.batch_interval:
                yield self._format_batch_sse(batch)
                batch = []
                last_send = time.time()
```

### 3. 事件压缩

```python
# 对大事件进行压缩
import gzip
import base64

def _format_sse(self, event: Event) -> str:
    json_data = json.dumps(event.to_dict(), ensure_ascii=False)

    if len(json_data) > 1024:  # 超过1KB才压缩
        compressed = gzip.compress(json_data.encode('utf-8'))
        encoded = base64.b64encode(compressed).decode('ascii')
        return f"data: {json.dumps({'compressed': True, 'data': encoded})}\n\n"
    else:
        return f"data: {json_data}\n\n"
```

---

## 监控与调试

### 获取事件统计

```python
# 获取事件总线统计信息
event_bus = get_event_bus()
stats = event_bus.get_stats()

print(stats)
# {
#     "total_events": 1234,
#     "events_by_type": {
#         "agent.thought": 456,
#         "tool.start": 123,
#         ...
#     },
#     "failed_events": 5,
#     "active_subscriptions": 3,
#     "pending_approvals": 1
# }
```

### 查看事件历史

```python
# 获取最近100个事件
history = event_bus.get_event_history(limit=100)

# 过滤特定类型的事件
thoughts = event_bus.get_event_history(
    event_types=[EventType.THOUGHT, EventType.THOUGHT_STRUCTURED],
    session_id="abc123",
    limit=50
)
```

---

## 迁移清单

- [ ] 创建事件总线相关文件
  - [x] `backend/agents/event_bus.py`
  - [x] `backend/agents/event_publisher.py`
  - [x] `backend/agents/sse_adapter.py`

- [ ] 修改 MasterAgent V2
  - [ ] 在 `__init__` 中初始化事件发布器
  - [ ] 在 `execute_stream` 中使用事件发布器替代 `yield`
  - [ ] 在工具执行中发布事件

- [ ] 修改 Flask 路由
  - [ ] `/api/agent/stream` 使用 SSE 适配器
  - [ ] 添加 `/api/agent/approval` 路由

- [ ] 前端适配
  - [ ] 修改 EventSource 处理逻辑
  - [ ] 添加用户许可对话框组件

- [ ] 测试
  - [ ] 单元测试：事件总线
  - [ ] 集成测试：Agent执行
  - [ ] E2E测试：用户许可流程

---

**文档版本**: 1.0
**创建日期**: 2026-02-11
