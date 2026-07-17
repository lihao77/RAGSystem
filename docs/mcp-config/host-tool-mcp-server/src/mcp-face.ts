import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Router } from "./router.js";
import type { StaticTool } from "./config.js";

/** stateful 模式：Mcp-Session-Id → transport 复用（initialize 后长期保持）。 */
const transports = new Map<string, StreamableHTTPServerTransport>();

function createServer(staticTools: StaticTool[], router: Router): Server {
  const server = new Server(
    { name: "host-tool-mcp-server", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // tools/list 永远返回静态清单（不查路由，不随前端连接变化）。
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: staticTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
    })),
  }));

  // tools/call：从 _meta.session_id 取会话归属，交 router 路由到对应前端执行。
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const params = request.params;
    const sessionId = params._meta?.["session_id"] as string | undefined;
    const result = await router.invoke(sessionId, params.name, params.arguments);
    return {
      content: [{ type: "text" as const, text: result.observation || result.error || "(无输出)" }],
      isError: !result.ok,
    };
  });

  return server;
}

/** 挂载 /mcp（streamable-http，stateful）路由到 express app。 */
export function mountMcpFace(app: Express, staticTools: StaticTool[], router: Router): void {
  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    try {
      if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId)!.handleRequest(req, res, req.body);
        return;
      }
      if (!sessionId) {
        // initialize：新建 transport + server，handleRequest 后 sessionId 生成、入表复用。
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        const server = createServer(staticTools, router);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        if (transport.sessionId) transports.set(transport.sessionId, transport);
        return;
      }
      res
        .status(400)
        .json({ jsonrpc: "2.0", error: { code: -32602, message: "invalid or unknown session" }, id: null });
    } catch (err) {
      console.error("[mcp-face] POST /mcp 失败:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
      }
    }
  });

  // GET：stateful SSE stream（client 拉取 server-initiated 通知；本 server 无主动通知，转 transport）。
  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32602, message: "invalid session" }, id: null });
      return;
    }
    await transport.handleRequest(req, res);
  });

  // DELETE：会话终止。
  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (transport) {
      await transport.close();
      if (sessionId) transports.delete(sessionId);
    }
    res.status(200).end();
  });
}
