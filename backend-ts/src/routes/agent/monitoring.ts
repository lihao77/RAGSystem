import type { FastifyPluginAsync } from "fastify";

import { ok } from "../../contracts/common.js";
import { HttpError, NotMigratedError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";

export const registerMonitoringRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get("/metrics", async (request) => {
    const query = request.query as { agent_name?: string };
    if (query.agent_name?.trim()) {
      throw new HttpError(404, "not_found", `未找到智能体 ${query.agent_name.trim()} 的指标`);
    }
    return ok(emptySystemMetrics(), "获取系统指标成功");
  });

  app.post("/metrics/reset", async (request) => {
    const body = isRecord(request.body) ? request.body : {};
    const agentName = typeof body.agent_name === "string" && body.agent_name.trim() ? body.agent_name.trim() : "";
    return ok(undefined, `已重置${agentName ? `智能体 ${agentName}` : "所有"}指标`);
  });

  app.get("/context-snapshot", async () => {
    throw new NotMigratedError("Agent context snapshot");
  });

  app.get("/context-snapshot/message-content", async (request) => {
    const query = request.query as { session_id?: string; seq?: string };
    const sessionId = query.session_id?.trim();
    const seq = Number.parseInt(query.seq ?? "", 10);
    if (!sessionId || !Number.isInteger(seq) || seq < 1) {
      throw new HttpError(400, "invalid_request", "请提供有效的 session_id 和 seq");
    }

    const message = options.container.conversationStore.getMessageBySeq(sessionId, seq);
    if (!message) {
      throw new HttpError(404, "not_found", "消息不存在");
    }

    return ok(
      {
        id: message.id,
        seq: message.seq,
        role: message.role,
        content: message.content,
        content_length: message.content.length,
      },
      "获取消息完整内容成功",
    );
  });

  app.get("/tool-call/raw-result", async (request) => {
    const query = request.query as { session_id?: string; call_id?: string };
    const sessionId = query.session_id?.trim();
    const callId = query.call_id?.trim();
    if (!sessionId || !callId) {
      throw new HttpError(400, "invalid_request", "请提供 session_id 和 call_id");
    }

    const item = options.container.conversationStore.getToolCallRawResult(sessionId, callId);
    if (!item) {
      throw new HttpError(404, "not_found", "未找到对应的工具调用原始结果");
    }

    return ok(item, "获取工具调用原始结果成功");
  });
};

function emptySystemMetrics(): {
  total_agents: number;
  total_calls: number;
  avg_duration_ms: number;
  overall_success_rate: number;
  waiting: {
    total_waits: number;
    total_completed: number;
    total_timeouts: number;
    total_keepalive_rounds: number;
  };
  agents: Record<string, never>;
} {
  return {
    total_agents: 0,
    total_calls: 0,
    avg_duration_ms: 0,
    overall_success_rate: 0,
    waiting: {
      total_waits: 0,
      total_completed: 0,
      total_timeouts: 0,
      total_keepalive_rounds: 0,
    },
    agents: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
