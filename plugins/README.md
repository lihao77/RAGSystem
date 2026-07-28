# Backend feature plugins

Feature plugins depend on the public `@ragsystem/backend-core` plugin API. The
core must never import a concrete plugin. Product workspaces install plugins in
their `product-plugins.ts` manifest.

The first extracted plugin is `@ragsystem/backend-plugin-artifacts`. It owns the
Artifact HTTP routes; omitting it removes `/api/artifacts/*` while the kernel
continues to start normally. Its application resolvers and session access policy
are injected by the Local or SaaS product manifest, so the plugin does not import
core request containers, route helpers, services, or error utilities.

Plugins register routes during setup and may implement `start` and `stop`
lifecycle hooks. Infrastructure supplied by a product can be exposed through
typed capability tokens.

Core and Fastify are peer dependencies. A product must provide exactly one
compatible host instance.
