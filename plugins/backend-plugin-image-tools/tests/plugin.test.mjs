import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import {
  backendPluginModule,
  createImageToolsPlugin,
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
    readAttachment: async () => new Uint8Array([1, 2, 3]),
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
    pathAccessPolicy: { isApproved: () => false },
    ...factoryOverrides,
  });
  return Array.isArray(tools) ? tools : [tools];
}

test("view_image is hidden when not in enabled_tools", () => {
  assert.deepEqual(buildViewImageTool([]), []);
});

test("view_image rejects paths outside the workspace", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "image-tools-"));
  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const outside = path.join(tmp, "outside.png"); // 在 workspace 之外
  fs.writeFileSync(outside, "not an image");
  const [tool] = buildViewImageTool();
  const result = await tool.call({ file_path: outside }, { workspaceRoot: workspace, tenantId: "tenant-1" });
  assert.equal(result.success, false);
  assert.match(result.summary, /workspace/);
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
