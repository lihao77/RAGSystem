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

test("配置组自包含：厂商下拉 + API Key(password) + 端点 + 模型下拉，不引用 core Provider", () => {
  const groups = MEDIA_SYSTEM_CONFIG_EXTENSION.groups;
  assert.equal(groups.length, 2);
  for (const group of groups) {
    const keys = group.fields.map((field) => field.key);
    assert.ok(keys.includes("vendor"));
    assert.ok(keys.includes("api_key"));
    assert.ok(keys.includes("api_endpoint"));
    assert.ok(keys.includes("model_name"));
    assert.equal(keys.includes("provider"), false);
    assert.equal(keys.includes("provider_type"), false);
    const vendorField = group.fields.find((field) => field.key === "vendor");
    assert.equal(vendorField.options.length, MEDIA_VENDORS.length);
    const modelField = group.fields.find((field) => field.key === "model_name");
    assert.ok(modelField.options.length > 0);
  }
  // image 组列生图模型、video 组列生视频模型。
  const imageModels = groups[0].fields.find((field) => field.key === "model_name").options.map((option) => option.value);
  const videoModels = groups[1].fields.find((field) => field.key === "model_name").options.map((option) => option.value);
  assert.ok(imageModels.includes("glm-image"));
  assert.ok(videoModels.includes("cogvideox-3"));
  assert.equal(imageModels.includes("cogvideox-3"), false);
});
