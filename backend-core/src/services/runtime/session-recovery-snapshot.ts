import { buildExecutionTree, SessionSnapshotPayloadSchema, type Envelope, type SessionSnapshotPayload } from "@ragsystem/agent-protocol";
import type { RuntimeSessionRecoveryFacts } from "../../contracts/storage/runtime-storage.js";
import { executionRunId, executionCarrierIdsFromRows } from "../sessions/execution-boundaries.js";
import { stripPrivateMessageFields } from "../sessions/index.js";
import { EnvelopeProjector } from "./event-outbox/projector.js";
import { projectSessionRuntime } from "./session-runtime-service.js";

/** Pure projection: never performs another read after the recovery transaction closes. */
export function projectSessionRecovery(facts: RuntimeSessionRecoveryFacts): SessionSnapshotPayload {
  const session = facts.session;
  if (!session) throw new Error("cannot recover a missing session");
  const projector = new EnvelopeProjector();
  const events = facts.activeRunEvents.map(row => projector.toEnvelope(row));
  const rootRunId = facts.activeRootRun?.run_id;
  const rootEvents = events.filter(event => event.run_id === rootRunId);
  const firstBoundary = facts.executionRows.find(message => message.role === "user" && executionRunId(message) === rootRunId)?.id ?? null;
  const carrierIds = executionCarrierIdsFromRows(facts.messages, facts.executionRows);
  const boundaryByRun = new Map<string, string | null>();
  if (rootRunId) boundaryByRun.set(rootRunId, firstBoundary);
  const boundaryByTool = new Map(rootEvents.filter(event => event.type === "tool_call" && event.call_id)
    .map(event => [event.call_id!, event.boundary_message_id ?? firstBoundary]));
  for (let changed = true; changed;) {
    changed = false;
    for (const run of facts.runs) {
      if (run.parent_run_id && boundaryByRun.has(run.parent_run_id) && !boundaryByRun.has(run.run_id)) {
        boundaryByRun.set(run.run_id, (run.parent_call_id ? boundaryByTool.get(run.parent_call_id) : null)
          ?? boundaryByRun.get(run.parent_run_id) ?? firstBoundary);
        changed = true;
      }
    }
  }
  const groups = new Map<string | null, Envelope[]>();
  const rootStarted = rootEvents.find(event => event.type === "agent_started");
  for (const event of events) {
    if (event.type === "delegate_call" || event.type === "interaction") continue;
    const boundary = event.run_id === rootRunId
      ? event.boundary_message_id ?? firstBoundary
      : boundaryByRun.get(event.run_id ?? "") ?? firstBoundary;
    const group = groups.get(boundary) ?? (rootStarted ? [rootStarted] : []);
    if (event !== rootStarted) group.push(event);
    groups.set(boundary, group);
  }
  const execution = rootRunId ? [...groups].map(([boundary_message_id, frames]) => ({
    run_id: rootRunId, boundary_message_id, tree: buildExecutionTree(frames),
  })) : [];
  const latestRoot = facts.runs.find(run => !run.parent_run_id && !run.child_agent_id);
  const runById = new Map(facts.runs.map(run => [run.run_id, run]));
  const entryAgent = session.team_snapshot?.entry_agent_name ?? "";
  const participants = [{
    participant_id: "root", parent_participant_id: null, scope: "root", thread_key: "root",
    agent_name: latestRoot?.agent_name ?? entryAgent,
    display_name: latestRoot?.agent_display_name ?? latestRoot?.agent_name ?? entryAgent,
    lifecycle_status: "active", last_run_id: latestRoot?.run_id ?? null,
    last_run_status: latestRoot?.status ?? null, created_at: session.created_at,
    updated_at: latestRoot?.updated_at ?? session.updated_at,
  }, ...facts.children.map(child => ({
    participant_id: child.child_agent_id, parent_participant_id: child.parent_participant_id,
    scope: "child", thread_key: child.thread_key, agent_name: child.agent_name,
    display_name: runById.get(child.last_run_id ?? "")?.agent_display_name ?? child.agent_name,
    lifecycle_status: child.status, last_run_id: child.last_run_id,
    last_run_status: runById.get(child.last_run_id ?? "")?.status ?? null,
    created_at: child.created_at, updated_at: child.updated_at,
  }))];
  return SessionSnapshotPayloadSchema.parse({
    event_watermark: facts.eventWatermark,
    runtime: projectSessionRuntime(facts),
    messages: {
      items: facts.messages.map(message => ({ ...stripPrivateMessageFields(message),
        has_execution: carrierIds.has(message.id),
      })),
      has_more: facts.hasMoreMessages, before_seq: facts.messages[0]?.seq ?? null,
    },
    participants, pending_requests: facts.pendingRequests,
    execution, tree: buildExecutionTree(events),
  });
}
