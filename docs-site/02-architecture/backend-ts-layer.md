# TypeScript 后端分层

| 包/目录 | 职责 |
|---|---|
| backend-core/src/contracts | 领域、运行时与存储契约 |
| backend-core/src/services | Agent 执行、编排、配置与会话业务逻辑 |
| backend-core/src/routes | HTTP/WebSocket 接口 |
| backend-core/src/plugins | 插件生命周期、能力、资源和扩展点 |
| backend-local/src/adapters/local | SQLite、文件、隐式身份与本地组合 |
| plugins/backend-plugin-* | 各功能的路由、工具、配置和存储 |
| packages/agent-sdk、agent-llm、agent-protocol | Agent SDK、模型传输与消息协议 |

运行入口只有 backend-local/main.ts。core 保持为可测试的内核库，使用 application 接口接收本地实现。场景底层继续使用 tenantId 和按场景目录，前端通过本地场景插件管理。

产品内置 Team 由 backend-local 的组合层补齐；Agent 配置服务仅提供存取、归一和校验。领域插件通过明确契约接入，不在 core 内硬编码插件能力。
