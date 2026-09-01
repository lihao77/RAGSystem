#!/usr/bin/env node
/**
 * LLM wire 抓取查看器（开发基础设施，配套 packages/agent-llm/src/wire-capture.ts）。
 *
 * 读取抓取目录的 wire-*.jsonl，汇总每次 provider 交换的线上 usage 形状——
 * 网关实际返回的字段名与数值直接可见，是 usage 解析口径排障的第一现场。
 *
 * 用法：
 *   node scripts/llm-wire-report.mjs                       # 最近 20 条交换概览
 *   node scripts/llm-wire-report.mjs --usage-shapes        # 按 provider 汇总 usage 字段形状（排障首选）
 *   node scripts/llm-wire-report.mjs --provider pqy_zhipuai --limit 5
 *   node scripts/llm-wire-report.mjs --raw <id前缀>         # 打印某次交换的完整 request/response
 *   node scripts/llm-wire-report.mjs --dir D:/test/llm-wire
 *
 * 抓取开启方式见 docs/dev/llm-wire-capture.md（RAGSYSTEM_LLM_WIRE_CAPTURE）。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);

const defaultDir = (() => {
  const env = process.env.RAGSYSTEM_LLM_WIRE_CAPTURE?.trim() ?? "";
  if (env && !["1", "true", "on", "yes"].includes(env.toLowerCase())) return env;
  return path.join(process.cwd(), "llm-wire-logs");
})();
const dir = flag("dir") ?? defaultDir;
const providerFilter = flag("provider")?.toLowerCase();
const modelFilter = flag("model")?.toLowerCase();
const limit = Number.parseInt(flag("limit") ?? "20", 10);
const rawId = flag("raw");

if (!fs.existsSync(dir)) {
  console.error(`抓取目录不存在: ${dir}`);
  console.error("先设置 RAGSYSTEM_LLM_WIRE_CAPTURE=1（或目录路径）并跑一次会话，再执行本脚本。");
  process.exit(1);
}

// ---- 读取与配对 ----
const files = fs.readdirSync(dir).filter((name) => name.startsWith("wire-") && name.endsWith(".jsonl")).sort();
const requests = new Map();
const responses = new Map();
for (const name of files) {
  const text = fs.readFileSync(path.join(dir, name), "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.kind === "request") requests.set(record.id, record);
    else if (record.kind === "response") responses.set(record.id, record);
  }
}

const exchanges = [...requests.entries()]
  .map(([id, request]) => ({ id, request, response: responses.get(id) ?? null }))
  .filter((exchange) => !providerFilter || exchange.request.provider?.toLowerCase() === providerFilter)
  .filter((exchange) => {
    if (!modelFilter) return true;
    return String(exchange.request.body?.model ?? "").toLowerCase().includes(modelFilter);
  })
  .sort((left, right) => String(right.request.ts).localeCompare(String(left.request.ts)));

if (exchanges.length === 0) {
  console.log(`目录 ${dir} 中没有匹配的交换记录（共 ${requests.size} 个请求）。`);
  process.exit(0);
}

// ---- wire usage 提取：JSON 响应取 body.usage；SSE 逐条解析 data 行里带 usage 的对象 ----
function extractWireUsages(response) {
  if (!response?.body) return [];
  const found = [];
  const text = typeof response.body === "string" ? response.body : JSON.stringify(response.body);
  if (!response.stream) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && parsed.usage && typeof parsed.usage === "object") {
        found.push({ event: "json", usage: parsed.usage });
      }
    } catch {
      /* 非 JSON 响应体忽略 */
    }
    return found;
  }
  for (const block of text.split(/\n\n/)) {
    const dataLines = block.split("\n").filter((line) => line.startsWith("data:"));
    if (!dataLines.length) continue;
    const dataText = dataLines.map((line) => line.slice(5).trim()).join("");
    if (!dataText || dataText === "[DONE]") continue;
    try {
      const parsed = JSON.parse(dataText);
      if (parsed && typeof parsed === "object") {
        const usage = parsed.usage && typeof parsed.usage === "object" ? parsed.usage : null;
        const nested = parsed.message?.usage && typeof parsed.message.usage === "object" ? parsed.message.usage : null;
        if (usage || nested) {
          found.push({ event: parsed.type ?? "(sse)", usage: usage ?? nested });
        }
      }
    } catch {
      /* 跳过非 JSON data 行 */
    }
  }
  return found;
}

// ---- 模式一：完整原始记录 ----
if (rawId) {
  const exchange = exchanges.find((item) => item.id.startsWith(rawId));
  if (!exchange) {
    console.error(`未找到 id 前缀为 ${rawId} 的交换。`);
    process.exit(1);
  }
  console.log(JSON.stringify({ request: exchange.request, response: exchange.response }, null, 2));
  process.exit(0);
}

// ---- 模式二：usage 形状汇总（排障首选） ----
if (has("usage-shapes")) {
  const shapes = new Map();
  for (const exchange of exchanges) {
    for (const { event, usage } of extractWireUsages(exchange.response)) {
      const key = `${exchange.request.provider}|${exchange.request.body?.model ?? "?"}|${event}|${Object.keys(usage).sort().join(",")}`;
      if (!shapes.has(key)) {
        shapes.set(key, { provider: exchange.request.provider, model: exchange.request.body?.model ?? "?", event, usage });
      }
    }
  }
  if (!shapes.size) {
    console.log("未在任何响应里发现 usage 对象（检查响应是否 2xx、或网关是否返回 usage）。");
    process.exit(0);
  }
  for (const { provider, model, event, usage } of shapes.values()) {
    console.log(`\n[${provider}] ${model} · ${event}`);
    for (const [field, value] of Object.entries(usage)) console.log(`  ${field} = ${JSON.stringify(value)}`);
  }
  process.exit(0);
}

// ---- 模式三：交换概览表 ----
console.log(`目录: ${dir}`);
console.log(`交换数: ${exchanges.length}（显示最近 ${Math.min(limit, exchanges.length)} 条）\n`);
for (const exchange of exchanges.slice(0, limit)) {
  const { request, response } = exchange;
  const usages = extractWireUsages(response);
  const merged = {};
  for (const { usage } of usages) Object.assign(merged, usage);
  const usageText = Object.keys(merged).length
    ? Object.entries(merged).map(([key, value]) => `${key}=${typeof value === "object" && value !== null ? JSON.stringify(value) : value}`).join(" ")
    : "(无 usage)";
  console.log(`${request.ts} ${request.provider} ${request.body?.model ?? "?"}`);
  console.log(`  ${request.method} ${request.url}`);
  console.log(`  status=${response?.status ?? "-"} stream=${response?.stream ?? "-"} interrupted=${response?.interrupted ?? false}`);
  console.log(`  wire usage: ${usageText}`);
}
