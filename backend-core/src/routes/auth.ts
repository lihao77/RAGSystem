import type { FastifyPluginAsync } from "fastify";
import { AuthIdentitySchema } from "@ragsystem/api-contracts";
import type { IdentityProvider } from "../services/identity/index.js";

/** The local user is implicit; its scene is resolved for every request. */
export const registerAuthRoutes: FastifyPluginAsync<{ identityProvider: IdentityProvider }> = async (app, options) => {
  app.get("/me", async (request) => {
    const identity = await options.identityProvider.resolve(request, "tenant");
    return AuthIdentitySchema.parse({
      ...identity,
      user: { id: identity.userId, displayName: "Local User" },
    });
  });
};
