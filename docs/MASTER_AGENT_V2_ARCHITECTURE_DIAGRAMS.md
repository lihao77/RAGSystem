# MasterAgent V2 架构可视化图表

本文档包含 MasterAgent V2 多智能体系统的各类架构图，使用 Mermaid 格式绘制。

---

## 1. 系统总体架构图

```mermaid
graph TB
    User[用户请求] --> Flask[Flask Routes<br/>routes/agent.py]
    Flask --> Orch[AgentOrchestrator<br/>orchestrator.py]

    Orch --> MasterV1[MasterAgent V1<br/>DAG静态编排]
    Orch --> MasterV2[MasterAgent V2<br/>ReAct动态编排]

    MasterV2 --> AgentExec[AgentExecutor<br/>agent_executor.py]

    AgentExec --> SubAgent1[kgqa_agent]
    AgentExec --> SubAgent2[chart_agent]
    AgentExec --> SubAgent3[emergency_agent]

    SubAgent1 --> ToolExec[ToolExecutor<br/>tool_executor.py]
    SubAgent2 --> ToolExec
    SubAgent3 --> ToolExec

    ToolExec --> Neo4j[(Neo4j DB)]
    ToolExec --> Vector[(VectorStore<br/>SQLite-vec)]
    ToolExec --> Services[Services<br/>Cypher等]

    style MasterV2 fill:#4CAF50
    style AgentExec fill:#2196F3
    style ToolExec fill:#FF9800
```

---

## 2. MasterAgent V2 执行流程图

```mermaid
sequenceDiagram
    participant User
    participant Flask
    participant MasterV2
    participant AgentExec
    participant SubAgent
    participant Tool

    User->>Flask: POST /api/agent/stream
    Flask->>MasterV2: execute_stream(task, context)

    loop ReAct循环 (最多15轮)
        MasterV2->>MasterV2: 分析任务 (LLM)
        MasterV2->>MasterV2: thought: 决定调用哪个Agent

        alt 调用Agent
            MasterV2->>AgentExec: invoke_agent_kgqa_agent
            AgentExec->>SubAgent: execute_stream(task, child_context)

            loop SubAgent ReAct循环
                SubAgent->>SubAgent: thought: 决定使用工具
                SubAgent->>Tool: execute_tool(tool_name, args)
                Tool-->>SubAgent: tool_result
                SubAgent->>Flask: yield tool_start/tool_end
            end

            SubAgent-->>AgentExec: final_answer
            AgentExec->>MasterV2: context.merge(child_context)
            MasterV2->>Flask: yield subtask_start/subtask_end
        end

        alt 有最终答案
            MasterV2->>Flask: yield final_answer
            Flask-->>User: SSE stream
        end
    end
```

---

## 3. 上下文分层与Fork/Merge机制

```mermaid
graph TB
    subgraph "Level 0: Master Context"
        MC[MasterAgent Context]
        MC_History[conversation_history<br/>独立]
        MC_Shared[shared_data<br/>引用共享]
        MC_Blackboard[blackboard<br/>引用共享]
    end

    subgraph "Level 1: SubAgent Context"
        SC[SubAgent Context]
        SC_History[conversation_history<br/>独立副本]
        SC_Shared[shared_data<br/>引用父级]
        SC_Blackboard[blackboard<br/>引用父级]
    end

    MC -->|context.fork| SC
    SC -->|context.merge| MC

    MC_Shared -.->|引用| SC_Shared
    MC_Blackboard -.->|引用| SC_Blackboard

    style MC fill:#4CAF50
    style SC fill:#2196F3
    style MC_Shared fill:#FFC107
    style SC_Shared fill:#FFC107
    style MC_Blackboard fill:#FF5722
    style SC_Blackboard fill:#FF5722
```

---

## 4. 数据流与事件流

```mermaid
graph LR
    subgraph "请求流 (Request Flow)"
        A1[User Request] --> A2[Flask Route]
        A2 --> A3[Orchestrator]
        A3 --> A4[MasterAgent V2]
        A4 --> A5[AgentExecutor]
        A5 --> A6[SubAgent]
        A6 --> A7[ToolExecutor]
        A7 --> A8[DB/Service]
    end

    subgraph "响应流 (Response Flow - SSE)"
        B8[DB/Service] --> B7[ToolExecutor]
        B7 --> B6[SubAgent<br/>yield events]
        B6 --> B5[AgentExecutor<br/>透传events]
        B5 --> B4[MasterAgent V2<br/>汇总events]
        B4 --> B2[Flask<br/>SSE]
        B2 --> B1[User]
    end

    style A4 fill:#4CAF50
    style B4 fill:#4CAF50
```

---

## 5. 循环依赖问题可视化

### 5.1 当前的循环依赖

```mermaid
graph LR
    MasterV2[MasterAgent V2] -->|需要访问| Orch[Orchestrator]
    Orch -->|注册| MasterV2

    Loader[AgentLoader] -->|创建| MasterV2
    Loader -->|需要| Orch
    Orch -->|使用| Loader

    style MasterV2 fill:#F44336
    style Orch fill:#F44336
    style Loader fill:#F44336
```

### 5.2 解耦后的依赖关系 (事件总线方案)

```mermaid
graph TB
    MasterV2[MasterAgent V2] --> EventBus[EventBus]
    SubAgent[SubAgent] --> EventBus

    EventBus -->|发布| Exec1[agent.execute事件]
    EventBus -->|订阅| Sub1[SubAgent订阅]

    style EventBus fill:#4CAF50
    style MasterV2 fill:#2196F3
    style SubAgent fill:#2196F3
```

---

## 6. Agent工具调用拓扑 (MasterV2特有)

```mermaid
graph TB
    Master[MasterAgent V2] -->|LLM决策| ToolList[可用Agent工具列表]

    ToolList --> T1[invoke_agent_kgqa_agent]
    ToolList --> T2[invoke_agent_chart_agent]
    ToolList --> T3[invoke_agent_emergency_agent]

    T1 -->|执行| A1[kgqa_agent实例]
    T2 -->|执行| A2[chart_agent实例]
    T3 -->|执行| A3[emergency_agent实例]

    A1 -->|工具列表| T1A[query_knowledge_graph_with_nl]
    A1 --> T1B[execute_cypher_query]
    A1 --> T1C[find_causal_chain]

    A2 --> T2A[generate_chart]
    A2 --> T2B[transform_data]

    A3 --> T3A[query_emergency_plan]

    style Master fill:#4CAF50
    style T1 fill:#FF9800
    style T2 fill:#FF9800
    style T3 fill:#FF9800
```

---

## 7. 性能瓶颈点标注

```mermaid
graph TB
    User[用户请求] --> Flask[Flask Routes]
    Flask --> Orch[Orchestrator<br/>⚠️ 单例瓶颈]

    Orch -->|共享| LLM[LLMAdapter<br/>⚠️ 全局单例]

    Orch --> MasterV2[MasterAgent V2]
    MasterV2 -->|使用| LLM

    MasterV2 --> AgentExec[AgentExecutor]
    AgentExec --> SubAgent[SubAgent]
    SubAgent -->|使用| LLM

    SubAgent --> ToolExec[ToolExecutor<br/>⚠️ Switch-Case O(n)]

    ToolExec --> Neo4j[(Neo4j)]
    ToolExec --> Vector[(VectorStore)]

    style Orch fill:#F44336
    style LLM fill:#F44336
    style ToolExec fill:#FF9800
```

---

## 8. 改进后的架构 (事件驱动 + 池化)

```mermaid
graph TB
    User[用户请求] --> Flask[Flask Routes]
    Flask --> ReqOrch[请求级Orchestrator<br/>✅ 隔离状态]

    ReqOrch --> Pool[LLMAdapter Pool<br/>✅ 连接池]

    ReqOrch --> MasterV2[MasterAgent V2]
    MasterV2 -->|publish| EventBus[EventBus<br/>✅ 解耦通信]

    EventBus -->|subscribe| SubAgent1[SubAgent 1]
    EventBus -->|subscribe| SubAgent2[SubAgent 2]

    SubAgent1 --> Registry[ToolRegistry<br/>✅ O(1)查找]
    SubAgent2 --> Registry

    Registry --> Tool1[Tool 1]
    Registry --> Tool2[Tool 2]
    Registry --> Tool3[Tool 3]

    style ReqOrch fill:#4CAF50
    style Pool fill:#4CAF50
    style EventBus fill:#4CAF50
    style Registry fill:#4CAF50
```

---

## 9. 工具注册表优化前后对比

### 9.1 优化前 (Switch-Case)

```mermaid
graph TB
    Start[execute_tool] --> If1{tool == A?}
    If1 -->|Yes| ToolA[执行工具A]
    If1 -->|No| If2{tool == B?}
    If2 -->|Yes| ToolB[执行工具B]
    If2 -->|No| If3{tool == C?}
    If3 -->|Yes| ToolC[执行工具C]
    If3 -->|No| IfN[...]
    IfN --> Else[返回错误]

    style Start fill:#F44336
```

**时间复杂度**: O(n) - 最坏情况需要遍历所有工具

### 9.2 优化后 (注册表)

```mermaid
graph TB
    Start[execute_tool] --> Registry[ToolRegistry<br/>Dict查找]
    Registry --> Tool[直接执行工具]

    style Start fill:#4CAF50
    style Registry fill:#4CAF50
```

**时间复杂度**: O(1) - 直接哈希查找

---

## 10. 分布式追踪链路图

```mermaid
sequenceDiagram
    participant User
    participant Flask
    participant MasterV2
    participant SubAgent
    participant Tool

    Note over User,Tool: TraceID: abc123

    User->>Flask: Request
    Note right of Flask: SpanID: span-001<br/>ParentSpan: null

    Flask->>MasterV2: execute_stream
    Note right of MasterV2: SpanID: span-002<br/>ParentSpan: span-001

    MasterV2->>SubAgent: invoke_agent
    Note right of SubAgent: SpanID: span-003<br/>ParentSpan: span-002

    SubAgent->>Tool: execute_tool
    Note right of Tool: SpanID: span-004<br/>ParentSpan: span-003

    Tool-->>SubAgent: result
    SubAgent-->>MasterV2: result
    MasterV2-->>Flask: yield events
    Flask-->>User: SSE

    Note over User,Tool: 所有日志都附加 TraceID + SpanID
```

---

## 11. 插件化架构愿景

```mermaid
graph TB
    subgraph "核心系统"
        Core[Agent Core]
        Registry[Plugin Registry]
        Loader[Plugin Loader]
    end

    subgraph "插件1: kgqa_agent"
        P1[AgentPlugin Interface]
        P1A[execute]
        P1B[get_capabilities]
    end

    subgraph "插件2: chart_agent"
        P2[AgentPlugin Interface]
        P2A[execute]
        P2B[get_capabilities]
    end

    subgraph "插件3: custom_agent"
        P3[AgentPlugin Interface]
        P3A[execute]
        P3B[get_capabilities]
    end

    Core --> Registry
    Registry --> Loader

    Loader -->|加载| P1
    Loader -->|加载| P2
    Loader -->|加载| P3

    P1 --> P1A
    P1 --> P1B
    P2 --> P2A
    P2 --> P2B
    P3 --> P3A
    P3 --> P3B

    style Core fill:#4CAF50
    style Registry fill:#2196F3
    style Loader fill:#FF9800
```

---

## 12. 异步化架构愿景

```mermaid
graph TB
    subgraph "异步事件循环"
        Loop[asyncio Event Loop]
    end

    subgraph "并发Agent执行"
        Master[MasterAgent V2<br/>async execute]
        Task1[asyncio.Task<br/>SubAgent 1]
        Task2[asyncio.Task<br/>SubAgent 2]
        Task3[asyncio.Task<br/>SubAgent 3]
    end

    subgraph "异步工具调用"
        ToolTask1[asyncio.Task<br/>Tool 1]
        ToolTask2[asyncio.Task<br/>Tool 2]
    end

    Loop --> Master
    Master -->|create_task| Task1
    Master -->|create_task| Task2
    Master -->|create_task| Task3

    Task1 -->|create_task| ToolTask1
    Task2 -->|create_task| ToolTask2

    style Loop fill:#4CAF50
    style Master fill:#2196F3
    style Task1 fill:#FF9800
    style Task2 fill:#FF9800
    style Task3 fill:#FF9800
```

---

## 13. 微服务化部署拓扑

```mermaid
graph TB
    subgraph "负载均衡层"
        LB[Nginx / HAProxy]
    end

    subgraph "API网关"
        Gateway[API Gateway]
    end

    subgraph "Agent服务集群"
        Master1[MasterAgent Service 1]
        Master2[MasterAgent Service 2]

        KGQA1[KGQA Agent Service 1]
        KGQA2[KGQA Agent Service 2]

        Chart1[Chart Agent Service]
    end

    subgraph "基础设施"
        Registry[Service Registry<br/>Consul/etcd]
        MQ[Message Queue<br/>RabbitMQ/Kafka]
    end

    subgraph "数据层"
        Neo4j[(Neo4j Cluster)]
        Redis[(Redis Cache)]
    end

    LB --> Gateway
    Gateway --> Master1
    Gateway --> Master2

    Master1 -->|gRPC| KGQA1
    Master1 -->|gRPC| Chart1
    Master2 -->|gRPC| KGQA2

    Master1 --> Registry
    Master2 --> Registry
    KGQA1 --> Registry
    KGQA2 --> Registry
    Chart1 --> Registry

    Master1 --> MQ
    Master2 --> MQ

    KGQA1 --> Neo4j
    KGQA2 --> Neo4j
    Chart1 --> Redis

    style LB fill:#4CAF50
    style Gateway fill:#2196F3
    style Registry fill:#FF9800
    style MQ fill:#FF9800
```

---

## 使用说明

### 在 Markdown 编辑器中查看

支持 Mermaid 的 Markdown 编辑器：
- **Typora** (推荐)
- **VS Code** (需安装 Mermaid 插件)
- **GitHub** (原生支持)
- **GitLab** (原生支持)

### 导出为图片

使用 Mermaid CLI:
```bash
npm install -g @mermaid-js/mermaid-cli

# 导出单个图表
mmdc -i architecture.mmd -o architecture.png

# 导出所有图表
mmdc -i MASTER_AGENT_V2_ARCHITECTURE_DIAGRAMS.md -o diagrams/
```

### 在线编辑

- [Mermaid Live Editor](https://mermaid.live/)
- 复制图表代码到编辑器进行修改和导出

---

**文档版本**: 1.0
**创建日期**: 2026-02-11
**维护者**: RAGSystem Team
