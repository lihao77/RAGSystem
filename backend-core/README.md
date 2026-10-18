# RAGSystem Backend Core

`backend-core` is the Agent kernel and plugin host. It is not a deployable server and does not
own Local filesystem, SQLite, or sandbox adapters.

## Core Owns

- Agent execution orchestration, prompts, delegation, context compression, and common runtime
  tools.
- Shared contracts for sessions, conversations, execution, storage ports, events, permissions,
  model providers, and system configuration.
- Fastify application assembly and deployment-neutral route/application contracts.
- Plugin lifecycle, capability registry, typed resource tokens, route/tool contributions, and
  runtime ports.
- Model Adapter: provider catalog, provider administration, chat/embedding/rerank transport, and
  provider resilience. Model Adapter is a generic model access capability; it does not own any
  knowledge-base domain behavior.

## Deployment Adapters Own

- `backend-local`: filesystem, SQLite, local sessions, local runtime storage, host execution
  environment, and local resource injection.

Deployments inject host capabilities through typed resource tokens. Core and plugins must not
discover deployment implementations through repository paths or concrete service imports.

## Domain Plugins Own

- Knowledge: vectorizers, rerankers, indexing, document ingestion, and knowledge tools.
- Memory: memory storage, retrieval, and memory hooks/tools.
- Skills: Skill packages, built-in Skill sources, execution, authoring, and Skill tools.
- MCP: server configuration, client lifecycle, and MCP tools.
- Execution Tools, Document Tools, Scheduler, Daemon/Feishu, Widget, Media Generation, Image
  Tools, Pet, Local Scenes, and Agent Builder: their respective tools, routes, persistence, and
  runtime capabilities.

`backend-local/backend.plugins.yaml` is the authoritative installed inventory; see
[../plugins/README.md](../plugins/README.md) for the plugin contract.

Sandboxing is deployment infrastructure rather than a feature plugin. Deployments expose the
high-level run sandbox runtime to tool plugins while the low-level sandbox driver remains private.

Plugins consume Core contracts and runtime ports. A plugin may depend on another plugin's
capability or typed resource token, but it must not import a Core concrete service as its runtime
integration API. The package export map mirrors that line: `contracts/`, `plugins/`, `identity/`
and the remaining wildcard directories stay open by design, while `services/` exports an explicit
allowlist of the modules plugins and deployments actually consume. Importing a new Core service is
therefore a visible `package.json` change that has to be reviewed as a seam decision.

## Development

```bash
npm run typecheck:backend
npm -w @ragsystem/backend-core run typecheck:test
npm -w @ragsystem/backend-core test
npm run build:backend
```

See [docs/migration-boundaries.md](docs/migration-boundaries.md) for the ownership checklist.
