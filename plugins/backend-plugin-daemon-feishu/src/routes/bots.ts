import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import "@ragsystem/backend-core/fastify-context.js";

import { BotConfigUpdateSchema, BotCronTaskCreateSchema, BotCronTaskUpdateSchema } from "../contracts/bot.js";
import type { DaemonBotRepository } from "../contracts/bot-repository.js";
import { DaemonOutgoingMessageSchema, DaemonTestMessageSchema } from "../contracts/daemon.js";
import { createUserId, type UserId } from "@ragsystem/backend-core/identity/types.js";
import { DaemonServiceError, type DaemonService } from "../services/daemon-service.js";
import { HttpError, httpErrorFrom } from "@ragsystem/backend-core/utils/errors.js";
import type { RuntimeContainerRegistry } from "@ragsystem/backend-core/services/runtime/runtime-container-registry.js";
import { requireTenantMember } from "@ragsystem/backend-core/routes/tenant-role.js";

interface BotParams { botId: string; }
interface BotCronParams extends BotParams { taskId: string; }
interface LimitQuery { limit?: string | number; }
interface BotListQuery { tenant?: string | number | boolean; }

const BotCreateSchema = z.object({ display_name: z.string().trim().min(1) });
const BotUpdateSchema = z.object({ display_name: z.string().trim().min(1) });
const BotIdSchema = z.string().regex(/^usr_[a-z0-9]+(?:_[a-z0-9]+)*$/);

export interface BotRouteOptions {
  readonly botRepository: DaemonBotRepository;
  readonly daemon: DaemonService;
  readonly registry: RuntimeContainerRegistry;
}

export const registerBotRoutes: FastifyPluginAsync<BotRouteOptions> = async (app, options) => {
  app.addHook("preHandler", async (request) => {
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (pathname.includes("/webhook/")) return;
    requireTenantMember(request);
    const botId = readBotId(request);
    if (botId) await assertOwnedTenantBot(request, options, botId);
  });

  app.get<{ Querystring: BotListQuery }>("/", async (request) => {
    if (String(request.query.tenant ?? "") === "1") {
      return { bots: await options.botRepository.listByTenant(request.identity.tenantId) };
    }
    return {
      bots: (await options.botRepository.listWithConfigByOwner(request.identity.userId))
        .filter((bot) => bot.config.tenant_id === request.identity.tenantId),
    };
  });

  app.post("/", async (request) => {
    const input = BotCreateSchema.parse(request.body);
    const bot = await options.botRepository.create({ tenantId: request.identity.tenantId, ownerId: request.identity.userId, displayName: input.display_name });
    return { bot: { ...bot, config: await options.botRepository.getConfig(bot.id) } };
  });

  app.post<{ Params: { platform: string; routeToken: string } }>("/webhook/:platform/:routeToken", {
    config: { auth: "public" },
  }, async (request) => {
    if (request.params.platform !== "feishu") throw new HttpError(400, "invalid_request", `不支持的平台: ${request.params.platform}`);
    try {
      return await options.daemon.handleIncomingMessage(request.params.routeToken, request.body);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: BotParams }>("/:botId", async (request) => {
    const botId = parseBotId(request.params.botId);
    return { bot: await options.botRepository.get(botId), config: await options.botRepository.getConfig(botId) };
  });

  app.put<{ Params: BotParams }>("/:botId", async (request) => {
    const botId = parseBotId(request.params.botId);
    const input = BotUpdateSchema.parse(request.body);
    await options.botRepository.rename(botId, input.display_name);
    return { bot: await options.botRepository.get(botId), config: await options.botRepository.getConfig(botId) };
  });

  app.delete<{ Params: BotParams }>("/:botId", async (request) => {
    const botId = parseBotId(request.params.botId);
    const lease = await options.registry.acquire(request.identity.tenantId);
    let facets;
    try {
      facets = await lease.runtime.sessionApplication.listSessionFacets({
        access: { userId: request.identity.userId, includeTenant: true, includeAll: true },
      });
    } finally {
      lease.release();
    }
    if (facets.origins.some((origin) => origin.type === "bot" && origin.id === botId && origin.count > 0)) {
      throw new HttpError(409, "conflict", "该 Bot 已被历史会话引用，不能物理删除；请停用 Bot");
    }
    if (!await options.botRepository.delete(botId)) throw new HttpError(404, "not_found", "bot 不存在");
    await options.daemon.reloadBot(botId);
    return { status: "ok" };
  });

  app.get<{ Params: BotParams }>("/:botId/config", async (request) => {
    const config = await options.botRepository.getConfig(parseBotId(request.params.botId));
    if (!config) throw new HttpError(404, "not_found", "bot 配置不存在");
    return config;
  });

  app.put<{ Params: BotParams }>("/:botId/config", async (request) => {
    const botId = parseBotId(request.params.botId);
    await options.botRepository.updateConfig(botId, BotConfigUpdateSchema.parse(request.body));
    await options.daemon.reloadBot(botId);
    return options.botRepository.getConfig(botId);
  });

  app.post<{ Params: BotParams }>("/:botId/test", async (request) => {
    try {
      return await options.daemon.testMessage(parseBotId(request.params.botId), DaemonTestMessageSchema.parse(request.body));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post<{ Params: BotParams }>("/:botId/send", async (request) => {
    return options.daemon.sendMessage(parseBotId(request.params.botId), DaemonOutgoingMessageSchema.parse(request.body));
  });

  app.get<{ Params: BotParams }>("/:botId/cron/tasks", async (request) => options.daemon.listBotCronTasks(parseBotId(request.params.botId)));

  app.post<{ Params: BotParams }>("/:botId/cron/tasks", async (request) => {
    try {
      return await options.daemon.createBotCronTask(parseBotId(request.params.botId), BotCronTaskCreateSchema.parse(request.body));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.put<{ Params: BotCronParams }>("/:botId/cron/tasks/:taskId", async (request) => {
    const updated = await options.daemon.updateBotCronTask(parseBotId(request.params.botId), request.params.taskId, BotCronTaskUpdateSchema.parse(request.body));
    if (!updated) throw new HttpError(404, "not_found", `任务不存在: ${request.params.taskId}`);
    return updated;
  });

  app.delete<{ Params: BotCronParams }>("/:botId/cron/tasks/:taskId", async (request) => {
    if (!await options.daemon.deleteBotCronTask(parseBotId(request.params.botId), request.params.taskId)) {
      throw new HttpError(404, "not_found", `任务不存在: ${request.params.taskId}`);
    }
    return { status: "ok" };
  });

  app.post<{ Params: BotCronParams }>("/:botId/cron/tasks/:taskId/trigger", async (request) => {
    try {
      return await options.daemon.triggerBotCronTask(parseBotId(request.params.botId), request.params.taskId);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: BotCronParams; Querystring: LimitQuery }>("/:botId/cron/tasks/:taskId/history", async (request) => {
    const limit = Number(request.query.limit ?? 20);
    return {
      task_id: request.params.taskId,
      history: await options.daemon.getBotCronHistory(parseBotId(request.params.botId), request.params.taskId, Number.isFinite(limit) ? limit : 20),
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

async function assertOwnedTenantBot(request: FastifyRequest, options: BotRouteOptions, botId: UserId): Promise<void> {
  await options.botRepository.assertOwner(botId, request.identity.userId);
  const config = await options.botRepository.getRuntimeConfig(botId);
  if (!config || config.tenant_id !== request.identity.tenantId) throw new HttpError(404, "not_found", "bot 不存在");
}

function toHttpError(error: unknown): HttpError {
  return httpErrorFrom(error, (value) => value instanceof DaemonServiceError
    ? new HttpError(value.statusCode, "invalid_request", value.message)
    : null);
}
