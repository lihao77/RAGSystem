# Session Runtime Lifecycle

Session runtime state is a backend-owned projection. Clients must not infer it from messages,
loading flags, run events, execution handles, or pending-interaction events.

## Canonical session states

| State | Durable facts | Initial-load strategy | Allowed actions |
| --- | --- | --- | --- |
| `idle` | No active root run and no active maintenance claim | `history` | `send_message`, `start_maintenance` |
| `running` | Root run is `running`; no unresolved or claimed interaction batch | `attach_run` | Locally owned: `send_followup`, `stop_run`; remote: none |
| `waiting_interaction` | Root run is `running`; at least one interaction is `waiting` | `attach_run_and_present_interactions` | Locally owned: `respond_interaction`, `stop_run`; remote: none |
| `suspended` | Root run is `suspended` | `restore_suspended_run_and_present_interactions` | Unresolved interaction: `respond_interaction`, `stop_run`; resolved batch: `resume_run`, `stop_run` |
| `resuming` | A durable interaction batch is `resuming` | `attach_resume` | Locally owned: `stop_run`; remote: none |
| `maintenance` | No active root run; a non-expired maintenance claim exists | `watch_maintenance` | none |

Completed, failed, and interrupted runs are historical outcomes. They appear in `last_run` and
never keep the Session out of `idle`.

## Required invariants

1. At most one active root run exists per Session.
2. `waiting_interaction` and `resuming` are projected from the active root and its durable
   interaction records in one storage snapshot.
3. A crashed `running` root with a durable `waiting` interaction is recovered to `suspended`,
   never to `interrupted`.
4. A crashed `running` root without a durable unresolved interaction is recovered to
   `interrupted`.
5. Pending interaction presentation is reconstructed from `pending_interactions.request_payload`.
   Outbox history is not the source of current interaction state.
   A resolved batch whose resume owner crashed stays durable but is not presented again. The
   snapshot exposes `resume_interaction_id` and `resume_run`, so the client resumes from the stored
   resolution without asking the user to submit the interaction twice.
6. `session.runtime` is a current-state snapshot and is not filtered by the event replay cursor.
7. Run/outbox events reconstruct history and execution presentation only. They never directly
   change the frontend Session lifecycle.
8. Composer, stop, interaction, and maintenance controls are driven only by `allowed_actions`.

## Transition table

| Trigger | From | To |
| --- | --- | --- |
| Root run committed | `idle` | `running` |
| Durable interaction recorded | `running` | `waiting_interaction` |
| Live interaction batch resolved | `waiting_interaction` | `running` |
| Interaction wait detached or process recovery finds a waiting interaction | `waiting_interaction` | `suspended` |
| Resume batch claimed | `suspended` | `resuming` |
| Resume executor attached | `resuming` | `running` |
| Run completed, failed, or interrupted | any active run state | `idle` |
| Maintenance claim acquired | `idle` | `maintenance` |
| Maintenance released or expired | `maintenance` | `idle` |

## Frontend ownership

The frontend keeps one `SessionRuntimeSnapshot` in the Session store. Only the runtime reducer may
replace it. Other modules may update transient presentation details such as model streaming phase,
tool progress, and timing, but must not write Session lifecycle state.

On initial load:

1. Load persisted messages and files.
2. Open the Session WebSocket.
3. Wait for the first `session.runtime` snapshot.
4. Apply the snapshot's `load_strategy` in the runtime reducer.
5. Replay run events when the strategy requires restoring an active run, including a detached
   suspended run whose execution tree still belongs in the current conversation.
