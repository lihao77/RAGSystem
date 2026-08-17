import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import YAML from "yaml";

import { LlmProviderClient } from "../packages/agent-llm/dist/index.js";
import { buildAnthropicBody } from "../packages/agent-llm/dist/providers/anthropic.js";
import { buildGeminiBody } from "../packages/agent-llm/dist/providers/gemini.js";
import { buildChatBody } from "../packages/agent-llm/dist/providers/openai-chat.js";
import { buildResponsesBody } from "../packages/agent-llm/dist/providers/openai-responses.js";
import {
  analyzeRoundCache,
  analyzeTransitions,
  summarizeProviderResults,
  summarizeRounds,
} from "./cache-hit-rate-analysis.mjs";

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

loadDotEnv(path.resolve(".env"));
loadDotEnv(path.resolve("backend-local/.env"));

const providersPath = resolveProvidersPath(options.providersPath);
const providerConfigs = loadProviderConfigs(providersPath);
const selectedProviders = selectProviders(providerConfigs, options);
if (selectedProviders.length === 0) {
  throw new Error("没有找到可测试的 chat provider");
}

const runId = randomUUID();
const startedAt = new Date();
const outputDir = path.resolve(options.outputDir ?? path.join(
  ".tmp",
  "cache-benchmarks",
  startedAt.toISOString().replaceAll(":", "-").replaceAll(".", "-"),
));
await fsp.mkdir(outputDir, { recursive: true });
await fsp.mkdir(path.dirname(path.resolve(".tmp/cache-benchmarks/latest.txt")), { recursive: true });
await fsp.writeFile(path.resolve(".tmp/cache-benchmarks/latest.txt"), `${outputDir}\n`, "utf8");

const runConfig = {
  runId,
  startedAt: startedAt.toISOString(),
  providersPath,
  outputDir,
  rounds: options.rounds,
  delayMs: options.delayMs,
  stableBytes: options.stableBytes,
  toolResultBytes: options.toolResultBytes,
  forcePromptCacheKey: options.forcePromptCacheKey,
  openAiExplicitBreakpoint: options.openAiExplicitBreakpoint,
  providers: selectedProviders.map(sanitizeProvider),
};
await writeJson(path.join(outputDir, "run-config.json"), runConfig);

const roundsPath = path.join(outputDir, "rounds.jsonl");
const providerResults = [];
for (const selected of selectedProviders) {
  process.stdout.write(`\n[cache-live] ${selected.key} (${selected.provider.provider_type}/${selected.model})\n`);
  const result = await runProviderBenchmark(selected, {
    ...options,
    runId,
    roundsPath,
  });
  providerResults.push(result);
  await writeJson(path.join(outputDir, "report.partial.json"), buildReport(runConfig, providerResults));
}

const report = buildReport(runConfig, providerResults);
await writeJson(path.join(outputDir, "report.json"), report);
await fsp.writeFile(path.join(outputDir, "report.md"), renderMarkdown(report), "utf8");
await fsp.rm(path.join(outputDir, "report.partial.json"), { force: true });

process.stdout.write(`\n[cache-live] report: ${path.join(outputDir, "report.md")}\n`);
for (const provider of report.providers) {
  process.stdout.write(
    `[cache-live] ${provider.providerKey}: reported=${formatRate(provider.summary.reportedHitRate)} `
      + `warm=${formatRate(provider.summary.warmHitRate)} conditional=${formatRate(provider.summary.nonZeroConditionalHitRate)} `
      + `unreported=${provider.summary.unreportedRounds.length} status=${provider.status}\n`,
  );
}

if (options.strict && providerResults.some((result) => result.status !== "ok")) {
  process.exitCode = 1;
} else if (providerResults.every((result) => result.rounds.every((round) => round.status !== "ok"))) {
  process.exitCode = 1;
}

async function runProviderBenchmark(selected, context) {
  const client = new LlmProviderClient();
  const stablePrefix = buildPayload(
    context.stableBytes,
    `RAGSYSTEM CACHE PROBE STABLE PREFIX ${context.runId} ${selected.key} ${selected.model}`,
  );
  const toolResult = buildPayload(
    context.toolResultBytes,
    `RAGSYSTEM READ_FILE RESULT ${context.runId} ${selected.key}`,
  );
  const promptCacheKey = `ragsystem:cache-live:${sha256(`${context.runId}:${selected.key}:${selected.model}`).slice(0, 24)}`;
  const tools = [{
    type: "function",
    function: {
      name: "read_file",
      description: "Read a deterministic cache benchmark fixture.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  }];
  const syntheticToolCall = {
    id: `call_cache_probe_${sha256(selected.key).slice(0, 12)}`,
    type: "function",
    function: { name: "read_file", arguments: '{"path":"cache-probe.txt"}' },
  };
  const messages = [
    {
      role: "system",
      content: `${stablePrefix}\n\nFollow cache probe instructions exactly and keep replies under 12 tokens.`,
    },
    { role: "user", content: "Reply only CACHE-PROBE-ROUND-1." },
  ];
  const roundRecords = [];

  for (let round = 1; round <= context.rounds; round += 1) {
    const phase = round === 1 ? "cold_initial" : round === 2 ? "tool_result_continuation" : "stable_followup";
    const request = {
      provider: selected.provider,
      model: selected.model,
      messages: context.openAiExplicitBreakpoint && selected.provider.provider_type === "openai_chat"
        ? addOpenAiExplicitBreakpoint(messages)
        : structuredClone(messages),
      tools,
      toolChoice: "auto",
      temperature: 0,
      maxCompletionTokens: 48,
      promptCacheKey,
      ...(selected.provider.provider_type === "deepseek" ? { thinkingLevel: "off" } : {}),
    };
    const body = buildWireBody(request);
    const record = {
      providerKey: selected.key,
      providerType: selected.provider.provider_type,
      model: selected.model,
      round,
      phase,
      startedAt: new Date().toISOString(),
      request: summarizeRequest(body, request.messages),
      status: "error",
    };
    const callStartedAt = Date.now();
    try {
      const result = await client.complete(request);
      record.status = "ok";
      record.elapsedMs = Date.now() - callStartedAt;
      record.finishReason = result.finishReason ?? null;
      record.outputPreview = compactPreview(result.content);
      record.toolCallCount = result.toolCalls?.length ?? 0;
      record.usage = result.usage ?? null;
      record.rawUsage = extractRawUsage(result.raw);
      record.cache = analyzeRoundCache(result.usage, record.rawUsage);
      process.stdout.write(renderRoundLine(record));

      if (round === 1) {
        messages.push({ role: "assistant", content: "", tool_calls: [syntheticToolCall] });
        messages.push({
          role: "tool",
          tool_call_id: syntheticToolCall.id,
          content: `${toolResult}\n\nReply only CACHE-PROBE-ROUND-2 and do not call tools.`,
        });
      } else {
        messages.push(toAssistantMessage(result, round));
        appendToolResults(messages, result.toolCalls, round);
        if (round < context.rounds) {
          messages.push({ role: "user", content: `Reply only CACHE-PROBE-ROUND-${round + 1}; do not call tools.` });
        }
      }
    } catch (error) {
      record.elapsedMs = Date.now() - callStartedAt;
      record.error = error instanceof Error ? error.message : String(error);
      process.stdout.write(`[round ${round}] ERROR ${record.error}\n`);
    }
    roundRecords.push(record);
    await fsp.appendFile(context.roundsPath, `${JSON.stringify(record)}\n`, "utf8");
    if (round < context.rounds && context.delayMs > 0) await delay(context.delayMs);
    if (record.status !== "ok") break;
  }

  return {
    providerKey: selected.key,
    providerType: selected.provider.provider_type,
    model: selected.model,
    status: roundRecords.length === context.rounds && roundRecords.every((record) => record.status === "ok") ? "ok" : "partial",
    rounds: roundRecords,
    summary: summarizeRounds(roundRecords),
    analysis: analyzeTransitions(roundRecords),
  };
}

function parseArgs(args) {
  const parsed = {
    providersPath: null,
    providerKeys: [],
    model: null,
    outputDir: null,
    rounds: 5,
    delayMs: 1200,
    stableBytes: 64 * 1024,
    toolResultBytes: 8 * 1024,
    strict: false,
    forcePromptCacheKey: false,
    openAiExplicitBreakpoint: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} 缺少参数`);
      index += 1;
      return value;
    };
    if (arg === "--providers-path") parsed.providersPath = next();
    else if (arg === "--provider") parsed.providerKeys.push(...next().split(",").map((value) => value.trim()).filter(Boolean));
    else if (arg === "--model") parsed.model = next();
    else if (arg === "--output-dir") parsed.outputDir = next();
    else if (arg === "--rounds") parsed.rounds = positiveInteger(next(), arg, 3);
    else if (arg === "--delay-ms") parsed.delayMs = nonNegativeInteger(next(), arg);
    else if (arg === "--stable-bytes") parsed.stableBytes = positiveInteger(next(), arg, 1024);
    else if (arg === "--tool-result-bytes") parsed.toolResultBytes = positiveInteger(next(), arg, 256);
    else if (arg === "--strict") parsed.strict = true;
    else if (arg === "--force-prompt-cache-key") parsed.forcePromptCacheKey = true;
    else if (arg === "--openai-explicit-breakpoint") parsed.openAiExplicitBreakpoint = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (parsed.model && parsed.providerKeys.length > 1) throw new Error("--model 只能与单个 --provider 一起使用");
  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage: npm run test:cache-live -- [options]\n\n`
    + `  --provider <key[,key]>       指定 provider；默认测试全部 chat provider\n`
    + `  --model <name>               单 provider 模型覆盖\n`
    + `  --providers-path <path>      providers.yaml 路径\n`
    + `  --rounds <n>                 轮数，默认 5，最少 3\n`
    + `  --delay-ms <n>               轮间延迟，默认 1200\n`
    + `  --stable-bytes <n>            稳定 system 前缀大小，默认 65536\n`
    + `  --tool-result-bytes <n>       read_file 结果大小，默认 8192\n`
    + `  --output-dir <path>           输出目录\n`
    + `  --force-prompt-cache-key      对自定义 openai_chat 端点强制发送稳定缓存键\n`
    + `  --openai-explicit-breakpoint  在 OpenAI Chat system 文本块后添加显式断点\n`
    + `  --strict                      任一 provider 失败时退出非零\n`);
}

function resolveProvidersPath(explicitPath) {
  if (explicitPath) return requireFile(path.resolve(explicitPath));
  if (process.env.RAGSYSTEM_PROVIDER_CONFIG?.trim()) {
    return requireFile(path.resolve(process.env.RAGSYSTEM_PROVIDER_CONFIG.trim()));
  }
  const dataRoot = path.resolve(process.env.RAG_DATA_ROOT?.trim() || path.join(process.env.USERPROFILE ?? process.cwd(), ".ragsystem"));
  const direct = path.join(dataRoot, "config", "model_adapter", "providers.yaml");
  if (fs.existsSync(direct)) return direct;
  const tenantsRoot = path.join(dataRoot, "tenants");
  const matches = fs.existsSync(tenantsRoot)
    ? fs.readdirSync(tenantsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(tenantsRoot, entry.name, "config", "model_adapter", "providers.yaml"))
      .filter((candidate) => fs.existsSync(candidate))
    : [];
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`未找到 providers.yaml（data root: ${dataRoot}）`);
  throw new Error(`找到多个租户 provider 配置，请用 --providers-path 指定: ${matches.join(", ")}`);
}

function loadProviderConfigs(filePath) {
  const parsed = YAML.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("providers.yaml 格式无效");
  return Object.entries(parsed).map(([key, raw]) => {
    const config = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const provider = {
      ...config,
      key,
      api_key: resolveEnvPlaceholder(String(config.api_key ?? "")),
      api_endpoint: resolveEnvPlaceholder(String(config.api_endpoint ?? "")),
    };
    return { key, provider, models: collectModels(config) };
  });
}

function selectProviders(configs, selection) {
  const requested = new Set(selection.providerKeys);
  const unknown = selection.providerKeys.filter((key) => !configs.some((item) => item.key === key));
  if (unknown.length > 0) throw new Error(`未知 provider: ${unknown.join(", ")}`);
  const selected = configs
    .filter((item) => requested.size === 0 || requested.has(item.key))
    .filter((item) => item.provider.provider_type !== "rerank_api")
    .map((item) => ({
      ...item,
      provider: (selection.forcePromptCacheKey || selection.openAiExplicitBreakpoint)
        && item.provider.provider_type === "openai_chat"
        ? { ...item.provider, supports_prompt_caching: true }
        : item.provider,
      model: selection.model ?? chooseChatModel(item.models),
    }))
    .filter((item) => item.model && item.provider.api_key);
  return selected;
}

function collectModels(config) {
  const models = [];
  if (Array.isArray(config.models)) models.push(...config.models.map(String));
  if (config.model_map && typeof config.model_map === "object" && !Array.isArray(config.model_map)) {
    for (const value of Object.values(config.model_map)) {
      if (Array.isArray(value)) models.push(...value.map(String));
      else if (typeof value === "string") models.push(value);
    }
  }
  return [...new Set(models.map((value) => value.trim()).filter(Boolean))];
}

function chooseChatModel(models) {
  return models.find((model) => !/(embedding|rerank)/i.test(model)) ?? null;
}

function buildWireBody(request) {
  if (request.provider.provider_type === "anthropic") return buildAnthropicBody(request, false);
  if (request.provider.provider_type === "gemini") return buildGeminiBody(request);
  if (request.provider.provider_type === "openai_resp") return buildResponsesBody(request, false);
  return buildChatBody(request, false);
}

function addOpenAiExplicitBreakpoint(messages) {
  return messages.map((message, index) => {
    const cloned = structuredClone(message);
    if (index !== 0 || cloned.role !== "system" || typeof cloned.content !== "string") return cloned;
    return {
      ...cloned,
      content: [{
        type: "text",
        text: cloned.content,
        prompt_cache_breakpoint: { mode: "explicit" },
      }],
    };
  });
}

function summarizeRequest(body, messages) {
  const serialized = JSON.stringify(body);
  return {
    bytes: Buffer.byteLength(serialized),
    sha256: sha256(serialized),
    messageCount: messages.length,
    roles: messages.map((message) => message.role),
    lastRole: messages.at(-1)?.role ?? null,
    cacheMarkers: collectCacheMarkers(body),
  };
}

function collectCacheMarkers(value, currentPath = "$", output = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectCacheMarkers(item, `${currentPath}[${index}]`, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${currentPath}.${key}`;
    if (key === "cache_control" || key === "prompt_cache_key" || key === "prompt_cache_breakpoint") {
      output.push({ path: itemPath, value: item });
    } else {
      collectCacheMarkers(item, itemPath, output);
    }
  }
  return output;
}

function buildReport(config, providers) {
  return {
    ...config,
    completedAt: new Date().toISOString(),
    providers,
    overall: summarizeProviderResults(providers),
  };
}

function renderMarkdown(report) {
  const lines = [
    "# Cache Hit Rate Live Report",
    "",
    `- Run ID: \`${report.runId}\``,
    `- Started: ${report.startedAt}`,
    `- Completed: ${report.completedAt}`,
    `- Stable prefix: ${report.stableBytes} bytes`,
    `- Tool result: ${report.toolResultBytes} bytes`,
    `- Overall warm hit rate: ${formatRate(report.overall.warmHitRate)}`,
    `- Reported hit rate: ${formatRate(report.overall.reportedHitRate)}`,
    `- Conditional hit rate excluding zero-hit rounds: ${formatRate(report.overall.nonZeroConditionalHitRate)}`,
    "",
    "## Provider Summary",
    "",
    "| Provider | Type | Model | Status | Reported | Warm | Conditional | Post-tool | Unreported | Drop rounds |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const provider of report.providers) {
    lines.push(`| ${provider.providerKey} | ${provider.providerType} | ${provider.model} | ${provider.status} | ${formatRate(provider.summary.reportedHitRate)} | ${formatRate(provider.summary.warmHitRate)} | ${formatRate(provider.summary.nonZeroConditionalHitRate)} | ${formatRate(provider.summary.postToolHitRate)} | ${provider.summary.unreportedRounds.join(", ") || "-"} | ${provider.summary.cacheDropRounds.join(", ") || "-"} |`);
  }
  for (const provider of report.providers) {
    lines.push("", `## ${provider.providerKey}`, "");
    lines.push(`Transition: \`${provider.analysis.conclusion}\``);
    lines.push("", "| Round | Phase | Input | Cached | Written | Uncached | Hit Rate | Result | Latency |", "|---:|---|---:|---:|---:|---:|---:|---|---:|");
    for (const round of provider.rounds) {
      lines.push(`| ${round.round} | ${round.phase} | ${round.cache?.inputTokens ?? "-"} | ${round.cache?.cachedInputTokens ?? "-"} | ${round.cache?.cacheCreationInputTokens ?? "-"} | ${round.cache?.uncachedInputTokens ?? "-"} | ${formatRate(round.cache?.hitRate)} | ${round.status === "ok" ? round.cache?.classification ?? "ok" : `error: ${escapeTable(round.error ?? "unknown")}`} | ${round.elapsedMs ?? "-"} ms |`);
    }
  }
  lines.push("", "## Interpretation", "",
    "- Round 1 is a deliberate cold request.",
    "- Round 2 appends a new read_file tool result. The new tool result cannot be a cache read in that same request; it can only be written while the older prefix may be read.",
    "- Round 3 is the first request where the Round 2 tool result can be part of a cache read.",
    "- `Warm` excludes Round 1 and only includes rounds with provider-reported cache metrics.",
    "- `Conditional` excludes every reported round whose cached token count is zero; it is not the overall hit rate.",
    "- `Unreported` rounds are excluded from all cache-rate denominators and drop-round diagnostics.",
    "");
  return `${lines.join("\n")}\n`;
}

function renderRoundLine(record) {
  const cache = record.cache;
  return `[round ${record.round}] input=${cache?.inputTokens ?? "-"} cached=${cache?.cachedInputTokens ?? "-"} `
    + `write=${cache?.cacheCreationInputTokens ?? "-"} hit=${formatRate(cache?.hitRate)} ${cache?.classification ?? "no_usage"}\n`;
}

function toAssistantMessage(result, round) {
  return {
    role: "assistant",
    content: result.content || (result.toolCalls?.length ? "" : `CACHE-PROBE-ROUND-${round}`),
    ...(result.toolCalls?.length ? { tool_calls: result.toolCalls } : {}),
    ...(result.reasoningBlocks?.length ? { reasoning_blocks: result.reasoningBlocks } : {}),
    ...(result.providerContinuation ? { provider_continuation: result.providerContinuation } : {}),
  };
}

function appendToolResults(messages, toolCalls, round) {
  for (const call of toolCalls ?? []) {
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: `CACHE-PROBE synthetic result for ${call.function.name} in round ${round}.`,
    });
  }
}

function extractRawUsage(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) && raw.usage && typeof raw.usage === "object"
    ? raw.usage
    : null;
}

function sanitizeProvider(selected) {
  return {
    key: selected.key,
    name: selected.provider.name ?? null,
    provider_type: selected.provider.provider_type,
    api_endpoint: selected.provider.api_endpoint || null,
    model: selected.model,
    api_key_configured: Boolean(selected.provider.api_key),
    supports_prompt_caching: selected.provider.supports_prompt_caching ?? null,
  };
}

function buildPayload(targetBytes, header) {
  let output = `${header}\n`;
  let index = 0;
  while (Buffer.byteLength(output) < targetBytes) {
    index += 1;
    output += `stable-cache-line-${String(index).padStart(5, "0")}: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu.\n`;
  }
  return output.slice(0, targetBytes);
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
}

function resolveEnvPlaceholder(value) {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name) => process.env[name] ?? match);
}

function requireFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
  return filePath;
}

function positiveInteger(value, name, minimum = 1) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number < minimum) throw new Error(`${name} 必须是不小于 ${minimum} 的整数`);
  return number;
}

function nonNegativeInteger(value, name) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} 必须是非负整数`);
  return number;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compactPreview(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function formatRate(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "n/a";
}

function escapeTable(value) {
  return String(value).replaceAll("|", "\\|").replace(/\s+/g, " ").slice(0, 180);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
