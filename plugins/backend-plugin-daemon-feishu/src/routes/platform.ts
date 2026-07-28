import type { FastifyPluginAsync } from "fastify";
import "@ragsystem/backend-core/fastify-context.js";

import type { ControlPlane } from "@ragsystem/backend-core/contracts/control-plane/index.js";
import { requirePlatformAdmin } from "@ragsystem/backend-core/routes/platform-guard.js";
import type { DaemonBotRepository } from "../contracts/bot-repository.js";

export const registerDaemonPlatformRoutes: FastifyPluginAsync<{
  controlPlane: ControlPlane;
  botRepository: DaemonBotRepository;
}> = async (app, options) => {
  app.get("/bots", async (request) => {
    const actor = await requirePlatformAdmin(request, options.controlPlane);
    const bots = await options.botRepository.listAll();
    await options.controlPlane.audit.record({
      actorUserId: actor.id,
      action: "list_bots",
      targetResource: "bots",
    });
    return { success: true, bots };
  });
};
