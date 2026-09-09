/**
 * wire-capture JSONL → 回放/夹具工具（capture 是一次性观测，夹具是永久回归）。
 *
 * 链路：开发期对真实网关抓线（RAGSYSTEM_LLM_WIRE_CAPTURE）→ 本工具把抓取会话
 * 转成测试可回放的 fetch stub（stub globalThis.fetch 后适配器原样解析），或抽取
 * 单次交换为可提交的自包含夹具（剥 id/ts，头表保持脱敏形态）。
 *
 * 用法（测试内）：
 *   const exchanges = readWireCapture("llm-wire-logs/wire-2026-09-09.jsonl");
 *   globalThis.fetch = replayFetch(exchanges);                  // 按 method+path+query 匹配
 *   globalThis.fetch = replayFetch(exchanges, { match: "sequence" }); // 按捕获顺序消费
 *
 * 用法（命令行，抽取可提交夹具）：
 *   node test/helpers/wire-replay.mjs <capture.jsonl> --list
 *   node test/helpers/wire-replay.mjs <capture.jsonl> --export <id> > fixture.json
 */
import fs from "node:fs";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** 读 capture JSONL → 交换列表（request/response 按 id 配对；response 可缺省=请求中断）。 */
export function readWireCapture(file) {
  const byId = new Map();
  const exchanges = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // 损坏行跳过（写入中断残留），不让单行坏档毁掉整份会话
    }
    if (record.kind === "request") {
      const exchange = { id: record.id, provider: record.provider ?? null, request: record, response: null };
      byId.set(record.id, exchange);
      exchanges.push(exchange);
    } else if (record.kind === "response" && byId.has(record.id)) {
      byId.get(record.id).response = record;
    }
  }
  return exchanges;
}

/** 回放 fetch：默认按 method+path+query 匹配（同键多次命中按捕获顺序消费），未命中响亮抛错。 */
export function replayFetch(exchanges, options = {}) {
  const sequence = (options.match ?? "path") === "sequence";
  const pending = new Map();
  if (sequence) {
    pending.set("*", [...exchanges]);
  } else {
    for (const exchange of exchanges) {
      const key = requestKey(exchange.request.url, exchange.request.method);
      const queue = pending.get(key) ?? [];
      if (queue.length === 0) pending.set(key, queue);
      queue.push(exchange);
    }
  }
  return async (input, init) => {
    const key = sequence ? "*" : requestKey(String(input), init?.method);
    const exchange = pending.get(key)?.shift();
    if (!exchange) {
      const remaining = [...pending.entries()].filter(([, queue]) => queue.length > 0).map(([k]) => k);
      throw new Error(`wire replay: 无可回放交换 ${key}（剩余可回放键: ${remaining.join(", ") || "无"}）`);
    }
    return responseOf(exchange);
  };
}

/** 交换 → 自包含夹具（剥 id/ts 等易变字段；头表保持抓取时的脱敏形态，请求/响应体原样）。 */
export function toWireFixture(exchange) {
  return {
    provider: exchange.provider,
    request: {
      method: exchange.request.method,
      url: exchange.request.url,
      headers: exchange.request.headers,
      body: exchange.request.body,
    },
    response: exchange.response
      ? {
          status: exchange.response.status,
          headers: exchange.response.headers,
          stream: exchange.response.stream,
          body: exchange.response.body,
        }
      : null,
  };
}

function requestKey(url, method) {
  const parsed = new URL(url);
  return `${(method ?? "GET").toUpperCase()} ${parsed.pathname}${parsed.search}`;
}

function responseOf(exchange) {
  const { response } = exchange;
  if (!response) {
    throw new Error(`wire replay: 交换 ${exchange.id} 无 response 行（请求中断/未落盘），不可回放`);
  }
  if (response.interrupted) {
    throw new Error(`wire replay: 交换 ${exchange.id} 的 response 标记 interrupted，不可回放`);
  }
  return new Response(response.body ?? "", {
    status: response.status ?? 200,
    headers: response.headers ?? {},
  });
}

// ────────────────────────────── 命令行入口 ──────────────────────────────

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
  const [file, ...flags] = process.argv.slice(2);
  if (!file) {
    console.error("用法: node test/helpers/wire-replay.mjs <capture.jsonl> [--list] [--export <id>]");
    process.exit(1);
  }
  const exchanges = readWireCapture(file);
  if (flags.includes("--list")) {
    for (const exchange of exchanges) {
      const outcome = exchange.response
        ? `${exchange.response.status ?? "?"}${exchange.response.interrupted ? " (interrupted)" : ""}`
        : "无响应";
      console.log(`${exchange.id}  ${(exchange.provider ?? "?").padEnd(16)} ${exchange.request.method} ${exchange.request.url}  →  ${outcome}`);
    }
  } else {
    const exportIndex = flags.indexOf("--export");
    const id = exportIndex >= 0 ? flags[exportIndex + 1] : exchanges[0]?.id;
    const exchange = exchanges.find((candidate) => candidate.id === id);
    if (!exchange) {
      console.error(`未找到交换 ${id ?? "(空捕获)"}`);
      process.exit(1);
    }
    console.log(JSON.stringify(toWireFixture(exchange), null, 2));
  }
}
