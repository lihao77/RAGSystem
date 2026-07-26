import type { FastifyPluginAsync } from "fastify";

import { AguiGateway } from "../../services/agui-gateway/index.js";
import { parseRunAgentInput } from "../../services/agui-gateway/agui-input.js";
import { WidgetAuthError } from "../../services/runtime/jwt-service.js";
import { HttpError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";
import { assertExecutableSessionIfExists } from "../session-owner.js";
import { ensureRequestApplications } from "../../app/request-applications.js";

/**
 * AG-UI 对接入面（prefix /api/agui）。
 *
 * POST /：标准 AG-UI server 端点。body = RunAgentInput，Accept: text/event-stream，响应 SSE 流。
 * 鉴权可选：配置 Widget key ring（options.widgetAuth 存在）时要求 Bearer token，否则放行
 * （默认部署零鉴权，与 /api/agent/* 一致；对外暴露时建议配 secret）。
 *
 * 端点形态对齐 AG-UI 官方 server 契约：客户端（@ag-ui/client HttpAgent / CopilotKit Runtime）
 * 把本 URL 注册为 agent，POST RunAgentInput 即可消费。
 */
export const registerAguiRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.post("/", async (request, reply) => {
    // 可选鉴权：配了 widgetAuth 才校验 Bearer。
    if (options.widgetAuth) {
      try {
        await options.widgetAuth.requireBearer(request);
      } catch (error) {
        if (error instanceof WidgetAuthError) {
          throw new HttpError(401, "unauthorized", error.message);
        }
        throw error;
      }
    }

    const input = parseRunAgentInput(request.body);
    await assertExecutableSessionIfExists(request, input.threadId);
    const applications = await ensureRequestApplications(request, options);
    const gateway = new AguiGateway(request.container, request.identity.userId, applications.execution, applications.interactions);
    await gateway.handle(input, reply);
    // hijack 后响应由 gateway 管理，handler 不再返回体。
  });
};
