# Frontend Architecture

## Runtime

The frontend is a Vue 3 + Vite application. Chat execution is driven by the session WebSocket and Pinia stores. ECharts renders chart presentations.

## Session Browser Workspaces

The project view is built from the active workspace list, while the timeline is built from session history. Removing a project with sessions soft-removes its workspace registration: the project and its sessions disappear from the project view, but the sessions and their workspace metadata remain available in the timeline. Adding the same canonical local path reactivates the existing workspace ID, which restores those sessions in the project view without rewriting session records. A workspace with no sessions is deleted outright so unused registrations do not accumulate.

## Host Tools

The browser declares and executes `get_client_env`, which reports client-only environment data such as timezone, language, browser User-Agent, and screen size.

## Rendering Boundaries

- Pending follow-ups support take-back and deletion while the backend reports `can_manage`. DELETE compares the displayed original content and atomically expires both the unclaimed mailbox input and its durable receipt; consumed or concurrently changed inputs return a conflict. Cancellation is persisted as `cancelled` and does not appear as a send failure. "Edit" takes the input back and refills the composer with its original text for a fresh send. In-flight reads started before a mutation cannot overwrite its result.

- WebSocket sends persist a receipt before the early ACK. `GET /sessions/:sessionId/message-requests` returns pending receipts plus explicitly requested IDs, with processing, queued, consumed or failed state. The frontend queries on connect and while it has pending sends, restores pending rows after a reload, and reloads root history when consumption was missed. Failed receipts clear their pending row even if the original socket error was lost. Temporary query failures retain the content for the next reconciliation; completed request IDs prevent stale HTTP responses from resurrecting a row.

- Follow-up sends appear as compact single-line rows attached to the top of the composer while sending or waiting to enter context, with delivery status on the right and long text truncated. The queue stays visible above pending approval or user-input panels when they replace the composer. The store keeps this queue by session and request ID; an ACK ends the transport request, while the canonical consumed user message (or history reconciliation after reconnect) removes its pending row. Disconnecting, switching sessions, or disposing the view marks outstanding rows as unconfirmed and preserves their content, because asynchronous failures may have been missed. Late ACKs cannot restore a confirmed waiting status; explicit failures and consumption facts reconcile their own session even when it is inactive. Unconfirmed messages are never automatically resent. Root user consumption has one writer in the session dispatcher, including late replay after a run has finished. Buffered execution events wait for their exact message boundary.
- Execution panels belong to user message boundaries that have actual reasoning or tool steps. Consecutive inputs consumed by the same run do not each get an empty panel. History availability uses the same explicit `boundary_message_id` (or legacy sequence fallback within the run) as execution replay; live inputs gain a panel when execution events arrive, not when a run merely claims them. A run ID alone never overrides `has_execution: false` during loading or cache restoration.
- `VisualizationLoader.vue` handles chart, image, and generic file artifacts.
- Chat messages and Artifact selection do not auto-open a renderer or infer a presentation.
