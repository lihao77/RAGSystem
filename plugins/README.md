# Backend feature plugins

Feature plugins depend on the public `@ragsystem/backend-core` plugin API. The
core must never import a concrete plugin. Product workspaces install plugins in
their `backend.plugins.yaml` manifest.

Plugins own optional product features and expose them through the public
`@ragsystem/backend-core` plugin API. File outputs use the shared workspace file
view; there is no dedicated Artifact route or staging plugin.

Plugins register routes, per-run hooks, runtime tools, and opaque resources during
setup, and may implement `start` and `stop` lifecycle hooks. Resource semantics
belong to the consuming plugin; core only tracks ownership and lifecycle.
Infrastructure supplied by a product can be exposed through typed capability
tokens. The host passes one immutable runtime-contributions object into each
tenant runtime, so new contribution kinds do not expand the deployment API.

Local and SaaS each own one required `backend.plugins.yaml`. The ordered entries
in that file are the complete plugin inventory:

```yaml
version: 1
plugins:
  - module: "@ragsystem/backend-plugin-skills/module.js"
```

Adding a plugin means installing its package and adding its module entry to the
product YAML. Missing manifests, unknown fields, duplicate modules, or import
failures stop startup instead of being silently ignored.

Core and Fastify are peer dependencies. A product must provide exactly one
compatible host instance.
