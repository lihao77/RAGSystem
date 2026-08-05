# Backend Ownership Boundaries

This document is the boundary checklist for the TypeScript backend. It describes ownership, not
legacy compatibility. New code should follow these rules directly; no compatibility wrapper for
the old string-resource or concrete-service protocols is maintained.

## Core Boundary

Core owns the Agent kernel, common runtime contracts, deployment-neutral application assembly,
generic model access, and the plugin host. Core may define a port and an implementation, but a
domain-specific workflow belongs to the plugin that owns that domain.

The plugin runtime context exposes only semantic ports:

- provider catalog plus embedding/rerank client ports;
- system configuration read/extension registration;
- Agent configuration operations needed by runtime plugins;
- session application;
- background task execution;
- durable client-event publishing.

Concrete Core service classes are internal composition details, not plugin integration APIs.

## Host Boundary

Local and SaaS adapters own deployment state and inject it through typed `BackendResourceToken`
values. A resource has one declared owner and one provider. Plugins must resolve resources by the
token contract and must not inspect deployment paths or import host adapter classes.

## Plugin Boundary

| Domain | Owner |
| --- | --- |
| Knowledge/vector indexing/rerank/document ingestion | Knowledge plugin |
| Memory persistence/retrieval/hooks | Memory plugin |
| Skill packages/execution/authoring | Skills plugin |
| Artifact staging and artifact APIs | Artifacts plugin |
| MCP configuration/client/tools | MCP plugin |
| Bash/code/search tools | Execution Tools plugin |
| Document tools | Document Tools plugin |
| Sandbox execution environment | Sandbox plugin plus deployment host lease |
| Widget routes/authentication | Widget plugin |
| Feishu daemon and scheduled tasks | Daemon/Feishu plugin |
| Agent Builder | Agent Builder plugin |

The Model Adapter is a Core capability used by these plugins. It supplies provider lookup and
model transport ports; it does not make Knowledge or any other domain a Core service.

## Change Checklist

Before adding a cross-domain dependency:

1. Identify the owning domain.
2. Define the smallest semantic contract under `backend-core/src/contracts`.
3. Inject the contract through a runtime port or typed resource token.
4. Keep Local/SaaS construction in deployment adapters.
5. Add a focused contract or lifecycle test and run the backend typecheck/test commands.
