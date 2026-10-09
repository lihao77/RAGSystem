import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import { PathApprovalService } from "@ragsystem/backend-core/services/runtime/path-approval-service.js";
import {
  backendPluginModule,
  createImageToolsPlugin,
  OpenAiVisionHelper,
  toProviderConfig,
  VIEW_IMAGE_TOOL_NAME,
} from "../dist/index.js";
import { describeUserMessageImagesWithHelper } from "../dist/index.js";
import { describeImageIfConfiguredWithHelper } from "../dist/index.js";
import { IMAGE_TOOLS_CONFIG_KEY } from "../dist/index.js";

/* ── 工具函数 ── */

function imagePart(fileId = "file-1", name = "photo.png", mime = "image/png") {
  return {
    type: "attachment_ref",
    file_id: fileId,
    original_name: name,
    stored_name: name,
    mime,
    size: 42,
    kind: "image",
    presentation: "inline",
  };
}

function textPart(text = "look at this") {
  return { type: "text", text };
}

function systemConfigWith(values = {}) {
  const config = { enabled: false, provider: "", provider_type: "", model_name: "", max_completion_tokens: 1200, timeout_seconds: 60, cache_enabled: true, ...values };
  return {
    getSection(key) {
      return key === IMAGE_TOOLS_CONFIG_KEY ? config : undefined;
    },
    getToolsConfig: () => ({ bash_default_timeout: 60, bash_max_timeout: 600, bash_max_output: 1e6, code_default_timeout: 60, code_max_timeout: 600 }),
    registerExtension: () => () => {},
  };
}

function modelAdapterWith(provider) {
  const providers = provider ? [provider] : [];
  return {
    getProvider: () => provider,
    hasProvider: () => provider != null,
    listProviders: () => providers,
  };
}

const visionProvider = { key: "vision-1", name: "vision", provider_type: "openai", supports_vision: true };

function transformerInput(overrides = {}) {
  return {
    sessionId: "session-1",
    tenantId: "tenant-1",
    contentParts: [textPart(), imagePart()],
    attachments: [{ file_id: "file-1", original_name: "photo.png", stored_name: "photo.png", mime: "image/png", size: 42, kind: "image" }],
    readAttachment: async () => ({ body: Buffer.from("89504e470d0a1a0a", "hex"), contentType: "image/png" }),
    modelAdapter: modelAdapterWith(visionProvider),
    systemConfig: systemConfigWith(),
    ...overrides,
  };
}

function stubHelper(description = "A photo of a cat.") {
  return { describeImage: async () => description };
}

/* ── transformer 行为 ── */

test("transformer returns null when the feature is disabled", async () => {
  const input = transformerInput();
  const result = await describeUserMessageImagesWithHelper(input, stubHelper);
  assert.equal(result, null);
});

test("transformer returns null when provider/model name is missing (no auto fallback)", async () => {
  const input = transformerInput({
    systemConfig: systemConfigWith({ enabled: true, provider: "", model_name: "" }),
  });
  const result = await describeUserMessageImagesWithHelper(input, stubHelper);
  assert.equal(result, null);
});

test("transformer returns null when provider is not found", async () => {
  const input = transformerInput({
    systemConfig: systemConfigWith({ enabled: true, provider: "missing", model_name: "gpt-4o" }),
    modelAdapter: modelAdapterWith(null),
  });
  const result = await describeUserMessageImagesWithHelper(input, stubHelper);
  assert.equal(result, null);
});

test("transformer returns null when there are no image parts", async () => {
  const input = transformerInput({
    systemConfig: systemConfigWith({ enabled: true, provider: "vision", model_name: "gpt-4o" }),
    contentParts: [textPart()],
  });
  const result = await describeUserMessageImagesWithHelper(input, stubHelper);
  assert.equal(result, null);
});

test("transformer skips TIFF and other unsupported historical image parts without reading or calling a helper", async () => {
  const input = transformerInput({
    systemConfig: systemConfigWith({ enabled: true, provider: "vision", model_name: "gpt-4o" }),
    contentParts: [imagePart("tiff", "scan.tif", "image/tiff"), imagePart("svg", "vector.svg", "image/svg+xml")],
    readAttachment: async () => assert.fail("unsupported images must not be read"),
  });
  assert.equal(await describeUserMessageImagesWithHelper(input, () => assert.fail("must not create helper")), null);
});

test("transformer keeps descriptions aligned in a mixture of PNG and old TIFF image parts", async () => {
  const input = transformerInput({
    systemConfig: systemConfigWith({ enabled: true, provider: "vision", model_name: "gpt-4o" }),
    contentParts: [imagePart("tiff", "scan.tif", "image/tiff"), imagePart("png", "photo.png")],
    readAttachment: async fileId => {
      assert.equal(fileId, "png");
      return { body: Buffer.from("89504e470d0a1a0a", "hex"), contentType: "image/png" };
    },
  });
  const parts = await describeUserMessageImagesWithHelper(input, () => stubHelper("PNG description"));
  assert.deepEqual(parts.filter(part => part.type === "image_description").map(part => part.file_id), ["png"]);
});

test("unsupported or mislabeled TIFF bytes never reach the auxiliary provider API", async () => {
  let requests = 0;
  const helper = new OpenAiVisionHelper({
    provider: { ...visionProvider, models: [] }, modelName: "vision-model", maxCompletionTokens: 100,
    timeoutSeconds: 1, cacheEnabled: false,
    client: { complete: async () => { requests += 1; assert.fail("unsupported image reached the API"); } },
  });
  for (const mime of ["image/tiff", "image/png"]) {
    assert.equal(await helper.describeImage({ bytes: Buffer.from("49492a0008000000", "hex"), mime }), null);
    const input = transformerInput({
      systemConfig: systemConfigWith({ enabled: true, provider: "vision", model_name: "gpt-4o" }),
      readAttachment: async () => ({ body: Buffer.from("49492a0008000000", "hex"), contentType: mime }),
    });
    const result = await describeUserMessageImagesWithHelper(input, () => ({ describeImage: () => assert.fail("unsupported bytes reached helper") }));
    assert.equal(result.some(part => part.type === "image_description"), false);
  }
  assert.equal(requests, 0);
});

test("transformer appends an image_description part after each image part", async () => {
  const input = transformerInput({
    systemConfig: systemConfigWith({ enabled: true, provider: "vision", model_name: "gpt-4o" }),
    contentParts: [textPart("look"), imagePart("file-1", "a.png"), imagePart("file-2", "b.png")],
  });
  let calls = 0;
  const result = await describeUserMessageImagesWithHelper(input, async () => {
    calls += 1;
    return stubHelper(`description-${calls}`);
  });
  assert.notEqual(result, null);
  assert.equal(result.length, 5);
  assert.equal(result[0].type, "text");
  assert.equal(result[1].type, "attachment_ref");
  assert.equal(result[2].type, "image_description");
  assert.equal(result[2].file_id, "file-1");
  assert.equal(result[2].original_name, "a.png");
  assert.match(result[2].text, /description-1/);
  assert.equal(result[3].type, "attachment_ref");
  assert.equal(result[4].type, "image_description");
  assert.equal(result[4].file_id, "file-2");
  assert.match(result[4].text, /description-1/);
  assert.equal(calls, 1); // helper 创建一次，多图共享（缓存复用）
});

test("transformer keeps original parts when the vision helper fails", async () => {
  const input = transformerInput({
    systemConfig: systemConfigWith({ enabled: true, provider: "vision", model_name: "gpt-4o" }),
  });
  const result = await describeUserMessageImagesWithHelper(input, async () => ({ describeImage: async () => null }));
  assert.notEqual(result, null);
  assert.equal(result.length, 2); // text + attachment_ref，无描述 part
  assert.equal(result[0].type, "text");
  assert.equal(result[1].type, "attachment_ref");
});

test("transformer skips unreadable attachments", async () => {
  const input = transformerInput({
    systemConfig: systemConfigWith({ enabled: true, provider: "vision", model_name: "gpt-4o" }),
    readAttachment: async () => null,
  });
  const result = await describeUserMessageImagesWithHelper(input, stubHelper);
  assert.equal(result.length, 2);
});

test("transformer skips description when the main model supports vision", async () => {
  const input = transformerInput({
    systemConfig: systemConfigWith({ enabled: true, provider: "vision", model_name: "gpt-4o" }),
    mainModelSupportsVision: true,
  });
  let helperCalls = 0;
  const result = await describeUserMessageImagesWithHelper(input, async () => {
    helperCalls += 1;
    return stubHelper("desc");
  });
  assert.equal(result, null); // 多模态主模型直接看原图，不生成描述
  assert.equal(helperCalls, 0); // 视觉辅助模型一次也不调用
});

test("transformer describes when the main model vision capability is not declared", async () => {
  const input = transformerInput({
    systemConfig: systemConfigWith({ enabled: true, provider: "vision", model_name: "gpt-4o" }),
    mainModelSupportsVision: false,
  });
  const result = await describeUserMessageImagesWithHelper(input, () => stubHelper("desc"));
  assert.ok(result);
  assert.equal(result.some((part) => part.type === "image_description"), true);
});

/* ── 插件装配 ── */

test("plugin contributes the view_image descriptor only when installed", async () => {
  const empty = new BackendPluginManager();
  await empty.register();
  assert.deepEqual(empty.runtimeContributions().listTools(), []);

  const installed = new BackendPluginManager([createImageToolsPlugin()]);
  await installed.register();
  assert.deepEqual(
    installed.runtimeContributions().listTools().map((tool) => tool.name),
    [VIEW_IMAGE_TOOL_NAME],
  );
});

test("standard plugin module rejects unsupported configuration", () => {
  assert.throws(
    () => backendPluginModule.create({ config: { unknown: true } }),
    /not supported/,
  );
});

test("plugin module create returns a working plugin", async () => {
  const plugin = await backendPluginModule.create({ config: undefined });
  assert.equal(plugin.manifest.id, "@ragsystem/backend-plugin-image-tools");
  const manager = new BackendPluginManager([plugin]);
  await manager.register();
  assert.equal(manager.runtimeContributions().listTools().length, 1);
});

/* ── view_image 工具（通过 factory 构建后直接调用） ── */

function buildViewImageTool(agentTools = [VIEW_IMAGE_TOOL_NAME], factoryOverrides = {}) {
  const plugin = createImageToolsPlugin();
  let factory;
  const registrations = [];
  const context = {
    capabilities: { get: () => undefined },
    hooks: { on: () => () => {} },
    routes: { register: () => {} },
    runtimes: { register: (fn) => { registrations.push(fn); } },
    resources: { register: () => () => {} },
    tools: { register: (fn) => { factory = fn; } },
    applications: { register: () => {} },
    events: { on: () => () => {} },
    transformers: { register: () => () => {} },
  };
  plugin.register(context);
  const tools = factory({
    tenantId: "tenant-1",
    teamName: null,
    agent: { agent_name: "agent-1", tools: { enabled_tools: agentTools } },
    pathAccessPolicy: new PathApprovalService(),
    ...factoryOverrides,
  });
  return Array.isArray(tools) ? tools : [tools];
}

test("view_image is hidden when not in enabled_tools", () => {
  assert.deepEqual(buildViewImageTool([]), []);
});

test("view_image rejects external paths without approval and reads them after approval", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "image-tools-"));
  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  // os.tmpdir() 本身属于读语义界内根，外部路径必须建在仓库目录下才真正越界
  const externalDir = path.join(fileURLToPath(new URL(".", import.meta.url)), ".tmp-external");
  fs.rmSync(externalDir, { recursive: true, force: true });
  fs.mkdirSync(externalDir, { recursive: true });
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const outside = path.join(externalDir, "outside.png");
  fs.writeFileSync(outside, png);
  const ctx = { workspaceRoot: workspace, tenantId: "tenant-1" };
  try {
    const policy = new PathApprovalService();
    const [tool] = buildViewImageTool([VIEW_IMAGE_TOOL_NAME], { pathAccessPolicy: policy });

    // checkAccess：越界路径作为候选信号交给审批流，工具本身保持 allow
    const decision = tool.checkAccess({ file_path: outside }, ctx);
    assert.equal(decision.action, "allow");
    assert.deepEqual(decision.signals?.candidatePaths, [path.resolve(outside)]);

    const rejected = await tool.call({ file_path: outside }, ctx);
    assert.equal(rejected.success, false);
    assert.match(rejected.summary, /受管目录范围/);

    policy.approve([externalDir]);
    const approved = await tool.call({ file_path: outside }, ctx);
    assert.equal(approved.success, true);
    assert.equal(approved.outputType, "image");
  } finally {
    fs.rmSync(externalDir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("view_image reads uploads images without approval", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "image-tools-"));
  const workspace = path.join(tmp, "workspace");
  const uploads = path.join(tmp, "uploads");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(uploads, { recursive: true });
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  fs.writeFileSync(path.join(uploads, "up.png"), png);
  try {
    const [tool] = buildViewImageTool();
    const result = await tool.call({ file_path: path.join(uploads, "up.png") }, {
      workspaceRoot: workspace,
      executionPaths: { workspace, uploads },
      tenantId: "tenant-1",
    });
    assert.equal(result.success, true);
    assert.equal(result.outputType, "image");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("view_image rejects unsupported image types", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "image-tools-"));
  fs.writeFileSync(path.join(tmp, "note.txt"), "hello");
  const [tool] = buildViewImageTool();
  const result = await tool.call({ file_path: "note.txt" }, { workspaceRoot: tmp, tenantId: "tenant-1" });
  assert.equal(result.success, false);
  assert.match(result.summary, /PNG, JPEG, GIF, and WebP/);
});

test("view_image returns base64 media for a workspace image", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "image-tools-"));
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  fs.writeFileSync(path.join(tmp, "photo.png"), png);
  const [tool] = buildViewImageTool();
  const result = await tool.call({ file_path: "photo.png" }, { workspaceRoot: tmp, tenantId: "tenant-1" });
  assert.equal(result.success, true);
  assert.equal(result.outputType, "image");
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].kind, "image");
  assert.equal(result.media[0].mimeType, "image/png");
  assert.equal(result.media[0].source.type, "base64");
});

test("view_image skips description for vision-capable main model even when helper is configured", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "image-tools-"));
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  fs.writeFileSync(path.join(tmp, "photo.png"), png);
  const [tool] = buildViewImageTool([VIEW_IMAGE_TOOL_NAME], {
    mainModelSupportsVision: true,
    systemConfig: systemConfigWith({ enabled: true, provider: "vision", model_name: "gpt-4o" }),
    providers: [visionProvider],
  });
  const result = await tool.call({ file_path: "photo.png" }, { workspaceRoot: tmp, tenantId: "tenant-1" });
  assert.equal(result.success, true);
  assert.equal(result.answer, null); // 视觉主模型直接看图，不再解析一遍
  assert.equal(result.media.length, 1); // 图片本身仍以 media 返回
});

test("view_image attaches description for non-vision main model when helper is configured", async () => {
  const context = {
    mainModelSupportsVision: false,
    systemConfig: systemConfigWith({ enabled: true, provider: "vision", model_name: "gpt-4o" }),
    providers: [visionProvider],
  };
  const description = await describeImageIfConfiguredWithHelper(
    context,
    new Uint8Array([1, 2, 3]),
    "image/png",
    { tenantId: "tenant-1", signal: null },
    () => stubHelper("图中有一只猫。"),
  );
  assert.equal(description, "图中有一只猫。"); // 非视觉主模型依赖描述文本
});

test("view_image keeps description when main model vision capability is not declared", async () => {
  const context = {
    systemConfig: systemConfigWith({ enabled: true, provider: "vision", model_name: "gpt-4o" }),
    providers: [visionProvider],
  };
  const description = await describeImageIfConfiguredWithHelper(
    context,
    new Uint8Array([1, 2, 3]),
    "image/png",
    { tenantId: "tenant-1", signal: null },
    () => stubHelper("图中有一只猫。"),
  );
  assert.equal(description, "图中有一只猫。"); // 未声明主模型能力时保持原行为，不做猜测
});

test("view_image rejects images larger than 10 MB", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "image-tools-"));
  fs.writeFileSync(path.join(tmp, "big.png"), Buffer.alloc(10 * 1024 * 1024 + 1));
  const [tool] = buildViewImageTool();
  const result = await tool.call({ file_path: "big.png" }, { workspaceRoot: tmp, tenantId: "tenant-1" });
  assert.equal(result.success, false);
  assert.match(result.summary, /10 MB/);
});

/* ── 插件下行事件（plugin_event 进度帧） ── */

function recordingPublisher() {
  const calls = [];
  const publisher = {
    publish: (sessionId, event, data, options) => {
      calls.push({ sessionId, event, data, options });
      return Promise.resolve();
    },
  };
  return { calls, publisher };
}

test("transformer emits describe lifecycle events as ephemeral session frames", async () => {
  const { calls, publisher } = recordingPublisher();
  const input = transformerInput({
    systemConfig: systemConfigWith({ enabled: true, provider: "vision", model_name: "gpt-4o" }),
    contentParts: [textPart("look"), imagePart("file-1", "a.png"), imagePart("file-2", "b.png")],
    pluginEvents: publisher,
  });

  const result = await describeUserMessageImagesWithHelper(input, () => stubHelper("desc"));

  assert.ok(result);
  assert.deepEqual(
    calls.map((call) => call.event),
    ["image.describe_started", "image.describe_progress", "image.describe_progress", "image.describe_completed"],
  );
  for (const call of calls) {
    assert.equal(call.sessionId, "session-1");
    assert.equal(call.options.delivery, "ephemeral");
    assert.equal(call.data.source, "message");
  }
  assert.deepEqual(calls[0].data.files, ["a.png", "b.png"]);
  assert.equal(calls[0].data.total, 2);
  assert.equal(calls[1].data.ok, true);
  assert.equal(calls[1].data.file_id, "file-1");
  assert.equal(calls[3].data.described, 2);
  assert.equal(calls[3].data.failed, 0);
  assert.equal(typeof calls[3].data.duration_ms, "number");
});

test("transformer marks per-image failures in progress and completed events", async () => {
  const { calls, publisher } = recordingPublisher();
  const input = transformerInput({
    systemConfig: systemConfigWith({ enabled: true, provider: "vision", model_name: "gpt-4o" }),
    contentParts: [imagePart("file-1", "a.png"), imagePart("file-2", "b.png")],
    pluginEvents: publisher,
  });
  let describeCalls = 0;
  await describeUserMessageImagesWithHelper(input, async () => ({
    describeImage: async () => (++describeCalls === 1 ? null : "desc"),
  }));

  const progress = calls.filter((call) => call.event === "image.describe_progress");
  assert.deepEqual(progress.map((call) => call.data.ok), [false, true]);
  const completed = calls.find((call) => call.event === "image.describe_completed");
  assert.equal(completed.data.described, 1);
  assert.equal(completed.data.failed, 1);
});

test("transformer works without an event publisher (events are best-effort)", async () => {
  const input = transformerInput({
    systemConfig: systemConfigWith({ enabled: true, provider: "vision", model_name: "gpt-4o" }),
  });
  const result = await describeUserMessageImagesWithHelper(input, () => stubHelper("desc"));
  assert.ok(result);
  assert.equal(result.some((part) => part.type === "image_description"), true);
});

test("view_image describe emits run-scoped events with call lineage", async () => {
  const { calls, publisher } = recordingPublisher();
  const context = {
    mainModelSupportsVision: false,
    systemConfig: systemConfigWith({ enabled: true, provider: "vision", model_name: "gpt-4o" }),
    providers: [visionProvider],
    pluginEvents: publisher,
  };

  const description = await describeImageIfConfiguredWithHelper(
    context,
    new Uint8Array([1, 2, 3]),
    "image/png",
    { tenantId: "tenant-1", sessionId: "session-9", runId: "run-7", currentCallId: "call-3", signal: null },
    () => stubHelper("图中有一只猫。"),
  );

  assert.equal(description, "图中有一只猫。");
  assert.deepEqual(
    calls.map((call) => call.event),
    ["image.describe_started", "image.describe_progress", "image.describe_completed"],
  );
  for (const call of calls) {
    assert.equal(call.sessionId, "session-9");
    assert.equal(call.options.delivery, "ephemeral");
    assert.equal(call.options.runId, "run-7");
    assert.equal(call.options.callId, "call-3");
    assert.equal(call.data.source, "view_image");
  }
});

test("view_image describe emits nothing when the helper is not configured", async () => {
  const { calls, publisher } = recordingPublisher();
  const context = {
    mainModelSupportsVision: false,
    systemConfig: systemConfigWith(), // 未启用视觉辅助
    providers: [visionProvider],
    pluginEvents: publisher,
  };

  const description = await describeImageIfConfiguredWithHelper(
    context,
    new Uint8Array([1, 2, 3]),
    "image/png",
    { tenantId: "tenant-1", sessionId: "session-9", signal: null },
    () => stubHelper("desc"),
  );

  assert.equal(description, null);
  assert.deepEqual(calls, []);
});

/* ── toProviderConfig：模型条目输入模态 → agent-llm 能力位 ── */

test("toProviderConfig derives supports_vision from the model entry input modalities", () => {
  const provider = {
    key: "vision-1",
    name: "vision",
    provider_type: "zhipuai",
    api_format: "openai_chat",
    api_key: "sk-test",
    api_endpoint: "https://api.openai.com/v1",
    models: [
      { name: "gpt-4o", input_modalities: ["text", "image"], supports_function_calling: true, temperature: 0.2 },
      { name: "gpt-4.1-mini", input_modalities: ["text"] },
    ],
    // 旧 provider 级残留：不得覆盖模型级派生值
    supports_vision: true,
  };

  const vision = toProviderConfig(provider, "gpt-4o");
  // agent-llm 按 API 格式分发：provider_type 由 api_format 带出，厂商不透传为分发键
  assert.equal(vision.provider_type, "openai_chat");
  assert.equal(vision.supports_vision, true);
  assert.equal(vision.supports_function_calling, true);
  assert.equal(vision.temperature, 0.2);

  const text = toProviderConfig(provider, "gpt-4.1-mini");
  assert.equal(text.supports_vision, false);

  // 未指定模型时不注入能力位（旧 provider 级残留也被剥离）
  const noEntry = toProviderConfig(provider);
  assert.equal("supports_vision" in noEntry, false);
});

/* ── view_image 请求归一化（capability 提供的 normalizer） ── */

import { CapabilityRegistry } from "@ragsystem/backend-core/plugins/capability-registry.js";
import { IMAGE_REQUEST_NORMALIZER_CAPABILITY } from "@ragsystem/backend-core/contracts/images/image-request.js";

function normalizerRegistry(result) {
  const registry = new CapabilityRegistry();
  registry.provide(
    IMAGE_REQUEST_NORMALIZER_CAPABILITY,
    {
      normalize: async () => result,
    },
    "test",
  );
  return registry;
}

test("view_image normalizes media through the image request normalizer capability", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "image-tools-"));
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  fs.writeFileSync(path.join(tmp, "photo.png"), png);
  const normalizedBytes = Buffer.from("524946460400000057454250", "hex");
  const registry = normalizerRegistry({
    kind: "normalized",
    data: normalizedBytes,
    mime: "image/webp",
    width: 400,
    height: 300,
    originalWidth: 4000,
    originalHeight: 3000,
  });
  try {
    const [tool] = buildViewImageTool([VIEW_IMAGE_TOOL_NAME], { capabilities: registry });
    const result = await tool.call({ file_path: "photo.png" }, { workspaceRoot: tmp, tenantId: "tenant-1" });
    assert.equal(result.success, true);
    assert.equal(result.media[0].mimeType, "image/webp");
    assert.equal(result.media[0].source.data, normalizedBytes.toString("base64"));
    assert.equal(result.content.mime, "image/webp");
    assert.equal(result.content.size, normalizedBytes.byteLength);
    // 坐标换算提示：x 与 y 比例一致时给单一乘数
    assert.match(result.llmHint, /downscaled from 4000x3000 px/);
    assert.match(result.llmHint, /multiply coordinates by 10\.00/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("view_image lets oversized images through when the normalizer shrinks them", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "image-tools-"));
  // png 头 + 11MB 填充：超过 10MB 原始上限
  const oversized = Buffer.concat([
    Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
    Buffer.alloc(11 * 1024 * 1024),
  ]);
  fs.writeFileSync(path.join(tmp, "big.png"), oversized);
  const small = Buffer.from([0xff, 0xd8, 0xff]);
  const registry = normalizerRegistry({ kind: "normalized", data: small, mime: "image/jpeg", width: 100, height: 50 });
  try {
    const [tool] = buildViewImageTool([VIEW_IMAGE_TOOL_NAME], { capabilities: registry });
    const result = await tool.call({ file_path: "big.png" }, { workspaceRoot: tmp, tenantId: "tenant-1" });
    assert.equal(result.success, true);
    assert.equal(result.media[0].mimeType, "image/jpeg");
    // 未缩放（无 original 尺寸）时提示保持干净
    assert.ok(!result.llmHint.includes("downscaled"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("view_image keeps the hard size limit for passthrough or missing normalizers", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "image-tools-"));
  const oversized = Buffer.concat([
    Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
    Buffer.alloc(11 * 1024 * 1024),
  ]);
  fs.writeFileSync(path.join(tmp, "big.png"), oversized);
  try {
    // passthrough：归一化不适用（如动图），维持原字节 → 硬上限生效
    const passthrough = buildViewImageTool([VIEW_IMAGE_TOOL_NAME], {
      capabilities: normalizerRegistry({ kind: "passthrough" }),
    });
    const rejected = await passthrough[0].call({ file_path: "big.png" }, { workspaceRoot: tmp, tenantId: "tenant-1" });
    assert.equal(rejected.success, false);
    assert.match(rejected.summary, /10 MB/);

    // 无 normalizer（未提供 capability）：行为与旧版一致
    const bare = buildViewImageTool([VIEW_IMAGE_TOOL_NAME]);
    const bareResult = await bare[0].call({ file_path: "big.png" }, { workspaceRoot: tmp, tenantId: "tenant-1" });
    assert.equal(bareResult.success, false);
    assert.match(bareResult.summary, /10 MB/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("transformer describes with the variant content type instead of the upload-declared mime", async () => {
  // 归一化变体可能换编码（png→webp）：描述请求必须按字节真实编码声明，
  // 否则视觉端点按 mime 解码失败，描述静默缺失。
  const seen = [];
  const input = transformerInput({
    systemConfig: systemConfigWith({ enabled: true, provider: "vision", model_name: "gpt-4o" }),
    readAttachment: async () => ({ body: Buffer.from("524946460400000057454250", "hex"), contentType: "image/webp" }),
  });
  const result = await describeUserMessageImagesWithHelper(input, () => ({
    describeImage: async ({ bytes, mime }) => {
      seen.push({ bytes, mime });
      return "a description";
    },
  }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].mime, "image/webp");
  assert.equal(seen[0].bytes.byteLength, 12);
  assert.equal(result.some((part) => part.type === "image_description"), true);

  // contentType 缺失时按实际字节推断，不能随意假定为 PNG。
  const fallback = transformerInput({
    systemConfig: systemConfigWith({ enabled: true, provider: "vision", model_name: "gpt-4o" }),
    readAttachment: async () => ({ body: Buffer.from("89504e470d0a1a0a", "hex"), contentType: null }),
  });
  const fallbackSeen = [];
  await describeUserMessageImagesWithHelper(fallback, () => ({
    describeImage: async ({ mime }) => {
      fallbackSeen.push(mime);
      return "d";
    },
  }));
  assert.equal(fallbackSeen[0], "image/png");
});
