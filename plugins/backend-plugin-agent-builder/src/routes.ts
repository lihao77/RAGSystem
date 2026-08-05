import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import { ok } from "@ragsystem/backend-core/contracts/common.js";
import type { RuntimeContainer } from "@ragsystem/backend-core/contracts/runtime/runtime-container.js";
import type {} from "@ragsystem/backend-core/fastify-context.js";
import { requireTenantAdmin, requireTenantMember } from "@ragsystem/backend-core/routes/tenant-role.js";
import { HttpError } from "@ragsystem/backend-core/utils/errors.js";

import { createAgentBuilderBindings } from "./bindings.js";
import { AGENT_BUILDER_RUNTIME_CAPABILITY } from "./capability.js";
import {
  CreateAgentDraftRequestSchema,
  PublishAgentDraftRequestSchema,
  UpdateAgentDraftRequestSchema,
} from "./contracts.js";
import {
  AgentBuilderConflictError,
  AgentBuilderNotFoundError,
  AgentBuilderValidationError,
} from "./service.js";

interface IdParams { id: string }
interface ReleaseQuery { package_name?: string }

export const registerAgentBuilderRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (request) => { requireTenantMember(request); });

  app.get("/drafts", async (request) =>
    ok(await service(request).listDrafts(), "Agent drafts"),
  );

  app.get<{ Params: IdParams }>("/drafts/:id", async (request) =>
    handle(async () => ok(await service(request).getDraft(request.params.id), "Agent draft")),
  );

  app.post("/drafts", async (request) => handle(async () => {
    const body = CreateAgentDraftRequestSchema.parse(request.body);
    const builder = service(request);
    const draft = await builder.createDraft(body.blueprint);
    return ok(await builder.autoApproveDraft(draft, () => bindingsFor(request.container)), "Agent draft created");
  }));

  app.put<{ Params: IdParams }>("/drafts/:id", async (request) => handle(async () => {
    const body = UpdateAgentDraftRequestSchema.parse(request.body);
    const builder = service(request);
    const draft = await builder.updateDraft(request.params.id, body.expected_revision, body.blueprint);
    return ok(await builder.autoApproveDraft(draft, () => bindingsFor(request.container)), "Agent draft updated");
  }));

  app.post<{ Params: IdParams }>("/drafts/:id/validate", async (request) => handle(async () => {
    const bindings = await bindingsFor(request.container);
    const builder = service(request);
    const draft = await builder.validateDraft(request.params.id, bindings.inventory);
    return ok(await builder.autoApproveDraft(draft, () => Promise.resolve(bindings)), "Agent draft validated");
  }));

  app.post<{ Params: IdParams }>("/drafts/:id/publish", async (request) => handle(async () => {
    requireTenantAdmin(request);
    const body = PublishAgentDraftRequestSchema.parse(request.body);
    const draft = await service(request).getDraft(request.params.id);
    return ok(
      await service(request).publishDraft(
        request.params.id,
        body.expected_revision,
        await bindingsFor(request.container),
      ),
      "Agent release published",
    );
  }));

  app.get<{ Querystring: ReleaseQuery }>("/releases", async (request) =>
    ok(await service(request).listReleases(request.query.package_name), "Agent releases"),
  );

  app.get<{ Params: IdParams }>("/releases/:id", async (request) =>
    handle(async () => ok(await service(request).getRelease(request.params.id), "Agent release")),
  );
};

function service(request: FastifyRequest) {
  return request.container.pluginCapabilities.require(AGENT_BUILDER_RUNTIME_CAPABILITY).service;
}

function bindingsFor(container: RuntimeContainer) {
  return createAgentBuilderBindings({
    agentConfig: container.agentConfig,
    capabilities: container.pluginCapabilities,
    pluginTools: container.listPluginTools(),
  });
}

async function handle<Value>(operation: () => Promise<Value>): Promise<Value> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AgentBuilderNotFoundError) {
      throw new HttpError(404, "not_found", error.message);
    }
    if (error instanceof AgentBuilderConflictError) {
      throw new HttpError(409, "conflict", error.message);
    }
    if (error instanceof AgentBuilderValidationError) {
      throw new HttpError(422, "validation_failed", JSON.stringify(error.report));
    }
    if (error instanceof ZodError) {
      throw new HttpError(400, "invalid_request", error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    }
    throw error;
  }
}
