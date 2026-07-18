# 工具系统

本章拆解 RAGSystem 的工具体系：内置工具、MCP 集成、权限审批。基于 `backend-ts/src/tools/` 与 `services/runtime/` 的真实实现。

## 工具注册表

`tools/registry.ts` 的 `createBackendTools` 是工具聚合入口，**per-agent** 构建工具集：

```ts
export function createBackendTools(deps: BackendToolsDeps, pathService: PathApprovalService): Tool[] {
  const { agent } = deps;
  return [
    ...createRequestUserInputTools(...),
    ...createDocumentTools(...),
    ...createBashTools(...),
    ...createCodeExecutionTools(...),
    ...createLocalSearchTools(...),
    ...createSkillTools(...),
    ...createKnowledgeTools(...),
    ...createTaskTools(...),
    ...createMemoryTools(...),
    ...createDelegationTools(...),
    ...createMcpTools(...),
  ];
}
```

::: tip 关键设计
- **可见性融入工厂**：每个 `createXxxTools` 工厂接收 `agent` 配置，内部按 agent 决定返回哪些工具（不满足条件的工具不返回）
- **per-agent 闭包绑定**：工厂闭包绑定 agent 配置，返回的 Tool 实例自带 agent 上下文
- 返回 `Tool[]`（来自 `@ragsystem/agent-sdk`）供 SDK `createToolRegistry` 使用
:::

## 内置工具清单

| 工具组 | 工厂 | 执行服务 | 职责 |
|--------|------|----------|------|
| 请求用户输入 | `RequestUserInputTool/` | `PendingInteractionService` | 工具向用户请求输入 |
| 文档操作 | `DocumentTools/` | `LocalDocumentToolService` | 文件读/写/编辑/预览 |
| Bash | `BashTool/` | `LocalBashToolService` | 命令执行（含超时/输出限制/后台任务） |
| 代码执行 | `CodeExecutionTool/` | `CodeExecutionToolService` | 代码沙箱执行 |
| 本地检索 | `LocalSearchTools/` | `LocalSearchToolService` | glob/grep 文件搜索 |
| 技能 | `SkillTools/` | `SkillToolService` | 技能调用 |
| 知识库 | `KnowledgeTools/` | `VectorLibraryService` | 向量检索 |
| 任务 | `TaskTools/` | `TaskToolService` | 后台任务（含 background-output、task-store） |
| 记忆 | `MemoryTools/` | `MemoryToolService` | 记忆读写 |
| 委派 | `DelegationTools/` | `AgentDelegationService` | call_agent 等委派工具 |
| MCP | `McpTools/` | `McpService` | 动态 MCP 工具发现与调用 |

## 工具依赖注入

`BackendToolsDeps` 接口（`registry.ts:33`）定义工具所需的全部依赖：

```ts
interface BackendToolsDeps {
  agent: AgentConfig;                           // per-agent 配置
  memoryTools: MemoryToolService;
  pendingInteractions: PendingInteractionService | null;
  documentTools: LocalDocumentToolService | null;
  bashTools: LocalBashToolService | null;
  taskTools: TaskToolService | null;
  searchTools: LocalSearchToolService | null;
  vectorLibrary: VectorLibraryService | null;
  mcp: McpService | null;
  codeExecutionTools: CodeExecutionToolService | null;
  skillTools: SkillToolService | null;
  getAgentDelegation: () => DelegationPort | null;
  agentConfig?: DelegationAgentConfigLookup | null;  // 委派工具 allowlist 用
  teamName?: string | null;                           // session team
}
```

::: tip 来源
`runtime-container.ts:205-219` 构造 `toolsDeps`（`Omit<BackendToolsDeps, "agent" | "teamName">`），`agent` 与 `teamName` 由 runtime-adapter 在 per-run 时补充。
:::

注意大多数字段允许 `null`，工具工厂内部据此决定是否返回该工具——缺失依赖的工具对 agent 不可见。

## 权限与审批

### PermissionPolicyService

`services/runtime/permission-policy-service.ts`（由 `runtime-container.ts` 装配）实现工具调用权限策略。当前策略通过 Runtime 和 Agent 工具执行链生效，`app.ts` 未注册独立 `/api/permissions` 公共路由。

### PathApprovalService

文档/Bash 等涉及文件路径的工具，经 `PathApprovalService` 做路径审批（`registry.ts:59` 的第二参数）。

### MCP per-tool 风险等级

MCP 工具携带 `risk_level` 元数据（见 [MCP 服务](/03-guides/mcp#工具定义的丰富元数据)），权限系统据此决策是否需要人工审批。这是 MCP "一等公民"定位的体现。

## 运行时工具桥接

`services/runtime/runtime-tool-bridge/` 负责把 `BackendToolsDeps` 装配为 SDK 可用的工具集，per-run 注入 `agent` 与 `teamName`。

## 工具配置

部分工具的行为受系统配置驱动。`runtime-container.ts:169` 读取 `systemConfig.getToolsConfig()`：

```ts
const toolsConfig = systemConfig.getToolsConfig();
// 用于：
// - CodeExecutionTool: code_default_timeout / code_max_timeout
// - BashTool: bash_default_timeout / bash_max_timeout / bash_max_output
```

## HostToolRegistry

`services/runtime/host-tool-registry.ts`（`runtime-container.ts:195`）维护宿主级工具注册，供 widget 等场景按需暴露工具。

## 工具与 Agent 运行时的关系

```
AgentRunEngine (per-run)
    │
    ├─ runtime-adapter 构建 deps（补 agent + teamName）
    │
    ├─ createBackendTools(deps, pathService) → Tool[]
    │       ├─ 内置工具（按 agent 可见性过滤）
    │       └─ MCP 工具（动态从已连接服务器发现）
    │
    ├─ SDK createToolRegistry(Tool[])
    │
    └─ 工具循环：LLM 调用 → 权限审批 → 执行 → 观察
```

详见 [Agent 运行时](./agent-runtime)。
