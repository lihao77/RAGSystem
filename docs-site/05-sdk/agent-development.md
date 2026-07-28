---
status: current
audience: developer
source: packages/agent-sdk/src, backend-ts/src/tools
verified_at: 2026-07-27
---

# Agent 开发

新增 Agent 能力优先选择：

1. 业务编排写入 `backend-ts/src/services/agent`；
2. 可复用内核能力写入 `packages/agent-sdk`；
3. 外部模型适配写入 `packages/agent-llm`；
4. 工具能力创建独立 `backend-ts/src/tools/<Tool>` 并注册到 registry；
5. SDK 运行时行为通过 `KernelEvent` 暴露，backend 适配成 `agent-protocol` 的客户端事件。

工具必须声明输入 schema、权限风险、超时/取消行为、observation 和测试。
