import assert from "node:assert/strict";
import test from "node:test";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";

import {
  MEDIA_VENDORS,
  MEDIA_SYSTEM_CONFIG_EXTENSION,
  TOOL_DESCRIPTORS,
  backendPluginModule,
  findMediaVendor,
} from "../dist/index.js";

test("插件注册：不向 core Provider 体系注册任何类型；工具照常注册", async () => {
  const manager = new BackendPluginManager([backendPluginModule.create({ config: undefined })]);
  await manager.register();

  // providerTypes 注册面已从 BackendPluginContext 移除——媒体厂商完全插件自管。
  const contributions = manager.runtimeContributions();
  assert.equal("listProviderTypes" in contributions, false);

  const toolNames = TOOL_DESCRIPTORS.map((descriptor) => descriptor.name).sort();
  assert.deepEqual(toolNames, ["check_video_task", "generate_image", "generate_video"]);
  await manager.stop();
});

test("厂商清单：六家厂商各带默认端点；vendor 即 adapter id", async () => {
  const { MEDIA_VENDORS: vendors } = await import("../dist/index.js");
  assert.deepEqual(
    vendors.map((vendor) => vendor.value),
    ["zhipu", "volcengine", "dashscope", "modelscope", "openai", "google"],
  );
  for (const vendor of vendors) {
    assert.ok(vendor.defaultEndpoint.startsWith("https://"), vendor.value);
    assert.ok(vendor.label.length > 0);
  }
  assert.equal(findMediaVendor("zhipu")?.defaultEndpoint, "https://open.bigmodel.cn");
  assert.equal(findMediaVendor(" ZHIPU ")?.value, "zhipu");
  assert.equal(findMediaVendor("media_zhipu"), null);
});

test("配置组自包含：厂商下拉 + API Key(password) + 端点 + 模型名文本框，不引用 core Provider", () => {
  const groups = MEDIA_SYSTEM_CONFIG_EXTENSION.groups;
  assert.equal(groups.length, 2);
  for (const group of groups) {
    const keys = group.fields.map((field) => field.key);
    assert.ok(keys.includes("vendor"));
    assert.ok(keys.includes("api_key"));
    assert.ok(keys.includes("api_endpoint"));
    assert.ok(keys.includes("model_name"));
    assert.equal(keys.includes("custom_model"), false);
    assert.equal(keys.includes("provider"), false);
    assert.equal(keys.includes("provider_type"), false);
    const vendorField = group.fields.find((field) => field.key === "vendor");
    assert.equal(vendorField.options.length, MEDIA_VENDORS.length);
    // 模型名是自由文本：目录外新模型直接填，能力按厂商默认兜底。
    const modelField = group.fields.find((field) => field.key === "model_name");
    assert.equal(modelField.type, "text");
    assert.equal("options" in modelField, false);
  }
});

test("旧 custom_model 存量值折算进 model_name（model_name 非空则优先）", async () => {
  const { resolveImageConfig, resolveVideoConfig } = await import("../dist/index.js");
  assert.equal(resolveImageConfig({ model_name: "", custom_model: "new-model" }).model_name, "new-model");
  assert.equal(resolveImageConfig({ model_name: "glm-image", custom_model: "new-model" }).model_name, "glm-image");
  assert.equal(resolveImageConfig({ model_name: " glm-image " }).model_name, "glm-image");
  const video = resolveVideoConfig({ model_name: "", custom_model: "sora-2" });
  assert.equal(video.model_name, "sora-2");
  // 折算结果不再暴露 custom_model。
  assert.equal("custom_model" in resolveImageConfig({ custom_model: "x" }), false);
});

test("配置段被写入未知键（如历史 bug 注入的 provider/provider_type）不致整段失效", async () => {
  const { resolveImageConfig } = await import("../dist/index.js");
  const resolved = resolveImageConfig({
    enabled: true,
    vendor: "modelscope",
    api_key: "ms-token",
    model_name: "Qwen/Qwen-Image",
    provider: "moda",
    provider_type: "media_modelscope",
  });
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.vendor, "modelscope");
  assert.equal(resolved.api_key, "ms-token");
  assert.equal(resolved.model_name, "Qwen/Qwen-Image");
  assert.equal("provider" in resolved, false);
  assert.equal("provider_type" in resolved, false);
});
