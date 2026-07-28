# RAGSystem Backend Local

Local deployment composition for RAGSystem. It owns SQLite, sqlite-vec, filesystem storage,
local identity, host execution, and the desktop/server entrypoint.

```bash
cp .env.example .env
npm run dev
```

The shared routes and business services are provided by `@ragsystem/backend-core`.
Bundled feature plugins default to enabled. Set `BACKEND_PLUGINS=none` for core
only, or use a comma-separated subset of `artifacts,knowledge,memory,skills`.
