import type { ClientEvent } from "../../../contracts/events.js";
import type { OutboxRow } from "../../stores/conversation-store/types.js";

export class ClientEventProjector {
  toClientEvent(row: OutboxRow): ClientEvent {
    const payload = parsePayload(row);
    const base = {
      session_id: row.session_id,
      ...(row.run_id ? { run_id: row.run_id } : {}),
      event_id: row.event_id,
      event_seq: row.session_seq,
    };

    switch (row.event_type) {
      case "execution.step_recorded": {
        const step = asRecord(payload.step);
        return {
          type: "execution.step",
          ...base,
          ...mirrorEventData(step),
        };
      }
      case "run.final_answer_recorded": {
        const data = {
          content: payload.content,
          metadata: asRecord(payload.metadata),
        };
        return {
          type: "output.final_answer",
          ...base,
          ...mirrorEventData(data),
        };
      }
      case "agent.call_finished": {
        const data = {
          agent_name: asString(payload.agent_name),
          result: asString(payload.result) ?? "",
          success: Boolean(payload.success),
          agent_display_name: asString(payload.agent_display_name) ?? asString(payload.agent_name),
          run_id: row.run_id,
          task_id: asString(payload.task_id),
          request_id: asString(payload.request_id),
        };
        return {
          type: "call.agent.end",
          ...base,
          agent_name: data.agent_name,
          call_id: asString(payload.call_id),
          ...mirrorEventData(data),
        };
      }
      case "message.saved": {
        const data = {
          id: asString(payload.message_id),
          seq: asNumber(payload.seq),
          role: asString(payload.role),
          run_id: row.run_id,
          task_id: asString(payload.task_id),
          request_id: asString(payload.request_id),
        };
        return {
          type: "output.message_saved",
          ...base,
          ...mirrorEventData(data),
        };
      }
      case "run.completed": {
        const data = {
          status: "completed",
          final_message_id: asString(payload.final_message_id),
          metadata: asRecord(payload.metadata),
        };
        return {
          type: "run.end",
          ...base,
          ...mirrorEventData(data),
        };
      }
      case "run.error_reported": {
        const data = {
          agent_name: asString(payload.agent_name),
          error: asString(payload.error) ?? "",
          error_type: asString(payload.error_type) ?? "ExecutionError",
          content: asString(payload.error) ?? "",
          run_id: row.run_id,
          task_id: asString(payload.task_id),
          request_id: asString(payload.request_id),
        };
        return {
          type: "agent.error",
          ...base,
          agent_name: data.agent_name,
          call_id: asString(payload.call_id),
          error: data.error,
          ...mirrorEventData(data),
        };
      }
      case "run.failed":
      case "run.interrupted": {
        const data = {
          status: asString(payload.status) ?? (row.event_type === "run.interrupted" ? "interrupted" : "failed"),
          error: asString(payload.error) ?? "",
          metadata: asRecord(payload.metadata),
        };
        return {
          type: "run.end",
          ...base,
          ...mirrorEventData(data),
        };
      }
      default:
        throw new Error(`Unsupported outbox event type: ${row.event_type}`);
    }
  }
}

function parsePayload(row: OutboxRow): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(row.payload));
  } catch (error) {
    throw new Error(`Invalid outbox payload ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function mirrorEventData<T extends Record<string, unknown>>(data: T): { data: T; content: T } {
  return { data, content: data };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
