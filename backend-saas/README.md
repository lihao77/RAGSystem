# RAGSystem Backend SaaS

SaaS deployment composition for RAGSystem. It owns PostgreSQL repositories, S3-compatible
object storage, tenant-bound runtime composition, leases, and remote sandbox bindings.

```bash
cp .env.example .env
npm run dev
```

`DEPLOYMENT_MODE=saas`, PostgreSQL URLs, S3 credentials, and authentication secrets are required.
The shared routes and business services are provided by `@ragsystem/backend-core`.
`backend.plugins.yaml` is the required and complete feature-plugin inventory.
Edit its ordered module entries to install, disable, or configure plugins.
