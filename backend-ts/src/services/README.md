# Service Domains

`services` is organized by runtime domain. Keep service entry files inside the
domain that owns their behavior, and keep same-name implementation folders next
to their facade file.

## Domains

- `agent/`: agent orchestration, execution, sessions, prompts, delegation, and
  context construction.
- `runtime/`: process-level runtime composition, runtime protocols, event bus,
  permissions, pending interactions, and background tasks.
- `tools/`: local tool implementations and tool-facing service APIs.
- `stores/`: persistence, checkpoints, file indexing, conversation data, and
  memory storage.
- `config/`: system configuration services.
- `integrations/`: external protocol or provider adapters, including LLM, MCP,
  and model adapter services.
- `knowledge/`: vector library and embedding model services.
- `artifacts/`: artifact storage and management.
- `daemon/`: daemon runtime services.

## Local Structure

Use the existing facade pattern for multi-file services:

```text
services/<domain>/foo-service.ts
services/<domain>/foo-service/*.ts
```

`foo-service.ts` is the public entry point for that service. Files in the
same-name folder are implementation details and should normally be imported only
by the facade or other files in the same service package.

Avoid adding new service files directly under `services/`; choose the owning
domain instead.
