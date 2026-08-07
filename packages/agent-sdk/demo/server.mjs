/**
 * agent-sdk Demo Server
 *
 * 内置 3 个演示工具（get_time / calculate / random_choice）+ HTTP 服务。
 * POST /api/run 接收配置，createRuntime 跑 ReAct 循环，NDJSON 流式推送 KernelEvent。
 * GET / 返回 index.html。
 *
 * 用法：node packages/agent-sdk/demo/server.mjs
 *       然后浏览器打开 http://localhost:4199
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime, buildTool } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.DEMO_PORT ?? 4199;

/* ============================================================
 * 内置演示工具（buildTool 构造的 Tool[]）
 * ========================================================== */

function executeBuiltinTool(toolName, args) {
  if (toolName === "get_time") {
    const now = new Date().toISOString();
    return {
      success: true,
      toolName,
      summary: `当前时间: ${now}`,
      answer: now,
      outputType: "text",
      content: now,
      metadata: {},
      files: [],
      llmHint: null,
    };
  }
  if (toolName === "calculate") {
    const expr = String(args.expression ?? "").trim();
    if (!expr) {
      return errResult(toolName, "缺少 expression 参数");
    }
    if (!/^[0-9+\-*/().\s^]+$/.test(expr)) {
      return errResult(toolName, `表达式含非法字符: ${expr}`);
    }
    try {
      const safe = expr.replace(/\^/g, "**");
      // eslint-disable-next-line no-new-func
      const value = Function(`"use strict"; return (${safe});`)();
      const text = String(value);
      return {
        success: true,
        toolName,
        summary: `${expr} = ${text}`,
        answer: text,
        outputType: "text",
        content: text,
        metadata: { expression: expr },
        files: [],
        llmHint: null,
      };
    } catch (e) {
      return errResult(toolName, `计算失败: ${e.message}`);
    }
  }
  if (toolName === "random_choice") {
    const items = Array.isArray(args.items) ? args.items : [];
    if (items.length === 0) {
      return errResult(toolName, "items 列表为空");
    }
    const picked = items[Math.floor(Math.random() * items.length)];
    return {
      success: true,
      toolName,
      summary: `随机选中: ${picked}`,
      answer: picked,
      outputType: "text",
      content: picked,
      metadata: { candidates: items.length },
        files: [],
      llmHint: null,
    };
  }
  return errResult(toolName, `未知工具: ${toolName}`);
}

function errResult(toolName, message) {
  return { success: false, toolName, summary: message, answer: null, outputType: "error", content: message, metadata: { source_shape: "error" }, files: [], llmHint: null };
}

const tools = [
  buildTool({
    name: "get_time",
    description: "获取当前日期时间。无需参数。",
    parameters: { type: "object", properties: {}, required: [] },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: () => executeBuiltinTool("get_time", {}),
  }),
  buildTool({
    name: "calculate",
    description: "计算一个数学表达式，支持加减乘除、括号、幂运算。例如 calculate({ expression: '2*(3+4)' }) 返回 14。",
    parameters: {
      type: "object",
      properties: { expression: { type: "string", description: "数学表达式，如 2+3*4 或 (10-2)/4" } },
      required: ["expression"],
    },
    isReadOnly: () => true,
    call: (input) => executeBuiltinTool("calculate", input),
  }),
  buildTool({
    name: "random_choice",
    description: "从给定列表中随机选择一个元素。",
    parameters: {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" }, description: "候选列表" } },
      required: ["items"],
    },
    call: (input) => executeBuiltinTool("random_choice", input),
  }),
];

/* ============================================================
 * 构造 createRuntime 所需对象
 * ========================================================== */

function buildProfile(config) {
  // profile.llmTiers.default.provider 内联完整 ProviderConfig（index.html 已构造，SDK 自建 OpenAiCompatibleClient 据此调用）。
  return {
    agentName: "demo-agent",
    llmTiers: {
      default: {
        provider: config.provider,
        modelName: config.modelName,
        temperature: config.temperature ?? 0.7,
        maxCompletionTokens: config.maxCompletionTokens ?? 2048,
        maxContextTokens: config.maxContextTokens ?? 32768,
        extraParams: {},
      },
    },
    behavior: {
      systemPrompt: config.systemPrompt || "",
      compressionTriggerRatio: null,
      summarizeMaxTokens: null,
      preserveRecentTurns: null,
    },
    customParams: {},
  };
}

async function runAgent(config, messages, task, sessionId, signal, onEvent) {
  const profile = buildProfile(config);
  // SDK 纯计算：注入静态 conversation（messages → ChatMessage[]）+ tools，无 store/落库。
  const conversation = (messages ?? []).map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
  }));
  const runtime = createRuntime({
    profile,
    tools,
    dataRoot: config.dataRoot,
  });
  try {
    const handle = runtime.run({
      sessionId: sessionId || `demo-${Date.now()}`,
      task,
      conversation,
      threadKey: "root",
      ...(signal ? { signal } : {}),
    });
    // 消费事件流——把每个 KernelEvent 透传给 onEvent（落库归消费端，demo 只推流）。
    for await (const event of handle.events) {
      onEvent(event);
    }
    const result = await handle.result;
    onEvent({ type: "_done", content: result.content, metadata: result.metadata, finishReason: result.finishReason });
    return result;
  } finally {
    runtime.close();
  }
}

/* ============================================================
 * HTTP 服务器
 * ========================================================== */

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "POST" && req.url === "/api/run") {
    const body = await readBody(req);
    let config;
    try {
      const parsed = JSON.parse(body);
      config = parsed;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    });

    const send = (obj) => {
      res.write(JSON.stringify(obj) + "\n");
    };

    try {
      await runAgent(config, config.messages ?? [{ role: 'user', content: config.task }], config.task, config.sessionId, controller.signal, send);
    } catch (err) {
      send({ type: "_error", message: err?.message ?? String(err) });
    } finally {
      res.end();
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not Found");
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

server.listen(PORT, () => {
  console.log(`\n  agent-sdk demo running at http://localhost:${PORT}\n`);
  console.log(`  Built-in tools: get_time, calculate, random_choice`);
  console.log(`  Fill in your LLM provider config and run a task.\n`);
});
