import type { Goal } from "../../../contracts/runtime/goals.js";
import type { RuntimeStorage } from "../../../contracts/storage/runtime-storage.js";
import type { ClientEventPublisherPort } from "../../../contracts/runtime/core-runtime-ports.js";

/** State changes outside a run still need one durable, agent-visible history entry. */
export async function recordGoalStatusMessage(
  goal: Goal,
  storage: RuntimeStorage,
  events: Pick<ClientEventPublisherPort, "publish">,
): Promise<void> {
  const messageId = `goalstate_${goal.id}_${goal.continuation_generation}_${goal.status}`;
  const text = goal.status === "paused"
    ? `目标「${goal.objective}」已暂停，已有进度已保留。`
    : `目标「${goal.objective}」已由用户恢复，可以继续推进。`;
  const { message } = await storage.operations.persistMessage({ message: {
    messageId,
    sessionId: goal.session_id,
    role: "assistant",
    threadKey: "root",
    contentParts: [{ type: "text", text }],
    metadata: { source: "goal_status_change", visible_to_user: true },
  } });
  await events.publish(goal.session_id, {
    type: "state_sync", session_id: goal.session_id,
    payload: { category: "message_saved", ref: {
      message_id: message.id, seq: message.seq, role: message.role, content_parts: message.content_parts,
    } },
  }, { eventId: `${messageId}:saved`, aggregateType: "session", aggregateId: goal.session_id });
  await events.publish(goal.session_id, {
    type: "state_sync", session_id: goal.session_id,
    payload: { category: "session_updated", detail: { entity: "goal" } },
  }, { aggregateType: "session", aggregateId: goal.session_id });
}
