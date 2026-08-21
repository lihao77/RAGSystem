# Frontend Architecture

## Runtime

The frontend is a Vue 3 + Vite application. Chat execution is driven by the session WebSocket and Pinia stores. ECharts renders chart presentations.

## Session Browser Workspaces

The project view is built from the active workspace list, while the timeline is built from session history. Removing a project with sessions soft-removes its workspace registration: the project and its sessions disappear from the project view, but the sessions and their workspace metadata remain available in the timeline. Adding the same canonical local path reactivates the existing workspace ID, which restores those sessions in the project view without rewriting session records. A workspace with no sessions is deleted outright so unused registrations do not accumulate.

## Host Tools

The browser declares and executes `get_client_env`, which reports client-only environment data such as timezone, language, browser User-Agent, and screen size.

## Rendering Boundaries

- `VisualizationLoader.vue` handles chart, image, and generic file artifacts.
- Chat messages and Artifact selection do not auto-open a renderer or infer a presentation.
