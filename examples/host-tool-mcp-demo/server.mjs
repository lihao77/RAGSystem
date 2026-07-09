// host-tool-mcp 网页 demo 静态服务器（无 token 普通会话路径）。
//
// 伺服 widget/host-tools/mcp-client 三个 UMD + index.html，端口 5173（在 backend CORS_ORIGINS 默认白名单内）。
// widget 懒建 session（首次发消息时建），经 onSessionChange 回调把 session_id 传给页面注册 MCP 执行端；
// newSession 切换时回调收 null → 断开旧执行端，新会话建立后重新注册。
//
// 前置（用户自备）：
//   1. host-tool-mcp-server 已 build 并启动（默认 :8787）：npm -w host-tool-mcp-server run build && npm -w host-tool-mcp-server start
//   2. backend（:5002）已加 frontend-tools MCP server（POST /api/mcp/servers，transport=streamable_http,url=http://127.0.0.1:8787/mcp）
//      且 entry agent（orchestrator_agent）的 mcp.enabled_servers 含 frontend-tools（PATCH /api/agent-config/configs/orchestrator_agent）
//   3. widget 三 UMD 已构建：npm -w @ragsystem/agent-widget run build
//
// 用法：node examples/host-tool-mcp-demo/server.mjs   →   浏览器开 http://localhost:5173
//   改后端地址：BACKEND_BASE=http://localhost:5002  改 MCP WS：MCP_WS_URL=ws://127.0.0.1:8787/ws  改端口：DEMO_PORT=5173
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.DEMO_PORT || 5173);
const BACKEND = (process.env.BACKEND_BASE || "http://localhost:5002").replace(/\/$/, "");
const MCP_WS = process.env.MCP_WS_URL || "ws://127.0.0.1:8787/ws";
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "..", "packages", "agent-widget", "dist");
const INDEX = path.resolve(here, "index.html");

const BUNDLES = {
  "/widget.js": "ragsystem-widget.umd.cjs",
  "/host-tools.js": "ragsystem-host-tools.umd.cjs",
  "/mcp-client.js": "ragsystem-mcp-client.umd.cjs",
};

const server = http.createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (BUNDLES[url]) {
    try {
      const buf = fs.readFileSync(path.join(DIST, BUNDLES[url]));
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache, no-store, must-revalidate" });
      res.end(buf);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`${BUNDLES[url]} 未构建，请先 npm -w @ragsystem/agent-widget run build`);
    }
    return;
  }
  if (url === "/" || url === "/index.html") {
    const html = fs.readFileSync(INDEX, "utf8").replaceAll("{{BACKEND}}", BACKEND).replaceAll("{{MCP_WS}}", MCP_WS);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(html);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`端口 ${PORT} 被占，换 DEMO_PORT=xxxx node examples/host-tool-mcp-demo/server.mjs`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`host-tool-mcp demo → http://localhost:${PORT}`);
  console.log(`backend ${BACKEND} | MCP 执行端 WS ${MCP_WS}`);
});
