import type { FastifyRequest } from "fastify";

/** Prevent a SaaS request from silently falling back to a Local implementation. */
export function requireDeploymentResolution<T>(
  request: FastifyRequest,
  name: string,
  resolved: T | undefined,
): T | undefined {
  if (resolved !== undefined) return resolved;
  if (request.container.deploymentKind === "saas") {
    throw new Error(`SaaS ${name} resolver returned no implementation`);
  }
  return undefined;
}
