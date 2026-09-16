# Frontend Architecture

## Runtime

The frontend is a Vue 3 + Vite application. Chat execution is driven by the session WebSocket and Pinia stores. ECharts renders chart presentations.

## Session Browser Workspaces

Session list and workspace preview responses include `runtime_state`, derived from lightweight batched database reads using the same lifecycle rules as the full runtime snapshot. The sidebar shows a spinner for running/resuming sessions. The active session uses WebSocket snapshots; visible groups and pinned sessions refresh through `POST /sessions/states` every ten seconds while the page is visible (up to 200 IDs per batch). State queries use the same tenant and visibility restrictions as the session list and never load execution events.

Both SQLite and PostgreSQL apply the existing session metadata hydration before projecting batch states, matching full runtime reads for empty or non-object metadata. SQLite list pages support the API's 200-session limit so a complete status batch is returned after access filtering.

Pins are local preferences scoped to the tenant and user. Only normalized, unique session IDs are persisted; list responses restore their content through the `session_ids` filter. Pins appear in one section above both views and are excluded from their original groups, without changing workspace membership. Source/workspace filters still apply. Removing or losing access to a pinned session cleans up its ID on restoration. Project and pinned items reserve a fixed left icon slot: running sessions show a 14px spinner, idle sessions keep an empty placeholder, and hover/focus replaces the spinner with the pin action. This slot aligns the indented titles. Timeline status appears immediately before the time. Hover/focus hides the time and running indicator and reveals the delete action on the right.

Each tenant/user can pin up to 20 sessions across both views and all filters. Attempts beyond the limit only show a warning and preserve existing pins; unpinning is an explicit user action. Restoration requests contain at most 20 IDs and split long encoded ID filters to stay within the proxy request-line limit.

Pin restoration tracks per-session cache revisions. A response cannot overwrite title, message, or activity updates received after its request started, and missing IDs cannot undo newer pin changes. This also protects pinned sessions outside the currently loaded list page.

Timeline items have no leading icon slot: hover/focus replaces the runtime indicator and time with a pin button to the left of delete. Both actions use 20px buttons with 14px icons, and the pin button keeps a transparent background with feedback on the SVG itself. Hover transitions combine a short slide and scale for the action buttons with a fade of the time and runtime indicator. The fixed slots keep titles aligned throughout the transition; reduced-motion preferences disable these transitions.

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
