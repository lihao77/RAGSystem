import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { McpServerCreate } from "../../src/contracts/integrations/mcp.js";
import { McpService, type RuntimeMcpToolDefinition } from "../../src/services/integrations/mcp-service.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createService(): McpService {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-mcp-anno-"));
  tempRoots.push(dir);
  return new McpService({ configPath: path.join(dir, "mcp_servers.yaml") });
}

/** 起一个 streamable_http mock server,tools/list 返回给定工具清单(含 annotations)。 */
function startMockServer(tools: unknown[]): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const message = JSON.parse(body || "{}") as { id?: number; method?: string };
        if (message.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        let result: unknown = null;
        if (message.method === "initialize") {
          result = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "mock-anno", version: "1.0.0" },
          };
        } else if (message.method === "tools/list") {
          result = { tools };
        }
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

async function connectAndList(service: McpService, url: string, riskLevel = "low", toolRiskOverrides?: Record<string, string>): Promise<RuntimeMcpToolDefinition[]> {
  await service.addServer({
    name: "demo",
    transport: "streamable_http",
    url,
    enabled: true,
    auto_connect: false,
    timeout: 5,
    risk_level: riskLevel,
    ...(toolRiskOverrides ? { tool_risk_overrides: toolRiskOverrides } : {}),
  } as unknown as McpServerCreate);
  await service.connectServer("demo");
  return service.listServerTools("demo").tools;
}

const READ_TOOL = {
  name: "read",
  description: "Read-only tool",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true, idempotentHint: true },
};

const DELETE_TOOL = {
  name: "delete",
  description: "Destructive tool",
  inputSchema: { type: "object", properties: {} },
  annotations: { destructiveHint: true },
};

const PLAIN_TOOL = {
  name: "plain",
  description: "Plain tool",
  inputSchema: { type: "object", properties: {} },
};

describe("McpService tool.annotations", () => {
  it("透传 annotations 到 RuntimeMcpToolDefinition", async () => {
    const server = await startMockServer([READ_TOOL]);
    try {
      const tools = await connectAndList(createService(), server.url);
      const read = tools.find((t) => t.original_tool_name === "read")!;
      expect(read.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });
    } finally {
      await server.close();
    }
  });

  it("destructiveHint=true 把风险从 low 提升到 high(保守方向)", async () => {
    const server = await startMockServer([DELETE_TOOL]);
    try {
      const tools = await connectAndList(createService(), server.url, "low");
      const del = tools.find((t) => t.original_tool_name === "delete")!;
      expect(del.riskLevel).toBe("high");
      expect(del.annotations?.destructiveHint).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("destructiveHint=false 不降级风险(server high 仍 high)", async () => {
    const server = await startMockServer([{ ...PLAIN_TOOL, annotations: { destructiveHint: false } }]);
    try {
      const tools = await connectAndList(createService(), server.url, "high");
      const plain = tools.find((t) => t.original_tool_name === "plain")!;
      expect(plain.riskLevel).toBe("high");
    } finally {
      await server.close();
    }
  });

  it("无 annotations 时不附 annotations 字段,风险用 server risk_level", async () => {
    const server = await startMockServer([PLAIN_TOOL]);
    try {
      const tools = await connectAndList(createService(), server.url, "medium");
      const plain = tools.find((t) => t.original_tool_name === "plain")!;
      expect(plain.annotations).toBeUndefined();
      expect(plain.riskLevel).toBe("medium");
    } finally {
      await server.close();
    }
  });

  it("usage_contract/returns 自描述总是注入", async () => {
    const server = await startMockServer([READ_TOOL]);
    try {
      const tools = await connectAndList(createService(), server.url);
      const read = tools.find((t) => t.original_tool_name === "read")!;
      expect(read.usage_contract).toBeInstanceOf(Array);
      expect(read.usage_contract!.length).toBeGreaterThan(0);
      expect(read.returns).toBeDefined();
      expect(read.returns?.shape).toBeDefined();
    } finally {
      await server.close();
    }
  });

  it("per-tool tool_risk_overrides 覆盖 server 级 risk_level", async () => {
    const server = await startMockServer([PLAIN_TOOL]);
    try {
      // server risk_level=low,plain 工具被 override 为 high(无 annotations 干扰)
      const tools = await connectAndList(createService(), server.url, "low", { plain: "high" });
      const plain = tools.find((t) => t.original_tool_name === "plain")!;
      expect(plain.riskLevel).toBe("high");
    } finally {
      await server.close();
    }
  });

  it("per-tool override 不影响未覆盖的工具(仍用 server 级)", async () => {
    const server = await startMockServer([READ_TOOL, PLAIN_TOOL]);
    try {
      // server risk_level=low,只 override plain=high;read 仍 low
      const tools = await connectAndList(createService(), server.url, "low", { plain: "high" });
      const read = tools.find((t) => t.original_tool_name === "read")!;
      const plain = tools.find((t) => t.original_tool_name === "plain")!;
      expect(read.riskLevel).toBe("low");
      expect(plain.riskLevel).toBe("high");
    } finally {
      await server.close();
    }
  });
});
