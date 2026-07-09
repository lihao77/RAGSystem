import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { WebSocketServer } from "ws";
import { loadStaticTools } from "./config.js";
import { Router } from "./router.js";
import { mountMcpFace } from "./mcp-face.js";
import { handleWsMessage } from "./ws-face.js";

/**
 * 前端工具 MCP server 入口：独立进程，同端口挂两个面——
 * - /mcp（streamable-http，stateful）：对 backend MCP client，tools/list 返回静态清单、tools/call 带 _meta.session_id 路由
 * - /ws（自定义 WS）：对前端执行端，register/invoke/result
 */
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";

  const staticTools = loadStaticTools();
  console.log(
    `[main] 加载 ${staticTools.length} 个静态工具: ${staticTools.map((t) => t.name).join(", ") || "(无)"}`,
  );
  const router = new Router(staticTools);

  const app = createMcpExpressApp({ host });
  mountMcpFace(app, staticTools, router);

  const server = app.listen(port, host, () => {
    console.log(`[main] MCP 面(streamable-http) http://${host}:${port}/mcp`);
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    console.log("[ws] 前端执行端连接");
    ws.on("message", (data) => {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      handleWsMessage(ws, text, router);
    });
    ws.on("close", () => router.disconnect(ws));
    ws.on("error", () => {});
  });
  console.log(`[main] 执行端 WS ws://${host}:${port}/ws`);
}

main().catch((err) => {
  console.error("[main] 启动失败:", err);
  process.exit(1);
});
