import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { McpServerCreate } from "../../src/contracts/mcp.js";
import { McpService } from "../../src/services/integrations/mcp-service.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createService(): McpService {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-mcp-remote-"));
  tempRoots.push(dir);
  return new McpService({ configPath: path.join(dir, "mcp_servers.yaml") });
}

const ECHO_TOOL = {
  name: "echo",
  description: "Echo text",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

function resultFor(method: string, params: Record<string, unknown>): unknown {
  if (method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "mock-remote", version: "1.0.0" },
    };
  }
  if (method === "tools/list") {
    return { tools: [ECHO_TOOL] };
  }
  if (method === "tools/call") {
    const text = (params.arguments as { text?: string } | undefined)?.text ?? "";
    return { content: [{ type: "text", text: `echo:${text}` }], isError: false };
  }
  return null;
}

function startStreamableHttpServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" || req.method === "DELETE") {
        // Server-push SSE stream and session termination are optional; the client tolerates 405.
        res.writeHead(405).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const message = JSON.parse(body || "{}") as { id?: number; method?: string; params?: Record<string, unknown> };
        if (message.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        const result = resultFor(message.method ?? "", message.params ?? {});
        if (result === null) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "test-session" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function startSseServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    let sseResponse: http.ServerResponse | null = null;
    const server = http.createServer((req, res) => {
      const parsed = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      if (req.method === "GET" && parsed.pathname === "/sse") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        sseResponse = res;
        res.write(`event: endpoint\ndata: /messages\n\n`);
        req.on("close", () => {
          if (sseResponse === res) {
            sseResponse = null;
          }
        });
        return;
      }
      if (req.method === "POST" && parsed.pathname === "/messages") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          res.writeHead(202).end();
          const message = JSON.parse(body || "{}") as { id?: number; method?: string; params?: Record<string, unknown> };
          if (sseResponse && message.id !== undefined) {
            const result = resultFor(message.method ?? "", message.params ?? {});
            if (result !== null) {
              sseResponse.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
            }
          }
        });
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/sse`,
        close: () => new Promise((r) => {
          if (sseResponse) {
            sseResponse.end();
          }
          server.close(() => r());
        }),
      });
    });
  });
}

describe("McpService remote transports", () => {
  it("connects, lists, calls, and disconnects a streamable_http server", async () => {
    const server = await startStreamableHttpServer();
    try {
      const service = createService();
      await service.addServer({
        name: "demo",
        transport: "streamable_http",
        url: server.url,
        headers: { "X-Test": "1" },
        enabled: true,
        auto_connect: false,
        timeout: 5,
      } as unknown as McpServerCreate);

      const status = await service.connectServer("demo");
      expect(status.status).toBe("connected");
      expect(status.tool_count).toBe(1);

      const tools = service.listServerTools("demo");
      expect(tools.tools[0]).toMatchObject({ name: "mcp__demo__echo", original_tool_name: "echo" });

      const result = await service.callTool("demo", "echo", { text: "hi" });
      expect(result.success).toBe(true);
      expect(String(result.content)).toContain("echo:hi");

      service.disconnectServer("demo");
      expect(service.getServerStatus("demo").status).toBe("disconnected");
    } finally {
      await server.close();
    }
  });

  it("connects, lists, calls, and disconnects an sse server", async () => {
    const server = await startSseServer();
    try {
      const service = createService();
      await service.addServer({
        name: "demo",
        transport: "sse",
        url: server.url,
        enabled: true,
        auto_connect: false,
        timeout: 5,
      } as unknown as McpServerCreate);

      const status = await service.connectServer("demo");
      expect(status.status).toBe("connected");
      expect(status.tool_count).toBe(1);

      const tools = service.listServerTools("demo");
      expect(tools.tools[0]).toMatchObject({ name: "mcp__demo__echo", original_tool_name: "echo" });

      const result = await service.callTool("demo", "echo", { text: "hi" });
      expect(result.success).toBe(true);
      expect(String(result.content)).toContain("echo:hi");

      service.disconnectServer("demo");
      expect(service.getServerStatus("demo").status).toBe("disconnected");
    } finally {
      await server.close();
    }
  });

  it("reports error status when the remote server is unreachable", async () => {
    const service = createService();
    await service.addServer({
      name: "dead",
      transport: "streamable_http",
      url: "http://127.0.0.1:1/mcp",
      enabled: true,
      auto_connect: false,
      timeout: 2,
    } as McpServerCreate);

    await expect(service.connectServer("dead")).rejects.toThrow();
    const status = service.getServerStatus("dead");
    expect(status.status).toBe("error");
    expect(status.error_message).toBeTruthy();
  });
});
