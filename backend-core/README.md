# RAGSystem Backend Core

`backend-core` is the Agent kernel and plugin host. It is not a deployable server and does not
own Local filesystem, SQLite, SaaS PostgreSQL, sandbox, or object-storage adapters.

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

- `backend-local`: filesystem, SQLite, local sessions, local runtime storage, and local host
  resource injection.
- `backend-saas`: PostgreSQL, object storage, sandbox leases, and SaaS session/runtime adapters.

Deployments inject host capabilities through typed resource tokens. Core and plugins must not
discover deployment implementations through repository paths or concrete service imports.

## Domain Plugins Own

- Knowledge: vectorizers, rerankers, indexing, document ingestion, and knowledge tools.
- Memory: memory storage, retrieval, and memory hooks/tools.
- Skills: Skill packages, built-in Skill sources, execution, authoring, and Skill tools.
- Artifacts: artifact storage, staging, and artifact tools.
- MCP: server configuration, client lifecycle, and MCP tools.
- Execution Tools, Document Tools, Sandbox, Widget, Daemon/Feishu, and Agent Builder: their
  respective tools, routes, persistence, and runtime capabilities.

Plugins consume Core contracts and runtime ports. A plugin may depend on another plugin's
capability or typed resource token, but it must not import a Core concrete service as its runtime
integration API.

## Development

```bash
npm run typecheck:backend
npm -w @ragsystem/backend-core run typecheck:test
npm -w @ragsystem/backend-core test
npm run build:backend
```

See [docs/migration-boundaries.md](docs/migration-boundaries.md) for the ownership checklist.
