# RAGSystem Backend Local

Local deployment composition for RAGSystem. It owns SQLite, sqlite-vec, filesystem storage,
local identity, host execution, and the desktop/server entrypoint.

```bash
cp .env.example .env
npm run dev
```

The shared routes and business services are provided by `@ragsystem/backend-core`.
