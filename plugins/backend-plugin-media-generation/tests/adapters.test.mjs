import assert from "node:assert/strict";
import test from "node:test";

import { getMediaAdapter } from "../dist/index.js";

/* ── stub fetch：捕获请求并按序返回预置响应 ── */

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeStub(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next instanceof Function) return next(url, init);
    if (next instanceof Response) return next;
    return jsonResponse(next ?? {});
  };
  return { fn, calls };
}

function provider(overrides = {}) {
  return { name: "测试媒体", key: "test_media", provider_type: "media_ark", api_key: "sk-test", ...overrides };
}

const ctxBase = (fetchImpl, providerOverride) => ({ provider: provider(providerOverride), signal: null, fetchImpl });

test("volcengine 生图：请求映射与 b64 解析", async () => {
  const adapter = getMediaAdapter("volcengine");
  const stub = makeStub([{ data: [{ b64_json: Buffer.from("png").toString("base64") }] }]);
  const outputs = await adapter.generateImage(
    { prompt: "一只猫", aspectRatio: "16:9", resolutionTier: "2k", n: 1, refImages: [], watermark: false },
    "doubao-seedream-4-0",
    ctxBase(stub.fn),
  );
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].type, "base64");
  const call = stub.calls[0];
  assert.ok(call.url.endsWith("/api/v3/images/generations"));
  assert.equal(call.init.headers.authorization, "Bearer sk-test");
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, "doubao-seedream-4-0");
  assert.equal(body.size, "2K");
  assert.equal(body.response_format, "b64_json");
});

test("volcengine 视频：任务提交与轮询映射", async () => {
  const adapter = getMediaAdapter("volcengine");
  const stub = makeStub([
    { id: "task-1" },
    { status: "succeeded", content: { video_url: "https://cdn.example.com/v.mp4" } },
  ]);
  const submitted = await adapter.submitVideoJob(
    { prompt: "海浪", durationSeconds: 8, resolution: "720p", aspectRatio: "16:9", withAudio: true },
    "doubao-seedance-2-0",
    ctxBase(stub.fn),
  );
  assert.equal(submitted.jobId, "task-1");
  const submitBody = JSON.parse(stub.calls[0].init.body);
  assert.equal(submitBody.model, "doubao-seedance-2-0");
  assert.equal(submitBody.ratio, "16:9");
  assert.equal(submitBody.duration, 8);
  assert.equal(submitBody.generate_audio, true);
  assert.deepEqual(submitBody.content[0], { type: "text", text: "海浪" });

  const status = await adapter.pollVideoJob("task-1", "doubao-seedance-2-0", ctxBase(stub.fn));
  assert.equal(status.status, "succeeded");
  assert.equal(status.outputs.video.url, "https://cdn.example.com/v.mp4");
});

test("zhipu 生图：像素尺寸映射（1:1/1k → 1024x1024）与 URL 解析", async () => {
  const adapter = getMediaAdapter("zhipu");
  const stub = makeStub([{ data: [{ url: "https://cdn.example.com/img.png" }] }]);
  const outputs = await adapter.generateImage(
    { prompt: "海报", aspectRatio: "1:1", resolutionTier: "1k", n: 1, refImages: [], watermark: false },
    "glm-image",
    ctxBase(stub.fn, { provider_type: "media_zhipu", api_endpoint: "https://open.bigmodel.cn" }),
  );
  assert.equal(outputs[0].type, "url");
  assert.ok(stub.calls[0].url.startsWith("https://open.bigmodel.cn/api/paas/v4/images/generations"));
  const body = JSON.parse(stub.calls[0].init.body);
  assert.equal(body.size, "1024x1024");
});

test("zhipu 视频：首尾帧 image_url 数组 + async-result 轮询", async () => {
  const adapter = getMediaAdapter("zhipu");
  const png = { bytes: new Uint8Array([1, 2, 3]), mime: "image/png" };
  const stub = makeStub([
    { id: "job-9", task_status: "PROCESSING" },
    { task_status: "SUCCESS", video_result: [{ url: "https://v.example.com/v.mp4", cover_image_url: "https://v.example.com/c.jpg" }] },
  ]);
  await adapter.submitVideoJob(
    { prompt: "烟花", durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", withAudio: false, firstFrame: png, lastFrame: png },
    "cogvideox-3",
    ctxBase(stub.fn, { provider_type: "media_zhipu" }),
  );
  const body = JSON.parse(stub.calls[0].init.body);
  assert.equal(body.duration, 5);
  assert.equal(body.with_audio, false);
  assert.ok(Array.isArray(body.image_url) && body.image_url.length === 2);

  const status = await adapter.pollVideoJob("job-9", "cogvideox-3", ctxBase(stub.fn, { provider_type: "media_zhipu" }));
  assert.equal(status.status, "succeeded");
  assert.equal(status.outputs.cover.url, "https://v.example.com/c.jpg");
});

test("dashscope 生图：multimodal messages 结构 + 参考图 data URL", async () => {
  const adapter = getMediaAdapter("dashscope");
  const stub = makeStub([{ output: { choices: [{ message: { content: [{ image: "https://oss.example.com/a.png" }] } }] } }]);
  const outputs = await adapter.generateImage(
    {
      prompt: "山景",
      aspectRatio: "4:3",
      resolutionTier: "1k",
      n: 1,
      refImages: [{ bytes: new Uint8Array([9, 9]), mime: "image/png" }],
      watermark: false,
    },
    "wan2.7-image",
    ctxBase(stub.fn, { provider_type: "media_dashscope" }),
  );
  assert.equal(outputs[0].url, "https://oss.example.com/a.png");
  const body = JSON.parse(stub.calls[0].init.body);
  const content = body.input.messages[0].content;
  assert.equal(content[0].text, "山景");
  assert.ok(content[1].image.startsWith("data:image/png;base64,"));
  assert.equal(body.parameters.size, "1408x1056");
});

test("modelscope 生图：异步任务提交 + 轮询映射、参考图 data URL 与 Qwen-Image 尺寸夹取", async () => {
  const adapter = getMediaAdapter("modelscope");
  const stub = makeStub([
    { task_id: "ms-1" },
    { task_status: "SUCCEED", output_images: ["https://ms.example.com/a.png"] },
  ]);
  const outputs = await adapter.generateImage(
    {
      prompt: "赛博城市",
      aspectRatio: "16:9",
      resolutionTier: "1k",
      n: 1,
      refImages: [{ bytes: new Uint8Array([7, 7]), mime: "image/png" }],
      watermark: false,
    },
    "Qwen/Qwen-Image",
    ctxBase(stub.fn, { provider_type: "media_modelscope" }),
  );
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].type, "url");
  assert.equal(outputs[0].url, "https://ms.example.com/a.png");

  const submit = stub.calls[0];
  assert.ok(submit.url.endsWith("/v1/images/generations"));
  assert.equal(submit.init.headers["x-modelscope-async-mode"], "true");
  assert.equal(submit.init.headers.authorization, "Bearer sk-test");
  const body = JSON.parse(submit.init.body);
  assert.equal(body.model, "Qwen/Qwen-Image");
  // 16:9@1k = 1728x960，Qwen-Image 系单边上限 1664 → 等比缩入
  assert.equal(body.size, "1664x924");
  assert.ok(Array.isArray(body.image_url) && body.image_url[0].startsWith("data:image/png;base64,"));

  const poll = stub.calls[1];
  assert.ok(poll.url.endsWith("/v1/tasks/ms-1"));
  assert.equal(poll.init.headers["x-modelscope-task-type"], "image_generation");
});

test("modelscope 生图：任务 FAILED 抛可读错误", async () => {
  const adapter = getMediaAdapter("modelscope");
  const stub = makeStub([
    { task_id: "ms-2" },
    { task_status: "FAILED", errors: "safety check failed" },
  ]);
  await assert.rejects(
    adapter.generateImage(
      { prompt: "x", aspectRatio: "1:1", resolutionTier: "1k", n: 1, refImages: [], watermark: false },
      "Tongyi-MAI/Z-Image-Turbo",
      ctxBase(stub.fn, { provider_type: "media_modelscope" }),
    ),
    /safety check failed/,
  );
});

test("modelscope 生图 n=2 部分失败：保留成功的一张（allSettled 并发任务）", async () => {
  const adapter = getMediaAdapter("modelscope");
  const stub = makeStub([
    { task_id: "ms-a" },
    new Response(JSON.stringify({ message: "quota exceeded" }), { status: 429, headers: { "content-type": "application/json" } }),
    { task_status: "SUCCEED", output_images: ["https://ms.example.com/ok.png"] },
  ]);
  const outputs = await adapter.generateImage(
    { prompt: "对比", aspectRatio: "1:1", resolutionTier: "1k", n: 2, refImages: [], watermark: false },
    "Tongyi-MAI/Z-Image-Turbo",
    ctxBase(stub.fn, { provider_type: "media_modelscope" }),
  );
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].url, "https://ms.example.com/ok.png");
});

test("modelscope 视频：官方未开放 API，明确报不支持", async () => {
  const adapter = getMediaAdapter("modelscope");
  const ctx = ctxBase(makeStub([]).fn, { provider_type: "media_modelscope" });
  await assert.rejects(
    adapter.submitVideoJob({ prompt: "x", durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", withAudio: true }, "any", ctx),
    /暂未开放视频/,
  );
  await assert.rejects(adapter.pollVideoJob("t", "any", ctx), /暂未开放视频/);
});

test("dashscope 视频：异步头 + tasks 轮询", async () => {
  const adapter = getMediaAdapter("dashscope");
  const stub = makeStub([
    { output: { task_id: "t-dash", task_status: "PENDING" } },
    { output: { task_status: "SUCCEEDED", video_url: "https://oss.example.com/v.mp4" } },
  ]);
  const ctx = ctxBase(stub.fn, { provider_type: "media_dashscope" });
  await adapter.submitVideoJob(
    { prompt: "雨夜", durationSeconds: 6, resolution: "1080p", aspectRatio: "9:16", withAudio: true },
    "wan2.7-t2v",
    ctx,
  );
  assert.equal(stub.calls[0].init.headers["x-dashscope-async"], "enable");
  const body = JSON.parse(stub.calls[0].init.body);
  assert.equal(body.parameters.resolution, "1080P");
  assert.equal(body.parameters.ratio, "9:16");

  const status = await adapter.pollVideoJob("t-dash", "wan2.7-t2v", ctx);
  assert.equal(status.status, "succeeded");
});

test("openai 生图：无参考图走 generations，有参考图走 edits", async () => {
  const adapter = getMediaAdapter("openai");
  const imageResponse = { data: [{ b64_json: "AAAA" }] };
  const gen = makeStub([imageResponse]);
  await adapter.generateImage(
    { prompt: "cat", aspectRatio: "1:1", resolutionTier: "1k", n: 1, refImages: [], watermark: false },
    "gpt-image-1",
    ctxBase(gen.fn, { provider_type: "media_openai" }),
  );
  assert.ok(gen.calls[0].url.endsWith("/v1/images/generations"));

  const edit = makeStub([imageResponse]);
  await adapter.generateImage(
    { prompt: "cat with hat", aspectRatio: "1:1", resolutionTier: "1k", n: 1, refImages: [{ bytes: new Uint8Array([1]), mime: "image/png" }], watermark: false },
    "gpt-image-1",
    ctxBase(edit.fn, { provider_type: "media_openai" }),
  );
  assert.ok(edit.calls[0].url.endsWith("/v1/images/edits"));
  const body = JSON.parse(edit.calls[0].init.body);
  assert.deepEqual(body.images, ["AQ=="]);
});

test("openai 视频：完成即带鉴权下载 content", async () => {
  const adapter = getMediaAdapter("openai");
  const videoBytes = new Uint8Array([1, 2, 3, 4]);
  const stub = makeStub([
    { id: "v-1", status: "queued" },
    { status: "completed" },
    new Response(videoBytes, { status: 200, headers: { "content-type": "video/mp4" } }),
  ]);
  const ctx = ctxBase(stub.fn, { provider_type: "media_openai" });
  await adapter.submitVideoJob(
    { prompt: "skate", durationSeconds: 8, resolution: "720p", aspectRatio: "16:9", withAudio: true },
    "sora-2",
    ctx,
  );
  const submitBody = JSON.parse(stub.calls[0].init.body);
  assert.equal(submitBody.seconds, 8);
  assert.equal(submitBody.size, "1280x720");

  const status = await adapter.pollVideoJob("v-1", "sora-2", ctx);
  assert.equal(status.status, "succeeded");
  assert.equal(status.outputs.video.type, "bytes");
  assert.deepEqual(new Uint8Array(status.outputs.video.data), videoBytes);
  assert.ok(stub.calls[2].url.endsWith("/v1/videos/v-1/content"));
  assert.equal(stub.calls[2].init.headers.authorization, "Bearer sk-test");
});

test("google 生图：inline_data 参考图与响应解析", async () => {
  const adapter = getMediaAdapter("google");
  const b64 = Buffer.from("img").toString("base64");
  const stub = makeStub([{
    candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/png", data: b64 } }] } }],
  }]);
  const outputs = await adapter.generateImage(
    {
      prompt: "logo",
      aspectRatio: "1:1",
      resolutionTier: "2k",
      n: 1,
      refImages: [{ bytes: new Uint8Array([3]), mime: "image/png" }],
      watermark: false,
    },
    "gemini-3.1-flash-image",
    ctxBase(stub.fn, { provider_type: "media_google" }),
  );
  assert.equal(outputs[0].data, b64);
  const body = JSON.parse(stub.calls[0].init.body);
  assert.equal(stub.calls[0].init.headers["x-goog-api-key"], "sk-test");
  assert.equal(body.generationConfig.imageConfig.aspectRatio, "1:1");
  assert.equal(body.generationConfig.imageConfig.imageSize, "2K");
  assert.ok(body.contents[0].parts[1].inline_data.data.length > 0);
});

test("google 视频：operation 轮询完成后带鉴权下载", async () => {
  const adapter = getMediaAdapter("google");
  const videoBytes = new Uint8Array([5, 6, 7]);
  const stub = makeStub([
    { name: "models/veo/operations/op-1" },
    { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://g.example.com/v.mp4" } }] } } },
    new Response(videoBytes, { status: 200, headers: { "content-type": "video/mp4" } }),
  ]);
  const ctx = ctxBase(stub.fn, { provider_type: "media_google" });
  await adapter.submitVideoJob(
    { prompt: "ocean", durationSeconds: 8, resolution: "1080p", aspectRatio: "16:9", withAudio: true },
    "veo-3.1-fast-generate-preview",
    ctx,
  );
  assert.ok(stub.calls[0].url.includes(":predictLongRunning"));
  const status = await adapter.pollVideoJob("models/veo/operations/op-1", "veo-3.1-fast-generate-preview", ctx);
  assert.equal(status.status, "succeeded");
  assert.equal(status.outputs.video.type, "bytes");
  assert.equal(stub.calls[2].init.headers["x-goog-api-key"], "sk-test");
});

test("厂商错误响应规整为可读消息", async () => {
  const adapter = getMediaAdapter("volcengine");
  const errorResponse = new Response(
    JSON.stringify({ error: { message: "content policy violation", code: "1515" } }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
  const stub = makeStub([errorResponse]);
  await assert.rejects(
    adapter.generateImage(
      { prompt: "x", aspectRatio: "1:1", resolutionTier: "1k", n: 1, refImages: [], watermark: false },
      "doubao-seedream-4-0",
      ctxBase(stub.fn),
    ),
    /content policy violation/,
  );
});

test("volcengine 生图 n=2 部分失败：保留成功的一张（allSettled）", async () => {
  const adapter = getMediaAdapter("volcengine");
  const stub = makeStub([
    new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "content-type": "application/json" } }),
    { data: [{ b64_json: Buffer.from("png").toString("base64") }] },
  ]);
  const outputs = await adapter.generateImage(
    { prompt: "对比图", aspectRatio: "1:1", resolutionTier: "1k", n: 2, refImages: [], watermark: false },
    "doubao-seedream-4-0",
    ctxBase(stub.fn),
  );
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].type, "base64");
});

test("volcengine 生图全部失败：抛出首个错误", async () => {
  const adapter = getMediaAdapter("volcengine");
  const stub = makeStub([
    new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429, headers: { "content-type": "application/json" } }),
  ]);
  await assert.rejects(
    adapter.generateImage(
      { prompt: "x", aspectRatio: "1:1", resolutionTier: "1k", n: 2, refImages: [], watermark: false },
      "doubao-seedream-4-0",
      ctxBase(stub.fn),
    ),
    /quota exceeded/,
  );
});

test("zhipu 生图 n=2 部分失败：保留成功的一张（allSettled）", async () => {
  const adapter = getMediaAdapter("zhipu");
  const stub = makeStub([
    { data: [{ url: "https://cdn.example.com/ok.png" }] },
    new Response(JSON.stringify({ error: { message: "internal error" } }), { status: 500, headers: { "content-type": "application/json" } }),
  ]);
  const outputs = await adapter.generateImage(
    { prompt: "双图", aspectRatio: "1:1", resolutionTier: "1k", n: 2, refImages: [], watermark: false },
    "glm-image",
    ctxBase(stub.fn, { provider_type: "media_zhipu" }),
  );
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].url, "https://cdn.example.com/ok.png");
});
