import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PathApprovalService } from "@ragsystem/backend-core/services/runtime/path-approval-service.js";
import { persistMediaFile, resolveWorkspaceRelative } from "../dist/storage.js";
import { loadWorkspaceImage, mediaAccessCandidates } from "../dist/tools/shared.js";
import {
  executeCheckVideoTask,
  executeGenerateImage,
  executeGenerateVideo,
  findModelEntry,
} from "../dist/index.js";

/** 媒体 Provider 完全插件自管：配置段即凭证源（vendor/api_key/endpoint/model）。 */
function makeContext(sectionValue) {
  return {
    tenantId: "t1",
    teamName: null,
    agent: { tools: { enabled_tools: ["generate_image", "generate_video", "check_video_task"] } },
    pathAccessPolicy: null,
    systemConfig: {
      getSection: (key) => (key === "media_image" || key === "media_video" ? sectionValue : undefined),
    },
  };
}

function makeToolCtx(root) {
  return { workspaceRoot: root, executionPaths: { workspace: root }, sessionId: "session-1", signal: null };
}

function makeSetup(overrides = {}) {
  return {
    provider: { name: "火山媒体", key: "ark_media", provider_type: "media_ark", api_key: "sk-ark", model_map: { image: "doubao-seedream-4-0", video: "doubao-seedance-2-0" }, models: ["doubao-seedream-4-0", "doubao-seedance-2-0"] },
    adapterId: "volcengine",
    model: "doubao-seedream-4-0",
    caps: findModelEntry("doubao-seedream-4-0").caps,
    ...overrides,
  };
}

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "media-gen-tool-"));
}

test("未启用配置 → 返回带指引的错误", async () => {
  const context = makeContext(undefined);
  const result = await executeGenerateImage(
    { prompt: "猫" },
    makeToolCtx(tempWorkspace()),
    context,
  );
  assert.equal(result.success, false);
  assert.ok(result.summary.includes("插件设置"));
});

test("厂商与模型目录不符 / 缺 API Key → 指引文案", async () => {
  const mismatch = makeContext({ enabled: true, vendor: "zhipu", api_key: "sk", model_name: "doubao-seedream-4-0" });
  const mismatchResult = await executeGenerateImage({ prompt: "猫" }, makeToolCtx(tempWorkspace()), mismatch);
  assert.equal(mismatchResult.success, false);
  assert.ok(mismatchResult.summary.includes("属于其他厂商"));

  const noKey = makeContext({ enabled: true, vendor: "zhipu", api_key: "  ", model_name: "glm-image" });
  const noKeyResult = await executeGenerateImage({ prompt: "猫" }, makeToolCtx(tempWorkspace()), noKey);
  assert.equal(noKeyResult.success, false);
  assert.ok(noKeyResult.summary.includes("API Key"));
});

test("generate_image 成功：落盘 + 内联 media + file_ref 提示", async () => {
  const root = tempWorkspace();
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const adapter = {
    generateImage: async () => [{ type: "base64", data: pngBytes.toString("base64"), mime: "image/png" }],
  };
  const result = await executeGenerateImage(
    { prompt: "一只猫" },
    makeToolCtx(root),
    makeContext({}),
    makeSetup({ adapter }),
  );
  assert.equal(result.success, true);
  assert.equal(result.outputType, "image");
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].kind, "image");
  const files = result.content.files;
  assert.equal(files.length, 1);
  assert.ok(files[0].relativePath.startsWith("media/images/img_"));
  assert.ok(fs.existsSync(path.join(root, files[0].relativePath)));
  assert.ok(result.llmHint.includes("<file_ref"));
});

test("generate_image 参考图不受支持 → 明确报错", async () => {
  const result = await executeGenerateImage(
    { prompt: "猫", reference_images: ["media/cat.png"] },
    makeToolCtx(tempWorkspace()),
    makeContext({}),
    makeSetup({ adapterId: "zhipu", model: "glm-image", caps: findModelEntry("glm-image").caps, adapter: {}, provider: { name: "智谱媒体", key: "zhipu_media", provider_type: "media_zhipu", api_key: "sk" } }),
  );
  assert.equal(result.success, false);
  assert.ok(result.summary.includes("不支持参考图"));
});

test("generate_video 成功：bytes 输出落盘为视频文件", async () => {
  const root = tempWorkspace();
  const mp4 = Buffer.from([0, 0, 0, 1, 0x66, 0x74, 0x79, 0x70]);
  let pollCount = 0;
  const adapter = {
    submitVideoJob: async () => ({ jobId: "job-1" }),
    pollVideoJob: async () => {
      pollCount += 1;
      return { status: "succeeded", outputs: { video: { type: "bytes", data: mp4, mime: "video/mp4" } } };
    },
  };
  const result = await executeGenerateVideo(
    { prompt: "海浪", duration_seconds: 5 },
    makeToolCtx(root),
    makeContext({}),
    makeSetup({ adapter, model: "cogvideox-3", adapterId: "zhipu", caps: findModelEntry("cogvideox-3").caps }),
  );
  assert.equal(result.success, true);
  assert.ok(result.content.file.startsWith("media/videos/vid_"));
  assert.ok(fs.existsSync(path.join(root, result.content.file)));
  assert.ok(result.llmHint.includes("<file_ref"));
  assert.equal(pollCount, 1);
});

test("generate_video 超时：返回 task_ref 引导续查（不判失败）", async () => {
  const adapter = {
    submitVideoJob: async () => ({ jobId: "job-slow" }),
    pollVideoJob: async () => ({ status: "running", progressHint: "RUNNING" }),
  };
  const result = await executeGenerateVideo(
    { prompt: "星空" },
    makeToolCtx(tempWorkspace()),
    makeContext({}),
    makeSetup({
      adapter,
      adapterId: "volcengine",
      model: "doubao-seedance-2-0",
      caps: findModelEntry("doubao-seedance-2-0").caps,
      waitTimeoutSeconds: 1,
    }),
  );
  assert.equal(result.success, true);
  assert.equal(result.content.status, "pending");
  assert.equal(result.content.task_ref, "volcengine:job-slow");
  assert.ok(result.llmHint.includes("check_video_task"));
});

test("check_video_task：running → 状态结果；succeeded → 落盘", async () => {
  const root = tempWorkspace();
  const runningAdapter = { pollVideoJob: async () => ({ status: "running", progressHint: "PROCESSING" }) };
  const running = await executeCheckVideoTask(
    { task_ref: "zhipu:job-1" },
    makeToolCtx(root),
    makeContext({}),
    makeSetup({ adapter: runningAdapter, adapterId: "zhipu", model: "cogvideox-3", caps: findModelEntry("cogvideox-3").caps }),
  );
  assert.equal(running.success, true);
  assert.equal(running.content.status, "running");

  const mp4 = Buffer.from([1, 2, 3, 4]);
  const doneAdapter = { pollVideoJob: async () => ({ status: "succeeded", outputs: { video: { type: "bytes", data: mp4, mime: "video/mp4" } } }) };
  const done = await executeCheckVideoTask(
    { task_ref: "zhipu:job-1" },
    makeToolCtx(root),
    makeContext({}),
    makeSetup({ adapter: doneAdapter, adapterId: "zhipu", model: "cogvideox-3", caps: findModelEntry("cogvideox-3").caps }),
  );
  assert.equal(done.success, true);
  assert.ok(done.content.file.startsWith("media/videos/vid_"));
  assert.ok(fs.existsSync(path.join(root, done.content.file)));
});

test("check_video_task：adapter 不匹配报错；格式非法报错", async () => {
  const mismatch = await executeCheckVideoTask(
    { task_ref: "zhipu:job-1" },
    makeToolCtx(tempWorkspace()),
    makeContext({}),
    makeSetup({ adapter: {}, adapterId: "volcengine", model: "doubao-seedance-2-0", caps: findModelEntry("doubao-seedance-2-0").caps }),
  );
  assert.equal(mismatch.success, false);
  assert.ok(mismatch.summary.includes("不符"));

  const malformed = await executeCheckVideoTask(
    { task_ref: "no-separator" },
    makeToolCtx(tempWorkspace()),
    makeContext({}),
    makeSetup({ adapter: {}, adapterId: "volcengine", model: "doubao-seedance-2-0", caps: findModelEntry("doubao-seedance-2-0").caps }),
  );
  assert.equal(malformed.success, false);
  assert.ok(malformed.summary.includes("格式非法"));
});

test("check_video_task：jobId 含路径穿越/空白等非法字符 → 拒绝", async () => {
  const badRefs = [
    "zhipu:../../etc/passwd",
    "zhipu:job id",
    "zhipu:job\t1",
    "zhipu:job#frag",
    "zhipu:",
  ];
  for (const taskRef of badRefs) {
    const result = await executeCheckVideoTask(
      { task_ref: taskRef },
      makeToolCtx(tempWorkspace()),
      makeContext({}),
      makeSetup({ adapter: {}, adapterId: "zhipu", model: "cogvideox-3", caps: findModelEntry("cogvideox-3").caps }),
    );
    assert.equal(result.success, false, taskRef);
    assert.ok(result.summary.includes("非法") || result.summary.includes("格式"), taskRef);
  }
});

test("check_video_task：google operation 名含 / 合法且 output_dir 生效", async () => {
  const root = tempWorkspace();
  const mp4 = Buffer.from([9, 9, 9]);
  const adapter = { pollVideoJob: async () => ({ status: "succeeded", outputs: { video: { type: "bytes", data: mp4, mime: "video/mp4" } } }) };
  const result = await executeCheckVideoTask(
    { task_ref: "google:models/veo/operations/op-1", output_dir: "media/videos/custom" },
    makeToolCtx(root),
    makeContext({}),
    makeSetup({ adapter, adapterId: "google", model: "veo-3.1-fast-generate-preview", caps: findModelEntry("veo-3.1-fast-generate-preview").caps }),
  );
  assert.equal(result.success, true);
  assert.ok(result.content.file.startsWith("media/videos/custom/vid_"));
  assert.ok(fs.existsSync(path.join(root, result.content.file)));
});

test("generate_video 轮询抛错：返回 pending 保留 task_ref（查询失败 ≠ 任务失败）", async () => {
  const adapter = {
    submitVideoJob: async () => ({ jobId: "job-err" }),
    pollVideoJob: async () => { throw new Error("网络抖动"); },
  };
  const result = await executeGenerateVideo(
    { prompt: "雨景" },
    makeToolCtx(tempWorkspace()),
    makeContext({}),
    makeSetup({ adapter, adapterId: "zhipu", model: "cogvideox-3", caps: findModelEntry("cogvideox-3").caps }),
  );
  assert.equal(result.success, true);
  assert.equal(result.content.status, "pending");
  assert.equal(result.content.task_ref, "zhipu:job-err");
  assert.ok(result.content.query_error.includes("网络抖动"));
  assert.ok(result.answer.includes("check_video_task"));
});

test("generate_video 等待中取消：保留 task_ref 引导续查", async () => {
  const controller = new AbortController();
  const adapter = {
    submitVideoJob: async () => ({ jobId: "job-cancel" }),
    pollVideoJob: async () => { controller.abort(); throw new Error("aborted"); },
  };
  const ctx = { ...makeToolCtx(tempWorkspace()), signal: controller.signal };
  const result = await executeGenerateVideo(
    { prompt: "夜景" },
    ctx,
    makeContext({}),
    makeSetup({ adapter, adapterId: "zhipu", model: "cogvideox-3", caps: findModelEntry("cogvideox-3").caps }),
  );
  assert.equal(result.success, true);
  assert.equal(result.content.status, "pending");
  assert.equal(result.content.task_ref, "zhipu:job-cancel");
  assert.ok(result.summary.includes("停止"));
});

test("generate_image url 输出：按下载响应 content-type 决定扩展名", async () => {
  const root = tempWorkspace();
  const webpBytes = Buffer.from("fake-webp-bytes");
  const adapter = {
    generateImage: async () => [{ type: "url", url: "https://cdn.example.com/img", mime: "application/octet-stream" }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(webpBytes, { status: 200, headers: { "content-type": "image/webp" } });
  try {
    const result = await executeGenerateImage({ prompt: "风景" }, makeToolCtx(root), makeContext({}), makeSetup({ adapter }));
    assert.equal(result.success, true);
    assert.ok(result.content.files[0].relativePath.endsWith(".webp"), result.content.files[0].relativePath);
    assert.equal(result.content.files[0].mime, "image/webp");
    assert.equal(result.media[0].mimeType, "image/webp");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("参考图与 output_dir 越界走路径审批：未批准拒绝、批准放行", async () => {
  const root = tempWorkspace();
  // os.tmpdir() 属于读语义界内根，外部路径必须建在仓库目录下才真正越界
  const externalDir = path.join(fileURLToPath(new URL(".", import.meta.url)), ".tmp-external-media");
  fs.rmSync(externalDir, { recursive: true, force: true });
  fs.mkdirSync(externalDir, { recursive: true });
  try {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const externalImage = path.join(externalDir, "ref.png");
    fs.writeFileSync(externalImage, png);
    const ctx = makeToolCtx(root);
    const policy = new PathApprovalService();

    // 未批准：参考图读取拒绝
    const rejected = await loadWorkspaceImage(root, externalImage, { ctx, pathService: policy });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /受管目录范围/);

    // checkAccess 候选：参考图（读）与 output_dir（写）都会上报
    const candidates = mediaAccessCandidates(
      { pathAccessPolicy: policy },
      { reference_images: [externalImage], output_dir: externalDir },
      ctx,
    );
    assert.deepEqual(candidates, [path.resolve(externalImage), path.resolve(externalDir)]);

    // 未批准：output_dir 落盘拒绝
    const dirRejected = resolveWorkspaceRelative(root, externalDir, policy);
    assert.equal(dirRejected.ok, false);
    assert.match(dirRejected.error, /受管目录范围/);

    // 批准后：参考图可读、产物可落盘到外部目录（relativePath 回退为绝对路径）
    policy.approve([externalDir]);
    const approved = await loadWorkspaceImage(root, externalImage, { ctx, pathService: policy });
    assert.equal(approved.ok, true);
    assert.equal(approved.image.bytes.length, png.length);

    const persisted = await persistMediaFile({
      workspaceRoot: root,
      outputDir: externalDir,
      baseName: "img",
      bytes: png,
      ext: ".png",
      pathService: policy,
    });
    assert.ok(fs.existsSync(persisted.absolutePath));
    assert.equal(path.isAbsolute(persisted.relativePath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(externalDir, { recursive: true, force: true });
  }
});
