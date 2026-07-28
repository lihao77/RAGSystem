import type { FastifyPluginAsync } from "fastify";

import { AguiGateway } from "../../services/agui-gateway/index.js";
import { InterruptMachine } from "../../services/agui-gateway/interrupt-machine.js";
import { parseRunAgentInput } from "../../services/agui-gateway/agui-input.js";
import type { RouteOptions } from "../route-options.js";
import { assertExecutableSessionIfExists } from "../session-owner.js";
import { ensureRequestApplications } from "../../app/request-applications.js";

/**
 * AG-UI 对接入面（prefix /api/agui）。
 *
 * POST /：标准 AG-UI server 端点。body = RunAgentInput，Accept: text/event-stream，响应 SSE 流。
 * 身份与租户上下文由外层路由作用域负责；集成插件可用自己的身份提供器挂载同一路由。
 *
 * 端点形态对齐 AG-UI 官方 server 契约：客户端（@ag-ui/client HttpAgent / CopilotKit Runtime）
 * 把本 URL 注册为 agent，POST RunAgentInput 即可消费。
 */
export const registerAguiRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  // A run and its AG-UI resume arrive as separate HTTP requests. Keep only the
  // opaque interrupt records at the tenant runtime boundary while request-bound
  // applications and identities are still resolved afresh for every call.
  const interruptMachines = new WeakMap<object, InterruptMachine>();
  app.post("/", async (request, reply) => {
    const input = parseRunAgentInput(request.body);
    await assertExecutableSessionIfExists(request, input.threadId);
    const applications = await ensureRequestApplications(request, options);
    let interruptMachine = interruptMachines.get(request.container);
    if (!interruptMachine) {
      interruptMachine = new InterruptMachine();
      interruptMachines.set(request.container, interruptMachine);
    }
    const gateway = new AguiGateway(request.container, request.identity.userId, applications.execution, applications.interactions, interruptMachine);
    await gateway.handle(input, reply);
    // hijack 后响应由 gateway 管理，handler 不再返回体。
  });
};
