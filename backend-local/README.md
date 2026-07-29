# RAGSystem Backend Local

Local deployment composition for RAGSystem. It owns SQLite, sqlite-vec, filesystem storage,
local identity, host execution, and the desktop/server entrypoint.

```bash
cp .env.example .env
npm run dev
```

The shared routes and business services are provided by `@ragsystem/backend-core`.
`backend.plugins.yaml` is the required and complete feature-plugin inventory.
Edit its ordered module entries to install, disable, or configure plugins.

By default the server listens on `BACKEND_TS_HOST` and `BACKEND_TS_PORT`. Set
`BACKEND_TS_SOCKET_PATH` to listen on a Unix domain socket or Windows named pipe
instead; the socket path takes precedence over the TCP settings.
