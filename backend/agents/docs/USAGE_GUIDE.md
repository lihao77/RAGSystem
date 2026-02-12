# 智能体系统使用指南

## 概述

RAGSystem 智能体系统已成功实现！系统提供了灵活、可扩展的智能体架构，支持单智能体执行和多智能体协作。

## 已完成的工作

### ✅ 基础设施
- `backend/agents/base.py` - BaseAgent 基类、AgentContext、AgentResponse
- `backend/agents/registry.py` - AgentRegistry 智能体注册表
- `backend/agents/orchestrator.py` - AgentOrchestrator 编排器

### ✅ 智能体实现
- `backend/agents/qa_agent.py` - QAAgent 知识图谱问答智能体
- `backend/agents/chart_agent.py` - ChartAgent 图表生成智能体（已存在）

### ✅ API 接口
- `backend/routes/agent.py` - 智能体系统 API 路由
- 已在 `app.py` 中注册路由：`/api/agent`

### ✅ 测试工具
- `backend/test_qa_agent.py` - QAAgent 测试脚本

## API 使用指南

### 1. 查看可用智能体

```bash
GET /api/agent/agents
```

**响应示例：**
```json
{
  "success": true,
  "data": [
    {
      "name": "qa_agent",
      "description": "知识图谱问答智能体，基于 Function Calling 实现多轮对话和工具调用",
      "capabilities": [
        "knowledge_graph_query",
        "multi_turn_conversation",
        "tool_calling",
        "reasoning"
      ],
      "tools": [
        "query_knowledge_graph_with_nl",
        "search_knowledge_graph",
        "get_entity_relations",
        "..."
      ]
    }
  ],
  "message": "共有 1 个智能体"
}
```

### 2. 执行任务（自动路由）

```bash
POST /api/agent/execute
Content-Type: application/json

{
  "task": "查询2023年南宁市的洪涝灾害情况",
  "session_id": "user_123",  // 可选
  "agent": "qa_agent"         // 可选，不指定则自动路由
}
```

**响应示例：**
```json
{
  "success": true,
  "data": {
    "answer": "根据查询结果，2023年南宁市发生了...",
    "agent_name": "qa_agent",
    "execution_time": 2.5,
    "tool_calls": [
      {
        "name": "query_knowledge_graph_with_nl",
        "arguments": {"question": "..."},
        "result": {"success": true, "data": [...]}
      }
    ],
    "metadata": {
      "rounds": 2,
      "tool_calls_count": 3
    },
    "session_id": "user_123"
  },
  "message": "任务执行成功"
}
```

### 3. 执行指定智能体

```bash
POST /api/agent/execute/qa_agent
Content-Type: application/json

{
  "task": "潘厂水库在2020年6月7日的情况如何？",
  "session_id": "user_123"
}
```

### 4. 多智能体协作

```bash
POST /api/agent/collaborate
Content-Type: application/json

{
  "tasks": [
    {"task": "查询2023年各市的受灾人数", "agent": "qa_agent"},
    {"task": "生成受灾人数对比柱状图", "agent": "chart_agent"}
  ],
  "session_id": "user_123",
  "mode": "sequential"  // sequential 或 parallel（未来支持）
}
```

**响应示例：**
```json
{
  "success": true,
  "data": {
    "results": [
      {
        "success": true,
        "content": "查询到以下数据...",
        "agent_name": "qa_agent",
        "execution_time": 2.3
      },
      {
        "success": true,
        "content": "已生成图表",
        "agent_name": "chart_agent",
        "execution_time": 0.5
      }
    ],
    "session_id": "user_123",
    "total_tasks": 2
  },
  "message": "协作任务执行完成"
}
```

### 5. 健康检查

```bash
GET /api/agent/health
```

## 测试指南

### 运行测试脚本

```bash
cd backend
python test_qa_agent.py
```

测试脚本包含以下测试用例：
1. **智能体信息查询** - 测试智能体元数据
2. **直接调用 QAAgent** - 测试单智能体执行
3. **通过 Orchestrator 调用** - 测试自动路由
4. **多轮对话** - 测试上下文管理

### 手动测试（使用 curl）

```bash
# 1. 查看可用智能体
curl http://localhost:5000/api/agent/agents

# 2. 执行问答任务
curl -X POST http://localhost:5000/api/agent/execute \
  -H "Content-Type: application/json" \
  -d '{
    "task": "查询2023年南宁市的洪涝灾害情况"
  }'

# 3. 健康检查
curl http://localhost:5000/api/agent/health
```

## Python 使用示例

### 示例 1: 直接使用 QAAgent

```python
from agents import QAAgent, AgentContext
from model_adapter import get_default_adapter
from config import get_config

# 初始化
config = get_config()
adapter = get_default_adapter()

# 创建智能体
qa_agent = QAAgent(model_adapter=adapter, config=config)

# 创建上下文
context = AgentContext(session_id="user_123")

# 执行任务
response = qa_agent.execute(
    task="查询2023年南宁市的洪涝灾害情况",
    context=context
)

# 处理结果
if response.success:
    print(f"答案: {response.content}")
    print(f"执行时间: {response.execution_time:.2f}秒")
else:
    print(f"错误: {response.error}")
```

### 示例 2: 使用 Orchestrator（推荐）

```python
from agents import get_orchestrator, QAAgent, AgentContext
from model_adapter import get_default_adapter
from config import get_config

# 初始化
config = get_config()
adapter = get_default_adapter()

# 创建 Orchestrator
orchestrator = get_orchestrator(model_adapter=adapter)

# 注册智能体
qa_agent = QAAgent(model_adapter=adapter, config=config)
orchestrator.register_agent(qa_agent)

# 执行任务（自动路由）
response = orchestrator.execute(
    task="查询2023年南宁市的洪涝灾害情况"
)

print(f"路由到: {response.agent_name}")
print(f"答案: {response.content}")
```

### 示例 3: 多轮对话

```python
from agents import get_orchestrator, QAAgent, AgentContext

# 初始化（同上）
orchestrator = get_orchestrator(model_adapter=adapter)
qa_agent = QAAgent(model_adapter=adapter, config=config)
orchestrator.register_agent(qa_agent)

# 创建持久化上下文
context = AgentContext(session_id="user_123")

# 第一轮对话
response1 = orchestrator.execute(
    task="查询2023年广西的水灾情况",
    context=context
)
print(f"回答1: {response1.content}")

# 第二轮对话（依赖上下文）
response2 = orchestrator.execute(
    task="受灾最严重的是哪个地区？",
    context=context
)
print(f"回答2: {response2.content}")

# 查看对话历史
print(f"对话历史: {len(context.conversation_history)} 条")
```

### 示例 4: 多智能体协作

```python
from agents import get_orchestrator, QAAgent, ChartAgent, AgentContext

# 初始化
orchestrator = get_orchestrator(model_adapter=adapter)

# 注册多个智能体
qa_agent = QAAgent(model_adapter=adapter, config=config)
chart_agent = ChartAgent()  # ChartAgent 未来也需要适配 BaseAgent

orchestrator.register_agent(qa_agent)
# orchestrator.register_agent(chart_agent)  # 等重构完成

# 多智能体协作
context = AgentContext(session_id="user_123")

results = orchestrator.collaborate(
    tasks=[
        {'task': '查询2023年各市的受灾人数', 'agent': 'qa_agent'},
        # {'task': '生成对比柱状图', 'agent': 'chart_agent'},
    ],
    context=context,
    mode='sequential'
)

for i, result in enumerate(results):
    print(f"任务 {i+1} 结果: {result.content}")
```

## 架构说明

### 核心组件

1. **BaseAgent** - 智能体基类
   - 定义统一接口
   - 提供生命周期管理
   - 支持能力声明

2. **AgentContext** - 上下文管理
   - 对话历史
   - 中间结果
   - 共享数据

3. **AgentRegistry** - 注册表
   - 智能体注册和发现
   - 按能力查找

4. **AgentOrchestrator** - 编排器
   - 任务路由
   - 智能体调度
   - 多智能体协作

### 智能体特性

#### QAAgent
- **职责**: 知识图谱问答
- **工具**: 9个知识图谱工具
- **能力**: 多轮对话、工具调用、推理
- **特点**: 基于 Function Calling，支持复杂查询

#### ChartAgent（待重构）
- **职责**: 图表生成
- **工具**: 内置图表生成方法
- **能力**: 数据可视化
- **特点**: 自动选择图表类型

## 下一步开发建议

### 短期任务
1. ✅ QAAgent 实现
2. ⏳ 重构 ChartAgent 继承 BaseAgent
3. ⏳ 添加更多智能体（VisualizationAgent、AnalysisAgent 等）
4. ⏳ 完善测试覆盖率

### 中期任务
1. 实现会话管理（持久化上下文）
2. 添加智能体性能监控
3. 支持并行协作模式
4. 添加智能体配置管理

### 长期任务
1. 实现智能体记忆系统
2. 支持自主规划能力
3. 工具动态注册机制
4. 智能体学习和优化

## 故障排查

### 常见问题

**1. 智能体初始化失败**
```
错误: Orchestrator 初始化失败
解决: 检查 Model Adapter 配置和 Neo4j 连接
```

**2. 工具调用失败**
```
错误: 工具 xxx 执行失败
解决: 查看后端日志，检查工具依赖
```

**3. 路由失败**
```
错误: 未找到合适的智能体
解决: 检查智能体注册和 can_handle 方法
```

### 调试技巧

1. **查看日志**
```bash
# 后端日志会显示详细的执行过程
tail -f backend/logs/app.log
```

2. **使用测试脚本**
```bash
cd backend
python test_qa_agent.py
```

3. **直接测试智能体**
```python
from agents import QAAgent
from model_adapter import get_default_adapter
from config import get_config

agent = QAAgent(model_adapter=get_default_adapter(), config=get_config())
print(agent.get_info())
```

## 文档索引

- **设计文档**: `backend/agents/AGENT_SYSTEM_DESIGN.md`
- **使用指南**: 本文件
- **API 文档**: 见本文 "API 使用指南" 部分
- **测试脚本**: `backend/test_qa_agent.py`

## 总结

智能体系统现已完全可用！🎉

- ✅ 基础设施完成
- ✅ QAAgent 实现
- ✅ API 接口就绪
- ✅ 测试工具完成

你可以：
1. 运行测试脚本验证功能
2. 通过 API 接口调用智能体
3. 开始添加更多智能体
4. 实现多智能体协作场景

祝开发顺利！如有问题，请参考设计文档或查看测试脚本示例。
