import type { Envelope } from "../contracts/events.js";
import type { ClientEventPublisherPort } from "../contracts/runtime/core-runtime-ports.js";
import type {
  PluginClientEventPublisher,
  PluginClientEventPublishOptions,
  PluginEventDelivery,
} from "./backend-plugin.js";

/** 事件名上限：插件事件走 outbox/WS 帧，名字应短且稳定（建议 'namespace.action'）。 */
const MAX_EVENT_NAME_LENGTH = 128;
/** data 序列化上限：durable 帧整体落 outbox 行，限制单帧体积防滥用。 */
const MAX_DATA_BYTES = 64 * 1024;

/**
 * 构建按插件盖章的下行事件发布器（plugin_event 帧）。
 *
 * plugin_id 由宿主（plugin-manager 按 contribution.pluginId）盖章——插件拿不到未盖章的
 * 发布面，无法伪造他插件身份。durable 走 ClientEventPublisherPort.publish（落 outbox 可回放）；
 * ephemeral 走可选的 publishEphemeral 实时直发，端口未实现时降级 durable（不丢帧）。
 */
export function createPluginClientEventPublisher(
  pluginId: string,
  clientEvents: ClientEventPublisherPort,
): PluginClientEventPublisher {
  return {
    async publish(
      sessionId: string,
      event: string,
      data?: unknown,
      options: PluginClientEventPublishOptions = {},
    ): Promise<void> {
      const targetSession = typeof sessionId === "string" ? sessionId.trim() : "";
      if (!targetSession) throw new Error(`Plugin '${pluginId}' event requires a session id`);
      const name = typeof event === "string" ? event.trim() : "";
      if (!name) throw new Error(`Plugin '${pluginId}' event name must not be empty`);
      if (name.length > MAX_EVENT_NAME_LENGTH) {
        throw new Error(`Plugin '${pluginId}' event name exceeds ${MAX_EVENT_NAME_LENGTH} chars: ${name.slice(0, 32)}…`);
      }
      if (data !== undefined) assertDataSize(pluginId, data);

      const delivery: PluginEventDelivery = options.delivery ?? "durable";
      const runId = typeof options.runId === "string" && options.runId.trim() ? options.runId : null;
      const callId = typeof options.callId === "string" && options.callId.trim() ? options.callId : null;
      const envelope: Envelope = {
        type: "plugin_event",
        session_id: targetSession,
        ...(runId ? { run_id: runId } : {}),
        ...(callId ? { call_id: callId } : {}),
        payload: {
          plugin_id: pluginId,
          event: name,
          ...(data !== undefined ? { data } : {}),
          delivery,
        },
      };

      if (delivery === "ephemeral" && typeof clientEvents.publishEphemeral === "function") {
        await clientEvents.publishEphemeral(targetSession, envelope);
        return;
      }
      // durable（或 ephemeral 降级）：不落 run lease 断言——插件可在 run 外发会话级帧。
      await clientEvents.publish(targetSession, envelope, {
        runId,
        aggregateType: runId ? "run" : "session",
        aggregateId: runId ?? targetSession,
      });
    },
  };
}

function assertDataSize(pluginId: string, data: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(data) ?? "";
  } catch {
    throw new Error(`Plugin '${pluginId}' event data must be JSON-serializable`);
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_DATA_BYTES) {
    throw new Error(`Plugin '${pluginId}' event data exceeds ${MAX_DATA_BYTES} bytes`);
  }
}
