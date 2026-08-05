# Core Service Domains

This directory contains implementation details of the Core Agent kernel. Public integration
surfaces belong in `src/contracts`; plugin runtime factories receive those contracts through
`BackendPluginRuntimeContext`.

## Domains

- `agent/`: Agent orchestration, execution, sessions, prompts, delegation, and context
  construction.
- `runtime/`: Process-level runtime composition, event delivery, permissions, pending
  interactions, and generic background-task execution.
- `config/`: Core system configuration projection and extension lifecycle.
- `integrations/`: Generic model-provider administration and model transport adapters.
- `identity/`: Deployment-neutral identity and authentication primitives.

Persistence and deployment-specific implementations are outside Core in `backend-local`,
`backend-saas`, or a domain plugin. Knowledge, Memory, Skills, Artifacts, MCP, Daemon/Feishu,
Widget, Agent Builder, and tool-domain services are plugin-owned and must not be added here.

When a plugin needs a Core capability, add or use a semantic port under `src/contracts` and inject
it through the plugin runtime context. Do not expose a concrete Core service class as a plugin API.
