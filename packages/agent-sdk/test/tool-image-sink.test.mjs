import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildToolMediaModelContent } from "../dist/tools/observation.js";

/** 1×1 红色 PNG（合法签名，可过 matchesImageSignature）。 */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function imageResult() {
  return {
    success: true,
    toolName: "view_image",
    summary: "ok",
    answer: null,
    outputType: "image",
    content: {},
    metadata: {},
    files: [],
    media: [{ kind: "image", mimeType: "image/png", source: { type: "base64", data: TINY_PNG.toString("base64") }, alt: "photo.png" }],
    llmHint: null,
  };
}

function visionProvider() {
  return { supports_vision: true };
}

test("media 经 ToolImageSink 持久化：file_id 进 metadata、in-band 用 sink 字节、files 标 session 生命周期", async () => {
  const result = imageResult();
  const adapted = new Uint8Array([9, 9, 9]);
  let saved = null;
  const parts = await buildToolMediaModelContent({
    result,
    observation: "obs",
    provider: visionProvider(),
    dataRoot: os.tmpdir(),
    sessionId: "session-1",
    imageSink: {
      save: async (input) => {
        saved = input;
        return {
          fileId: "file-42",
          storedPath: "D:/data/sessions/session-1/uploads/x.png",
          storedSize: input.bytes.byteLength,
          bytes: adapted,
          mimeType: "image/webp",
        };
      },
    },
  });

  assert.equal(saved.sessionId, "session-1");
  assert.equal(saved.toolName, "view_image");
  assert.equal(saved.name, "photo.png");
  assert.deepEqual([...new Uint8Array(saved.bytes)], [...TINY_PNG]);

  // metadata：file_id + 原始字节 mime（stored_path 上是原始字节；只有 in-band 用换码 mime）
  const entry = result.metadata.tool_result_media[0];
  assert.equal(entry.file_id, "file-42");
  assert.equal(entry.mime, "image/png");
  assert.equal(entry.stored_path, "D:/data/sessions/session-1/uploads/x.png");
  assert.equal(entry.original_name, "photo.png");

  // in-band data URL 用 sink 的请求适配字节与 mime
  const image = parts.find((part) => part.type === "image_url");
  assert.equal(image.image_url.url, `data:image/webp;base64,${Buffer.from(adapted).toString("base64")}`);

  // files 条目：session 生命周期 + file_id 元数据 + 原始字节 mime；media 引用指向持久化落点
  assert.equal(result.files[0].metadata.lifecycle, "session");
  assert.equal(result.files[0].metadata.file_id, "file-42");
  assert.equal(result.files[0].mimeType, "image/png");
  assert.equal(result.files[0].size, TINY_PNG.byteLength);
  assert.deepEqual(result.media, [{ kind: "image", mimeType: "image/png", source: { type: "file", path: "D:/data/sessions/session-1/uploads/x.png" }, alt: "photo.png" }]);
});

test("sink 抛错或未注入时回退临时文件通道：无 file_id、lifecycle transient", async () => {
  const failing = imageResult();
  await buildToolMediaModelContent({
    result: failing,
    observation: "obs",
    provider: visionProvider(),
    dataRoot: os.tmpdir(),
    sessionId: "session-1",
    imageSink: { save: async () => { throw new Error("storage down"); } },
  });
  assert.equal(failing.metadata.tool_result_media[0].file_id, undefined);
  assert.equal(failing.files[0].metadata.lifecycle, "transient");
  assert.ok(failing.files[0].path.startsWith(os.tmpdir()));
  fs.rmSync(path.dirname(failing.files[0].path), { recursive: true, force: true });

  const noSink = imageResult();
  await buildToolMediaModelContent({
    result: noSink,
    observation: "obs",
    provider: visionProvider(),
    dataRoot: os.tmpdir(),
    sessionId: "session-1",
  });
  assert.equal(noSink.metadata.tool_result_media[0].file_id, undefined);
  assert.equal(noSink.files[0].metadata.lifecycle, "transient");
  fs.rmSync(path.dirname(noSink.files[0].path), { recursive: true, force: true });
});

test("sink 已注入但 sessionId 缺失时不调用 sink，走临时文件回退", async () => {
  const result = imageResult();
  let sinkCalls = 0;
  await buildToolMediaModelContent({
    result,
    observation: "obs",
    provider: visionProvider(),
    dataRoot: os.tmpdir(),
    sessionId: null,
    imageSink: {
      save: async () => {
        sinkCalls += 1;
        return null;
      },
    },
  });
  assert.equal(sinkCalls, 0);
  assert.equal(result.metadata.tool_result_media[0].file_id, undefined);
  assert.equal(result.files[0].metadata.lifecycle, "transient");
  assert.ok(result.files[0].path.startsWith(os.tmpdir()));
  fs.rmSync(path.dirname(result.files[0].path), { recursive: true, force: true });
});
