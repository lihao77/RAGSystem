import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";

import { BotConfigUpdateSchema, BotCronTaskCreateSchema, BotCronTaskUpdateSchema } from "../contracts/bot.js";
import { DaemonOutgoingMessageSchema, DaemonTestMessageSchema } from "../contracts/daemon.js";
import { createUserId, type UserId } from "../identity/types.js";
import { DaemonServiceError } from "../services/daemon/daemon-service.js";
import { HttpError, httpErrorFrom } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";
import { requireTenantMember } from "./tenant-role.js";

interface BotParams { botId: string; }
interface BotCronParams extends BotParams { taskId: string; }
interface LimitQuery { limit?: string | number; }
interface BotListQuery { tenant?: string | number | boolean; }

const BotCreateSchema = z.object({ display_name: z.string().trim().min(1) });
const BotUpdateSchema = z.object({ display_name: z.string().trim().min(1) });
const BotIdSchema = z.string().regex(/^usr_[a-z0-9]+(?:_[a-z0-9]+)*$/);

export const registerBotRoutes: FastifyPluginAsync<RouteOptions> = async (app) => {
  app.addHook("preHandler", async (request) => {
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (pathname.includes("/webhook/")) return;
    requireTenantMember(request);
    const botId = readBotId(request);
    if (botId) assertOwnedTenantBot(request, botId);
  });

  app.get<{ Querystring: BotListQuery }>("/", async (request) => {
    if (String(request.query.tenant ?? "") === "1") {
      return { bots: app.controlStore.listBotsByTenant(request.identity.tenantId) };
    }
    return {
      bots: app.controlStore.listBotsWithConfig(request.identity.userId)
        .filter((bot) => bot.config.tenant_id === request.identity.tenantId),
    };
  });

  app.post("/", async (request) => {
    const input = BotCreateSchema.parse(request.body);
    const bot = app.controlStore.createBot({ tenantId: request.identity.tenantId, ownerId: request.identity.userId, displayName: input.display_name });
    return { bot: { ...bot, config: app.controlStore.getBotConfig(bot.id) } };
  });

  app.post<{ Params: { platform: string; routeToken: string } }>("/webhook/:platform/:routeToken", async (request) => {
    if (request.params.platform !== "feishu") throw new HttpError(400, "invalid_request", `不支持的平台: ${request.params.platform}`);
    try {
      return await app.botEngine.handleIncomingMessage(request.params.routeToken, request.body);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: BotParams }>("/:botId", async (request) => {
    const botId = parseBotId(request.params.botId);
    return { bot: app.controlStore.getBot(botId), config: app.controlStore.getBotConfig(botId) };
  });

  app.put<{ Params: BotParams }>("/:botId", async (request) => {
    const botId = parseBotId(request.params.botId);
    const input = BotUpdateSchema.parse(request.body);
    app.controlStore.updateUser(botId, input.display_name);
    return { bot: app.controlStore.getBot(botId), config: app.controlStore.getBotConfig(botId) };
  });

  app.delete<{ Params: BotParams }>("/:botId", async (request) => {
    const botId = parseBotId(request.params.botId);
    if (!app.controlStore.deleteBot(botId)) throw new HttpError(404, "not_found", "bot 不存在");
    app.botEngine.reloadBot(botId);
    return { status: "ok" };
  });

  app.get<{ Params: BotParams }>("/:botId/config", async (request) => {
    const config = app.controlStore.getBotConfig(parseBotId(request.params.botId));
    if (!config) throw new HttpError(404, "not_found", "bot 配置不存在");
    return config;
  });

  app.put<{ Params: BotParams }>("/:botId/config", async (request) => {
    const botId = parseBotId(request.params.botId);
    app.controlStore.updateBotConfig(botId, BotConfigUpdateSchema.parse(request.body));
    app.botEngine.reloadBot(botId);
    return app.controlStore.getBotConfig(botId);
  });

  app.post<{ Params: BotParams }>("/:botId/test", async (request) => {
    try {
      return await app.botEngine.testMessage(parseBotId(request.params.botId), DaemonTestMessageSchema.parse(request.body));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post<{ Params: BotParams }>("/:botId/send", async (request) => {
    return app.botEngine.sendMessage(parseBotId(request.params.botId), DaemonOutgoingMessageSchema.parse(request.body));
  });

  app.get<{ Params: BotParams }>("/:botId/cron/tasks", async (request) => app.botEngine.listBotCronTasks(parseBotId(request.params.botId)));

  app.post<{ Params: BotParams }>("/:botId/cron/tasks", async (request) => {
    try {
      return app.botEngine.createBotCronTask(parseBotId(request.params.botId), BotCronTaskCreateSchema.parse(request.body));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.put<{ Params: BotCronParams }>("/:botId/cron/tasks/:taskId", async (request) => {
    const updated = app.botEngine.updateBotCronTask(parseBotId(request.params.botId), request.params.taskId, BotCronTaskUpdateSchema.parse(request.body));
    if (!updated) throw new HttpError(404, "not_found", `任务不存在: ${request.params.taskId}`);
    return updated;
  });

  app.delete<{ Params: BotCronParams }>("/:botId/cron/tasks/:taskId", async (request) => {
    if (!app.botEngine.deleteBotCronTask(parseBotId(request.params.botId), request.params.taskId)) {
      throw new HttpError(404, "not_found", `任务不存在: ${request.params.taskId}`);
    }
    return { status: "ok" };
  });

  app.post<{ Params: BotCronParams }>("/:botId/cron/tasks/:taskId/trigger", async (request) => {
    try {
      return await app.botEngine.triggerBotCronTask(parseBotId(request.params.botId), request.params.taskId);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: BotCronParams; Querystring: LimitQuery }>("/:botId/cron/tasks/:taskId/history", async (request) => {
    const limit = Number(request.query.limit ?? 20);
    return {
      task_id: request.params.taskId,
      history: app.botEngine.getBotCronHistory(parseBotId(request.params.botId), request.params.taskId, Number.isFinite(limit) ? limit : 20),
    };
  });
};

function readBotId(request: FastifyRequest): UserId | null {
  const params = request.params as { botId?: unknown };
  return typeof params.botId === "string" ? parseBotId(params.botId) : null;
}

function parseBotId(value: string): UserId {
  return createUserId(BotIdSchema.parse(value));
}

function assertOwnedTenantBot(request: FastifyRequest, botId: UserId): void {
  appControlStore(request).assertBotOwner(botId, request.identity.userId);
  const config = appControlStore(request).getBotRuntimeConfig(botId);
  if (!config || config.tenant_id !== request.identity.tenantId) throw new HttpError(404, "not_found", "bot 不存在");
}

function appControlStore(request: FastifyRequest) {
  return request.server.controlStore;
}

function toHttpError(error: unknown): HttpError {
  return httpErrorFrom(error, (value) => value instanceof DaemonServiceError
    ? new HttpError(value.statusCode, "invalid_request", value.message)
    : null);
}
