import assert from "node:assert/strict";
import test from "node:test";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";

import {
  PLUGIN_ID,
  backendPluginModule,
  MEDIA_PROVIDER_TYPES,
  TOOL_DESCRIPTORS,
} from "../dist/index.js";

test("插件注册：按厂商的 provider type，各自携带 image/video 模型映射任务", async () => {
  const manager = new BackendPluginManager([backendPluginModule.create({ config: undefined })]);
  await manager.register();

  const contributions = manager.runtimeContributions();
  const providerTypes = contributions.listProviderTypes();
  assert.equal(providerTypes.length, 1);
  assert.equal(providerTypes[0].pluginId, PLUGIN_ID);
  assert.equal(providerTypes[0].types.length, MEDIA_PROVIDER_TYPES.length);

  for (const type of providerTypes[0].types) {
    assert.equal(type.extension_id, PLUGIN_ID);
    // 类型声明自己的模型映射任务（Provider 页面据此渲染任务下拉）
    assert.deepEqual(type.model_tasks, [
      { value: "image", label: "生图模型" },
      { value: "video", label: "生视频模型" },
    ]);
    assert.ok(type.default_endpoint.length > 0);
  }

  const toolNames = TOOL_DESCRIPTORS.map((descriptor) => descriptor.name).sort();
  assert.deepEqual(toolNames, ["check_video_task", "generate_image", "generate_video"]);
  await manager.stop();
});

test("provider type 即厂商路由；model_map 任务归一", async () => {
  const { adapterIdForProviderType, isMediaProviderType, modelsForTask, PROVIDER_TYPE_TO_ADAPTER } = await import("../dist/index.js");
  for (const [typeValue, adapter] of Object.entries(PROVIDER_TYPE_TO_ADAPTER)) {
    assert.equal(adapterIdForProviderType(typeValue), adapter);
    assert.ok(isMediaProviderType(typeValue));
  }
  assert.equal(adapterIdForProviderType("openai_chat"), null);
  assert.equal(isMediaProviderType("media_generation"), false);

  assert.deepEqual(
    modelsForTask({ name: "x", provider_type: "media_zhipu", model_map: { image: "glm-image", video: ["a", "b"] } }, "image"),
    ["glm-image"],
  );
  assert.deepEqual(
    modelsForTask({ name: "x", provider_type: "media_zhipu", model_map: { image: "glm-image", video: ["a", "b"] } }, "video"),
    ["a", "b"],
  );
});
